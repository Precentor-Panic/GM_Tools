/**
 * Atlas checks. Each finding has an id, a severity (error | warn | info) and the ids it's about. Nothing here blocks
 * a save (warn, don't block); the GM page and Claude's tools show them.
 */
import { routePoints, exitCrossing, pointInSection } from "./geometry.mjs";

const STRATUM_ORDER = (atlas) => Object.fromEntries(atlas.strata.map((s, i) => [s.id, i]));

export const CHECKS = {
  "depth-band": "A place's depth sits outside its depth band",
  "band-skip": "A passage skips a depth band without being a shaft or stair",
  orphan: "A place with no passages",
  uphill: "Water flows from deeper to shallower without being pressurised (full)",
  "gate-owner": "A gate nobody controls",
  unnamed: "A place with no name and no World Fabric link",
  "out-of-bounds": "A place outside the atlas frame",
  "known-unknown": "The table knows an id the atlas doesn't have",
  "known-draft": "The table knows a draft (drafts never reach the survey)",
  "known-dangling": "A known passage whose ends the table doesn't know",
  "section-no-exit": "A section with no passage leaving it",
  drafts: "Drafts waiting for the GM",
  unreachable: "Places with no route to street level",
};

export function lintAtlas(atlas, known = null) {
  const out = [];
  const add = (id, severity, ids, message) => out.push({ check: id, severity, ids, message });
  const order = STRATUM_ORDER(atlas);
  const strata = Object.fromEntries(atlas.strata.map((s) => [s.id, s]));
  const nodes = Object.fromEntries(atlas.nodes.map((n) => [n.id, n]));
  const degree = Object.fromEntries(atlas.nodes.map((n) => [n.id, 0]));
  for (const e of atlas.edges) { degree[e.from]++; degree[e.to]++; }

  for (const n of atlas.nodes) {
    const s = strata[n.stratum];
    if (s && s.bottom > s.top && (n.depth < s.top || n.depth > s.bottom)) add("depth-band", "warn", [n.id], `${label(n)} is ${n.depth} ft down, outside ${s.name} (${s.top}–${s.bottom} ft)`);
    if (!degree[n.id] && !n.partyOnly) add("orphan", "warn", [n.id], `${label(n)} has no passages`);
    if (!n.name && !n.wf) add("unnamed", "warn", [n.id], `"${n.id}" has no name`);
    const [x0, y0, x1, y1] = atlas.frame.bounds;
    if (n.x < x0 || n.x > x1 || n.y < y0 || n.y > y1) add("out-of-bounds", "error", [n.id], `${label(n)} lies outside the frame`);
  }
  for (const e of atlas.edges) {
    const a = nodes[e.from], b = nodes[e.to];
    if (!a || !b) continue;
    const vertical = e.kind === "shaft" || e.kind === "stair" || e.kind === "ladder" || e.kind === "lift";
    if (!vertical && Math.abs(order[a.stratum] - order[b.stratum]) > 1) add("band-skip", "warn", [e.id], `${label(a)} → ${label(b)} jumps from ${a.stratum} to ${b.stratum} with no shaft`);
    if (e.flow !== "none" && e.water !== "full") {
      const [src, dst] = e.flow === "forward" ? [a, b] : [b, a];
      if (dst.depth < src.depth - 2) add("uphill", "warn", [e.id], `water runs uphill from ${label(src)} (${src.depth} ft) to ${label(dst)} (${dst.depth} ft)`);
    }
    if (e.gate && !e.gate.controlledBy && e.gate.state !== "broken" && e.gate.state !== "open") add("gate-owner", "info", [e.id], `the ${e.gate.kind} on ${label(a)} → ${label(b)} has no keeper`);
  }
  for (const s of atlas.sections) {
    const exits = sectionExits(atlas, s);
    if (!exits.length) add("section-no-exit", "warn", [s.id], `section "${s.name}" has no passage leaving it`);
  }
  const drafts = [...atlas.nodes, ...atlas.edges, ...atlas.areas].filter((x) => x.draft).map((x) => x.id);
  if (drafts.length) add("drafts", "info", drafts, `${drafts.length} draft(s) waiting for the GM`);

  // Reachability from street level (stratum index 0 or depth 0).
  const adj = {};
  for (const e of atlas.edges) { (adj[e.from] ||= []).push(e.to); (adj[e.to] ||= []).push(e.from); }
  const start = atlas.nodes.filter((n) => n.depth === 0 || order[n.stratum] === 0).map((n) => n.id);
  const seen = new Set(start);
  const q = [...start];
  while (q.length) for (const m of adj[q.shift()] || []) if (!seen.has(m)) { seen.add(m); q.push(m); }
  const lost = atlas.nodes.filter((n) => !seen.has(n.id) && !n.partyOnly && degree[n.id]).map((n) => n.id);
  if (lost.length) add("unreachable", "warn", lost, `${lost.length} place(s) can't be reached from street level`);

  if (known) {
    const all = new Set([...atlas.nodes, ...atlas.edges].map((x) => x.id));
    const draftSet = new Set(drafts);
    for (const id of Object.keys(known.known)) {
      if (!all.has(id)) add("known-unknown", "error", [id], `the table knows "${id}", which isn't in the atlas`);
      else if (draftSet.has(id)) add("known-draft", "error", [id], `the table knows "${id}", which is still a draft`);
    }
    for (const e of atlas.edges) {
      if (!known.known[e.id]) continue;
      if (!known.known[e.from] || !known.known[e.to]) add("known-dangling", "info", [e.id], `the table knows the passage ${e.id} but not both its ends`);
    }
  }
  return out;
}

function label(n) { return n.name || n.id; }

/** Climbs (they leave a map upward or downward, not through its edge) and pipes (nobody walks them). */
const NOT_AN_EXIT = new Set(["shaft", "stair", "ladder", "lift", "pipe", "riser"]);

/**
 * The passages that leave a section: one end inside its footprint, the other outside. Each with the side and the
 * position along it (in squares) where its drawn route crosses the edge, sorted round the map (n, e, s, w).
 */
export function sectionExits(atlas, section) {
  const nodes = Object.fromEntries(atlas.nodes.map((n) => [n.id, n]));
  const out = [];
  for (const e of atlas.edges) {
    const a = nodes[e.from], b = nodes[e.to];
    if (!a || !b || NOT_AN_EXIT.has(e.kind)) continue;
    const ia = pointInSection(section, a), ib = pointInSection(section, b);
    if (ia === ib) continue;
    const pts = routePoints(e, a, b, atlas.frame.centre);
    const cross = exitCrossing(section, ia ? pts : [...pts].reverse());
    out.push({ edge: e.id, inside: ia ? a.id : b.id, outside: ia ? b.id : a.id, side: cross?.side ?? "?", at: cross?.at ?? null });
  }
  const sideOrder = { n: 0, e: 1, s: 2, w: 3, "?": 4 };
  return out.sort((x, y) => sideOrder[x.side] - sideOrder[y.side] || (x.at ?? 0) - (y.at ?? 0));
}
