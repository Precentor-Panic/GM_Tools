/**
 * Rules Oracle — G9a "structured backend".
 *
 * Indexes the Plutonium Foundry module's bundled 5etools RULES data
 * (`<dataDir>/modules/plutonium/data/{variantrules,actions,
 * conditionsdiseases,skills,senses,tables}.json`) into a flat, searchable
 * row shape. This is the rules-mechanics sibling of combat-planning/
 * plutonium-source.mjs (which indexes the BESTIARY out of the same
 * Plutonium install) — same read-only, never-throws, dataDir-resolved-by-
 * the-caller discipline, deliberately kept as its own small file rather
 * than folded into that module while it's mid-generalization elsewhere.
 *
 * HEADER NOTE (per the task brief): this loader reads the plutonium JSON
 * files DIRECTLY with its own tiny loader rather than depending on
 * combat-planning/plutonium-source.mjs's exports, because that module is
 * being generalized into a family-loader CONCURRENTLY by another workstream.
 * Once that lands, this file's per-family JSON read/cache logic should fold
 * onto the generalized family loader instead of keeping a second copy —
 * this is a deliberate, temporary duplication, not an oversight.
 *
 * HARD RULE: read-only. Nothing here ever writes into the Plutonium module
 * dir (readFileSync/existsSync/statSync only).
 *
 * Graceful empty state: a missing Plutonium data dir returns
 * `{ installed: false, rows: [] }` — never a throw. Other machines
 * (or a fresh checkout with Plutonium not installed) are expected to hit
 * this path constantly.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Family definitions: <dataDir>/modules/plutonium/data/<file>, and the
 * top-level array propert(ies) each file's JSON carries its records under. */
export const RULE_FAMILIES = {
  variantrules: { file: "variantrules.json", props: ["variantrule"] },
  actions: { file: "actions.json", props: ["action"] },
  conditionsdiseases: { file: "conditionsdiseases.json", props: ["condition", "disease", "status"] },
  skills: { file: "skills.json", props: ["skill"] },
  senses: { file: "senses.json", props: ["sense"] },
  tables: { file: "tables.json", props: ["table"] }
};

/** Rows are capped this many chars (an "…" is appended when cut) so one
 * bulky rule entry (or a whole table's rows) never dominates a response. */
export const RULE_TEXT_MAX_CHARS = 1200;

/** The bundled rules data dir, resolved from the SAME dataDir every other Foundry-data reader in this project uses. */
export function plutoniumRulesDataDir(dataDir) {
  return join(dataDir, "modules", "plutonium", "data");
}

/**
 * PURE. Replace a 5etools inline tag (`{@variantrule Foo|XPHB}`,
 * `{@condition blinded}`, `{@dice 1d6}`, `{@action Attack|XPHB}`, ...) with
 * its visible text — the tag body's first pipe-segment, trimmed. Falls back
 * to the bare tag name if the body is empty (shouldn't happen in practice).
 * @param {string} s
 * @returns {string}
 */
export function stripFiveEtoolsTags(s) {
  if (typeof s !== "string") return "";
  return s.replace(/\{@(\w+)([^}]*)\}/g, (_match, tag, rest) => {
    const body = rest.trim();
    const first = body.split("|")[0].trim();
    return first || tag;
  });
}

/**
 * PURE. Flatten a 5etools "entries" node (a string, an array of them, or a
 * nested {type, name?, entries|items} object, or a {type:"table", ...}
 * table) into plain visible text, tags stripped throughout.
 * @param {*} node
 * @returns {string}
 */
export function flattenRuleEntries(node) {
  if (node == null) return "";
  if (typeof node === "string") return stripFiveEtoolsTags(node);
  if (Array.isArray(node)) return node.map(flattenRuleEntries).filter(Boolean).join("\n");
  if (typeof node === "object") {
    if (node.type === "table") {
      const parts = [];
      if (typeof node.caption === "string" && node.caption) parts.push(stripFiveEtoolsTags(node.caption));
      if (Array.isArray(node.colLabels)) parts.push(node.colLabels.map(stripFiveEtoolsTags).join(" | "));
      if (Array.isArray(node.rows)) {
        for (const row of node.rows) {
          if (Array.isArray(row)) parts.push(row.map((cell) => flattenRuleEntries(cell)).join(" | "));
          else parts.push(flattenRuleEntries(row));
        }
      }
      return parts.filter(Boolean).join("\n");
    }
    const parts = [];
    if (typeof node.name === "string" && node.name) parts.push(`${stripFiveEtoolsTags(node.name)}.`);
    if (Array.isArray(node.items)) parts.push(flattenRuleEntries(node.items));
    if (Array.isArray(node.entries)) parts.push(flattenRuleEntries(node.entries));
    if (typeof node.entry === "string") parts.push(stripFiveEtoolsTags(node.entry));
    return parts.filter(Boolean).join("\n");
  }
  return String(node);
}

