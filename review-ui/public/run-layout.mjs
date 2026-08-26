/**
 * Run layout — the vocabulary that turns a scene's elements into a
 * "runnable spread" (Run mode): which column an element sits in, what ROLE
 * it plays there, and which VARIANT (if any) it belongs to.
 *
 * Pure, dependency-free, DOM-free, zod-free ON PURPOSE: this one file is
 * imported by the store (session-planner/scene-elements.mjs via the
 * session-planner/run-layout.mjs re-export, to infer layouts server-side),
 * by the HTTP server, AND by the browser (served as a plain public module,
 * `./run-layout.mjs`) so the inference fallback is defined exactly once.
 * It lives under public/ only so the browser's relative import and Node's
 * resolve the same path. Keep it that way — no imports.
 *
 * The data model (explicit, stored on the element as `element.run`):
 *   { column: 'main'|'side'|'off',
 *     role:   'read'|'dressing'|'beat'|'exits'|'block'|'card'|'gm'|'sketch',
 *     variant?: string,        // free string, e.g. "Present", "Night"
 *     placeholder?: boolean }  // seeded by a skeleton, not filled yet
 *
 * Roles → what the renderer reads (documented in
 * design/session-planner/README.md §E):
 *   read     looks = read-aloud prose; trigger = when; means/secret = GM asides
 *   dressing name + looks (+gives)              → one bullet in the Dressing list
 *   beat     name as header; trigger/gives/means/wants/checks/secret
 *   exits    gives/means/secret/looks lines → "LABEL: text → 'Target scene'"
 *   block    stat block card: bestiaryEntryId / statblockRef / stat, means = tactics
 *   card     payload card: gives = phrase, looks = effect, means = alternate use, secret = failure
 *   gm       GM box: looks/gives/means (trigger = when)
 *   sketch   looks = inline SVG markup, means = caption
 *
 * Explicit `run` ALWAYS wins. `inferRunLayout()` exists only so elements
 * that predate this model (or were just added in a hurry) still land
 * somewhere sensible; it keys off light naming conventions ("Read Aloud —
 * X", "Backdrop — X", "→ Where this leads", "Thread …") that the
 * scene-authoring skill already recommends for any world.
 */

export const RUN_LAYOUT_VERSION = 1;

export const RUN_COLUMNS = ["main", "side", "off"];
export const RUN_ROLES = ["read", "dressing", "beat", "exits", "block", "card", "gm", "sketch"];

/** Where a role naturally lives when the caller only names the role. */
export const ROLE_DEFAULT_COLUMN = {
  read: "main", dressing: "main", beat: "main", exits: "main",
  block: "side", card: "side", gm: "side", sketch: "side"
};

export const ROLE_LABELS = {
  read: "Read aloud", dressing: "Dressing", beat: "Beat", exits: "Exits",
  block: "Stat block", card: "Card", gm: "GM box", sketch: "Sketch"
};

const DASH_SPLIT = /\s+[—–-]\s+/;

/** "Read Aloud — The reset" → "The reset"; no dash → fallback. */
export function titleAfterDash(name, fallback = "") {
  const parts = String(name || "").split(DASH_SPLIT);
  return parts.length > 1 ? parts.slice(1).join(" — ").trim() : fallback;
}

/**
 * The inference fallback. Returns a full `{column, role, variant?}` for an
 * element that has no explicit `run`. Never consult this when `element.run`
 * is set — use `effectiveRun()`.
 */
export function inferRunLayout(element) {
  const name = String(element?.name || "").trim();
  const fields = element?.fields || {};
  let role;
  if (/^(→|->)/.test(name) || /^exits?\b/i.test(name) || /where this leads/i.test(name)) role = "exits";
  else if (/^read[ -]?aloud/i.test(name)) role = "read";
  else if (/^backdrop/i.test(name)) role = "gm";
  else if (/^sketch\b/i.test(name) || /^\s*<svg[\s>]/i.test(String(fields.looks || ""))) role = "sketch";
  else if (element?.stat || fields.bestiaryEntryId || fields.statblockRef || /^enemies\b/i.test(name)) role = "block";
  else if (element?.kind === "graph") role = "beat";
  else role = "dressing";

  const out = { column: ROLE_DEFAULT_COLUMN[role], role };
  // A KEY (graph) person/object reads best as a side block when it has
  // checks or a secret — that's the brief's "interaction card" shape.
  if (role === "beat" && (Array.isArray(fields.checks) && fields.checks.length || fields.secret)) out.column = "side";
  if (role === "read" || role === "gm") {
    const variant = titleAfterDash(name, "");
    if (variant) out.variant = variant;
  }
  return out;
}

/** `element.run` when present (and shaped), else the inferred layout. Second value says which. */
export function effectiveRun(element) {
  const run = element?.run;
  if (run && RUN_COLUMNS.includes(run.column) && RUN_ROLES.includes(run.role)) {
    return { run, inferred: false };
  }
  return { run: inferRunLayout(element), inferred: true };
}

/**
 * Does an element with `run.variant` render given the scene's
 * `activeVariants`? Empty/missing activeVariants = show everything (the
 * pre-variant behavior); elements without a variant always render.
 */
export function variantVisible(run, activeVariants) {
  if (!run?.variant) return true;
  if (!Array.isArray(activeVariants) || activeVariants.length === 0) return true;
  return activeVariants.includes(run.variant);
}

/** True when no text field carries content (checks count as content). */
export function elementIsEmpty(element) {
  const f = element?.fields || {};
  for (const [k, v] of Object.entries(f)) {
    if (k === "checks") { if (Array.isArray(v) && v.length) return false; continue; }
    if (v != null && String(v).trim() !== "") return false;
  }
  return !(element?.stat && element.stat.raw && String(element.stat.raw).trim());
}

/**
 * Parses one exit line. Convention (world-agnostic): "LABEL: text → 'Target'".
 * Label words "plot"/"explore"/"linger" normalise to those three; any other
 * uppercase label is kept as written (title-cased). Target is whatever
 * follows the arrow, quotes stripped.
 */
export function parseExitLine(raw) {
  let text = String(raw || "").trim();
  if (!text) return null;
  let label = "";
  const lm = text.match(/^([A-Z][A-Z ]*(?:\([^)]*\))?)\s*:\s*/);
  if (lm) { label = lm[1]; text = text.slice(lm[0].length); }
  const low = label.toLowerCase();
  if (/plot/.test(low)) label = "Plot";
  else if (/explore/.test(low)) label = "Explore";
  else if (/linger/.test(low)) label = "Linger";
  else if (label) label = label.charAt(0) + label.slice(1).toLowerCase();
  let target = "";
  const tm = text.match(/\s*(?:→|->)\s*(.+?)\s*$/);
  if (tm) {
    target = tm[1].trim().replace(/^['‘"]+/, "").replace(/['’"]+$/, "").trim();
    text = text.slice(0, tm.index).trim();
  }
  return { label, text, target };
}
