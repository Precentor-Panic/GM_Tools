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
 *     placeholder?: boolean,   // seeded by a skeleton, not filled yet
 *     group?: string }         // EXPLICIT-ONLY composite-card tag: elements
 *                              // sharing a non-empty group (same column)
 *                              // render as ONE card (see planRunSpread).
 *                              // inferRunLayout NEVER sets this — grouping
 *                              // is a composition decision the GM (or an
 *                              // MCP collaborator) makes, never guesswork.
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

// v2: `group` added to the run-layout shape (optional — every v1 element
// parses unchanged) and planRunSpread() introduced as the single pure
// element-sequence -> spread-plan step (auto-folds + composite group cards).
// v3 (variants round, 2026-09-01): variant gating became a STAMP
// (item.variantHidden) instead of a pre-filter, and planRunSpread computes
// per-unit `tabs`/`activeTab` (local-flip tab state via opts.activeTabs;
// scene.activeVariants seeds; first tab is the default) so folded cards
// render their states as clickable tabs. Loose gated elements still drop.
// v4 (narrative-state round): `revealTab` added to the run-layout shape
// (optional boolean — every v3 element parses unchanged) and planRunSpread
// gained opts.revealStates (Map entityId -> revealState or record): a
// member marked revealTab whose bound graph entity is 'revealed' becomes
// the SEEDED active tab — mid-session gap coverage for an NPC/thread whose
// card flips state when the table learns the truth. Local picks still win.
export const RUN_LAYOUT_VERSION = 4;

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

// Role-aware field labels (Phase 4, persona round): the ONE mapping between
// the stored field key and the word the GM sees, shared by Prep's field
// lines/add-chips AND Run's spread — previously Run relabeled a card's
// looks/means/secret to Effect/Alternate/Failure while Prep still said
// Looks/Means/Secret, so the GM typed in one vocabulary and ran in another
// (two personas independently flagged it). Edit THIS table to rename a
// field's presentation; every surface follows.
export const RUN_FIELD_LABELS = {
  read: { means: "GM" },
  card: { gives: "Phrase", looks: "Effect", means: "Alternate", secret: "Failure" }
};

/** The display label for `field` on an element of `role`; falls back to the generic label. */
export function runFieldLabel(role, field, fallback = field) {
  return RUN_FIELD_LABELS[role]?.[field] ?? fallback;
}

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
 * The pure spread planner (run-spread consolidation pass): turns the
 * already-filtered, order-sorted element sequence into the render plan for
 * the two Run columns. This is THE single place the consolidation rules
 * live — the renderer consumes the plan verbatim, and a cosmetics round can
 * retune the rules here without touching schema, routes, or the renderer's
 * role builders.
 *
 * Input: `placed` — [{el, run, variantHidden?}] as buildRunSpread's
 * classify loop produces it: off-column and empty-placeholder elements are
 * ALREADY removed (hard drops), while variant gating is a STAMP
 * (`variantHidden: true` when the element's variant is gated out by
 * scene.activeVariants) — the variants round (2026-09-01) needs gated
 * members to REACH the planner so a folded card can render them as
 * clickable tabs instead of silently omitting them. The sequence is in
 * `order`.
 *
 * `opts.activeTabs` — a Map of unitKey -> variant name: the GM's LOCAL,
 * ephemeral tab choices (adjudicated: tab clicks never write data;
 * scene.activeVariants seeds, local flips override). unitKey is
 * `${column}::${group}` for a group unit and `"gmfold"` for the side fold.
 *
 * Output: { main: Unit[], side: Unit[] } where a Unit is one of
 *   { kind:'element',  el, run }               — one ordinary element
 *   { kind:'dressing', members:[{el,run}] }    — the ONE folded Dressing card
 *   { kind:'gm-fold',  key, members, tabs, activeTab } — the ONE folded side GM card
 *   { kind:'group', key, group, lead, members, tabs, activeTab } — a composite
 * where a member of a tabbed unit carries `hidden: true` when it belongs to
 * a non-active tab (the renderer skips it; the tab row represents it).
 *
 * Rules (adjudicated 2026-08-31; tabs 2026-09-01):
 *   - Explicit `run.group` wins: grouped elements are excluded from every
 *     auto-fold pool and render as one composite card per (column, group),
 *     positioned by the LEAD's position. A one-member group renders as a
 *     plain element — no wrapper penalty for a half-built group.
 *   - TABS: within a group or the gm-fold, the variant-carrying members'
 *     variant names (member order, deduped) form the unit's `tabs`. The
 *     active tab resolves: the GM's local pick (opts.activeTabs) when it
 *     still names a real tab → else the first member the activeVariants
 *     gating left visible → else the FIRST tab (the adjudicated default).
 *     Members whose variant is not the active tab are `hidden`;
 *     variant-less members always show. Lead = lowest-order non-hidden
 *     member. A single-tab unit shows its one state with no tab row
 *     (renderer keys off tabs.length >= 2).
 *   - LOOSE variant-gated elements (no group, not in the gm-fold) keep the
 *     old behavior: dropped from the plan entirely.
 *   - MAIN order: the lowest-order ungrouped visible `read` opens the
 *     column, then the ONE Dressing card (ALL ungrouped visible main
 *     dressing, regardless of interleaving), then everything else in
 *     element order.
 *   - SIDE: ungrouped `gm` boxes fold into one card only at >=2 counting
 *     gated ones (they become tabs), positioned where the first one sat.
 *     Blocks, cards, and sketches always stay individual.
 *   - CONSERVATION: every group/gm-fold member appears in the output
 *     exactly once (hidden ones included, flagged); loose gated elements
 *     are the only drops.
 */
