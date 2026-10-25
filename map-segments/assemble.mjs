// Composition + segments -> the tiles and walls of one scene (pure; no fs, no Foundry).
//
// One tile per piece (its art), the pieces' own walls offset into place, and
// generated walls along every piece edge EXCEPT the composition's openings, so
// two pieces only connect where the composition says they do. A door opening
// gets a door wall (ds 2 when locked). Every opening is checked against the
// tagged exits of each piece it touches: a door into solid art is a mistake.
//
// Output tiles are in the bridge's wire shape (top-left x/y in pixels);
// set_scene_layout converts to Foundry's centre anchor.
import { Composition, Segment } from "./composition.mjs";

const EDGE_WALL = { light: 20, move: 20, sight: 20, sound: 20 };
const SEAM_SRC = "gm-tools-assets/segments/_common";

export function mergeIntervals(iv) {
  const out = [];
  for (const [a, b] of [...iv].sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
    if (out.length && a <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  }
  return out;
}

export function subtractIntervals(iv, cuts) {
  let cur = iv.map(([a, b]) => [a, b]);
  for (const [ca, cb] of cuts) {
    const next = [];
    for (const [a, b] of cur) {
      if (cb <= a || ca >= b) { next.push([a, b]); continue; }
      if (a < ca) next.push([a, ca]);
      if (cb < b) next.push([cb, b]);
    }
    cur = next;
  }
  return cur;
}

/**
 * @param {object} compositionInput  a composition (validated here)
 * @param {(segmentId: string, library: string) => object} loadSegment  returns that segment's segment.json
 * @returns {{name, width, height, gridSize, backgroundColor, tiles, walls, problems, pieces}}
 */
export function assembleComposition(compositionInput, loadSegment) {
  const comp = Composition.parse(compositionInput);
  const G = comp.gridSize;
  const tiles = [], walls = [], problems = [], pieces = {};
  const lines = new Map(); // "h:12" -> [[a,b]] in squares
  const addLine = (k, iv) => { if (!lines.has(k)) lines.set(k, []); lines.get(k).push(iv); };

  comp.pieces.forEach((p, i) => {
    const lib = p.library ?? comp.library;
    const seg = Segment.parse(loadSegment(p.segment, lib));
    const theme = comp.theme && seg.themes?.[comp.theme] ? comp.theme : null;
    const variants = theme ? seg.themes[theme].variants : seg.variants;
    if (!variants[p.variant]) throw new Error(`piece ${p.key}: segment ${p.segment} has no variant "${p.variant}"${theme ? ` in theme ${theme}` : ""}`);
    if (seg.gridSize !== G) throw new Error(`piece ${p.key}: segment ${p.segment} is ${seg.gridSize} px per square, the composition ${G}`);
    const [ax, ay] = p.at, w = seg.widthSquares, h = seg.heightSquares;
    if (ax < 0 || ay < 0 || ax + w > comp.widthSquares || ay + h > comp.heightSquares) problems.push(`${p.key}: piece runs off the ${comp.widthSquares}x${comp.heightSquares} map`);
    const path = (f) => `${lib}/${p.segment}/${f}`;
    pieces[p.key] = { segment: p.segment, at: [ax, ay], widthSquares: w, heightSquares: h, variants: Object.fromEntries(Object.entries(variants).map(([k, f]) => [k, path(f)])) };
    tiles.push({ key: `piece:${p.key}`, src: path(variants[p.variant]), x: ax * G, y: ay * G, width: w * G, height: h * G, sort: i });
    for (const sw of seg.walls) {
      const { c, cut, ...rest } = sw;
      walls.push({ ...rest, key: `seg:${p.key}`, c: [c[0] + ax * G, c[1] + ay * G, c[2] + ax * G, c[3] + ay * G] });
    }
    addLine(`h:${ay}`, [ax, ax + w]); addLine(`h:${ay + h}`, [ax, ax + w]);
    addLine(`v:${ax}`, [ay, ay + h]); addLine(`v:${ax + w}`, [ay, ay + h]);
    if (comp.seams) {
      const t = Math.round(comp.seams.width * G), X = ax * G, Y = ay * G, W = w * G, H = h * G;
      for (const [side, x, y, sw2, sh] of [["n", X, Y, W, t], ["s", X, Y + H - t, W, t], ["w", X, Y, t, H], ["e", X + W - t, Y, t, H]]) {
        tiles.push({ key: `seam:${p.key}${side}`, src: `${SEAM_SRC}/seam-${side}.png`, x, y, width: sw2, height: sh, alpha: comp.seams.alpha, sort: 1000 });
      }
    }
  });

  // Openings must sit inside a tagged exit on every piece edge they touch.
  for (const o of comp.openings) {
    let touching = 0;
    for (const p of comp.pieces) {
      const pc = pieces[p.key], [ax, ay] = pc.at;
      const seg = loadSegment(p.segment, p.library ?? comp.library);
      const sides = o.line === "v" ? { w: ax, e: ax + pc.widthSquares } : { n: ay, s: ay + pc.heightSquares };
      const [lo, hi, off] = o.line === "v" ? [ay, ay + pc.heightSquares, ay] : [ax, ax + pc.widthSquares, ax];
      for (const [side, at] of Object.entries(sides)) {
        if (at !== o.at || o.from < lo || o.to > hi) continue;
        touching++;
        const via = o.via ?? "walk";
        const ok = (seg.edges?.[side] ?? []).some((e) => (via === "any" || e.kind === via) && e.from <= o.from - off && o.to - off <= e.to);
        if (!ok) problems.push(`${o.id}: no tagged ${via} exit on ${p.key} (${p.segment}) side ${side} at ${o.from - off}-${o.to - off}`);
      }
    }
    if (!touching) problems.push(`${o.id}: touches no piece edge`);
  }

  const cuts = new Map();
  for (const o of comp.openings) { const k = `${o.line}:${o.at}`; if (!cuts.has(k)) cuts.set(k, []); cuts.get(k).push([o.from, o.to]); }
  for (const [k, iv] of lines) {
    const [kind, atS] = k.split(":"); const at = Number(atS);
    for (const [a, b] of subtractIntervals(mergeIntervals(iv), cuts.get(k) ?? [])) {
      walls.push({ ...EDGE_WALL, key: "edge", c: kind === "h" ? [a * G, at * G, b * G, at * G] : [at * G, a * G, at * G, b * G] });
    }
  }
  for (const o of comp.openings) {
    if (o.kind !== "door") continue;
    walls.push({ ...EDGE_WALL, key: `door:${o.id}`, door: 1, ds: o.locked ? 2 : 0,
      c: o.line === "h" ? [o.from * G, o.at * G, o.to * G, o.at * G] : [o.at * G, o.from * G, o.at * G, o.to * G] });
  }
  for (const ov of comp.overlays) {
    const pc = pieces[ov.piece];
    tiles.push({ key: `overlay:${ov.key}`, src: ov.src, x: pc.at[0] * G, y: pc.at[1] * G, width: pc.widthSquares * G, height: pc.heightSquares * G, alpha: ov.alpha, sort: ov.sort });
  }
  return { name: comp.name, width: comp.widthSquares * G, height: comp.heightSquares * G, gridSize: G, backgroundColor: comp.backgroundColor, tiles, walls, problems, pieces, puzzle: comp.puzzle ?? null };
}

/** The set_scene_layout op data for an assembled scene. */
export function layoutOpData(sceneUuid, assembled) {
  return {
    sceneUuid, width: assembled.width, height: assembled.height, padding: 0, gridSize: assembled.gridSize,
    background: { src: null, color: assembled.backgroundColor },
    tiles: assembled.tiles, walls: assembled.walls,
    puzzle: assembled.puzzle // null clears a puzzle the scene had
  };
}
