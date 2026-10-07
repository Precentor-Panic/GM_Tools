/**
 * Foundry push orchestrator (2026-10-06) — ONE entry point for "get this
 * session's actors, faces and scenes into Foundry", replacing the hand-rolled
 * per-push scripts that have been re-invented every session.
 *
 * WHY THIS EXISTS. Pushing session three by hand hit five failures in one
 * sitting, every one of them a property of the push PROCESS rather than of any
 * single route:
 *
 *   1. DUPLICATE SCENES. Two pusher scripts ran at once and both queued a
 *      create_scene for the same scene; Foundry ended up with two copies of
 *      "The Silt Trench — the count", one of them empty. Nothing anywhere
 *      prevented a second concurrent pusher. -> `withPushLock`.
 *   2. LOST REFS. `push-bestiary-entry` and `push-scene` return `queued` the
 *      instant the op is written; the created document's uuid arrives LATER in
 *      world-fabric-foundry-results.json, which the bridge OVERWRITES per
 *      batch. Nothing reconciled it, so every ref was lost and the stores
 *      still believed nothing had been pushed. This is the same trap that lost
 *      the KB hauler's ref in session two, hit again. -> `awaitOpResult`
 *      reconciles before the next op is allowed to queue.
 *   3. TOKENS NEVER ARRIVED. A scene's token ops are only composed once the
 *      scene's own uuid is known, so losing the ref in (2) silently produced
 *      eight scenes with no tokens on them. -> refs reconcile inline, and
 *      `verify` reports token counts so this cannot pass unnoticed again.
 *   4. THE CLIENT'S --hold IS A HARD TIMER. The headless GM client left the
 *      world mid-push and every subsequent call 409'd on a non-empty queue
 *      with no indication why. -> `requireLiveClient` checks before each op
 *      and fails with the real reason.
 *   5. NO IDEMPOTENCY. Re-running a push re-created documents instead of
 *      skipping ones already pushed. -> every step skips a record that already
 *      carries a ref unless `force` is set.
 *
 * PUSH ROUND (2026-10-07) closed three more, found by reading the code rather
 * than by losing another evening to them:
 *
 *   6. `pushOne` RACED THE ROUTE IT WAS WAITING ON. Every push route polls
 *      the bridge itself, and `writeFoundryOps` deletes its own batch's
 *      results before returning them -- so the file poll below looked for
 *      something already consumed, waited out the full ten-minute budget and
 *      reported a FAILURE for a push that had worked. The worst failure mode
 *      a push tool can have, because the obvious response is to run it again
 *      and create a duplicate. The route's own answer is now used directly;
 *      the file poll is the `queued` fallback only.
 *   7. THE LOCK LIVED IN FOUNDRY'S WORLD FOLDER. Moved to GM_Tools' own
 *      store dir -- a dotfile in there gets carried into backups and
 *      restores, where a dead pid can wedge a push on a machine that never
 *      ran one.
 *   8. `--force` ON AN ACTOR WAS UNUSABLE. The route refuses an
 *      already-pushed entry and this surfaced that as a hard failure.
 *      bin/foundry-push no longer forces actors at all: re-creating one
 *      orphans every token pointing at the first. It re-sends the FACE,
 *      which is the thing that actually changes.
 *
 * Deliberately NOT a new route and NOT an MCP tool: pushing is a destructive,
 * external, GM-initiated act (the same precedent push-scene/sync-to-plans
 * already set), and an LLM-reachable "push everything" verb is exactly the
 * kind of thing the no-silent-auto-write invariant exists to prevent. It is a
 * library a human-run script calls.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { foundryResultsPath, foundryOpsPath, foundryIndexPath } from "./snapshot.mjs";

/** How long to wait for one op to drain before giving up. The FIRST op after a
 * client connects has been measured at ~8 minutes; every one after it at ~35s.
 * Budget for the slow first op rather than reporting a false hang. */
