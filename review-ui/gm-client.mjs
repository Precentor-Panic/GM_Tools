#!/usr/bin/env node
/**
 * Headless Foundry GM client for the World Fabric bridge.
 *
 * Logs into a Foundry world as a GM-role user, waits for the world to be ready
 * (which starts the module's ops watcher and re-exports the index), stays
 * connected until the ops queue has been empty for a quiet period, then exits.
 * Prints the browser console so bridge errors are visible from the terminal.
 *
 *   node gm-client.mjs --daemon        # the always-on bridge: stay connected,
 *                                      # write a heartbeat, refresh the index,
 *                                      # exit non-zero if the connection is lost
 *                                      # (ops/systemd/gm-tools-bridge.service)
 *   node gm-client.mjs                 # drain the queue, then exit
 *   node gm-client.mjs --hold 600      # stay connected 10 min regardless
 *   node gm-client.mjs --set-password  # after login, set FOUNDRY_GM_PASSWORD on the
 *                                      # account (for a freshly created blank-password user)
 *
 * Env (from ../.env via --env-file-if-exists, or the shell):
 *   FOUNDRY_URL           default http://localhost:30000
 *   FOUNDRY_GM_USER       user name to log in as (must have the Gamemaster role)
 *   FOUNDRY_GM_PASSWORD   its password ("" for a user without one)
 *   WF_OPS_FILE           ops file to watch; default derived from FOUNDRY_DATA_DIR + WF_WORLD
 *   FOUNDRY_DATA_DIR      default /opt/dev/foundrydata/Data
 *   WF_WORLD              default aureus
 *
 * COEXISTENCE. Other GM clients may be connected (the GM's own browser tab).
 * The module picks ONE client to apply bridge work: an active GM whose user
 * carries the `world-fabric.bridge` flag, else Foundry's activeGM
 * (foundry_worldFabric scripts/data/bridge-leader.mjs). This client sets that
 * flag on its own user at login, so it leads whenever it is connected. The one
 * thing it cannot share with is a SECOND session of its own user, so a one-shot
 * run refuses while the daemon's heartbeat is fresh.
 *
 * Must run from review-ui/ so Playwright resolves.
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { bridgeStatePath, bridgeLiveness } from "../wf-mcp-server/lib/bridge-state.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };

const URL = process.env.FOUNDRY_URL ?? "http://localhost:30000";
const USER = process.env.FOUNDRY_GM_USER;
const PASSWORD = process.env.FOUNDRY_GM_PASSWORD ?? "";
const DATA = process.env.FOUNDRY_DATA_DIR ?? "/opt/dev/foundrydata/Data";
const WORLD = process.env.WF_WORLD ?? "aureus";
const OPS = process.env.WF_OPS_FILE ?? `${DATA}/worlds/${WORLD}/world-fabric-foundry-ops.json`;
const HOLD_S = Number(opt("--hold", "0"));
const QUIET_S = Number(opt("--quiet", "20"));
const MAX_S = Number(opt("--max", String(6 * 3600)));
const DAEMON = flag("--daemon");
const BEAT_MS = 5000;                                   // heartbeat + liveness probe
const REINDEX_MS = Number(opt("--reindex", "120")) * 1000; // periodic index refresh (daemon)
const LOST_AFTER = 6;                                   // consecutive failed probes before giving up

if (!USER) { console.error("FOUNDRY_GM_USER is not set."); process.exit(2); }
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const queueEmpty = () => !existsSync(OPS) || readFileSync(OPS, "utf8").trim() === "[]";

const STATE = bridgeStatePath(WORLD);
const startedAt = new Date().toISOString();
const writeState = (fields) => {
  try { writeFileSync(STATE, JSON.stringify({ world: WORLD, user: USER, pid: process.pid, mode: DAEMON ? "daemon" : "one-shot", startedAt, beatAt: new Date().toISOString(), ...fields }, null, 2)); } catch { /* status is advisory */ }
};

// Two sessions of the SAME user both believe they lead. The daemon is the one
// that stays; a one-shot run beside it has nothing to add.
{
  const { connected, state: other } = bridgeLiveness(WORLD);
  if (connected && other.pid !== process.pid && !flag("--force")) {
    console.error(`The bridge is already connected to "${WORLD}" (pid ${other.pid}, ${other.mode}, last beat ${other.beatAt}). Nothing to do. Pass --force to connect a second session anyway.`);
    process.exit(DAEMON ? 1 : 0);
  }
}

