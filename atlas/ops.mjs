/**
 * Atlas edit ops. Pure: `applyOps(atlas, ops, opts)` returns a changed copy and one result per op; the store writes
 * it (`applyAtlasOps` below wraps both, under the store's lock, and keeps one undo slot).
 *
 * Ops address ids, so two editors don't need each other's revision. Kinds:
 *   add-node | update-node | move-node | remove-node        (remove cascades the node's passages; the result lists them)
 *   add-edge | update-edge | remove-edge
 *   add-area | update-area | remove-area
 *   add-section | update-section | remove-section
 *   accept {ids}         clear `draft` on places, passages, areas (the GM's acceptance)
 *   radial-remap {bands} grow or shrink the city: every radius in a band maps linearly to the new band
 *
 * `opts.draftNew` marks every add as a draft (Claude's additions, plan §8 q-drafts). Moves are trusted.
 */
import { polar, fromPolar } from "./geometry.mjs";
import { updateAtlas, loadAtlas, atlasDir } from "./store.mjs";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const LISTS = { node: "nodes", edge: "edges", area: "areas", section: "sections" };

function find(atlas, list, id) {
  const x = atlas[list].find((r) => r.id === id);
  if (!x) throw new Error(`no ${list.slice(0, -1)} "${id}"`);
  return x;
}

/** Map one radius through piecewise-linear bands [{from:[r0,r1], to:[r0,r1]}]; outside every band, unchanged. */
export function remapRadius(r, bands) {
  for (const b of bands) {
    const [a0, a1] = b.from, [b0, b1] = b.to;
    if (r >= a0 && r <= a1) return b0 + ((r - a0) / (a1 - a0 || 1)) * (b1 - b0);
  }
  return r;
}

function remapPoint(p, bands, centre) {
  const pp = polar(p, centre);
  const q = fromPolar(remapRadius(pp.r, bands), pp.th, centre);
  return { x: Math.round(q.x), y: Math.round(q.y) };
}

function applyOne(atlas, op, opts) {
  const draft = opts.draftNew ? { draft: true } : {};
  switch (op.op) {
    case "add-node": case "add-edge": case "add-area": case "add-section": {
      const list = LISTS[op.op.slice(4)];
      if (atlas[list].some((r) => r.id === op.data.id)) throw new Error(`"${op.data.id}" already exists`);
      atlas[list].push({ ...op.data, ...(list === "sections" ? {} : draft) });
      return { added: op.data.id };
    }
    case "update-node": case "update-edge": case "update-area": case "update-section": {
      const x = find(atlas, LISTS[op.op.slice(7)], op.id);
      for (const [k, v] of Object.entries(op.patch || {})) {
        if (k === "id") throw new Error("ids can't be changed");
        if (v === null) delete x[k]; else x[k] = v;
      }
      return { updated: op.id };
    }
    case "move-node": {
      const n = find(atlas, "nodes", op.id);
      const at = op.r !== undefined ? fromPolar(op.r, op.th, atlas.frame.centre) : { x: op.x, y: op.y };
      n.x = Math.round(at.x); n.y = Math.round(at.y);
      if (op.depth !== undefined) n.depth = op.depth;
      return { moved: op.id, x: n.x, y: n.y };
    }
    case "remove-node": {
      find(atlas, "nodes", op.id);
      const gone = atlas.edges.filter((e) => e.from === op.id || e.to === op.id).map((e) => e.id);
      atlas.nodes = atlas.nodes.filter((n) => n.id !== op.id);
      atlas.edges = atlas.edges.filter((e) => !gone.includes(e.id));
      return { removed: op.id, alsoRemoved: gone };
    }
    case "remove-edge": case "remove-area": case "remove-section": {
      const list = LISTS[op.op.slice(7)];
      find(atlas, list, op.id);
      atlas[list] = atlas[list].filter((r) => r.id !== op.id);
      return { removed: op.id };
    }
    case "accept": {
      const done = [];
      for (const list of ["nodes", "edges", "areas"]) for (const x of atlas[list]) if (op.ids.includes(x.id) && x.draft) { delete x.draft; done.push(x.id); }
      return { accepted: done };
    }
    case "radial-remap": {
      const c = atlas.frame.centre;
      for (const n of atlas.nodes) Object.assign(n, remapPoint(n, op.bands, c));
      for (const e of atlas.edges) if (e.path) e.path = e.path.map((p) => remapPoint(p, op.bands, c));
      for (const a of atlas.areas) {
        const s = a.shape;
        if (s.type === "circle") s.r = Math.round(remapRadius(s.r, op.bands));
        else if (s.type === "annulus" || s.type === "sector") { s.r0 = Math.round(remapRadius(s.r0, op.bands)); s.r1 = Math.round(remapRadius(s.r1, op.bands)); }
        else if (s.type === "polygon") s.points = s.points.map((p) => remapPoint(p, op.bands, c));
      }
      for (const s of atlas.sections) {
        // Sections keep their size (they're battle maps); their centre moves with the ground under it.
        const w = s.sizeSq.w * 5, h = s.sizeSq.h * 5;
        const mid = remapPoint({ x: s.origin.x + w / 2, y: s.origin.y + h / 2 }, op.bands, c);
        s.origin = { x: mid.x - w / 2, y: mid.y - h / 2 };
      }
      const outer = Math.max(...op.bands.map((b) => b.to[1]));
      const fb = atlas.frame.bounds, half = Math.max(Math.abs(fb[0]), Math.abs(fb[2]), outer * 1.12);
      atlas.frame.bounds = [-half, -half, half, half];
      return { remapped: atlas.nodes.length };
    }
    default:
      throw new Error(`unknown op "${op.op}"`);
  }
}

export function applyOps(atlas, ops, opts = {}) {
  const out = structuredClone(atlas);
  const results = ops.map((op) => applyOne(out, op, opts));
  return { atlas: out, results };
}

const undoPath = (world, id) => join(atlasDir(world), `${id}.undo.json`);

/** Apply ops under the store's lock and keep the previous version as the one undo slot. */
export function applyAtlasOps(world, id, ops, opts = {}) {
  let results;
  const { atlas, before } = updateAtlas(world, id, (a) => {
    const r = applyOps(a, ops, opts);
    results = r.results;
    return r.atlas;
  });
  writeFileSync(undoPath(world, id), JSON.stringify({ revision: atlas.revision, before }), "utf8");
  return { atlas, results };
}

/** Put back the version before the last applyAtlasOps, if nothing has been written since. */
export function undoAtlasOps(world, id) {
  const p = undoPath(world, id);
  if (!existsSync(p)) throw new Error("nothing to undo");
  const { revision, before } = JSON.parse(readFileSync(p, "utf8"));
  const cur = loadAtlas(world, id);
  if (cur.revision !== revision) throw new Error(`the atlas has changed since (revision ${cur.revision}, undo was for ${revision})`);
  const { atlas } = updateAtlas(world, id, () => ({ ...before }));
  unlinkSync(p);
  return atlas;
}
