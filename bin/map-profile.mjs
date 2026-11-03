// Profile maps from their walls (map-plan/profile.mjs).
//   bin/map-profile <file.dd2vtt>... [--svg <dir>]            print one profile per map; --svg writes a preview each
//   bin/map-profile --scenes <dir> [--out <file.jsonl>]        every walled scene in <dir>/**/scenes.json (Foundry scene
//                                                              docs), one JSON line each: { id, pack, name, profile }
//   bin/map-profile --bench <profiles.jsonl> [--k 5] [--shape-only]   the closest maps to each benchmark brief, narrowed
//                                                              by the brief's theme words unless --shape-only
// Profiles of published maps are derived from someone else's product: write them under stagecraft/ (ignored) or
// outside the repo, never into a tracked file. --out refuses a path git would track.
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fromDd2vtt, fromFoundryScene } from "../map-plan/readers.mjs";
import { profile, analyse } from "../map-plan/profile.mjs";
import { nearest } from "../map-plan/similar.mjs";
import { planSvg } from "../map-plan/svg.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const svgDir = opt("--svg"), scenesDir = opt("--scenes"), out = opt("--out"), bench = opt("--bench"), k = Number(opt("--k", 5));
const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..");

function assertUntracked(path) {
  const abs = resolve(path);
  if (!abs.startsWith(REPO + "/")) return;
  try { execFileSync("git", ["-C", REPO, "check-ignore", "-q", abs]); }
  catch { throw new Error(`${path} is inside the repo and not ignored. Write published-map profiles under stagecraft/ or outside the repo.`); }
}

function* sceneFiles(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* sceneFiles(p);
    else if (e === "scenes.json") yield p;
  }
}

if (scenesDir) {
  if (out) assertUntracked(out);
  const lines = [];
  let n = 0, skipped = 0;
  const t0 = Date.now();
  for (const f of sceneFiles(scenesDir)) {
    const pack = basename(dirname(f));
    const d = JSON.parse(readFileSync(f, "utf8"));
    for (const s of Array.isArray(d) ? d : Object.values(d)) {
      if (!s?.walls?.length) continue;
      try {
        const plan = fromFoundryScene(s, { pack });
        lines.push(JSON.stringify({ id: `${pack}/${s._id}`, pack, name: s.name, profile: profile(plan) }));
        n++;
      } catch (e) { skipped++; if (skipped <= 5) console.error(`skip ${pack}/${s._id}: ${e.message}`); }
    }
  }
  if (out) { mkdirSync(dirname(resolve(out)), { recursive: true }); writeFileSync(out, lines.join("\n") + "\n"); }
  else console.log(lines.join("\n"));
  console.error(`profiled ${n} scene(s), skipped ${skipped}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
} else if (bench) {
  const rows = readFileSync(bench, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const { briefs } = JSON.parse(readFileSync(join(REPO, "map-plan/bench/briefs.json"), "utf8"));
  for (const b of briefs) {
    // Narrow by theme words in the pack and scene names when the brief has them, then rank by character. One hit per
    // layout: variants of one map (same pack, same wall count) share their walls.
    const re = b.words?.length ? new RegExp(`\\b(${b.words.join("|")})`, "i") : null;
    const pool = re && !args.includes("--shape-only") ? rows.filter((r) => re.test(`${r.pack} ${r.name}`)) : rows;
    const seen = new Set();
    const hits = nearest(b.want, pool, pool.length).filter((h) => {
      const key = `${h.pack}:${h.profile.walls.length}`;
      if (seen.has(key)) return false; seen.add(key); return true;
    }).slice(0, k);
    console.log(`${b.id} [${pool.length}]: ${hits.map((h) => `${h.id} (${h.score})`).join(", ")}`);
  }
} else {
  if (!args.length) { console.error("usage: bin/map-profile <file.dd2vtt>... [--svg <dir>] | --scenes <dir> [--out f.jsonl] | --bench <f.jsonl>"); process.exit(2); }
  if (svgDir && !existsSync(svgDir)) mkdirSync(svgDir, { recursive: true });
  for (const f of args) {
    const plan = fromDd2vtt(JSON.parse(readFileSync(f, "utf8")), { name: basename(f), ref: f });
    const A = analyse(plan);
    console.log(JSON.stringify({ id: basename(f).replace(/\.dd2vtt$/, ""), profile: profile(plan) }));
    if (svgDir) writeFileSync(join(svgDir, basename(f).replace(/\.dd2vtt$/, ".svg")), planSvg(plan, { analysis: A, title: basename(f) }));
  }
}
