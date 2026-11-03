// The shelf at the command line (map-plan/shelf.mjs). Reads what bin/map-profile and map-plan/tools/look.py wrote
// under stagecraft/map-shelf/ (ignored: profiles of published maps are derived from someone else's product).
//   bin/map-shelf brief <id>|all [--k 5] [--json]     the closest layouts to a benchmark brief, with why
//   bin/map-shelf like <map id> [--k 5]               layouts most like a map, by shape
//   bin/map-shelf text "<description>" [--k 5]        layouts whose picture is closest to a description (needs look.py)
//   bin/map-shelf card <map id>                       one map's character card
//   bin/map-shelf html                                the local shelf page (<dir>/shelf.html, with wall drawings in
//                                                     <dir>/walls/ and the thumbnails look.py thumbs made in <dir>/thumbs/)
// Options: --dir <shelf dir> (default stagecraft/map-shelf), --python <python with open_clip> (default
// $MAP_LOOK_PYTHON or /opt/dev/.venvs/map-tag/bin/python), --no-picture (ignore look.py output).
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { lookTags, textCloseness } from "../map-plan/look.mjs";
import { lookup, character, groupLayouts, layoutKey } from "../map-plan/shelf.mjs";
import { nearest } from "../map-plan/similar.mjs";
import { fromDd2vtt, fromFoundryScene } from "../map-plan/readers.mjs";
import { analyse } from "../map-plan/profile.mjs";
import { planSvg } from "../map-plan/svg.mjs";
import { tagsOf } from "../map-plan/shelf.mjs";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const flag = (k) => { const i = args.indexOf(k); if (i >= 0) args.splice(i, 1); return i >= 0; };
const dir = opt("--dir", join(REPO, "stagecraft/map-shelf")), k = Number(opt("--k", 5));
const python = opt("--python", process.env.MAP_LOOK_PYTHON ?? "/opt/dev/.venvs/map-tag/bin/python");
const asJson = flag("--json"), noPicture = flag("--no-picture");
const [cmd, ...rest] = args;

const jsonl = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const rows = [...jsonl(join(dir, "profiles.jsonl")), ...jsonl(join(dir, "ours.jsonl")).map((r) => ({ ...r, pack: r.pack ?? "ours" }))];
if (!rows.length) { console.error(`no profiles in ${dir}: run bin/map-profile --scenes ... --out ${dir}/profiles.jsonl first`); process.exit(2); }
const looks = noPicture ? [] : [...jsonl(join(dir, "look.jsonl")), ...jsonl(join(dir, "look-ours.jsonl"))];
const tags = lookTags(looks);
for (const r of rows) if (tags.has(r.id)) r.look = tags.get(r.id);
const byId = new Map(rows.map((r) => [r.id, r]));
const layouts = groupLayouts(rows);

/** Embeddings of descriptions, cached beside the shelf (they're ours, but the cache sits with the data it serves). */
function textEmbeddings(texts) {
  const cacheFile = join(dir, "text-emb.jsonl"), cache = new Map(jsonl(cacheFile).map((t) => [t.text, t.emb]));
  const missing = texts.filter((t) => !cache.has(t));
  if (missing.length) {
    if (!existsSync(python)) throw new Error(`no python with open_clip at ${python} (set --python or MAP_LOOK_PYTHON)`);
    const out = execFileSync(python, ["-I", join(REPO, "map-plan/tools/look.py"), "text", ...missing], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const l of out.split("\n").filter(Boolean)) { const t = JSON.parse(l); cache.set(t.text, t.emb); }
    writeFileSync(cacheFile, [...cache].map(([text, emb]) => JSON.stringify({ text, emb })).join("\n") + "\n");
  }
  return texts.map((t) => cache.get(t));
}
/** Closeness of every map's picture to a description, as a z-score over the shelf. */
function closeness(text) {
  if (!looks.length) return new Map();
  const c = textCloseness(textEmbeddings([text])[0], looks), v = [...c.values()];
  const mean = v.reduce((s, x) => s + x, 0) / v.length, sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length) || 1;
  return new Map([...c].map(([id, x]) => [id, (x - mean) / sd]));
}

