/**
 * A section's build brief: what a battle map of this part of the atlas has to contain, and where its exits must be.
 * The contract with whatever builds the map (the Dungeondraft MCP server, a Czepeku map, a segment composition).
 * Drafts never reach a brief. (Named section-brief because session-planner/brief.mjs already exists.)
 */
import { pointInSection, toSectionSquares } from "./geometry.mjs";
import { sectionExits } from "./lint.mjs";

export function sectionBrief(atlas, sectionId) {
  const s = atlas.sections.find((x) => x.id === sectionId);
  if (!s) throw new Error(`no section "${sectionId}"`);
  const live = { ...atlas, nodes: atlas.nodes.filter((n) => !n.draft && !n.partyOnly), edges: atlas.edges.filter((e) => !e.draft) };
  const nodes = Object.fromEntries(live.nodes.map((n) => [n.id, n]));
  const edges = Object.fromEntries(live.edges.map((e) => [e.id, e]));
  const inside = live.nodes.filter((n) => pointInSection(s, n));
  const exits = sectionExits(live, s).map((x) => {
    const e = edges[x.edge], o = nodes[x.outside];
    return {
      side: x.side, at: x.at, edge: x.edge, leadsTo: o.name || o.id, kind: e.kind, water: e.water, systems: e.systems,
      ...(e.gate ? { gate: e.gate } : {}), ...(e.tells.length ? { tells: e.tells } : {}),
    };
  });
  return {
    section: { id: s.id, name: s.name, vibe: s.vibe ?? null, sizeSq: s.sizeSq, rotation: s.rotation, sceneId: s.sceneId ?? null, build: s.build ?? null },
    places: inside.map((n) => {
      const sq = toSectionSquares(s, n);
      return { id: n.id, name: n.name || n.id, kind: n.kind, depth: n.depth, at: { x: Math.round(sq.x * 10) / 10, y: Math.round(sq.y * 10) / 10 },
        systems: n.systems, ...(n.owner ? { owner: n.owner } : {}), tells: n.tells, ...(n.note ? { note: n.note } : {}) };
    }),
    exits,
  };
}

/**
 * Check a built map's exits against the brief, by side and order only (a network placed to ±100 ft can't match a
 * 155 ft map to the foot). `built` = [{id, side}] — the map's openings on its outer edge.
 */
export function checkExits(brief, built) {
  const want = {}, have = {};
  for (const x of brief.exits) (want[x.side] ||= []).push(x.leadsTo);
  for (const x of built) (have[x.side] ||= []).push(x.id);
  const problems = [];
  for (const side of new Set([...Object.keys(want), ...Object.keys(have)])) {
    const w = (want[side] || []).length, h = (have[side] || []).length;
    if (w !== h) problems.push({ side, wanted: want[side] || [], built: have[side] || [] });
  }
  return { ok: problems.length === 0, problems };
}