export function planRunSpread(placed, opts = {}) {
  const items = Array.isArray(placed) ? placed : [];
  const activeTabs = opts.activeTabs instanceof Map ? opts.activeTabs : new Map();
  // opts.revealStates: Map of graph entityId -> revealState string (or a
  // whole narrative-state record — both accepted). Absent/empty = the
  // revealTab seed never fires, byte-identical to v3 behavior.
  const revealStates = opts.revealStates instanceof Map ? opts.revealStates : new Map();
  const revealStateOf = (entityId) => {
    if (!entityId) return undefined;
    const v = revealStates.get(entityId);
    return typeof v === "string" ? v : v?.revealState;
  };
  const groups = new Map(); // "column::group" -> {column, group, members:[]}
  const seq = []; // ordered: {type:'single', item, column} | {type:'group', key} (at first occurrence)
  for (const item of items) {
    const column = item?.run?.column === "side" ? "side" : "main";
    const group = typeof item?.run?.group === "string" && item.run.group.trim() ? item.run.group : null;
    if (group) {
      const key = `${column}::${group}`;
      if (!groups.has(key)) {
        groups.set(key, { column, group, members: [] });
        seq.push({ type: "group", key });
      }
      groups.get(key).members.push(item);
      continue;
    }
    // Loose gated elements drop UNLESS they are side gm boxes — those may
    // join the gm-fold below, where the gating becomes a tab instead.
    const gmFoldCandidate = column === "side" && item.run.role === "gm";
    if (item.variantHidden && !gmFoldCandidate) continue;
    seq.push({ type: "single", item, column });
  }

  // Tab resolution shared by groups and the gm-fold. Mutates members with
  // `hidden` flags; returns {tabs, activeTab}.
  const resolveTabs = (unitKey, members) => {
    const tabs = [];
    for (const m of members) {
      const v = m.run?.variant;
      if (v && !tabs.includes(v)) tabs.push(v);
    }
    let activeTab = null;
    if (tabs.length) {
      const local = activeTabs.get(unitKey);
      if (local && tabs.includes(local)) activeTab = local;
      // v4 reveal seed (between the local pick and the activeVariants
      // seed): a member marked run.revealTab whose bound graph entity —
      // its own graphEntityId, else the first member's in the unit that
      // has one — is 'revealed' becomes the seeded tab. This is the
      // mid-session reveal wire: flip the entity's reveal state (at a
      // wrap, or live via wf_set_reveal_state) and the card's default
      // state follows on the next rebuild, while a local tab click still
      // overrides for this table, this session.
      if (!activeTab) {
        const unitBindId = members.find((m) => m.el?.graphEntityId)?.el?.graphEntityId;
        const revealSeed = members.find((m) =>
          m.run?.revealTab && m.run?.variant &&
          revealStateOf(m.el?.graphEntityId ?? unitBindId) === "revealed"
        );
        if (revealSeed) activeTab = revealSeed.run.variant;
      }
      // else: the first member activeVariants left visible (the stamp is
      // the gating result, so "not variantHidden" IS "variant is active or
      // no gating") — else the adjudicated first-tab default.
      if (!activeTab) {
        const seeded = members.find((m) => m.run?.variant && !m.variantHidden);
        activeTab = seeded ? seeded.run.variant : tabs[0];
      }
    }
    for (const m of members) {
      m.hidden = !!(m.run?.variant && activeTab !== null && m.run.variant !== activeTab);
    }
    return { tabs, activeTab };
  };

  const toUnit = (entry) => {
    if (entry.type === "single") return { kind: "element", el: entry.item.el, run: entry.item.run };
    const g = groups.get(entry.key);
    const { tabs, activeTab } = resolveTabs(entry.key, g.members);
    const visible = g.members.filter((m) => !m.hidden);
    if (g.members.length === 1) return { kind: "element", el: g.members[0].el, run: g.members[0].run };
    return { kind: "group", key: entry.key, group: g.group, lead: visible[0] ?? g.members[0], members: g.members, tabs, activeTab };
  };
  const columnOf = (entry) => (entry.type === "single" ? entry.column : groups.get(entry.key).column);

  // MAIN: opening read first, then the one Dressing card, then the rest.
  const main = [];
  const mainSeq = seq.filter((e) => columnOf(e) === "main");
  const dressingMembers = [];
  let opener = null;
  const mainRest = [];
  for (const e of mainSeq) {
    if (e.type === "single" && e.item.run.role === "dressing") { dressingMembers.push(e.item); continue; }
    if (!opener && e.type === "single" && e.item.run.role === "read") { opener = e; continue; }
    mainRest.push(e);
  }
  if (opener) main.push(toUnit(opener));
  if (dressingMembers.length) main.push({ kind: "dressing", members: dressingMembers });
  for (const e of mainRest) main.push(toUnit(e));

  // SIDE: fold ungrouped gm boxes at >=2 (gated ones count — they tab), in
  // place of the first one.
  const side = [];
  const sideSeq = seq.filter((e) => columnOf(e) === "side");
  const gmMembers = sideSeq
    .filter((e) => e.type === "single" && e.item.run.role === "gm")
    .map((e) => e.item);
  const foldGm = gmMembers.length >= 2;
  let gmFoldPlaced = false;
  for (const e of sideSeq) {
    if (e.type === "single" && e.item.run.role === "gm") {
      if (foldGm) {
        if (!gmFoldPlaced) {
          const { tabs, activeTab } = resolveTabs("gmfold", gmMembers);
          side.push({ kind: "gm-fold", key: "gmfold", members: gmMembers, tabs, activeTab });
          gmFoldPlaced = true;
        }
        continue;
      }
      // No fold: a lone gm box behaves as loose — gated means gone.
      if (e.item.variantHidden) continue;
    }
    side.push(toUnit(e));
  }

  return { main, side };
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
