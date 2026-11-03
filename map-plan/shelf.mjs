// The shelf: every map whose walls we have, grouped by layout, each with a character card, and a lookup that answers
// a brief with the closest layouts and says why. A brief (bench/briefs.json) gives:
//   want      ranges on the shape (similar.mjs, briefScore)
//   theme     { place[], terrain[] }   tags from vocab.json; any one place and any one terrain is enough
//   contents  [kind...]                what should be in it (vocab.json contents)
//   describe  a sentence for the picture search (look.py text), optional
// Rows are { id, pack?, name, profile, theme } (bin/map-profile) with, when a picture was looked at, `look` (look.mjs
// lookTags) and `closeness` to the brief's description.
import { briefScore, footprintDistance } from "./similar.mjs";
import { ROOM_BANDS } from "./profile.mjs";

// Theme outweighs shape: a sewer with a cart in it is no market, however market-shaped. Contents fine-tune.
export const SHELF_WEIGHTS = { shape: 0.35, theme: 0.4, contents: 0.15, picture: 0.1 };

/**
 * Variants of one layout (day, night, flooded, ruined ...) come in one pack, at one size, with nearly the same walls:
 * the same room count give or take one and nearly the same footprint. Returns [{ key, rows }], and stamps each row
 * with its group's key as `layout`.
 */
export function groupLayouts(rows, { footprint = 0.06 } = {}) {
  const parent = rows.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  const byPack = new Map();
  rows.forEach((r, i) => { const k = `${r.pack ?? r.id}:${r.profile.size.w}x${r.profile.size.h}`; if (!byPack.has(k)) byPack.set(k, []); byPack.get(k).push(i); });
  for (const idx of byPack.values()) for (let a = 0; a < idx.length; a++) for (let b = a + 1; b < idx.length; b++) {
    const p = rows[idx[a]].profile, q = rows[idx[b]].profile;
    if (Math.abs(p.rooms.count - q.rooms.count) <= 1 && footprintDistance(p, q) <= footprint) parent[find(idx[a])] = find(idx[b]);
  }
  const groups = new Map();
  rows.forEach((r, i) => {
    const k = rows[find(i)].id;
    if (!groups.has(k)) groups.set(k, { key: k, rows: [] });
    groups.get(k).rows.push(r); r.layout = k;
  });
  return [...groups.values()];
}
export const layoutKey = (r) => r.layout ?? r.id;

const union = (...lists) => [...new Set(lists.flat().filter(Boolean))];

/** What a row's theme and contents come to, from its name, its items and its picture. Each tag says where it came from. */
export function tagsOf(r) {
  const picture = r.look ?? { place: [], terrain: [], contents: {} };
  const items = r.profile.items?.kinds ?? {};
  return {
    place: union(r.theme?.place, picture.place), terrain: union(r.theme?.terrain, picture.terrain), mood: r.theme?.mood ?? [],
    setting: r.theme?.setting ?? null, contents: union(Object.keys(items), Object.keys(picture.contents ?? {})),
    from: {
      name: union(r.theme?.place, r.theme?.terrain, r.theme?.mood), items: Object.keys(items),
      picture: union(picture.place, picture.terrain, Object.keys(picture.contents ?? {})),
    },
  };
}

/** Contents by weight of evidence: placed items count once each, a room whose picture shows the kind counts three. */
export function contentsLine(r, max = 8) {
  const items = r.profile.items?.kinds ?? {}, pic = r.look?.contents ?? {};
  const w = new Map();
  for (const [k, n] of Object.entries(items)) w.set(k, (w.get(k) ?? 0) + n);
  for (const [k, n] of Object.entries(pic)) w.set(k, (w.get(k) ?? 0) + 3 * n);
  return [...w].sort((a, b) => b[1] - a[1]).slice(0, max).map(([k]) => k).join(", ");
}

/** A character card in words: size, shape, theme, contents. */
export function character(r) {
  const p = r.profile, t = tagsOf(r);
  const bands = ROOM_BANDS.map(([b]) => [b, p.rooms.bands?.[b] ?? 0]).filter(([, n]) => n).map(([b, n]) => `${n} ${b}`).join(", ");
  const enclosed = p.enclosure >= 0.6 ? "indoors" : p.enclosure >= 0.25 ? "part indoors" : "open ground";
  const walls = p.walls.organic >= 0.5 ? "organic (rock, roots, rubble)" : p.walls.squareness >= 0.8 ? "square" : "mixed square and irregular";
  return {
    size: `${p.size.w} x ${p.size.h} squares; ${p.rooms.count} room${p.rooms.count === 1 ? "" : "s"}${bands ? ` (${bands})` : ""}` +
      (p.building?.rooms >= 2 ? `; largest building ${p.building.rooms} rooms, ${p.building.area} sq` : ""),
    shape: `${enclosed}, walls ${walls}; ${p.graph.loops} loop${p.graph.loops === 1 ? "" : "s"}, ${p.graph.deadEnds} dead end${p.graph.deadEnds === 1 ? "" : "s"}; longest sightline ${p.openness.longest} sq`,
    theme: union(t.place, t.terrain, t.mood).join(", ") || "(no theme words)",
    contents: contentsLine(r) || "(nothing named)",
  };
}

const share = (want, have) => (want?.length ? want.filter((w) => have.includes(w)).length / want.length : null);

/**
 * How well a row answers a brief, 0..1, and why. Parts the brief doesn't ask for drop out of the weighting.
 * `closeness` (picture vs description) is a z-score over the shelf when given.
 */
export function briefFit(r, brief, weights = SHELF_WEIGHTS) {
  const t = tagsOf(r);
  const miss = brief.want ? briefScore(r.profile, brief.want) : null;
  const parts = {
    shape: miss == null ? null : 1 / (1 + 2 * miss),
    theme: brief.theme ? (() => {
      const pl = brief.theme.place?.length ? (brief.theme.place.some((x) => t.place.includes(x)) ? 1 : 0) : null;
      const te = brief.theme.terrain?.length ? (brief.theme.terrain.some((x) => t.terrain.includes(x)) ? 1 : 0) : null;
      const got = [pl, te].filter((v) => v != null);
      return got.length ? got.reduce((s, v) => s + v, 0) / got.length : null;
    })() : null,
    contents: share(brief.contents, t.contents),
    picture: r.closeness == null ? null : 1 / (1 + Math.exp(-(r.closeness - 1))),
  };
  let s = 0, w = 0;
  for (const [k, v] of Object.entries(parts)) if (v != null) { s += weights[k] * v; w += weights[k]; }
  return { fit: w ? Math.round((1000 * s) / w) / 1000 : 0, parts, matched: {
    theme: union(t.place.filter((x) => brief.theme?.place?.includes(x)), t.terrain.filter((x) => brief.theme?.terrain?.includes(x))),
    contents: (brief.contents ?? []).filter((k) => t.contents.includes(k)),
  } };
}

/** The best `k` layouts for a brief: one entry per layout, its best-fitting variant first, the others listed. */
export function lookup(brief, rows, k = 5, weights) {
  const scored = rows.map((r) => ({ r, ...briefFit(r, brief, weights) }));
  const byLayout = new Map();
  for (const s of scored) {
    const key = layoutKey(s.r);
    if (!byLayout.has(key)) byLayout.set(key, []);
    byLayout.get(key).push(s);
  }
  return [...byLayout.values()].map((list) => {
    list.sort((a, b) => b.fit - a.fit);
    return { ...list[0], variants: list.slice(1).map((s) => ({ id: s.r.id, name: s.r.name })) };
  }).sort((a, b) => b.fit - a.fit).slice(0, k);
}
