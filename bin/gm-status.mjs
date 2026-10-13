#!/usr/bin/env node
/**
 * One status command: are the servers up, is the bridge connected, how old is
 * the index, how deep is the queue.
 *
 *   bin/gm-status            human report; exit 0 healthy, 1 if anything is wrong
 *   bin/gm-status --json     the same facts as JSON
 *   bin/gm-status --world x  another world (default WF_WORLD / WF_DEFAULT_WORLD)
 *
 * Reads only. Every line is something a push depends on, in dependency order,
 * and every problem line says what to run.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDataDir } from "../wf-mcp-server/lib/data-dir.mjs";
import { foundryIndexPath, foundryOpsPath, foundryResultsPath } from "../wf-mcp-server/lib/snapshot.mjs";
import { bridgeLiveness } from "../wf-mcp-server/lib/bridge-state.mjs";
import { listCampaigns } from "../mutation-engine/campaign-home.mjs";

const argv = process.argv.slice(2);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const asJson = argv.includes("--json");
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const world = opt("--world") ?? process.env.WF_WORLD ?? process.env.WF_DEFAULT_WORLD ?? null;
const foundryPort = process.env.FOUNDRY_PORT ?? "30000";
const appPort = process.env.REVIEW_UI_PORT ?? "8787";
const dataDir = resolveDataDir();

const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch (e) { return (e.stdout ?? "").toString().trim(); } };
const getJson = async (url) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(4000) }); return r.ok ? await r.json() : null; } catch { return null; } };
const age = (ms) => ms == null || !Number.isFinite(ms) ? "unknown" : ms < 90e3 ? `${Math.round(ms / 1000)} s` : ms < 90 * 60e3 ? `${Math.round(ms / 60e3)} min` : ms < 48 * 3600e3 ? `${(ms / 3600e3).toFixed(1)} h` : `${Math.round(ms / 86400e3)} days`;
const readArr = (p) => { try { const t = readFileSync(p, "utf8").trim(); const j = t ? JSON.parse(t) : []; return Array.isArray(j) ? j : []; } catch { return null; } };

function unit(name) {
  const out = sh("systemctl", ["--user", "show", name, "-p", "LoadState", "-p", "ActiveState", "-p", "SubState", "-p", "UnitFileState", "-p", "ExecMainStartTimestamp", "-p", "NRestarts", "-p", "MainPID"]);
  const kv = Object.fromEntries(out.split("\n").filter(Boolean).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
  const since = kv.ExecMainStartTimestamp ? Date.parse(kv.ExecMainStartTimestamp.replace(/^\w+ /, "").replace(/ [A-Z]{2,5}$/, "")) : NaN;
  return { name, installed: kv.LoadState === "loaded", active: kv.ActiveState === "active", state: `${kv.ActiveState ?? "?"}/${kv.SubState ?? "?"}`, enabled: kv.UnitFileState === "enabled", since: Number.isFinite(since) ? since : null, restarts: Number(kv.NRestarts ?? 0), pid: Number(kv.MainPID ?? 0) };
}

/** Newest mtime among tracked server-side source files -- what a restart would load. */
function newestServerSource() {
  const files = sh("git", ["-C", repo, "ls-files", "*.mjs"]).split("\n").filter((f) => f && !/(^|\/)(test|public|node_modules)\//.test(f) && !/\.test\.mjs$/.test(f) && !f.startsWith("bin/") && f !== "review-ui/gm-client.mjs");
  let newest = 0, which = null;
  for (const f of files) { try { const m = statSync(join(repo, f)).mtimeMs; if (m > newest) { newest = m; which = f; } } catch { /* deleted */ } }
  return { newest, which };
}

const now = Date.now();
const rows = []; // {key, ok, label, detail, fix?}
const add = (key, ok, label, detail, fix) => rows.push({ key, ok, label, detail, ...(fix && !ok ? { fix } : {}) });

// 1. Foundry
const fUnit = unit("foundry.service");
const fStatus = await getJson(`http://localhost:${foundryPort}/api/status`);
add("foundry", Boolean(fStatus?.active),
  "Foundry", fStatus ? (fStatus.active ? `up on :${foundryPort}, world "${fStatus.world}", v${fStatus.version}, ${fStatus.users} user(s) connected` : `up on :${foundryPort} but no world is open`) : `not answering on :${foundryPort}`,
  fUnit.installed ? "systemctl --user restart foundry" : "ops/install-services.sh --start");
if (fStatus?.active && world && fStatus.world !== world) add("foundry-world", false, "Foundry world", `Foundry has "${fStatus.world}" open, the bridge is configured for "${world}"`, "fix FOUNDRY_WORLD / WF_WORLD in ~/.config/gm-tools/services.env");

// 2. GM_Tools
const aUnit = unit("gm-tools.service");
const aWorlds = await getJson(`http://localhost:${appPort}/api/worlds`);
add("app", aWorlds != null, "GM_Tools", aWorlds != null ? `up on :${appPort}` : `not answering on :${appPort}`, aUnit.installed ? "systemctl --user restart gm-tools" : "ops/install-services.sh --start");
if (aWorlds != null && aUnit.active && aUnit.since) {
  const src = newestServerSource();
  const stale = src.newest > aUnit.since + 2000;
  add("app-code", !stale, "GM_Tools code", stale ? `the server started ${age(now - aUnit.since)} ago, before ${src.which} was last changed (${age(now - src.newest)} ago); it is running old code` : `server started ${age(now - aUnit.since)} ago, current with the tree`, "systemctl --user restart gm-tools");
}

// 3. Bridge
const bUnit = unit("gm-tools-bridge.service");
if (!world) add("bridge", false, "Bridge", "no world configured (set WF_WORLD or pass --world)");
else {
  const live = bridgeLiveness(world, now);
  const s = live.state;
  let detail;
  if (live.connected) detail = `connected to "${world}" as ${s.user} (${s.mode}), heartbeat ${age(live.ageMs)} ago` + (s.leader === false ? "; NOT the client applying changes" : "") + (s.otherGMs?.length ? `; other GM clients: ${s.otherGMs.join(", ")}` : "") + (s.players?.length ? `; players: ${s.players.join(", ")}` : "");
  else if (!s) detail = "never connected (no heartbeat on record)";
  else if (live.pidAlive === false) detail = `not connected: the client process (pid ${s.pid}) is gone`;
  else detail = `not connected: last heartbeat ${age(live.ageMs)} ago, state "${s.state}"` + (s.error ? `, ${s.error}` : "");
  add("bridge", live.connected && s.leader !== false, "Bridge", detail, bUnit.installed ? "systemctl --user restart gm-tools-bridge   (log: journalctl --user -u gm-tools-bridge -n 40)" : "ops/install-services.sh --start");

  // 4. Index age
  const ip = dataDir ? foundryIndexPath(dataDir, world) : null;
  let exportedAt = null;
  try { exportedAt = JSON.parse(readFileSync(ip, "utf8")).exportedAt ?? null; } catch { /* none */ }
  const iAge = exportedAt ? now - Date.parse(exportedAt) : null;
  add("index", iAge != null && iAge < 5 * 60e3, "Index", exportedAt ? `exported ${age(iAge)} ago` : "never exported", "it refreshes every 2 minutes while the bridge is connected; fix the bridge line first");

  // 5. Queues
  const ops = dataDir ? readArr(foundryOpsPath(dataDir, world)) : null;
  const mutPath = dataDir ? join(dataDir, "worlds", world, "world-fabric-mutations.json") : null;
  const muts = mutPath && existsSync(mutPath) ? readArr(mutPath) : [];
  const results = dataDir && existsSync(foundryResultsPath(dataDir, world)) ? readArr(foundryResultsPath(dataDir, world)) : [];
  const opsN = ops?.length ?? 0, mutN = muts?.length ?? 0, resN = results?.length ?? 0;
  let opsAge = null;
  try { if (opsN) opsAge = now - statSync(foundryOpsPath(dataDir, world)).mtimeMs; } catch { /* gone */ }
  const stuck = (opsN > 0 && (!live.connected || opsAge > 120e3)) || (mutN > 0 && !live.connected);
  add("queue", !stuck, "Queue", `${opsN} Foundry op(s) waiting${opsN ? ` for ${age(opsAge)}` : ""}, ${mutN} graph mutation(s) waiting, ${resN} result(s) not yet collected`, "nothing drains the queue without a connected bridge; fix the bridge line first");
}

// 6. Boot
const linger = sh("loginctl", ["show-user", process.env.USER ?? "", "-p", "Linger", "--value"]);
const units = [fUnit, aUnit, bUnit];
const allInstalled = units.every((u) => u.installed), allEnabled = units.every((u) => u.enabled), allActive = units.every((u) => u.active);
add("services", allInstalled && allEnabled && allActive && linger === "yes", "Services",
  !allInstalled ? `not installed: ${units.filter((u) => !u.installed).map((u) => u.name).join(", ")}`
    : `${units.map((u) => `${u.name.replace(".service", "")} ${u.state}${u.restarts ? ` (${u.restarts} restarts)` : ""}`).join(", ")}; start at ${linger === "yes" ? "boot" : "login only (lingering is off)"}`,
  !allInstalled || !allEnabled ? "ops/install-services.sh --start" : linger !== "yes" ? `sudo loginctl enable-linger ${process.env.USER}` : "systemctl --user status foundry gm-tools gm-tools-bridge");

// 7. Campaign repos. Advisory: uncommitted campaign data is normal mid-prep, never a failure.
for (const [w, dir] of Object.entries(listCampaigns())) {
  if (!existsSync(dir)) { add(`campaign-${w}`, false, `Campaign ${w}`, `registered at ${dir}, which does not exist`, "fix the entry in ~/.config/gm-tools/campaigns.json"); continue; }
  const branch = sh("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
  const changed = sh("git", ["-C", dir, "status", "--porcelain", "--untracked-files=all", "--", "data"]).split("\n").filter(Boolean).length;
  add(`campaign-${w}`, true, `Campaign ${w}`, branch ? `${dir}, branch ${branch}, ${changed ? `${changed} uncommitted file(s) under data/` : "data/ committed"}` : `${dir} (not a git repo)`);
}

const healthy = rows.every((r) => r.ok);
if (asJson) console.log(JSON.stringify({ healthy, world, checkedAt: new Date(now).toISOString(), checks: rows }, null, 2));
else {
  const w = Math.max(...rows.map((r) => r.label.length));
  for (const r of rows) {
    console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.label.padEnd(w)}  ${r.detail}`);
    if (r.fix) console.log(`      ${" ".repeat(w)}  -> ${r.fix}`);
  }
  console.log(healthy ? "\nAll good. Pushes will apply within a few seconds." : "\nNot healthy. Fix the first FAIL line; later ones usually follow from it.");
}
process.exit(healthy ? 0 : 1);