// A headless page counts as hidden, and Chromium throttles a hidden page's
// timers down to one wake-up a minute after five minutes. The module's
// watchers are 5-second setIntervals, so every op pushed to a long-lived
// client took about a minute to be noticed (measured 2026-10-13: 45-60 s per
// op). These switches turn that throttling off for this browser only.
const browser = await chromium.launch({
  headless: true,
  args: [
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=IntensiveWakeUpThrottling"
  ]
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
// Nobody looks at this client, so it must not draw. With the canvas on, a
// headless browser renders the active scene in software and holds three to
// four CPU cores for as long as it is connected (measured 2026-10-13: 340%),
// which also starves the page's own timers and uploads. `core.noCanvas` is
// Foundry's own per-client "Disable Game Canvas" setting; client settings live
// in localStorage, so this touches this browser profile and nothing else.
await context.addInitScript(() => { try { localStorage.setItem("core.noCanvas", "true"); } catch { /* not a Foundry origin */ } });
const page = await context.newPage();
page.on("console", (m) => { const t = m.text(); if (/world-fabric|World Fabric|WF |error|Error/i.test(t)) log(`[browser:${m.type()}]`, t.slice(0, 400)); });
page.on("pageerror", (e) => log("[pageerror]", String(e).slice(0, 400)));

let exitCode = 0;
try {
  await page.goto(`${URL}/join`, { waitUntil: "domcontentloaded", timeout: 60000 });
  // The join form: a <select name="userid"> of user names, a password input, and a Join button.
  await page.waitForSelector('select[name="userid"]', { timeout: 60000 });
  const picked = await page.evaluate((name) => {
    const sel = document.querySelector('select[name="userid"]');
    const o = [...sel.options].find((x) => x.textContent.trim() === name);
    if (!o) return null;
    sel.value = o.value; sel.dispatchEvent(new Event("change", { bubbles: true }));
    return o.value;
  }, USER);
  if (!picked) throw new Error(`no user named "${USER}" on the join screen`);
  if (PASSWORD) await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL(/\/game/, { timeout: 60000 }),
    page.click('button[name="join"], button[type="submit"]')
  ]);
  log(`joined as ${USER}; waiting for the world to be ready`);
  await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 180000 });

  const who = await page.evaluate(() => ({
    me: game.user.name, isGM: game.user.isGM,
    otherGMs: game.users.filter((u) => u.active && u.isGM && u.id !== game.user.id).map((u) => u.name),
    wf: !!game.modules.get("world-fabric")?.active,
    version: game.version
  }));
  who.noCanvas = await page.evaluate(() => game.settings.get("core", "noCanvas") === true);
  // Same reason: Foundry's interface animates, and a headless browser paints
  // every frame in software (about half a core, measured). Nothing here needs
  // the DOM to be visible, so stop it painting.
  await page.evaluate(() => { document.documentElement.style.display = "none"; });
  log("ready:", JSON.stringify(who));
  if (!who.isGM) throw new Error(`"${USER}" is not a Gamemaster-role user`);
  if (!who.wf) throw new Error("the world-fabric module is not active in this world");
  // Mark this user as the bridge so every GM client agrees who applies.
  await page.evaluate(async () => { if (game.user.getFlag("world-fabric", "bridge") !== true) await game.user.setFlag("world-fabric", "bridge", true); });
  const hasLeaderApi = await page.evaluate(() => typeof game.modules.get("world-fabric")?.api?.isBridgeLeader === "function");
  if (!hasLeaderApi) throw new Error("the world-fabric module in this world predates the bridge-leader rule; restart Foundry so it serves the current module");
  if (who.otherGMs.length) log(`other GM clients connected: ${who.otherGMs.join(", ")} (they stand down while this client is connected)`);

  if (flag("--claim-watcher")) {
    // The bridge's watcher yields to game.users.activeGM (the first active GM by id).
    // When another GM is connected but its client is NOT running the bridge (a tab
    // left open with the module errored), that guard stalls every push. This makes
    // THIS client the active GM in its own eyes only; nothing changes for anyone else.
    await page.evaluate(() => Object.defineProperty(game.users, "activeGM", { get: () => game.user, configurable: true }));
    log("claimed the ops watcher for this client (activeGM override, local to this page)");
  }

  if (flag("--set-password")) {
    if (!PASSWORD) throw new Error("--set-password needs FOUNDRY_GM_PASSWORD");
    await page.evaluate((pw) => game.user.update({ password: pw }), PASSWORD);
    log("password set on the account through Foundry's own user update");
  }

  const probe = () => page.evaluate(() => ({
    ready: game.ready === true,
    connected: game.socket?.connected === true,
    leader: game.modules.get("world-fabric")?.api?.isBridgeLeader?.() === true,
    otherGMs: game.users.filter((u) => u.active && u.isGM && u.id !== game.user.id).map((u) => u.name),
    players: game.users.filter((u) => u.active && !u.isGM).map((u) => u.name),
    moduleVersion: game.modules.get("world-fabric")?.version ?? null
  }));
  const reindex = async () => { await page.evaluate(() => game.modules.get("world-fabric")?.api?.reindexForGmTools?.()); return new Date().toISOString(); };

  if (DAEMON) {
    // Always-on: no quiet-period exit. Leave only when told to (SIGTERM) or
    // when the connection is really gone, and then with a non-zero code so
    // the service manager starts a fresh client.
    let stopping = false, failures = 0, lastIndexAt = await reindex(), opsBatches = 0, wasEmpty = queueEmpty();
    const stop = (sig) => { if (!stopping) { stopping = true; log(`${sig}; leaving the world`); } };
    process.on("SIGTERM", () => stop("SIGTERM"));
    process.on("SIGINT", () => stop("SIGINT"));
    log("daemon: holding the connection");
    while (!stopping) {
      let p = null;
      try { p = await Promise.race([probe(), sleep(4000).then(() => { throw new Error("probe timed out"); })]); } catch (e) { p = null; if (!stopping) log("probe failed:", String(e.message).slice(0, 160)); }
      const ok = p?.ready && p?.connected;
      failures = ok ? 0 : failures + 1;
      const empty = queueEmpty();
      if (ok && wasEmpty && !empty) opsBatches++;
      // Fresh index after every drained batch, and on a timer, so GM_Tools
      // never reads a stale picture of what is in Foundry.
      if (ok && ((!wasEmpty && empty) || Date.now() - Date.parse(lastIndexAt) >= REINDEX_MS)) {
        try { lastIndexAt = await reindex(); } catch (e) { log("reindex failed:", String(e.message).slice(0, 160)); }
      }
      wasEmpty = empty;
      writeState({ state: ok ? "connected" : "degraded", ...(p ?? {}), lastIndexAt, opsBatches, queueEmpty: empty });
      if (failures >= LOST_AFTER) throw new Error(`lost the Foundry connection (${failures} failed probes)`);
      await sleep(BEAT_MS);
    }
    writeState({ state: "stopped" });
    await browser.close();
    process.exit(0);
  }

  // Stay connected: until the queue has been empty for QUIET_S (or HOLD_S if longer).
  writeState({ state: "connected", ...(await probe()) });
  const t0 = Date.now();
  let emptySince = queueEmpty() ? Date.now() : null;
  while (Date.now() - t0 < MAX_S * 1000) {
    const empty = queueEmpty();
    if (empty && emptySince == null) { emptySince = Date.now(); log("ops queue is empty"); }
    if (!empty) emptySince = null;
    const heldLongEnough = Date.now() - t0 >= HOLD_S * 1000;
    if (empty && heldLongEnough && Date.now() - emptySince >= QUIET_S * 1000) break;
    writeState({ state: "connected", queueEmpty: empty });
    await sleep(2000);
  }
  await page.evaluate(() => game.modules.get("world-fabric")?.api?.reindexForGmTools?.());
  await sleep(2000);
  log("done; leaving the world");
  writeState({ state: "stopped" });
} catch (e) {
  log("FAILED:", e.message);
  writeState({ state: "stopped", error: String(e.message).slice(0, 300) });
  exitCode = 1;
} finally {
  await browser.close();
}
process.exit(exitCode);