export const OP_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 2500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJsonArray(path) {
  try {
    const raw = readFileSync(path, "utf8").trim();
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// --- the concurrency guard, i.e. failure (1) -------------------------------

/**
 * The lock lives in GM_TOOLS' OWN store dir, not inside the Foundry world
 * folder (push round, 2026-10-07). The world folder is Foundry's to manage --
 * it gets backed up, copied between installs and occasionally rebuilt, and a
 * stray dotfile in there is at best confusing and at worst carried into a
 * restore, where a dead pid could wedge a push on a machine that never ran
 * it. Honours GM_TOOLS_PUSH_LOCK_DIR, the same env-override convention every
 * other store in this project uses, which is also what lets tests point it
 * somewhere disposable.
 */
function lockPath(dataDir, world) {
  const base = process.env.GM_TOOLS_PUSH_LOCK_DIR
    || join(process.env.HOME ?? dataDir, ".gm-tools", "push-locks");
  return join(base, `${world}.lock`);
}

/**
 * Run `fn` holding an exclusive per-world push lock. A stale lock (its pid is
 * gone) is reclaimed rather than wedging the next run forever — a crashed
 * pusher must not require manual cleanup.
 */
export async function withPushLock(dataDir, world, fn) {
  const path = lockPath(dataDir, world);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    let held = null;
    try { held = JSON.parse(readFileSync(path, "utf8")); } catch { held = null; }
    const alive = held?.pid && (() => { try { process.kill(held.pid, 0); return true; } catch { return false; } })();
    if (alive) {
      throw new Error(
        `Another push is already running for world "${world}" (pid ${held.pid}, started ${held.at}). ` +
        `Two concurrent pushers is how duplicate scenes get created — wait for it, or kill it and delete ${path}.`
      );
    }
    unlinkSync(path); // stale: the holder is gone
  }
  writeFileSync(path, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), "utf8");
  try {
    return await fn();
  } finally {
    try { unlinkSync(path); } catch { /* already gone */ }
  }
}

// --- the client check, i.e. failure (4) ------------------------------------

/**
 * A live GM client is the thing that drains the queue. Without one every op
 * sits in the file and the NEXT call 409s on a non-empty queue, which reads
 * like a different bug entirely. Freshness of the exported index is the
 * available signal.
 */
export function clientLooksLive(dataDir, world, { maxAgeMs = 5 * 60 * 1000, now = Date.now() } = {}) {
  const path = foundryIndexPath(dataDir, world);
  if (!existsSync(path)) return { live: false, reason: "no index has ever been exported for this world" };
  let exportedAt = null;
  try { exportedAt = JSON.parse(readFileSync(path, "utf8"))?.exportedAt ?? null; } catch { /* unreadable */ }
  if (!exportedAt) return { live: false, reason: "the index carries no exportedAt" };
  const age = now - Date.parse(exportedAt);
  if (!Number.isFinite(age)) return { live: false, reason: `unparseable exportedAt (${exportedAt})` };
  if (age > maxAgeMs) {
    // NOT proof of absence. The client re-exports the index on connect and
    // after applying ops, so a connected-but-idle client goes stale on this
    // signal alone. Callers treat this as a WARNING; the authoritative test is
    // whether the queue actually drains (awaitQueueDrain), which is why
    // pushOne reports a drain timeout with this reason attached rather than
    // refusing to try.
    return { live: false, stale: true, exportedAt, ageMs: age, reason: `the index is ${Math.round(age / 60000)} minutes old — a GM client may not be connected (idle clients also look like this)` };
  }
  return { live: true, exportedAt, ageMs: age };
}

// --- one op at a time, reconciled, i.e. failures (2) and (3) ---------------

/** Wait for the ops queue to be empty. Queuing on top of a full queue is a 409. */
export async function awaitQueueDrain(dataDir, world, { timeoutMs = OP_TIMEOUT_MS } = {}) {
  const ops = foundryOpsPath(dataDir, world);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readJsonArray(ops).length === 0) return true;
    await sleep(POLL_MS);
  }
  return false;
}

/**
 * Wait for ONE op id to appear in the results file, and hand the caller the
 * result so it can be reconciled immediately. The results file is overwritten
 * per batch, so a result not consumed before the next op is queued is gone —
 * that is why this is awaited inline rather than swept up at the end.
 *
 * @returns {Promise<{ok:boolean, foundryUuid?:string, error?:string}|null>} null on timeout
 */
export async function awaitOpResult(dataDir, world, opId, { timeoutMs = OP_TIMEOUT_MS } = {}) {
  const ops = foundryOpsPath(dataDir, world);
  const results = foundryResultsPath(dataDir, world);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    if (readJsonArray(ops).length !== 0) continue; // still in flight
    const hit = readJsonArray(results).find((r) => r.opId === opId);
    if (hit) return hit;
  }
  return null;
}

/**
 * Queue one op through `queueFn`, wait for it, reconcile via `reconcileFn`.
 * The three failure shapes a caller actually has to tell apart are returned
 * distinctly rather than collapsed into a boolean:
 *   skipped  — already pushed, nothing to do (idempotency)
 *   ok       — applied and the ref was reconciled
 *   failed   — the bridge rejected it, or it never came back
 */
