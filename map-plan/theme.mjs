// A map's theme and contents in words (vocab.json). Theme: what kind of place it is, its terrain, its mood or variant,
// and whether it's inside or out. Contents: what is in it. Both come from words here (a map's name, a brief, the names
// of the objects placed on it); a picture tagger can add the same tags from the art, on the machine that holds it.
import { readFileSync } from "node:fs";

export const VOCAB = JSON.parse(readFileSync(new URL("./vocab.json", import.meta.url), "utf8"));
export const PLACES = Object.keys(VOCAB.theme.place), TERRAINS = Object.keys(VOCAB.theme.terrain), MOODS = Object.keys(VOCAB.theme.mood);
export const CONTENT_KINDS = Object.keys(VOCAB.contents);

/** Lower-case words, split on anything that isn't a letter and on camelCase ("ScaryGoblinsNight"). */
export function words(text) {
  return String(text ?? "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 1);
}

function index(groups) {
  const m = new Map();
  for (const [tag, ws] of Object.entries(groups)) for (const w of ws) { if (!m.has(w)) m.set(w, new Set()); m.get(w).add(tag); }
  return m;
}
const IDX = Object.fromEntries(Object.entries(VOCAB.theme).map(([facet, groups]) => [facet, index(groups)]));
const CIDX = index(Object.fromEntries(Object.entries(VOCAB.contents).map(([k, v]) => [k, v.words])));

/** Tags whose words appear in the word list; a plural matches its singular ("barrels" -> "barrel"). */
function tagsIn(ws, idx) {
  const out = new Set();
  for (const w of ws) for (const v of [w, w.replace(/s$/, ""), w.replace(/es$/, "")]) for (const t of idx.get(v) ?? []) out.add(t);
  return out;
}

/**
 * Theme from text (names, a brief). Returns { place[], terrain[], mood[], setting: "interior"|"exterior"|null }, each
 * list in vocabulary order.
 */
export function themeFromText(text) {
  const ws = words(text);
  const pick = (facet) => { const s = tagsIn(ws, IDX[facet]); return Object.keys(VOCAB.theme[facet]).filter((t) => s.has(t)); };
  const set = pick("setting");
  return { place: pick("place"), terrain: pick("terrain"), mood: pick("mood"), setting: set.length === 1 ? set[0] : null };
}

/** Content kinds named by one object or asset name ("Barrel_Wood_Dark_A_1x1.webp" -> ["storage"]). */
export function kindsOfName(name) {
  const base = String(name ?? "").split("/").pop().replace(/\.[a-z0-9]+$/i, "");
  return CONTENT_KINDS.filter((k) => tagsIn(words(base), CIDX).has(k));
}

/** Content kinds and counts from a plan's items: { count, kinds: { kind: n } }, kinds in vocabulary order. */
export function contentsFromItems(items = []) {
  const n = new Map();
  for (const it of items) for (const k of new Set([...(it.kinds ?? []), ...kindsOfName(it.what)])) n.set(k, (n.get(k) ?? 0) + 1);
  return { count: items.length, kinds: Object.fromEntries(CONTENT_KINDS.filter((k) => n.has(k)).map((k) => [k, n.get(k)])) };
}
