// Make a map plan from a recipe and a seed (map-plan/makers). Deterministic: the same recipe and seed make the same map.
//   bin/map-make <recipe> [--seed N] [--out plan.json] [--svg preview.svg] [--brief <brief id>] [--mirror|--no-mirror] [--turn 0-3]
//   bin/map-make --list
// Prints the map's character (rooms, loops, how square or organic its walls are) and, with --brief, how far it sits
// from that benchmark brief's ranges (0 = inside every one). Pictures come from a renderer: the Dungeondraft tooling
// builds one from the plan (outside this repo).
import { writeFileSync, readFileSync } from "node:fs";
import { RECIPES, make } from "../map-plan/makers/index.mjs";
import { profile } from "../map-plan/profile.mjs";
import { briefScore } from "../map-plan/similar.mjs";
import { planSvg } from "../map-plan/svg.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
if (args.includes("--list") || !args.length) { console.log(Object.keys(RECIPES).join("\n")); process.exit(0); }
const seed = Number(opt("--seed", 1)), out = opt("--out"), svg = opt("--svg"), briefId = opt("--brief"), turn = opt("--turn");
const o = {};
if (args.includes("--mirror")) o.mirror = true;
if (args.includes("--no-mirror")) o.mirror = false;
if (turn != null) o.turn = Number(turn);
const name = args.find((a) => !a.startsWith("--"));
const { trace, links, regions, ...plan } = make(name, o, seed);
const p = profile(plan);
const pct = (v) => `${Math.round(v * 100)}%`;
console.log(`${plan.name} (${name}, seed ${seed}): ${plan.width} x ${plan.height} squares`);
console.log(`  rooms ${p.rooms.count} (${Object.entries(p.rooms.bands).filter(([, n]) => n).map(([b, n]) => `${n} ${b}`).join(", ")}); loops ${p.graph.loops}; doors out ${p.graph.doorsOut}`);
console.log(`  walls ${pct(p.walls.squareness)} square, ${pct(p.walls.diagonal)} diagonal, ${pct(p.walls.organic)} organic; ${pct(p.enclosure)} indoors`);
console.log(`  ${plan.items.length} things placed, ${plan.lights.length} lights`);
if (briefId) {
  const b = JSON.parse(readFileSync(new URL("../map-plan/bench/briefs.json", import.meta.url), "utf8")).briefs.find((x) => x.id === briefId);
  if (!b) throw new Error(`no brief ${briefId}`);
  console.log(`  brief ${briefId}: ${briefScore(p, b.want).toFixed(2)} from its ranges`);
}
if (out) writeFileSync(out, JSON.stringify(plan));
if (svg) writeFileSync(svg, planSvg(plan, { px: 16 }));