const show = (h) => {
  const c = character(h.r);
  return [`${h.r.name}  [${h.r.id}]  fit ${h.fit}`, `    size      ${c.size}`, `    shape     ${c.shape}`, `    theme     ${c.theme}`, `    contents  ${c.contents}`,
    `    why       ${Object.entries(h.parts).filter(([, v]) => v != null).map(([p, v]) => `${p} ${Math.round(v * 100)}%`).join(", ")}` +
      (h.matched.theme.length || h.matched.contents.length ? ` (matched ${[...h.matched.theme, ...h.matched.contents].join(", ")})` : ""),
    ...(h.variants.length ? [`    variants  ${h.variants.length}: ${h.variants.slice(0, 6).map((v) => v.name).join("; ")}${h.variants.length > 6 ? "; ..." : ""}`] : [])].join("\n");
};

if (cmd === "brief") {
  const { briefs } = JSON.parse(readFileSync(join(REPO, "map-plan/bench/briefs.json"), "utf8"));
  const pick = rest[0] === "all" || !rest[0] ? briefs : briefs.filter((b) => b.id === rest[0]);
  if (!pick.length) { console.error(`no brief ${rest[0]} (have ${briefs.map((b) => b.id).join(", ")})`); process.exit(2); }
  const out = [];
  for (const b of pick) {
    const close = b.describe && looks.length ? closeness(b.describe) : new Map();
    for (const r of rows) r.closeness = close.get(r.id) ?? null;
    const hits = lookup(b, rows, k);
    out.push({ brief: b.id, hits: hits.map((h) => ({ id: h.r.id, name: h.r.name, pack: h.r.pack, fit: h.fit, parts: h.parts, matched: h.matched, card: character(h.r), variants: h.variants })) });
    if (!asJson) console.log(`\n== ${b.id}: ${b.title ?? ""}\n${hits.map(show).join("\n")}`);
  }
  if (asJson) console.log(JSON.stringify(out, null, 1));
} else if (cmd === "like") {
  const t = byId.get(rest[0]);
  if (!t) { console.error(`no map ${rest[0]}`); process.exit(2); }
  const seen = new Set([layoutKey(t)]);
  const hits = nearest(t.profile, rows, rows.length).filter((h) => { const key = layoutKey(byId.get(h.id)); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, k);
  for (const h of hits) console.log(`${h.score}  ${h.name}  [${h.id}]\n    ${Object.values(character(h)).join("\n    ")}`);
} else if (cmd === "text") {
  const close = closeness(rest.join(" "));
  if (!close.size) { console.error("no pictures looked at yet: run map-plan/tools/look.py index first"); process.exit(2); }
  const groups = layouts.map((g) => g.rows.sort((a, b) => (close.get(b.id) ?? -9) - (close.get(a.id) ?? -9))[0]);
  for (const r of groups.sort((a, b) => (close.get(b.id) ?? -9) - (close.get(a.id) ?? -9)).slice(0, k))
    console.log(`${(close.get(r.id) ?? 0).toFixed(2)}  ${r.name}  [${r.id}]\n    ${Object.values(character(r)).join("\n    ")}`);
} else if (cmd === "card") {
  const r = byId.get(rest[0]);
  if (!r) { console.error(`no map ${rest[0]}`); process.exit(2); }
  console.log(JSON.stringify({ id: r.id, name: r.name, ...character(r), look: r.look ?? null }, null, 1));
} else if (cmd === "html") {
  const { briefs } = JSON.parse(readFileSync(join(REPO, "map-plan/bench/briefs.json"), "utf8"));
  const safe = (id) => id.replace(/\//g, "__");
  mkdirSync(join(dir, "walls"), { recursive: true });
  const scenesCache = new Map();
  const planOf = (r) => {
    if (r.src?.dd2vtt) return fromDd2vtt(JSON.parse(readFileSync(r.src.dd2vtt, "utf8")));
    if (!r.src?.scenes) return null;
    if (!scenesCache.has(r.src.scenes)) scenesCache.set(r.src.scenes, Object.values(JSON.parse(readFileSync(r.src.scenes, "utf8"))));
    const sc = scenesCache.get(r.src.scenes).find((x) => x?._id === r.src._id);
    return sc ? fromFoundryScene(sc, { pack: r.pack }) : null;
  };
  // The variant that best stands for its layout: the original, else the first by name.
  const rep = (g) => [...g.rows].sort((a, b) => (/original/i.test(b.name) - /original/i.test(a.name)) || a.name.localeCompare(b.name))[0];
  const out = [];
  for (const g of layouts) {
    const r = rep(g), t = tagsOf(r), id = safe(r.id), plan = planOf(r);
    if (plan && !existsSync(join(dir, "walls", `${id}.lines.svg`))) {
      const A = analyse(plan);
      writeFileSync(join(dir, "walls", `${id}.svg`), planSvg(plan, { px: 8, analysis: A }));
      writeFileSync(join(dir, "walls", `${id}.lines.svg`), planSvg(plan, { px: 8, analysis: A, overlay: true }));
    }
    const all = g.rows.map(tagsOf), p = r.profile;
    out.push({ key: g.key, name: r.name, pack: r.pack ?? "", card: character(r),
      tags: { place: [...new Set(all.flatMap((x) => x.place))], terrain: [...new Set(all.flatMap((x) => x.terrain))], contents: t.contents },
      variants: g.rows.filter((x) => x !== r).map((x) => x.name),
      thumb: existsSync(join(dir, "thumbs", `${id}.jpg`)) ? `thumbs/${id}.jpg` : null, walls: plan ? `walls/${id}.svg` : null, lines: plan ? `walls/${id}.lines.svg` : null,
      sizeBand: p.size.area < 800 ? "s" : p.size.area <= 2000 ? "m" : "l", inout: p.enclosure >= 0.6 ? "in" : p.enclosure >= 0.25 ? "mixed" : "out",
      search: [r.name, r.pack, ...g.rows.map((x) => x.name), ...t.place, ...t.terrain, ...t.mood, ...t.contents].join(" ").toLowerCase() });
  }
  const fits = {};
  for (const b of briefs) {
    const close = b.describe && looks.length ? closeness(b.describe) : new Map();
    for (const r of rows) r.closeness = close.get(r.id) ?? null;
    fits[b.id] = Object.fromEntries(lookup(b, rows, layouts.length).map((h) => [h.r.layout, { fit: h.fit,
      why: Object.entries(h.parts).filter(([, v]) => v != null).map(([k2, v]) => `${k2} ${Math.round(v * 100)}%`).join(", ") +
        (h.matched.theme.length || h.matched.contents.length ? ` · matched ${[...h.matched.theme, ...h.matched.contents].join(", ")}` : "") }]));
  }
  const page = readFileSync(join(REPO, "map-plan/shelf-page.html"), "utf8")
    .replace("/*DATA*/null", () => JSON.stringify({ maps: rows.length, layouts: out, briefs: briefs.map((b) => ({ id: b.id, title: b.title })), fits }).replace(/</g, "\\u003c"));
  writeFileSync(join(dir, "shelf.html"), page);
  console.log(`${join(dir, "shelf.html")}: ${out.length} layouts, ${rows.length} maps, ${out.filter((l) => l.thumb).length} with a picture`);
} else {
  console.error("usage: bin/map-shelf brief <id>|all | like <map id> | text \"<description>\" | card <map id>   [--k 5] [--json] [--dir d]");
  process.exit(2);
}