/** PURE. One raw record (from one family/prop) -> a row, or null if it should be skipped. */
export function buildRuleRow(family, propName, record) {
  if (!record || typeof record.name !== "string" || !record.name) return null;
  // The "tables" family's own records don't carry an `entries` array -- they
  // ARE a table shape directly (caption/colLabels/rows) -- so wrap the
  // record itself as one table node for flattening.
  const entriesNode = family === "tables"
    ? [{ type: "table", caption: record.caption, colLabels: record.colLabels, rows: record.rows }]
    : (record.entries ?? []);
  let text = flattenRuleEntries(entriesNode).trim();
  if (text.length > RULE_TEXT_MAX_CHARS) {
    text = `${text.slice(0, RULE_TEXT_MAX_CHARS)}…`;
  }
  // conditionsdiseases has no per-record discriminant of its own beyond
  // which prop array it came from (condition/disease/status) -- surface
  // that as ruleType. variantrules DOES carry its own `ruleType` field
  // (e.g. "C"/"O") -- prefer the record's real value when present.
  const ruleType = typeof record.ruleType === "string" && record.ruleType
    ? record.ruleType
    : (family === "conditionsdiseases" ? propName : undefined);
  return {
    family,
    name: record.name,
    source: typeof record.source === "string" ? record.source : null,
    page: record.page ?? null,
    ...(ruleType ? { ruleType } : {}),
    text
  };
}

// absolute file path -> { mtimeMs, rows } — per-file mtime cache (each
// family's file changes independently of the others, unlike the bestiary
// dir's single coarse cache key).
const fileRowCache = new Map();

function loadFamilyRows(dir, family, def) {
  const filePath = join(dir, def.file);
  let mtimeMs;
  try {
    mtimeMs = statSync(filePath).mtimeMs;
  } catch {
    return []; // file missing/unreadable -- this family just contributes nothing
  }
  const cached = fileRowCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.rows;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return []; // one unreadable/malformed file never takes the whole index down
  }
  const rows = [];
  for (const propName of def.props) {
    const records = Array.isArray(parsed?.[propName]) ? parsed[propName] : [];
    for (const record of records) {
      const row = buildRuleRow(family, propName, record);
      if (row) rows.push(row);
    }
  }
  fileRowCache.set(filePath, { mtimeMs, rows });
  return rows;
}

/**
 * The cached read every caller should use.
 * @param {string} dataDir
 * @returns {{installed:boolean, dir:string, count:number, rows:object[]}}
 */
export function loadRulesIndex(dataDir) {
  const dir = plutoniumRulesDataDir(dataDir);
  if (!existsSync(dir)) {
    return { installed: false, dir, count: 0, rows: [] };
  }
  const rows = [];
  for (const [family, def] of Object.entries(RULE_FAMILIES)) {
    rows.push(...loadFamilyRows(dir, family, def));
  }
  return { installed: true, dir, count: rows.length, rows };
}

/** Test seam: drop every cached per-file row set (mtime-driven otherwise). */
export function clearRulesIndexCache() {
  fileRowCache.clear();
}

/**
 * PURE. Case-insensitive ALL-terms match over name+text. Name hits rank
 * before text-only hits (a rule literally named what you searched for
 * belongs above one that merely mentions it in passing).
 * @param {object[]} rows          loadRulesIndex(...).rows
 * @param {{query?:string, family?:string, limit?:number}} [opts]
 * @returns {object[]}
 */
export function searchRulesIndex(rows, opts = {}) {
  const query = typeof opts.query === "string" ? opts.query.trim() : "";
  const family = typeof opts.family === "string" && opts.family.trim() ? opts.family.trim() : null;
  const limit = Math.min(Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 20, 50);
  if (!query) return [];
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];

  const nameHits = [];
  const textHits = [];
  for (const row of rows || []) {
    if (family && row.family !== family) continue;
    const nameLower = row.name.toLowerCase();
    if (terms.every((t) => nameLower.includes(t))) {
      nameHits.push(row);
      continue;
    }
    const textLower = (row.text || "").toLowerCase();
    if (terms.every((t) => nameLower.includes(t) || textLower.includes(t))) {
      textHits.push(row);
    }
  }
  return [...nameHits, ...textHits].slice(0, limit);
}
