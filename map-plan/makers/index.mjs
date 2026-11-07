// The makers, by name. make(name, opts, seed) returns a plan (plan.mjs) with the maker's own extras attached
// (trace, links, regions). The cave maker takes a chamber spec; RIVER_CAVE is the benchmark's.
import { makeTavern } from "./tavern.mjs";
import { makeTemple } from "./temple.mjs";
import { makeFort } from "./fort.mjs";
import { makeSewer } from "./sewer.mjs";
import { makeCave } from "./cave.mjs";

/** The benchmark's river cave: a mouth off the west edge, a hall, a river chamber under a ledge, a den, a loop back. */
export const RIVER_CAVE = {
  name: "River cave", width: 44, height: 30,
  chambers: [{ id: "mouth", at: [5, 17], r: 3.6 }, { id: "hall", at: [15, 14], r: 6.2 }, { id: "river", at: [30, 11], r: 6.8 },
    { id: "den", at: [33, 23], r: 3.8 }, { id: "shrine", at: [40, 5], r: 3 }],
  passages: [{ a: [-4, 18], b: "mouth", width: 4.5, wind: 0.2 }, { a: "mouth", b: "hall", width: 3.8 }, { a: "hall", b: "river", width: 3.4 },
    { a: "river", b: "shrine", width: 2.2, wind: 0.7 }, { a: "river", b: "den", width: 2.6 }, { a: "den", b: "hall", width: 2.1, wind: 0.6, via: [[24, 23.5], [17, 21.5]] }],
  river: { through: [[32, 3], [30, 10], [28.5, 17]], width: 2.6, depth: "deep", ford: [29.6, 12.4] },
  ledges: [{ chamber: "river", toward: [38, 12], height: 10, ramp: [34, 17], at: 0.45 }],
  pillars: [{ at: [13.5, 12], r: 0.9 }, { at: [17.5, 16.5], r: 0.7 }, { at: [26.5, 7.5], r: 0.8 }],
  camp: "den",
  // The shrine: a statue and candles at the end of the side passage.
  items: [{ what: "statue", x: 40.3, y: 4.6, size: 2, rotation: 180 }, { what: "candles", x: 39.1, y: 5.7, size: 0.7 }, { what: "candles", x: 41.5, y: 5.7, size: 0.7 }],
  lights: [{ x: 40.3, y: 5.8, bright: 0.5, dim: 3, color: "#ffd890" }],
};

export const RECIPES = {
  tavern: (o, s) => makeTavern(o, s),
  temple: (o, s) => makeTemple(o, s),
  fort: (o, s) => makeFort(o, s),
  sewer: (o, s) => makeSewer(o, s),
  cave: (o, s) => { const { plan } = makeCave({ ...RIVER_CAVE, ...o }, s); return plan; },
};

export function make(name, opts = {}, seed = 1) {
  const f = RECIPES[name];
  if (!f) throw new Error(`no maker ${name} (have ${Object.keys(RECIPES).join(", ")})`);
  return f(opts, seed);
}
