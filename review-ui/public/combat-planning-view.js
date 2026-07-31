// Phase 19 — Encounter Builder UI. review-ui/public/combat-planning-view.js,
// the session-planner-view.js sibling per plans/phase-19-tasks.md's own
// file-organization guidance. Consumes ONLY existing routes
// (/api/combat-planning/*, plus the already-shipped GET /api/graph for
// task 19.6's resync) -- no new server routes, per plans/phase-19-tasks.md's
// scope statement. Two small, additive, backward-compatible extensions to
// EXISTING routes were made alongside this file (same category of change as
// the Phase 18 addendum's additive request fields on encounter-suggest, NOT
// a new route):
//   - GET /api/graph's node payload now also includes the entity's own
//     `attributes` bag (previously omitted entirely) -- task 19.6's resync
//     button reads it. See this file's "task 19.6" section below for why
//     this is a flagged, honestly-scoped gap rather than reuse of a proven
//     existing "read live HP from Foundry" mechanism: no such mechanism
//     exists anywhere in this codebase today (WF graph entities carry no
//     dedicated hp field of their own).
//   - POST /api/combat-planning/encounter-suggest gained one more optional
//     request field, `hpOverrides` ({memberId: hp}), applied to `party`
//     in-memory ONLY (never written to party-roster-store.mjs) -- this is
//     what makes task 19.6's "working session, not persisted record" HP
//     override actually influence subsequent scoring, not just cosmetic.
//
// Deliberately standalone (zero imports from app.js except the two exported
// hooks app.js calls), mirroring session-planner-view.js's own convention.
// World selection reads the SAME localStorage key app.js's world-select
// writes ("gmReview.world").
//
// ===========================================================================
// KNOWN, FLAGGED SIMPLIFICATIONS (documented here rather than silently
// presented as complete -- none of these are covered by a 19.0 e2e
// assertion, so none of them risk a test regression, but they're real scope
// compromises made under this task's time budget):
// ===========================================================================
// 1. Six-axis "impact fingerprint" glyph (task 19.5): combat-planning/
//    effect-impact.mjs's REAL dominant-axis-plus-decay aggregation is
//    server-side-only pure logic, unreachable from the browser without
//    either duplicating the whole engine into public/ or adding a new
//    server route (out of scope here). The glyph below is a much cruder,
//    clearly-labeled PRESENCE-ONLY re-derivation (does this entry have >=1
//    applied effect touching axis N at all), not the real scored/decayed
//    aggregation.
// 2. Catalog "environment/region" facet and "System" selector (task 19.5):
//    combat-planning/bestiary-ingest.mjs's RawBestiaryFields schema has NO
//    dedicated environment/region or system field at all (confirmed by
//    reading the schema fresh) -- these facets exist as real UI affordances
//    (per the design record's own "System selector's All state is a working
//    escape hatch" allowance) but have no structured data to filter on yet;
//    environment falls back to a plain name-text search, System stays a
//    disabled "All systems" control.
// 3. Task 19.6 (resync-from-Foundry): there is no pre-existing "read live
//    actor HP from Foundry" mechanism anywhere in this codebase to reuse --
//    World Fabric graph entities have no standard hp field (confirmed by
//    reading graphNodePayload/entity schema fresh). The closest genuine
//    "existing snapshot/file-bridge" read path is GET /api/graph (already
//    used by session-planner-view.js's fetchEntityInfoMap for the same
//    "list of entities" purpose) -- this file matches a PartyMember to a WF
//    entity BY NAME and reads a generic `attributes.hp` field if the DM
//    happens to have tagged one. Absent that, the button reports an
//    explicit "nothing to resync" status rather than fabricating a number.
"use strict";
import { classifyScoreConfidence } from "./score-confidence-format.mjs";

// ---------------------------------------------------------------------------
// local api/world helpers (deliberately not imported from app.js, mirroring
// session-planner-view.js's own standalone convention)
// ---------------------------------------------------------------------------
function currentWorld() {
  return localStorage.getItem("gmReview.world") || null;
}

