/**
 * The players' survey: the part of an atlas the table knows, stripped of everything GM-only. It is what the survey
 * render draws, so nothing outside this view can leak into a players' image.
 *
 *   - Only known ids appear. No record = never heard of it.
 *   - Drafts never appear. A place linked to a World Fabric entity whose narrative state is `hidden` never appears
 *     (`hiddenWf`, read only).
 *   - Beliefs (partyOnly) appear where the party believes them; the real place they stand for doesn't, unless known.
 *   - "heard": a rough position (rounded to `heardGrid` ft) and a name, no depth, no tells.
 *     "seen": position, depth band, tells.   "walked": everything public, with depth in feet.
 *   - Stripped always: notes, owners, hooks, gate keepers, World Fabric ids, systems' GM logic.
 *   - A battle-map section appears (as a named group) only when the party has seen every place inside it.
 */
import { pointInSection } from "./geometry.mjs";
export function surveyView(atlas, known, { hiddenWf = new Set(), heardGrid = 250 } = {}) {
  const lvl = known.known || {};
  const ok = (x) => lvl[x.id] && !x.draft && !(x.wf && hiddenWf.has(x.wf));
  const nodes = atlas.nodes.filter(ok).map((n) => {
    const level = lvl[n.id];
    const rough = level === "heard";
    return {
      id: n.id, name: n.name || "?", kind: n.partyOnly ? "belief" : n.kind, level,
      x: rough ? Math.round(n.x / heardGrid) * heardGrid : n.x, y: rough ? Math.round(n.y / heardGrid) * heardGrid : n.y,
      stratum: rough ? null : n.stratum, depth: level === "walked" ? n.depth : null,
      ...(n.shape && level !== "heard" ? { shape: n.shape } : {}),
      tells: level === "heard" ? [] : n.tells,
      ...(n.partyOnly ? { belief: true } : {}),
    };
  });
  const shown = new Set(nodes.map((n) => n.id));
  const edges = atlas.edges.filter((e) => ok(e) && shown.has(e.from) && shown.has(e.to)).map((e) => ({
    id: e.id, from: e.from, to: e.to, kind: e.kind, route: e.route, ...(e.path ? { path: e.path } : {}), level: lvl[e.id],
    water: lvl[e.id] === "heard" ? null : e.water,
    ...(e.gate && lvl[e.id] !== "heard" ? { gate: { kind: e.gate.kind, state: e.gate.state } } : {}),
    tells: lvl[e.id] === "heard" ? [] : e.tells,
  }));
  // Areas the party can see from the street: rings, districts, the lake, the wall. Never a hidden or draft one.
  const areas = atlas.areas.filter((a) => !a.draft && !(a.wf && hiddenWf.has(a.wf))).map((a) => ({ id: a.id, name: a.name, kind: a.kind, shape: a.shape }));
  // A battle-map section whose every place the party has seen or walked becomes a named group on their sheet.
  const groups = atlas.sections.flatMap((sec) => {
    const inside = atlas.nodes.filter((n) => !n.draft && !n.partyOnly && pointInSection(sec, n));
    if (!inside.length || !inside.every((n) => lvl[n.id] === "seen" || lvl[n.id] === "walked")) return [];
    return [{ id: sec.id, name: sec.name, origin: sec.origin, rotation: sec.rotation, sizeSq: sec.sizeSq }];
  });
  return {
    id: atlas.id, name: atlas.name, frame: atlas.frame, groups,
    strata: atlas.strata.map((s) => ({ id: s.id, name: s.name, top: s.top, bottom: s.bottom })),
    areas, nodes, edges,
  };
}
