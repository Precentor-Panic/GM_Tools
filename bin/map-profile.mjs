// Profile maps from their walls (map-plan/profile.mjs).
//   bin/map-profile <file.dd2vtt>[=<layout.json>]... [--svg <dir>] [--out f.jsonl] [--look-job f.jsonl]
//                                                              one line per map: { id, name, profile, theme }; a Dungeondraft
//                                                              layout spec after "=" adds the map's objects as items
//   bin/map-profile --scenes <dir> [--out <file.jsonl>] [--look-job <file.jsonl>]   every walled scene in
//                                                              <dir>/**/scenes.json (Foundry scene docs), one line each:
//                                                              { id, pack, name, profile, theme }
//   --look-job writes what map-plan/tools/look.py needs to look at each map's picture (scenes with a local image only)
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
import { themeFromText } from "../map-plan/theme.mjs";
import { lookJob } from "../map-plan/look.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const svgDir = opt("--svg"), scenesDir = opt("--scenes"), out = opt("--out"), bench = opt("--bench"), k = Number(opt("--k", 5));
const jobOut = opt("--look-job");
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

const writeLines = (path, lines) => { mkdirSync(dirname(resolve(path)), { recursive: true }); writeFileSync(path, lines.join("\n") + (lines.length ? "\n" : "")); };

if (scenesDir) {
  if (out) assertUntracked(out);
  if (jobOut) assertUntracked(jobOut);
  const lines = [], jobs = [];
  let n = 0, skipped = 0;
  const t0 = Date.now();
  for (const f of sceneFiles(scenesDir)) {
    const pack = basename(dirname(f));
    const d = JSON.parse(readFileSync(f, "utf8"));
    for (const s of Array.isArray(d) ? d : Object.values(d)) {
      if (!s?.walls?.length) continue;
      try {
        const plan = fromFoundryScene(s, { pack }), id = `${pack}/${s._id}`;
        lines.push(JSON.stringify({ id, pack, name: s.name, profile: profile(plan), theme: themeFromText(`${pack} ${s.name}`), src: { scenes: resolve(f), _id: s._id } }));
        n++;
        // The scene's own copy of its picture, if this machine holds one (wall research layout: <root>/extra/<pack>/...).
        const img = [s.localImg && resolve(dirname(resolve(scenesDir)), s.localImg)].find((p) => p && existsSync(p));
        if (jobOut && img) {
          const g = typeof s.grid === "object" ? s.grid.size : s.grid;
          jobs.push(JSON.stringify(lookJob(plan, analyse(plan), { id, img, gridPx: g, sceneW: s.width, sceneH: s.height })));
        }
      } catch (e) { skipped++; if (skipped <= 5) console.error(`skip ${pack}/${s._id}: ${e.message}`); }
    }
  }
  if (out) writeLines(out, lines); else console.log(lines.join("\n"));
  if (jobOut) writeLines(jobOut, jobs);
  console.error(`profiled ${n} scene(s), skipped ${skipped}, ${jobs.length} with a local picture, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
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
  const lines = [], jobs = [];
  for (const arg of args) {
    const [f, layout] = arg.split("=");
    const d = JSON.parse(readFileSync(f, "utf8"));
    let plan = fromDd2vtt(d, { name: basename(f), ref: f });
    let name = basename(f).replace(/\.dd2vtt$/, "");
    if (layout) {
      // The layout spec's objects, in squares on the same grid: what was placed in each room.
      const spec = JSON.parse(readFileSync(layout, "utf8"));
      name = spec.name ?? name;
      plan = { ...plan, items: (spec.objects ?? []).filter((o) => Number.isFinite(o.x)).map((o) => ({ what: o.asset, x: o.x, y: o.y, ...(o.size ? { size: o.size } : {}) })) };
    }
    const A = analyse(plan), id = basename(f).replace(/\.dd2vtt$/, "");
    lines.push(JSON.stringify({ id, name, profile: profile(plan), theme: themeFromText(name), src: { dd2vtt: resolve(f), ...(layout ? { layout: resolve(layout) } : {}) } }));
    if (jobOut) jobs.push(JSON.stringify(lookJob(plan, A, { id, dd2vtt: resolve(f), gridPx: d.resolution.pixels_per_grid, sceneW: d.resolution.map_size.x * d.resolution.pixels_per_grid, sceneH: d.resolution.map_size.y * d.resolution.pixels_per_grid })));
    if (svgDir) writeFileSync(join(svgDir, `${id}.svg`), planSvg(plan, { analysis: A, title: basename(f) }));
  }
  if (out) writeLines(out, lines); else console.log(lines.join("\n"));
  if (jobOut) writeLines(jobOut, jobs);
}
