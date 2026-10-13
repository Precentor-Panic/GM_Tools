#!/usr/bin/env node
/**
 * Moves a world's campaign stores out of this checkout and into the world's
 * campaign repo, under `<campaignDir>/data/`, and registers the campaign so
 * every GM_Tools process reads and writes them there.
 *
 *   bin/campaign-adopt --world aureus --dir /path/to/campaign-repo            # report only
 *   bin/campaign-adopt --world aureus --dir /path/to/campaign-repo --apply
 *
 * --apply copies each store, checks the copy byte for byte, renames the
 * original to `*.migrated-<date>` (kept as the way back), then writes the
 * registry entry. It refuses while the app server is answering (stop it
 * first: a write landing mid-copy would be lost), and it refuses a store whose
 * destination already holds different data.
 *
 * It does not commit. Committing the campaign repo is the GM's call.
 * To undo: remove the world from the registry file and rename the
 * `*.migrated-<date>` files back.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CAMPAIGN_STORES, CAMPAIGN_DATA_DIRNAME, campaignRegistryPath, listCampaigns } from "../mutation-engine/campaign-home.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const flag = (name) => argv.includes(name);

const world = opt("--world");
if (!world || !/^[A-Za-z0-9_-]+$/.test(world)) { console.error("--world <id> is required"); process.exit(2); }
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const legacyBase = opt("--legacy-root", repo);
const registered = listCampaigns()[world] ?? null;
const dir = opt("--dir") ?? registered;
if (!dir) { console.error(`"${world}" is not registered: pass --dir <campaign repo folder>`); process.exit(2); }
if (!isAbsolute(dir) || !existsSync(dir) || !statSync(dir).isDirectory()) { console.error(`--dir must be an existing absolute folder: ${dir}`); process.exit(2); }
if (registered && registered !== dir) { console.error(`"${world}" is already registered at ${registered}`); process.exit(2); }
const apply = flag("--apply");
const base = opt("--base", `http://localhost:${process.env.REVIEW_UI_PORT ?? "8787"}`);
const dataDir = join(dir, CAMPAIGN_DATA_DIRNAME);
const stamp = new Date().toISOString().slice(0, 10);

/** Every data file under a path (a file, or a folder walked), relative to it; lock files skipped. */
function filesUnder(path) {
  if (statSync(path).isFile()) return [""];
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (!name.endsWith(".lock")) out.push(relative(path, p));
    }
  };
  walk(path);
  return out;
}
const sameBytes = (a, b) => existsSync(b) && readFileSync(a).equals(readFileSync(b));
const size = (path) => filesUnder(path).reduce((n, f) => n + statSync(join(path, f)).size, 0);
const kb = (n) => n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;

const rows = CAMPAIGN_STORES.map(({ store, kind }) => {
  const src = kind === "file" ? join(legacyBase, store, `${world}.json`) : join(legacyBase, store, world);
  const dest = kind === "file" ? join(dataDir, `${store}.json`) : join(dataDir, store);
  if (!existsSync(src)) return { store, kind, src, dest, state: existsSync(dest) ? "adopted" : "empty" };
  const files = filesUnder(src);
  if (!existsSync(dest)) return { store, kind, src, dest, files, state: "move" };
  const same = files.every((f) => sameBytes(join(src, f), join(dest, f)));
  return { store, kind, src, dest, files, state: same ? "finish" : "conflict" };
});

const label = { move: "move", finish: "copied, original not yet set aside", conflict: "CONFLICT: destination holds different data", adopted: "already in the campaign repo", empty: "no data" };
console.log(`${world} -> ${dataDir}${apply ? "" : "   (report only; --apply to do it)"}`);
for (const r of rows) {
  const detail = r.files ? `${r.files.length} file${r.files.length === 1 ? "" : "s"}, ${kb(size(r.src))}` : "";
  console.log(`  ${r.store.padEnd(22)} ${label[r.state]}${detail ? `  (${detail})` : ""}`);
}
const conflicts = rows.filter((r) => r.state === "conflict");
if (conflicts.length) {
  console.error(`\nStopped: ${conflicts.map((r) => r.dest).join(", ")} differ from the originals. Nothing was changed.`);
  process.exit(1);
}
const todo = rows.filter((r) => r.state === "move" || r.state === "finish");
if (!apply) {
  if (!registered) console.log(`\nThe apply will also register "${world}" in ${campaignRegistryPath()}.`);
  process.exit(0);
}

let serverUp = false;
try { serverUp = (await fetch(`${base}/`, { signal: AbortSignal.timeout(2000) })).status > 0; } catch { /* not answering */ }
if (serverUp && !flag("--while-running")) {
  console.error(`\nStopped: the app server is answering at ${base}. Stop it first (systemctl --user stop gm-tools), run this again, then start it.`);
  process.exit(1);
}

mkdirSync(dataDir, { recursive: true });
const ignorePath = join(dataDir, ".gitignore");
if (!existsSync(ignorePath)) writeFileSync(ignorePath, "# Write locks GM_Tools holds for the length of one save.\n*.lock\n", "utf8");

for (const r of todo) {
  for (const f of r.files) {
    const from = join(r.src, f), to = join(r.dest, f);
    mkdirSync(dirname(to), { recursive: true });
    if (!existsSync(to)) cpSync(from, to, { preserveTimestamps: true });
    if (!sameBytes(from, to)) { console.error(`\nStopped: ${to} does not match ${from} after the copy. Originals untouched from here on.`); process.exit(1); }
  }
}
// Only once every copy is verified are the originals set aside.
for (const r of todo) renameSync(r.src, `${r.src}.migrated-${stamp}`);

const registryPath = campaignRegistryPath();
let registry = {};
try { registry = JSON.parse(readFileSync(registryPath, "utf8")); } catch { /* none yet */ }
if (registry[world] !== dir) {
  registry[world] = dir;
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n", "utf8");
}
console.log(`\nDone: ${todo.length} store${todo.length === 1 ? "" : "s"} now in ${dataDir}; originals kept as *.migrated-${stamp}.`);
console.log(`"${world}" is registered in ${registryPath}. Start the app server, then review and commit the campaign repo.`);