export async function pushOne({ label, alreadyPushed, queueFn, reconcileFn, dataDir, world, force = false, timeoutMs = OP_TIMEOUT_MS }) {
  if (alreadyPushed && !force) return { label, status: "skipped", reason: "already has a Foundry ref" };

  // Liveness is advisory only (see clientLooksLive): an idle-but-connected
  // client looks stale. The queue draining is the real test, so try the op and
  // let a drain timeout be the failure, with the liveness hint attached.
  const live = clientLooksLive(dataDir, world);
  if (!(await awaitQueueDrain(dataDir, world, { timeoutMs }))) {
    return { label, status: "failed", reason: `the ops queue never drained${live.live ? "" : ` — ${live.reason}`}` };
  }

  let queued;
  try {
    queued = await queueFn();
  } catch (err) {
    return { label, status: "failed", reason: String(err?.message ?? err).slice(0, 200) };
  }
  const opId = queued?.opId;
  if (!opId) return { label, status: "failed", reason: `the push returned no opId: ${JSON.stringify(queued).slice(0, 160)}` };

  // THE ROUTE'S OWN ANSWER COMES FIRST (push round, 2026-10-07). Every push
  // route polls the bridge itself and, on success, returns
  // `{status:'applied', ok, foundryUuid}` -- and `writeFoundryOps` DELETES
  // its own batch's entries from the results file before returning them. So
  // polling the file afterwards, as this used to do unconditionally, looks
  // for something that has already been consumed: it waited out the full
  // ten-minute budget and reported a FAILURE for a push that had worked.
  // That is the single worst failure mode a push tool can have, because the
  // obvious response to it is to run the push again.
  //
  // The file poll is now only the `queued` fallback -- the genuine case where
  // the route's own short window expired before Foundry's ~5s watcher tick,
  // and the result really is still coming.
  let result;
  if (queued.status === "applied") {
    result = { ok: queued.ok !== false, foundryUuid: queued.foundryUuid ?? null, error: queued.error };
  } else {
    result = await awaitOpResult(dataDir, world, opId, { timeoutMs });
    if (!result) return { label, status: "failed", reason: `no result for ${opId} within ${Math.round(timeoutMs / 1000)}s`, opId };
  }
  if (!result.ok) return { label, status: "failed", reason: result.error ?? "the bridge reported a failure", opId };

  let ref = result.foundryUuid ?? null;
  try {
    if (reconcileFn) await reconcileFn(ref, result);
  } catch (err) {
    // The document EXISTS in Foundry but the store does not know its id. Say so
    // loudly: a silent failure here is what produces orphans and duplicates on
    // the next run.
    return { label, status: "failed", ref, reason: `applied in Foundry as ${ref} but the ref could not be reconciled: ${String(err?.message ?? err).slice(0, 140)}` };
  }
  return { label, status: "ok", ref };
}

// --- verification, i.e. "never let (3) pass unnoticed again" ---------------

/**
 * Read the exported index and report what is actually in Foundry: duplicate
 * scene names, and the token count per scene. A scene with zero tokens after a
 * push is the signature of failure (3) and must be surfaced, not assumed fine.
 *
 * @returns {{exportedAt:string|null, scenes:{name:string,uuid:string,tokens:number}[], duplicates:{name:string,uuids:string[]}[]}}
 */
export function verifyWorld(dataDir, world) {
  const path = foundryIndexPath(dataDir, world);
  if (!existsSync(path)) return { exportedAt: null, scenes: [], duplicates: [] };
  let index;
  try { index = JSON.parse(readFileSync(path, "utf8")); } catch { return { exportedAt: null, scenes: [], duplicates: [] }; }

  const tokensBy = new Map();
  for (const t of index.tokens ?? []) {
    const key = t?.sceneUuid;
    if (key) tokensBy.set(key, (tokensBy.get(key) ?? 0) + 1);
  }
  const scenes = (index.scenes ?? []).map((s) => ({ name: s.name, uuid: s.uuid, tokens: tokensBy.get(s.uuid) ?? 0 }));

  const byName = new Map();
  for (const s of scenes) {
    if (!byName.has(s.name)) byName.set(s.name, []);
    byName.get(s.name).push(s.uuid);
  }
  const duplicates = [...byName.entries()]
    .filter(([, uuids]) => uuids.length > 1)
    .map(([name, uuids]) => ({ name, uuids }));

  return { exportedAt: index.exportedAt ?? null, scenes, duplicates };
}
