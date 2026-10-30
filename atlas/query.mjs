/**
 * Questions about an atlas, answered small enough for an LLM's context: a summary, a neighbourhood, the quickest
 * route between two places, what's in an area or a section, a name search.
 */
import { travelMinutes, pointInArea, pointInSection } from "./geometry.mjs";
import { lintAtlas } from "./lint.mjs";

const nameOf = (n) => n.name || n.id;

export function summary(atlas, known = null) {
  const by = (list, key) => list.reduce((m, x) => { for (const k of [].concat(x[key])) m[k] = (m[k] || 0) + 1; return m; }, {});
  const findings = lintAtlas(atlas, known);
  return {
    id: atlas.id, name: atlas.name, revision: atlas.revision,
    counts: { nodes: atlas.nodes.length, edges: atlas.edges.length, areas: atlas.areas.length, sections: atlas.sections.length },
    nodesByStratum: by(atlas.nodes, "stratum"),
    edgesBySystem: by(atlas.edges, "systems"),
    strata: atlas.strata.map((s) => `${s.id} ${s.name} (${s.top}–${s.bottom} ft)`),
    systems: atlas.systems.map((s) => `${s.id}: ${s.name}${s.who ? ` — ${s.who}` : ""}`),
    sections: atlas.sections.map((s) => `${s.id}: ${s.name} (${s.sizeSq.w}×${s.sizeSq.h} sq)${s.build ? "" : " — not built"}`),
    drafts: [...atlas.nodes, ...atlas.edges].filter((x) => x.draft).map((x) => x.id),
    known: known ? Object.keys(known.known).length : null,
    findings: findings.reduce((m, f) => ({ ...m, [f.severity]: (m[f.severity] || 0) + 1 }), {}),
  };
}

function index(atlas) {
  const nodes = Object.fromEntries(atlas.nodes.map((n) => [n.id, n]));
  const adj = {};
  for (const e of atlas.edges) {
    (adj[e.from] ||= []).push({ e, to: e.to });
    (adj[e.to] ||= []).push({ e, to: e.from });
  }
  return { nodes, adj };
}

function edgeLine(atlas, e, nodes) {
  const a = nodes[e.from], b = nodes[e.to];
  return {
    id: e.id, from: e.from, to: e.to, kind: e.kind, systems: e.systems, water: e.water, route: e.route,
    minutes: travelMinutes(e, a, b, atlas.frame.centre),
    ...(e.gate ? { gate: `${e.gate.kind} (${e.gate.state}${e.gate.controlledBy ? `, ${e.gate.controlledBy}` : ""})` } : {}),
    ...(e.tells.length ? { tells: e.tells } : {}), ...(e.draft ? { draft: true } : {}), ...(e.hook ? { hook: true } : {}),
  };
}

function nodeLine(n) {
  return {
    id: n.id, name: nameOf(n), kind: n.kind, stratum: n.stratum, depth: n.depth, x: n.x, y: n.y,
    ...(n.systems.length ? { systems: n.systems } : {}), ...(n.owner ? { owner: n.owner } : {}), ...(n.wf ? { wf: n.wf } : {}),
    ...(n.tells.length ? { tells: n.tells } : {}), ...(n.note ? { note: n.note } : {}), ...(n.draft ? { draft: true } : {}),
    ...(n.partyOnly ? { partyOnly: true, standsFor: n.standsFor } : {}),
  };
}

/** Everything within `hops` passages of a place. */
export function neighbourhood(atlas, id, hops = 1) {
  const { nodes, adj } = index(atlas);
  if (!nodes[id]) throw new Error(`no node "${id}"`);
  const dist = { [id]: 0 };
  const q = [id];
  while (q.length) {
    const cur = q.shift();
    if (dist[cur] >= hops) continue;
    for (const { to } of adj[cur] || []) if (dist[to] === undefined) { dist[to] = dist[cur] + 1; q.push(to); }
  }
  const ids = new Set(Object.keys(dist));
  return {
    centre: nodeLine(nodes[id]),
    nodes: [...ids].filter((x) => x !== id).map((x) => ({ ...nodeLine(nodes[x]), hops: dist[x] })),
    edges: atlas.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => edgeLine(atlas, e, nodes)),
  };
}

/** Quickest route by minutes. `avoid`: gate states to treat as impassable (default sealed and locked). */
export function route(atlas, from, to, { avoid = ["sealed", "locked"], drafts = true } = {}) {
  const { nodes, adj } = index(atlas);
  if (!nodes[from] || !nodes[to]) throw new Error("unknown start or end");
  const best = { [from]: 0 }, prev = {};
  const open = new Set([from]);
  while (open.size) {
    const cur = [...open].reduce((a, b) => (best[a] <= best[b] ? a : b));
    open.delete(cur);
    if (cur === to) break;
    for (const { e, to: nxt } of adj[cur] || []) {
      if (e.gate && avoid.includes(e.gate.state)) continue;
      if (!drafts && (e.draft || nodes[nxt].draft)) continue;
      const d = best[cur] + travelMinutes(e, nodes[e.from], nodes[e.to], atlas.frame.centre);
      if (best[nxt] === undefined || d < best[nxt]) { best[nxt] = d; prev[nxt] = { from: cur, e }; open.add(nxt); }
    }
  }
  if (best[to] === undefined) return null;
  const steps = [];
  for (let c = to; c !== from; c = prev[c].from) steps.unshift(edgeLine(atlas, prev[c].e, nodes));
  return { from, to, minutes: best[to], steps };
}

export function inArea(atlas, areaId) {
  const area = atlas.areas.find((a) => a.id === areaId);
  if (!area) throw new Error(`no area "${areaId}"`);
  return atlas.nodes.filter((n) => pointInArea(n, area.shape)).map(nodeLine);
}

export function inSection(atlas, sectionId) {
  const s = atlas.sections.find((x) => x.id === sectionId);
  if (!s) throw new Error(`no section "${sectionId}"`);
  return atlas.nodes.filter((n) => pointInSection(s, n)).map(nodeLine);
}

export function search(atlas, text) {
  const t = text.toLowerCase();
  return atlas.nodes.filter((n) => [n.id, n.name, n.note, ...n.tells].some((v) => v && v.toLowerCase().includes(t))).map(nodeLine);
}