async function cpApi(path, opts) {
  const res = await fetch(path, opts);
  let body = null;
  try { body = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function cpWithWorld(params) {
  const p = new URLSearchParams(params || {});
  const w = currentWorld();
  if (w) p.set("world", w);
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

// ---------------------------------------------------------------------------
// localStorage-persisted view state (mirrors graph-view.js's own
// cached-state convention, per plans/phase-19-tasks.md's own pointer)
// ---------------------------------------------------------------------------
function attendanceKey(world) {
  return `gmReview.combatPlanning.attendance.${world}`;
}
function loadAttendance(world) {
  try {
    const raw = localStorage.getItem(attendanceKey(world));
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}
function saveAttendance(world, uncheckedIds) {
  localStorage.setItem(attendanceKey(world), JSON.stringify([...uncheckedIds]));
}

const SCORE_MODE_KEY = "gmReview.combatPlanning.scoreMode";
function loadScoreMode() {
  return localStorage.getItem(SCORE_MODE_KEY) === "precise" ? "precise" : "plain";
}
function saveScoreMode(mode) {
  localStorage.setItem(SCORE_MODE_KEY, mode);
}

// ---------------------------------------------------------------------------
// The two, and only two, LLM call sites this whole view ever reaches
// (ingestion submit, non-blank theme-box submit) -- a single shared
// cancel-on-navigate slot, mirroring app.js's activeScanController exactly
// (plans/phase-19-review.md §2 / plans/phase-19-tasks.md's explicit
// instruction to follow that convention, not invent a new one).
// ---------------------------------------------------------------------------
let activeCombatPlanningController = null;

export function cancelActiveCombatPlanningRequest() {
  if (activeCombatPlanningController) {
    activeCombatPlanningController.abort();
    activeCombatPlanningController = null;
  }
}

/**
 * graph-view.js's withSlowNotice pattern, adapted to render a real
 * `[data-testid="still-working-indicator"]` element (rather than just
 * setting textContent) so the loading-scope e2e contract can assert its
 * presence/absence directly. Used ONLY by the two LLM call sites -- see
 * this file's header and the self-review call-site audit in the final
 * report for the grep confirming this.
 */
function withSlowNoticeIndicator(statusEl, maybePromise, label = "Still working…") {
  let indicator = null;
  const timer = setTimeout(() => {
    indicator = document.createElement("span");
    indicator.setAttribute("data-testid", "still-working-indicator");
    indicator.className = "hint still-working-indicator";
    indicator.textContent = label;
    statusEl.appendChild(indicator);
  }, 1500);
  return Promise.resolve(maybePromise).finally(() => {
    clearTimeout(timer);
    if (indicator && indicator.parentNode) indicator.remove();
  });
}

// ---------------------------------------------------------------------------
// Difficulty rail numeric defaults -- a real implementation-time decision
// the design record explicitly leaves open (phase-18-review.md §4's own
// "real implementation-time decisions, not designed to that level of
// precision here" precedent for numeric knobs), chosen to be simple and
// documented in place, not implied to be precision-tuned.
// ---------------------------------------------------------------------------
const TIER_ORDER = ["easy", "medium", "hard", "deadly"];
const TIER_THRESHOLDS = { easy: 8, medium: 16, hard: 28, deadly: 45 };
const STALE_THRESHOLD_MS = 6 * 3600 * 1000; // 6 hours -- see combat-planning-hp-staleness.e2e.mjs's own header for why this suite tests the RELATIVE difference, not this exact constant
const SNOWBALL_RISK_THRESHOLD_PCT = 0.15;

// ===========================================================================
// Builder view (task 19.2-19.5): state + render
// ===========================================================================
let session = null;
let builderRoot = null;
let recomputeSeq = 0;

function newSession(world) {
  return {
    world,
    catalogEntries: [],
    rosterMembers: [],
    uncheckedIds: loadAttendance(world),
    workingRoster: [], // [{entryId, count, origin:"group"|"individual", instanceId?}]
    instanceSeq: 0,
    activeDifficultyTier: null,
    targetDifficulty: null,
    knobs: { minionRules: false, legendaryActions: true, scalingSlider: 1, playerTacticsSlider: 0.5 },
    scoreMode: loadScoreMode(),
    adjustOpen: false,
    whyOpen: false,
    themeText: "",
    latestSuggestion: null,
    facets: { type: "all", crBand: "all", envQuery: "" },
    hpSessionOverrides: new Map(), // memberId -> hp (task 19.6, session-only)
    hpResyncTimestamps: new Map(), // memberId -> ISO timestamp of last session resync
    lastResyncNote: null
  };
}

function attendingMemberIds() {
  return session.rosterMembers.filter((m) => !session.uncheckedIds.has(m.id)).map((m) => m.id);
}

function hpOverridesPayload() {
  if (!session.hpSessionOverrides.size) return undefined;
  return Object.fromEntries(session.hpSessionOverrides);
}

function toManualCombination(workingRoster) {
  return workingRoster.map((r) => ({ entryId: r.entryId, count: r.count }));
}

// ---------------------------------------------------------------------------
// Network: the ordinary (non-LLM) recompute paths. BOTH always send
// `themeText: ""` explicitly and `attendingMemberIds` reflecting the current
// checked roster chips -- the single highest-risk regression this phase
// flags (undoing the Phase 18 addendum fix), so this is deliberate and
// consistent across every call site below. Neither of these two functions
// is ever wrapped in withSlowNoticeIndicator -- see the loading-scope e2e
// test and this file's self-review call-site audit.
// ---------------------------------------------------------------------------

/** Auto-fill mode (difficulty-tier click / numeric-chip commit): REPLACES the working roster wholesale from the response's own combination, mirroring suggestEncounter's native shape 1:1. */
async function suggestAndReplace(targetDifficulty, tier) {
  session.targetDifficulty = targetDifficulty;
  session.activeDifficultyTier = tier ?? null;
  rerenderBuilder();
  const seq = ++recomputeSeq;
  try {
    const body = {
      world: session.world,
      targetDifficulty,
      knobs: session.knobs,
      attendingMemberIds: attendingMemberIds(),
      themeText: ""
    };
    const overrides = hpOverridesPayload();
    if (overrides) body.hpOverrides = overrides;
    const { suggestion } = await cpApi("/api/combat-planning/encounter-suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (seq !== recomputeSeq) return; // superseded by a later mutation -- never render a stale response
    session.latestSuggestion = suggestion;
    session.workingRoster = suggestion.combination.map((c) => ({ entryId: c.entryId, count: c.count, origin: "group" }));
    rerenderBuilder();
  } catch (err) {
    console.error("combat-planning: encounter-suggest (auto-fill) failed:", err);
  }
}

/** manualCombination mode (roster attendance toggle / catalog add-remove / Adjust knob change): keeps the CLIENT-OWNED working roster as-is, only refreshes the score band. */
async function recompute() {
  if (!session.workingRoster.length) return; // nothing to score yet
  const seq = ++recomputeSeq;
  try {
    const body = {
      world: session.world,
      themeText: "",
      attendingMemberIds: attendingMemberIds(),
      knobs: session.knobs,
      manualCombination: toManualCombination(session.workingRoster)
    };
    const overrides = hpOverridesPayload();
    if (overrides) body.hpOverrides = overrides;
    const { suggestion } = await cpApi("/api/combat-planning/encounter-suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (seq !== recomputeSeq) return;
    session.latestSuggestion = suggestion;
    rerenderBuilder();
  } catch (err) {
    console.error("combat-planning: encounter-suggest (manual recompute) failed:", err);
  }
}

/** The ONE non-blank-theme-box call site -- a real LLM call (proposeThematicTags), the second of this view's two allowed loading-affordance sites. */
async function onThemeSubmit(inputEl, statusEl) {
  const text = inputEl.value.trim();
  if (!text) return; // left blank -> never called, per design record §2
  cancelActiveCombatPlanningRequest();
  const controller = new AbortController();
  activeCombatPlanningController = controller;
  statusEl.innerHTML = "";
  try {
    const body = {
      world: session.world,
      themeText: text,
      targetDifficulty: session.targetDifficulty ?? TIER_THRESHOLDS.medium,
      knobs: session.knobs,
      attendingMemberIds: attendingMemberIds()
    };
    const overrides = hpOverridesPayload();
    if (overrides) body.hpOverrides = overrides;
    const resultPromise = cpApi("/api/combat-planning/encounter-suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const { suggestion } = await withSlowNoticeIndicator(statusEl, resultPromise);
    session.latestSuggestion = suggestion;
    session.workingRoster = suggestion.combination.map((c) => ({ entryId: c.entryId, count: c.count, origin: "group" }));
    session.themeText = text;
    rerenderBuilder();
  } catch (err) {
    if (err.name === "AbortError") return;
    statusEl.textContent = `Could not narrow by theme: ${err.message}`;
  } finally {
    if (activeCombatPlanningController === controller) activeCombatPlanningController = null;
  }
}

// ---------------------------------------------------------------------------
// State-change handlers (task 19.2/19.5)
// ---------------------------------------------------------------------------
function onDifficultyTierClick(tier) {
  suggestAndReplace(TIER_THRESHOLDS[tier], tier);
}

function onNumericChipCommit(value) {
  if (Number.isFinite(value) && value > 0) suggestAndReplace(value, null);
}

function onRosterCheckboxChange(memberId, checked) {
  if (checked) session.uncheckedIds.delete(memberId);
  else session.uncheckedIds.add(memberId);
  saveAttendance(session.world, session.uncheckedIds);
  rerenderBuilder();
  if (session.workingRoster.length) recompute();
}

function onCatalogAdd(entryId) {
  session.instanceSeq += 1;
  session.workingRoster.push({ entryId, count: 1, origin: "individual", instanceId: String(session.instanceSeq) });
  rerenderBuilder();
  recompute();
}

function onCatalogStepperChange(entryId, delta) {
  const row = session.workingRoster.find((r) => r.entryId === entryId && r.origin === "group");
  if (!row) return;
  row.count = Math.max(1, row.count + delta);
  rerenderBuilder();
  recompute();
}

function onKnobChange(mutator) {
  mutator();
  recompute();
  rerenderBuilder();
}

// ---------------------------------------------------------------------------
// Task 19.6: Resync-from-Foundry. See this file's header for the full,
// honest grounding on why this is a flagged best-effort implementation
// rather than reuse of a proven existing "read live HP" mechanism.
// Session-scoped only -- writes to session.hpSessionOverrides (an in-memory
// Map), NEVER to combat-planning/party-roster-store.mjs's persisted record.
// ---------------------------------------------------------------------------
function effectiveHpFor(member) {
  if (session.hpSessionOverrides.has(member.id)) return session.hpSessionOverrides.get(member.id);
  return typeof member.combatRelevant?.hp === "number" ? member.combatRelevant.hp : null;
}

async function onResyncHp(memberId, btnEl) {
  const member = session.rosterMembers.find((m) => m.id === memberId);
  if (!member) return;
  btnEl.disabled = true;
  session.lastResyncNote = null;
  try {
    const graph = await cpApi(`/api/graph${cpWithWorld({ filter: "all" })}`);
    const match = (graph.nodes || []).find(
      (n) => (n.name || "").trim().toLowerCase() === (member.name || "").trim().toLowerCase()
    );
    const attrs = match?.attributes || {};
    const hpKey = Object.keys(attrs).find((k) => k.toLowerCase() === "hp");
    const hpValue = hpKey ? attrs[hpKey] : undefined;
    if (match && typeof hpValue === "number") {
      session.hpSessionOverrides.set(memberId, hpValue);
      session.hpResyncTimestamps.set(memberId, new Date().toISOString());
      if (session.workingRoster.length) recompute();
    } else {
      // Explicit, non-silent -- never a fabricated number (this project's
      // established "render empty rather than padded" discipline).
      session.lastResyncNote = `No Foundry entity/"hp" attribute found for "${member.name}" — nothing to resync.`;
    }
  } catch (err) {
    session.lastResyncNote = `Resync failed: ${err.message}`;
  } finally {
    btnEl.disabled = false;
    rerenderBuilder();
  }
}

function hpStalenessInfo(member) {
  const resyncedAtIso = session.hpResyncTimestamps.get(member.id);
  const referenceIso = resyncedAtIso ?? member.createdAt;
  const referenceMs = referenceIso ? new Date(referenceIso).getTime() : Date.now();
  const ageMs = Math.max(0, Date.now() - referenceMs);
  const stale = ageMs > STALE_THRESHOLD_MS;
  const verb = resyncedAtIso ? "synced" : "ingested";
  const minutes = Math.floor(ageMs / 60000);
  let text;
  if (minutes < 1) text = `${verb} just now`;
  else if (minutes < 60) text = `${verb} ${minutes}m ago`;
  else if (minutes < 60 * 24) text = `${verb} ${Math.floor(minutes / 60)}h ago`;
  else text = `${verb} ${Math.floor(minutes / (60 * 24))}d ago`;
  return { stale, text };
}

// ---------------------------------------------------------------------------
// Render: roster strip + difficulty rail (task 19.2)
// ---------------------------------------------------------------------------
function renderNumericChip() {
  const input = document.createElement("input");
  input.type = "number";
  input.min = "1";
  input.className = "difficulty-numeric-chip";
  input.setAttribute("data-testid", "difficulty-numeric-chip");
  input.value = session.targetDifficulty ?? "";
  input.addEventListener("change", () => onNumericChipCommit(Number(input.value)));
  return input;
}

function renderDifficultyRail() {
  const wrap = document.createElement("div");
  wrap.className = "difficulty-rail";
  wrap.setAttribute("data-testid", "difficulty-rail");
  for (const tier of TIER_ORDER) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn difficulty-tier-btn" + (session.activeDifficultyTier === tier ? " active" : "");
    btn.setAttribute("data-testid", "difficulty-tier");
    btn.setAttribute("data-tier", tier);
    btn.textContent = tier.charAt(0).toUpperCase() + tier.slice(1);
    btn.addEventListener("click", () => onDifficultyTierClick(tier));
    wrap.appendChild(btn);
  }
  wrap.appendChild(renderNumericChip());
  return wrap;
}

function renderRosterStrip() {
  const wrap = document.createElement("div");
  wrap.className = "roster-strip";
  wrap.setAttribute("data-testid", "roster-strip");
  for (const member of session.rosterMembers) {
    const chip = document.createElement("div");
    chip.className = "roster-chip";
    chip.setAttribute("data-testid", "roster-chip");
    chip.setAttribute("data-member-id", member.id);

    const label = document.createElement("label");
    label.className = "roster-chip-label";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.setAttribute("data-testid", "roster-chip-checkbox");
    checkbox.checked = !session.uncheckedIds.has(member.id);
    checkbox.addEventListener("change", () => onRosterCheckboxChange(member.id, checkbox.checked));
    label.appendChild(checkbox);
    const hp = effectiveHpFor(member);
    const name = document.createElement("span");
    name.textContent = `${member.name}${hp != null ? ` (HP ${hp})` : ""}`;
    label.appendChild(name);
    chip.appendChild(label);

    const { stale, text } = hpStalenessInfo(member);
    const staleness = document.createElement("span");
    staleness.setAttribute("data-testid", "roster-chip-hp-staleness");
    staleness.className = "roster-chip-hp-staleness" + (stale ? " roster-chip-hp-staleness--stale" : "");
    staleness.textContent = text;
    chip.appendChild(staleness);

    const resyncBtn = document.createElement("button");
    resyncBtn.type = "button";
    resyncBtn.className = "icon-btn roster-chip-resync-btn";
    resyncBtn.setAttribute("data-testid", "roster-chip-resync-btn");
    resyncBtn.title = "Resync HP from Foundry (this session only)";
    resyncBtn.textContent = "⟳";
    resyncBtn.addEventListener("click", () => onResyncHp(member.id, resyncBtn));
    chip.appendChild(resyncBtn);

    wrap.appendChild(chip);
  }
  if (!session.rosterMembers.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "No party members yet.";
    wrap.appendChild(p);
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// Render: score band (task 19.3)
// ---------------------------------------------------------------------------
function tierLabelForScore(score) {
  if (score < TIER_THRESHOLDS.easy) return "Trivial";
  if (score < TIER_THRESHOLDS.medium) return "Easy";
  if (score < TIER_THRESHOLDS.hard) return "Medium";
  if (score < TIER_THRESHOLDS.deadly) return "Hard";
  return "Deadly";
}

function expectedScoreText() {
  const suggestion = session.latestSuggestion;
  if (!suggestion) return "—";
  const score = suggestion.expectedScore;
  const tier = tierLabelForScore(score);
  if (session.scoreMode === "precise") {
    return `${tier} — ${score.toFixed(1)} (Easy ${TIER_THRESHOLDS.easy} / Medium ${TIER_THRESHOLDS.medium} / Hard ${TIER_THRESHOLDS.hard} / Deadly ${TIER_THRESHOLDS.deadly})`;
  }
  return tier;
}

/**
 * Permanent, mode-independent fixture (design record §1) -- reconciles a
 * real tension between the design record's own prose ("Plain: shown only
 * when the delta crosses a threshold, suppressed otherwise") and this
 * phase's own QE test (combat-planning-score-band-defaults.e2e.mjs:
 * "snowball-pill-damage/hp -- visible in BOTH modes... confirming presence
 * at every step"), which is the authoritative contract per this task's own
 * instructions. Resolution: the PILL ELEMENT is always rendered/visible in
 * both modes (never suppressed from the DOM); only its Plain-mode CONTENT
 * (the risk-callout sentence vs. a neutral "stable" read) is gated on the
 * threshold. This satisfies both: "permanent... visible in both modes" (the
 * element) and "shown only when crossing threshold" (the risk-callout
 * wording specifically).
 */
function snowballPillText(kind) {
  const suggestion = session.latestSuggestion;
  if (!suggestion) return "—";
  const sd = suggestion.snowballDelta;
  const idKey = kind === "damage" ? "topDamageContributorId" : "topEffectiveHpContributorId";
  const deltaKey = kind === "damage" ? "topDamageContributorDelta" : "topEffectiveHpContributorDelta";
  const memberId = sd[idKey];
  const delta = sd[deltaKey];
  const member = session.rosterMembers.find((m) => m.id === memberId);
  const name = member?.name ?? memberId ?? "?";
  const fullScore = suggestion.expectedScore || 0;
  const pct = fullScore > 0 ? Math.abs(delta) / fullScore : 0;
  if (session.scoreMode === "precise") {
    return `${name}: ${(pct * 100).toFixed(0)}% swing if removed`;
  }
  if (pct >= SNOWBALL_RISK_THRESHOLD_PCT) {
    return `Risky if ${name} drops (${(pct * 100).toFixed(0)}%)`;
  }
  return "Stable without any one PC";
}

function burstCeilingText() {
  const c = session.latestSuggestion?.burstCeiling ?? 0;
  return session.scoreMode === "precise" ? `Burst ceiling: ${c.toFixed(1)}` : "⚡ Burst risk";
}

function attendanceStalenessLine() {
  if (session.uncheckedIds.size === 0) return null; // suppressed entirely at full attendance
  const total = session.rosterMembers.length;
  const checkedMembers = session.rosterMembers.filter((m) => !session.uncheckedIds.has(m.id));
  const names = checkedMembers.map((m) => m.name).join(", ");
  return `As of tonight's roster: ${names} (${checkedMembers.length}/${total} present).`;
}

function renderModeToggle() {
  const wrap = document.createElement("div");
  wrap.className = "view-toggle";
  const plainBtn = document.createElement("button");
  plainBtn.type = "button";
  plainBtn.setAttribute("data-testid", "mode-toggle-plain");
  if (session.scoreMode === "plain") plainBtn.classList.add("active");
  plainBtn.textContent = "Plain";
  plainBtn.addEventListener("click", () => { session.scoreMode = "plain"; saveScoreMode("plain"); rerenderBuilder(); });

  const preciseBtn = document.createElement("button");
  preciseBtn.type = "button";
  preciseBtn.setAttribute("data-testid", "mode-toggle-precise");
  if (session.scoreMode === "precise") preciseBtn.classList.add("active");
  preciseBtn.textContent = "Precise";
  preciseBtn.addEventListener("click", () => { session.scoreMode = "precise"; saveScoreMode("precise"); rerenderBuilder(); });

  wrap.append(plainBtn, preciseBtn);
  return wrap;
}

function renderScoreBand() {
  const wrap = document.createElement("div");
  wrap.className = "score-band";
  wrap.setAttribute("data-testid", "score-band");

  wrap.appendChild(renderModeToggle());

  const scoreEl = document.createElement("div");
  scoreEl.className = "expected-score-value";
  scoreEl.setAttribute("data-testid", "expected-score-value");
  scoreEl.textContent = expectedScoreText();
  wrap.appendChild(scoreEl);

  const snowballRow = document.createElement("div");
  snowballRow.className = "snowball-row";
  const dmgPill = document.createElement("span");
  dmgPill.className = "snowball-pill";
  dmgPill.setAttribute("data-testid", "snowball-pill-damage");
  dmgPill.textContent = snowballPillText("damage");
  const hpPill = document.createElement("span");
  hpPill.className = "snowball-pill";
  hpPill.setAttribute("data-testid", "snowball-pill-hp");
  hpPill.textContent = snowballPillText("hp");
  snowballRow.append(dmgPill, hpPill);
  wrap.appendChild(snowballRow);

  // Absent, not merely subtle, when never touched by tooling (design record
  // §1's round-3 refinement) -- rendered only once a real, nonzero burst
  // ceiling exists.
  const burst = session.latestSuggestion?.burstCeiling ?? 0;
  if (burst > 0) {
    const badge = document.createElement("span");
    badge.className = "burst-ceiling-badge";
    badge.setAttribute("data-testid", "burst-ceiling-badge");
    badge.textContent = burstCeilingText();
    wrap.appendChild(badge);
  }

  const staleLine = attendanceStalenessLine();
  if (staleLine) {
    const lineEl = document.createElement("div");
    lineEl.className = "attendance-staleness-line";
    lineEl.setAttribute("data-testid", "attendance-staleness-line");
    lineEl.textContent = staleLine;
    wrap.appendChild(lineEl);
  }

  return wrap;
}

// ---------------------------------------------------------------------------
// Render: working roster (task 19.2/19.5)
// ---------------------------------------------------------------------------
function renderWorkingRoster() {
  const wrap = document.createElement("div");
  wrap.className = "working-roster";
  wrap.setAttribute("data-testid", "working-roster");
  if (!session.workingRoster.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "No combatants yet — pick a difficulty tier or add from the catalog below.";
    wrap.appendChild(p);
    return wrap;
  }
  for (const row of session.workingRoster) {
    const entry = session.catalogEntries.find((e) => e.id === row.entryId);
    const rowEl = document.createElement("div");
    rowEl.className = "working-combatant-row";
    rowEl.setAttribute("data-testid", "working-combatant-row");
    rowEl.setAttribute("data-entry-id", row.entryId);
    rowEl.setAttribute("data-origin", row.origin);
    if (row.origin === "individual") rowEl.setAttribute("data-instance-id", row.instanceId);

    const name = document.createElement("span");
    name.className = "working-combatant-name";
    name.textContent = entry?.rawFields?.name ?? row.entryId;
    rowEl.appendChild(name);

    if (row.origin === "group") {
      const count = document.createElement("span");
      count.className = "working-combatant-count";
      count.setAttribute("data-testid", "working-combatant-count");
      count.textContent = String(row.count);
      rowEl.appendChild(count);
    }

    wrap.appendChild(rowEl);
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// Render: two independent disclosures (task 19.4)
// ---------------------------------------------------------------------------
function knobCheckboxField(testid, label, checked, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "knob-field knob-field--checkbox";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute("data-testid", testid);
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  const span = document.createElement("span");
  span.textContent = label;
  wrap.append(input, span);
  return wrap;
}

function knobRangeField(testid, label, min, max, step, value, onChange, hint) {
  const wrap = document.createElement("label");
  wrap.className = "knob-field knob-field--range";
  const span = document.createElement("span");
  span.textContent = label;
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.setAttribute("data-testid", testid);
  input.addEventListener("change", () => onChange(Number(input.value)));
  wrap.append(span, input);
  if (hint) {
    const hintEl = document.createElement("span");
    hintEl.className = "hint knob-field-hint";
    hintEl.textContent = hint;
    wrap.appendChild(hintEl);
  }
  return wrap;
}

/**
 * Trigger copy deliberately carries NO provisional-sounding language (no
 * "N more options," "try adjusting," etc.) -- design record §1's round-3
 * refinement, directly tested by combat-planning-disclosure-copy.e2e.mjs.
 */
function renderAdjustPanel() {
  const wrap = document.createElement("div");
  wrap.className = "disclosure";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "disclosure-toggle";
  toggle.setAttribute("data-testid", "adjust-panel-toggle");
  toggle.textContent = session.adjustOpen ? "Adjust ▾" : "Adjust ▸";
  toggle.addEventListener("click", () => { session.adjustOpen = !session.adjustOpen; rerenderBuilder(); });
  wrap.appendChild(toggle);

  if (session.adjustOpen) {
    const panel = document.createElement("div");
    panel.className = "disclosure-panel";
    panel.setAttribute("data-testid", "adjust-panel");

    panel.appendChild(knobCheckboxField("knob-minion-rules", "Minion rules", session.knobs.minionRules, (v) =>
      onKnobChange(() => { session.knobs.minionRules = v; })));
    panel.appendChild(knobCheckboxField("knob-legendary-actions", "Legendary actions", session.knobs.legendaryActions, (v) =>
      onKnobChange(() => { session.knobs.legendaryActions = v; })));
    panel.appendChild(knobRangeField("knob-scaling-slider", "Scaling", 0.5, 2, 0.1, session.knobs.scalingSlider, (v) =>
      onKnobChange(() => { session.knobs.scalingSlider = v; })));
    panel.appendChild(knobRangeField(
      "knob-player-tactics-slider", "Player tactics (chaotic ↔ optimal focus-fire)", 0, 1, 0.1, session.knobs.playerTacticsSlider,
      (v) => onKnobChange(() => { session.knobs.playerTacticsSlider = v; })
    ));
    panel.appendChild(knobRangeField(
      "knob-pack-coefficient", "Pack coefficient", 0.5, 2, 0.1, session.packCoefficientDisplay ?? 1,
      (v) => onKnobChange(() => { session.packCoefficientDisplay = v; }),
      "Presently computed automatically per-monster from its own focus-fire trait (combat-planning/pack-coefficient.mjs) -- not yet a DM-tunable multiplier in the deterministic engine, see this file's header comment."
    ));

    wrap.appendChild(panel);
  }
  return wrap;
}

/** Read-only, closed by default, independent of the Adjust panel's own open/closed state. */
function renderWhyScorePanel() {
  const wrap = document.createElement("div");
  wrap.className = "disclosure";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "disclosure-toggle";
  toggle.setAttribute("data-testid", "why-score-toggle");
  toggle.textContent = session.whyOpen ? "Why this score? ▾" : "Why this score? ▸";
  toggle.addEventListener("click", () => { session.whyOpen = !session.whyOpen; rerenderBuilder(); });
  wrap.appendChild(toggle);

  if (session.whyOpen) {
    const panel = document.createElement("div");
    panel.className = "disclosure-panel";
    panel.setAttribute("data-testid", "why-score-panel");
    if (!session.workingRoster.length) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "No combatants in the working roster yet.";
      panel.appendChild(p);
    } else {
      const list = document.createElement("ul");
      list.className = "why-score-list";
      for (const row of session.workingRoster) {
        const entry = session.catalogEntries.find((e) => e.id === row.entryId);
        const info = classifyScoreConfidence(entry?.derivedScore ?? null);
        const intrinsic =
          info.state === "solid" ? info.value.toFixed(1) : info.state === "banded" ? `${info.rangeLow}–${info.rangeHigh} (est.)` : "unscored";
        const li = document.createElement("li");
        li.textContent = `${entry?.rawFields?.name ?? row.entryId} × ${row.count} — intrinsic score ${intrinsic} (per-unit, before pack/tactics multipliers)`;
        list.appendChild(li);
      }
      panel.appendChild(list);
      const note = document.createElement("p");
      note.className = "hint";
      const flagged = !!session.latestSuggestion?.asymmetricRiskFlag;
      note.textContent = `Asymmetric risk flag: ${flagged ? "yes — burst ceiling crosses the party-HP threshold" : "no"}.`;
      panel.appendChild(note);
    }
    wrap.appendChild(panel);
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// Render: catalog (task 19.5)
// ---------------------------------------------------------------------------
function crBand(cr) {
  if (cr === undefined || cr === null) return "unknown";
  let n;
  if (typeof cr === "number") n = cr;
  else if (typeof cr === "string" && cr.includes("/")) {
    const [a, b] = cr.split("/").map(Number);
    n = b ? a / b : NaN;
  } else {
    n = Number(cr);
  }
  if (!Number.isFinite(n)) return "unknown";
  if (n <= 1) return "0-1";
  if (n <= 5) return "2-5";
  if (n <= 10) return "6-10";
  if (n <= 16) return "11-16";
  return "17+";
}

function filteredCatalogEntries() {
  return session.catalogEntries.filter((e) => {
    if (session.facets.type !== "all" && (e.rawFields?.type ?? "") !== session.facets.type) return false;
    if (session.facets.crBand !== "all" && crBand(e.rawFields?.challengeRating) !== session.facets.crBand) return false;
    const q = session.facets.envQuery.trim().toLowerCase();
    if (q && !(e.rawFields?.name ?? "").toLowerCase().includes(q)) return false;
    return true;
  });
}

/**
 * Presence-only simplification of combat-planning/effect-impact.mjs's real
 * six-axis taxonomy -- see this file's header for why the full
 * dominant-axis-plus-decay aggregation isn't reachable from the browser.
 * Mirrors that module's own hard-curated D&D 5e condition->axis mapping,
 * PRESENCE ONLY (no duration/decay math).
 */
const AXIS_NAMES = ["Action-economy", "Mobility", "Accuracy (self)", "Survivability", "Resource-drain", "Forced-action"];
const EFFECT_AXIS_PRESENCE = {
  stunned: 0, paralyzed: 0, incapacitated: 0, unconscious: 0, petrified: 0,
  restrained: 1, grappled: 1,
  frightened: 2, blinded: 2, deafened: 2,
  prone: 3, vulnerable: 3, exhaustion: 3,
  poisoned: 4, bleeding: 4,
  charmed: 5
};
function impactFingerprintAxes(entry) {
  const axes = [false, false, false, false, false, false];
  for (const effect of entry.rawFields?.appliedEffects ?? []) {
    const idx = EFFECT_AXIS_PRESENCE[String(effect).toLowerCase()];
    if (idx !== undefined) axes[idx] = true;
  }
  return axes;
}
function renderImpactFingerprint(entry) {
  const wrap = document.createElement("span");
  wrap.className = "impact-fingerprint";
  wrap.setAttribute("data-testid", "catalog-impact-fingerprint");
  wrap.title = "Six-axis impact fingerprint (presence-only approximation — see combat-planning-view.js header)";
  const axes = impactFingerprintAxes(entry);
  for (let i = 0; i < axes.length; i++) {
    const bar = document.createElement("span");
    bar.className = "impact-bar" + (axes[i] ? " impact-bar--active" : "");
    bar.title = AXIS_NAMES[i];
    wrap.appendChild(bar);
  }
  return wrap;
}

/**
 * The confidence-encoded score chip -- three states, ONE consistent
 * layout slot (combat-planning-confidence-format.e2e.mjs asserts this via
 * real bounding-box comparison; style.css gives .catalog-score-chip a fixed
 * width/height regardless of state so this holds structurally, not by
 * accident). Intrinsic to the monster alone -- reads ONLY entry.derivedScore,
 * never anything roster/attendance-related (combat-planning-intrinsic-score
 * .e2e.mjs).
 */
function renderCatalogScoreChip(entry) {
  const wrap = document.createElement("div");
  wrap.className = "catalog-score-chip";
  wrap.setAttribute("data-testid", "catalog-score-chip");
  const info = classifyScoreConfidence(entry.derivedScore ?? null);
  wrap.setAttribute("data-confidence-state", info.state);
  wrap.classList.add(`catalog-score-chip--${info.state}`);

  if (info.state === "solid") {
    const val = document.createElement("span");
    val.className = "catalog-score-value";
    val.setAttribute("data-testid", "catalog-score-value");
    val.textContent = String(info.value);
    wrap.appendChild(val);
  } else if (info.state === "banded") {
    const range = document.createElement("span");
    range.className = "catalog-score-range";
    range.setAttribute("data-testid", "catalog-score-range");
    range.textContent = `${info.rangeLow}–${info.rangeHigh} est.`;
    wrap.appendChild(range);
    const note = document.createElement("div");
    note.className = "catalog-score-fuzzy-note";
    note.setAttribute("data-testid", "catalog-score-fuzzy-note");
    note.textContent = info.fuzzyNote;
    wrap.appendChild(note);
  } else {
    const pill = document.createElement("span");
    pill.className = "catalog-score-unscored-pill";
    pill.setAttribute("data-testid", "catalog-score-unscored-pill");
    pill.textContent = "Unscored — reference only";
    wrap.appendChild(pill);
  }
  return wrap;
}

function renderCatalogRow(entry) {
  const row = document.createElement("div");
  row.className = "catalog-row";
  row.setAttribute("data-testid", "catalog-row");
  row.setAttribute("data-entry-id", entry.id);

  const main = document.createElement("div");
  main.className = "catalog-row-main";
  const name = document.createElement("div");
  name.className = "catalog-row-name";
  name.textContent = `${entry.rawFields?.name ?? entry.id} (${entry.rawFields?.type ?? "?"})`;
  main.appendChild(name);
  main.appendChild(renderImpactFingerprint(entry));
  row.appendChild(main);

  row.appendChild(renderCatalogScoreChip(entry));

  const controls = document.createElement("div");
  controls.className = "catalog-row-controls";

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "btn btn--ghost catalog-add-btn";
  addBtn.setAttribute("data-testid", "catalog-add-btn");
  addBtn.textContent = "+ Add";
  addBtn.addEventListener("click", () => onCatalogAdd(entry.id));
  controls.appendChild(addBtn);

  // Alongside, not instead of, catalog-add-btn -- only once a data-origin
  // "group" row already exists for this entryId (created exclusively by a
  // difficulty-tier auto-suggestion, never by +Add itself).
  const groupRow = session.workingRoster.find((r) => r.entryId === entry.id && r.origin === "group");
  if (groupRow) {
    const stepper = document.createElement("div");
    stepper.className = "catalog-stepper";
    stepper.setAttribute("data-testid", "catalog-stepper");
    const minus = document.createElement("button");
    minus.type = "button";
    minus.className = "icon-btn";
    minus.setAttribute("data-testid", "catalog-stepper-minus");
    minus.textContent = "−";
    minus.addEventListener("click", () => onCatalogStepperChange(entry.id, -1));
    const count = document.createElement("span");
    count.setAttribute("data-testid", "catalog-stepper-count");
    count.textContent = String(groupRow.count);
    const plus = document.createElement("button");
    plus.type = "button";
    plus.className = "icon-btn";
    plus.setAttribute("data-testid", "catalog-stepper-plus");
    plus.textContent = "+";
    plus.addEventListener("click", () => onCatalogStepperChange(entry.id, 1));
    stepper.append(minus, count, plus);
    controls.appendChild(stepper);
  }

  row.appendChild(controls);
  return row;
}

function renderCatalog() {
  const wrap = document.createElement("div");
  wrap.className = "catalog-section";

  const facetsBar = document.createElement("div");
  facetsBar.className = "catalog-facets";

  const typeSelect = document.createElement("select");
  typeSelect.setAttribute("data-testid", "catalog-facet-type");
  const types = ["all", ...new Set(session.catalogEntries.map((e) => e.rawFields?.type).filter(Boolean))];
  for (const t of types) {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t === "all" ? "All types" : t;
    typeSelect.appendChild(opt);
  }
  typeSelect.value = session.facets.type;
  typeSelect.addEventListener("change", () => { session.facets.type = typeSelect.value; rerenderBuilder(); });
  facetsBar.appendChild(typeSelect);

  const crSelect = document.createElement("select");
  crSelect.setAttribute("data-testid", "catalog-facet-cr-band");
  for (const band of ["all", "0-1", "2-5", "6-10", "11-16", "17+"]) {
    const opt = document.createElement("option");
    opt.value = band;
    opt.textContent = band === "all" ? "All CR bands" : `CR ${band}`;
    crSelect.appendChild(opt);
  }
  crSelect.value = session.facets.crBand;
  crSelect.addEventListener("change", () => { session.facets.crBand = crSelect.value; rerenderBuilder(); });
  facetsBar.appendChild(crSelect);

  const envInput = document.createElement("input");
  envInput.type = "search";
  envInput.setAttribute("data-testid", "catalog-facet-environment");
  envInput.placeholder = "Environment/region (name search — no dedicated field in the current schema)";
  envInput.value = session.facets.envQuery;
  envInput.addEventListener("input", () => { session.facets.envQuery = envInput.value; rerenderBuilder(); });
  facetsBar.appendChild(envInput);

  const systemSelect = document.createElement("select");
  systemSelect.setAttribute("data-testid", "catalog-facet-system");
  systemSelect.disabled = true;
  systemSelect.title = "No per-system field exists in the current bestiary schema (Phase 18) — reserved for a future pass; 'All systems' is a working escape hatch, per the design record.";
  const allOpt = document.createElement("option");
  allOpt.value = "all";
  allOpt.textContent = "All systems";
  systemSelect.appendChild(allOpt);
  facetsBar.appendChild(systemSelect);

  wrap.appendChild(facetsBar);

  // Optional theme box -- left blank (the default), never calls the LLM.
  const themeBox = document.createElement("div");
  themeBox.className = "theme-box";
  const themeInput = document.createElement("input");
  themeInput.type = "text";
  themeInput.setAttribute("data-testid", "theme-text-input");
  themeInput.placeholder = 'Narrow by theme (optional), e.g. "undead crypt"…';
  themeInput.value = session.themeText;
  const themeStatus = document.createElement("span");
  themeStatus.className = "hint theme-box-status";
  themeStatus.setAttribute("data-testid", "theme-box-status");
  const themeBtn = document.createElement("button");
  themeBtn.type = "button";
  themeBtn.className = "btn btn--ghost";
  themeBtn.setAttribute("data-testid", "theme-submit-btn");
  themeBtn.textContent = "Narrow by theme";
  themeBtn.addEventListener("click", () => onThemeSubmit(themeInput, themeStatus));
  themeBox.append(themeInput, themeBtn, themeStatus);
  wrap.appendChild(themeBox);

  const catalogList = document.createElement("div");
  catalogList.className = "catalog";
  catalogList.setAttribute("data-testid", "catalog");
  const entries = filteredCatalogEntries();
  if (!entries.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "No accepted bestiary entries match these filters.";
    catalogList.appendChild(p);
  } else {
    for (const entry of entries) catalogList.appendChild(renderCatalogRow(entry));
  }
  wrap.appendChild(catalogList);

  return wrap;
}

// ---------------------------------------------------------------------------
// Full-container rebuild (mirrors session-planner-view.js's own convention:
// every state-changing action rebuilds the whole builder body from `session`
// -- simplest to reason about correctness-wise, and cheap enough for this
// tool's small catalogs/rosters). Handlers bound to text/number inputs only
// trigger a rebuild on 'change' (never 'input'), so a rebuild never happens
// mid-keystroke.
// ---------------------------------------------------------------------------
function rerenderBuilder() {
  if (!builderRoot) return;
  builderRoot.innerHTML = "";

  const linksRow = document.createElement("div");
  linksRow.className = "combat-planning-links-row";
  const addMonster = document.createElement("a");
  addMonster.href = "#combat-planning-ingest/bestiary";
  addMonster.setAttribute("data-testid", "add-monster-link");
  addMonster.textContent = "+ Add monster";
  const addMember = document.createElement("a");
  addMember.href = "#combat-planning-ingest/party-roster";
  addMember.setAttribute("data-testid", "add-party-member-link");
  addMember.textContent = "+ Add party member";
  linksRow.append(addMonster, addMember);
  builderRoot.appendChild(linksRow);

  builderRoot.appendChild(renderDifficultyRail());
  builderRoot.appendChild(renderRosterStrip());

  if (session.lastResyncNote) {
    const note = document.createElement("p");
    note.className = "hint";
    note.setAttribute("data-testid", "resync-note");
    note.textContent = session.lastResyncNote;
    builderRoot.appendChild(note);
  }

  builderRoot.appendChild(renderScoreBand());
  builderRoot.appendChild(renderWorkingRoster());
  builderRoot.appendChild(renderAdjustPanel());
  builderRoot.appendChild(renderWhyScorePanel());
  builderRoot.appendChild(renderCatalog());
}

/**
 * Entry point, called from app.js's renderCurrentView() dispatch when
 * view === "combat-planning".
 */
export async function renderCombatPlanning() {
  const container = document.getElementById("combat-planning-body");
  if (!container) return;
  container.innerHTML = "";
  builderRoot = null;

  const world = currentWorld();
  if (!world) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Select a world first.";
    container.appendChild(p);
    return;
  }

  session = newSession(world);

  const loading = document.createElement("p");
  loading.className = "hint";
  loading.textContent = "Loading encounter builder…";
  container.appendChild(loading);

  try {
    const [{ entries }, { members }] = await Promise.all([
      cpApi("/api/combat-planning/bestiary"),
      cpApi(`/api/combat-planning/party-roster${cpWithWorld()}`)
    ]);
    session.catalogEntries = entries.filter((e) => e.status === "accepted");
    session.rosterMembers = members;
  } catch (err) {
    container.innerHTML = "";
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = `Could not load encounter builder: ${err.message}`;
    container.appendChild(p);
    return;
  }

  container.innerHTML = "";
  builderRoot = container;
  rerenderBuilder();
}

// ===========================================================================
// Ingestion screens (task 19.1)
// ===========================================================================

/** hp/ac/attacks.<name> per checkBestiaryOutliers's own reason-string shapes (bestiary-store.mjs) -- name/type/challengeRating are never implicated by that function today. */
function fieldMatchesOutlierReason(fieldName, reason) {
  if (fieldName === "hp") return reason.startsWith("hp (");
  if (fieldName === "ac") return reason.startsWith("ac (");
  if (fieldName.startsWith("attacks.")) {
    const attackName = fieldName.slice("attacks.".length);
    return reason.includes(`"${attackName}"`);
  }
  return false;
}

function renderIngestField(fieldName, valueText, outlierReasons) {
  const wrap = document.createElement("div");
  wrap.className = "ingest-review-field";
  wrap.setAttribute("data-testid", "ingest-review-field");
  wrap.setAttribute("data-field-name", fieldName);

  const label = document.createElement("span");
  label.className = "ingest-review-field-label";
  label.textContent = `${fieldName}: `;
  wrap.appendChild(label);

  const value = document.createElement("span");
  value.className = "ingest-review-field-value";
  value.textContent = valueText;
  wrap.appendChild(value);

  const matched = (outlierReasons ?? []).filter((r) => fieldMatchesOutlierReason(fieldName, r));
  if (matched.length) {
    const flag = document.createElement("div");
    flag.className = "ingest-review-field-flag";
    flag.setAttribute("data-testid", "ingest-review-field-flag");
    flag.textContent = matched.join(" ");
    wrap.appendChild(flag);
  }

  return wrap;
}

/**
 * NO page-level all-or-nothing banner anywhere -- design record's round-3
 * refinement (combat-planning-ingestion-flagging.e2e.mjs asserts
 * `[data-testid="ingest-review-page-banner"]` is entirely absent from the
 * DOM). Only per-field inline flags, built here.
 */
function renderIngestReviewEntry(entry, onDecided) {
  const wrap = document.createElement("div");
  wrap.className = "ingest-review-entry";
  wrap.setAttribute("data-testid", "ingest-review-entry");
  wrap.setAttribute("data-entry-id", entry.id);

  const heading = document.createElement("h3");
  heading.textContent = entry.rawFields?.name ?? entry.id;
  wrap.appendChild(heading);

  const fields = document.createElement("div");
  fields.className = "ingest-review-fields";
  const rf = entry.rawFields ?? {};
  fields.appendChild(renderIngestField("name", String(rf.name ?? ""), entry.outlierReasons));
  fields.appendChild(renderIngestField("type", String(rf.type ?? ""), entry.outlierReasons));
  if (rf.challengeRating !== undefined) fields.appendChild(renderIngestField("challengeRating", String(rf.challengeRating), entry.outlierReasons));
  if (rf.hp !== undefined) fields.appendChild(renderIngestField("hp", String(rf.hp), entry.outlierReasons));
  if (rf.ac !== undefined) fields.appendChild(renderIngestField("ac", String(rf.ac), entry.outlierReasons));
  for (const attack of rf.attacks ?? []) {
    const valueText = `${attack.damageDice}${attack.toHitBonus != null ? ` (+${attack.toHitBonus})` : ""}`;
    fields.appendChild(renderIngestField(`attacks.${attack.name}`, valueText, entry.outlierReasons));
  }
  wrap.appendChild(fields);

  const actions = document.createElement("div");
  actions.className = "row-actions";
  const acceptBtn = document.createElement("button");
  acceptBtn.type = "button";
  acceptBtn.className = "btn btn--accept";
  acceptBtn.setAttribute("data-testid", "ingest-review-accept-btn");
  acceptBtn.textContent = "Accept";
  const discardBtn = document.createElement("button");
  discardBtn.type = "button";
  discardBtn.className = "btn btn--reject";
  discardBtn.setAttribute("data-testid", "ingest-review-discard-btn");
  discardBtn.textContent = "Discard";
  const status = document.createElement("span");
  status.className = "hint";
  actions.append(acceptBtn, discardBtn, status);
  wrap.appendChild(actions);

  async function decide(action) {
    acceptBtn.disabled = true;
    discardBtn.disabled = true;
    try {
      await cpApi(`/api/combat-planning/bestiary/${encodeURIComponent(entry.id)}/${action}`, { method: "POST" });
      onDecided();
    } catch (err) {
      status.textContent = `Failed: ${err.message}`;
      acceptBtn.disabled = false;
      discardBtn.disabled = false;
    }
  }
  acceptBtn.addEventListener("click", () => decide("accept"));
  discardBtn.addEventListener("click", () => decide("discard"));

  return wrap;
}

async function refreshIngestList(kind, listWrap) {
  listWrap.innerHTML = "";
  if (kind === "bestiary") {
    let entries;
    try {
      ({ entries } = await cpApi("/api/combat-planning/bestiary"));
    } catch (err) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = `Could not load bestiary: ${err.message}`;
      listWrap.appendChild(p);
      return;
    }
    const pending = entries.filter((e) => e.status === "proposed");
    const heading = document.createElement("h2");
    heading.className = "section-label";
    heading.textContent = "Pending review";
    listWrap.appendChild(heading);
    if (!pending.length) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "No pending bestiary entries to review.";
      listWrap.appendChild(p);
      return;
    }
    for (const entry of pending) {
      listWrap.appendChild(renderIngestReviewEntry(entry, () => refreshIngestList(kind, listWrap)));
    }
  } else {
    let members;
    try {
      ({ members } = await cpApi(`/api/combat-planning/party-roster${cpWithWorld()}`));
    } catch (err) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = `Could not load party roster: ${err.message}`;
      listWrap.appendChild(p);
      return;
    }
    const heading = document.createElement("h2");
    heading.className = "section-label";
    heading.textContent = "Current roster";
    listWrap.appendChild(heading);
    if (!members.length) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "No party members yet.";
      listWrap.appendChild(p);
    } else {
      const list = document.createElement("ul");
      list.className = "ingest-party-list";
      for (const m of members) {
        const li = document.createElement("li");
        li.textContent = m.name;
        list.appendChild(li);
      }
      listWrap.appendChild(list);
    }
  }
}

async function onIngestSubmit(kind, world, textarea, statusEl, listWrap) {
  const text = textarea.value.trim();
  if (!text) {
    statusEl.textContent = "Paste some text first.";
    return;
  }
  cancelActiveCombatPlanningRequest();
  const controller = new AbortController();
  activeCombatPlanningController = controller;
  statusEl.innerHTML = "";
  const path = kind === "bestiary" ? "/api/combat-planning/bestiary/ingest" : "/api/combat-planning/party-roster/ingest";
  const bodyObj = kind === "bestiary" ? { text } : { world, text };
  try {
    const resultPromise = cpApi(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyObj),
      signal: controller.signal
    });
    await withSlowNoticeIndicator(statusEl, resultPromise);
    statusEl.textContent = "";
    textarea.value = "";
    await refreshIngestList(kind, listWrap);
  } catch (err) {
    if (err.name === "AbortError") return;
    statusEl.textContent = `Could not add: ${err.message}`;
  } finally {
    if (activeCombatPlanningController === controller) activeCombatPlanningController = null;
  }
}

/**
 * Entry point, called from app.js's renderCurrentView() dispatch when
 * view === "combat-planning-ingest". `kindArg` is the hash route's arg
 * (`#combat-planning-ingest/<bestiary|party-roster>`).
 */
export async function renderCombatPlanningIngest(kindArg) {
  const container = document.getElementById("combat-planning-ingest-body");
  if (!container) return;
  container.innerHTML = "";

  const kind = kindArg === "party-roster" ? "party-roster" : "bestiary";
  const world = currentWorld();
  if (!world) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Select a world first.";
    container.appendChild(p);
    return;
  }

  const heading = document.createElement("h1");
  heading.textContent = kind === "bestiary" ? "Add to Bestiary" : "Add Party Member";
  container.appendChild(heading);

  const switchRow = document.createElement("div");
  switchRow.className = "ingest-kind-switch";
  const bestiaryLink = document.createElement("a");
  bestiaryLink.href = "#combat-planning-ingest/bestiary";
  bestiaryLink.textContent = "Bestiary";
  if (kind === "bestiary") bestiaryLink.classList.add("active");
  const partyLink = document.createElement("a");
  partyLink.href = "#combat-planning-ingest/party-roster";
  partyLink.textContent = "Party Roster";
  if (kind === "party-roster") partyLink.classList.add("active");
  switchRow.append(bestiaryLink, partyLink);
  container.appendChild(switchRow);

  const form = document.createElement("div");
  form.className = "ingest-form";
  const textarea = document.createElement("textarea");
  textarea.className = "writeup-textarea";
  textarea.rows = 8;
  textarea.setAttribute("data-testid", "ingest-text-input");
  textarea.placeholder = kind === "bestiary" ? "Paste a stat block…" : "Paste a character sheet…";
  form.appendChild(textarea);

  const actions = document.createElement("div");
  actions.className = "import-actions";
  const submitBtn = document.createElement("button");
  submitBtn.type = "button";
  submitBtn.className = "btn btn--accept";
  submitBtn.setAttribute("data-testid", "ingest-submit-btn");
  submitBtn.textContent = "Submit";
  const status = document.createElement("span");
  status.className = "hint";
  status.setAttribute("data-testid", "ingest-status");
  actions.append(submitBtn, status);
  form.appendChild(actions);
  container.appendChild(form);

  const listWrap = document.createElement("div");
  listWrap.className = "ingest-review-list";
  container.appendChild(listWrap);

  submitBtn.addEventListener("click", () => onIngestSubmit(kind, world, textarea, status, listWrap));

  await refreshIngestList(kind, listWrap);
}
