// Phase 17 -- Session Planner UI, reworked in Phase 23 (Scene Construction
// UI) per plans/phase-21-review.md's redesign: scenes are now a persisted,
// ordered CHAIN of scenes (not a single current-scene view), with real
// add/remove-node, "+ insert between scenes" (real place or transit/path),
// Develop-node/Develop-scene as genuine peer buttons with per-node review,
// a scene-local rollback control, equal-weight Add Event/Add Encounter, and
// a mid-session ad-hoc "+" quick-gen control. See
// review-ui/test/e2e/scene-construction-fixture.mjs for the full DOM/route
// contract this file implements to.
//
// Deliberately standalone (zero imports from app.js), mirroring
// graph-view.js's own established convention of talking to the outside
// world only via plain DOM/fetch, not shared module state -- this keeps
// app.js -> session-planner-view.js a one-directional import, no circular
// module graph. World selection is read directly from the same
// localStorage key app.js itself writes on world-select change
// ("gmReview.world").
//
// CHAIN-BUILD ALGORITHM (the single most important design decision in this
// rework, worked out against BOTH the new scene-construction-*.e2e.mjs
// suite AND every PRE-EXISTING session-planner-*.e2e.mjs / scenes-tab-*
// .e2e.mjs file, which must all stay green):
//   - Every scene in the world is a candidate EXCEPT scenes with a non-null
//     parentSceneId ("forks" -- session-planner/scenes.mjs's `forkScene`,
//     the re-center control below) are excluded from appearing as a
//     SIBLING in anyone else's chain -- parentSceneId is "a different axis,
//     time not space" (plans/phase-21-review.md §12) and stays orthogonal
//     to the chain. The CURRENTLY VIEWED scene is always included
//     regardless of whether it's a root or a fork -- when it's a fork, it
//     substitutes for its own root's slot in the chain (its ultimate root
//     ancestor is excluded from the "other root scenes" set below).
//   - This is what makes re-centering (fork) show exactly ONE anchor card
//     again afterward, matching session-planner-recenter-race.e2e.mjs's/
//     session-planner-resume-persistence.e2e.mjs's/scenes-tab-*.e2e.mjs's
//     own pre-existing single-anchor-card assumption, while ALSO satisfying
//     scene-construction-insert-between.e2e.mjs's requirement that two
//     genuinely disconnected ROOT scenes both render together on load.
//   - Ordering: current scene at hop-distance 0; every other candidate's
//     hop-distance comes from the real GET /api/scene-planning/linkage
//     route (session-planner/scene-linkage.mjs's linkedScenesForScene) when
//     reachable, else treated as unreachable (sorted last). A stable sort
//     (native Array#sort, stable since ES2019) breaks ties by the
//     candidates' original creation order, matching
//     scene-construction-chain-display.e2e.mjs's/scenes-tab-linkage
//     .e2e.mjs's own "must not just echo creation order" requirement (an
//     ambiguous tie only happens between two candidates at the SAME
//     hop-distance, where creation-order is a defensible, stable
//     tie-break, not the primary sort key).
//
// LAZY PER-ITEM BODY LOAD (the second key design decision): each chain
// item's OUTER `<details>`/`<summary>` (task 23.1's own established
// free/JS-free-collapse precedent, renderBeyondCorridorSummary) renders
// eagerly for the WHOLE chain (cheap -- just an id + a name lookup already
// available from the one shared GET /api/graph fetch), but a chain item's
// INNER BODY (its own corridor brief, scene-actions-bar, rollback panel,
// saved-encounters list -- everything that needs its own network fetches)
// is built ONLY for the currently-loaded scene up front, and for any OTHER
// item on its own first expand (native `toggle` event). This is what lets
// scenes-tab-browse-and-navigate.e2e.mjs's/scenes-tab-linkage.e2e.mjs's
// pre-existing "exactly one `[data-card-role=anchor]` location-card exists
// anywhere on the page" assumption keep holding even when the chain
// contains other, never-expanded scenes -- their own anchor cards simply
// don't exist in the DOM yet, not just hidden.
"use strict";
import { createFlushableDebounce } from "./debounced-save.mjs";
// Run layout vocabulary + inference -- the SAME file the stores use (session-planner/run-layout.mjs re-exports it).
import { effectiveRun, variantVisible, elementIsEmpty, parseExitLine, titleAfterDash, planRunSpread, runFieldLabel, ROLE_LABELS, RUN_ROLES, RUN_COLUMNS, ROLE_DEFAULT_COLUMN } from "./run-layout.mjs";
// Phase 28 task 28.6: the SAME deterministic type->color hash graph-view.js
// already established for node fill colors (no second type-color mapping) --
// used to tint a KEY element's glyph/accent-rule with its real graph entity
// type, per the design record's "type-colored glyph" requirement.
import { colorForType } from "./graph-view.js";
// Phase 28 task 28.3: reuse the shared, generic undo-toast pattern (contract
// Decision 3) for scene-element remove-with-undo, rather than a second toast
// implementation. mountEditableList is NOT reused for the element list: the
// element row's own testid contract (scene-element-row + scene-element-
// remove-btn, NOT the helper's derived scene-element-row-remove-btn) plus its
// custom per-field click-to-edit body don't fit that helper's fixed
// body+controls shape -- see this file's scene-page section header.
import { showUndoToast } from "./plans-view.js";
// Phase 36 task 36.4b: the scene page's own "Stage" chip row reuses the
// shared tray's kind-glyph convention verbatim (◈ item / ▦ map / ◐ splash /
// ♪ music) rather than re-deriving a second copy.
import { KIND_GLYPH } from "./scene-tray.js";
// Phase 37 task 37.3: the Wrap rail renders its proposals through THE ONE
// shared proposal/diff card (README's "implement once"), replacing 29.6's
// local buildProposalCard renderer -- the SAME component Chronicle's "What
// changed" panel and the Connection-Menu lore intake use. The rail keeps its
// own chrome (slide-down panel, blurb, Accept all + Apply-to-graph footer);
// only the per-mutation card markup is now the shared one.
import { renderProposalCard } from "./proposal-card.js";

// ---------------------------------------------------------------------------
// local api/world helpers (see file header -- deliberately not imported
// from app.js, to keep this module standalone like graph-view.js)
// ---------------------------------------------------------------------------

function currentWorld() {
  return localStorage.getItem("gmReview.world") || null;
}

async function spApi(path, opts) {
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

function spWithWorld(params) {
  const p = new URLSearchParams(params || {});
  const w = currentWorld();
  if (w) p.set("world", w);
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Phase 36 task 36.2, §7 -- the quiet "in Foundry · updated Xm ago" line's
 * relative-time formatting. Coarse on purpose (minutes/hours/days), no
 * seconds granularity -- this is a subtle status line, not a live clock.
 */
function formatRelativeAgo(iso) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const diffMs = Date.now() - then;
  const minutes = Math.max(0, Math.round(diffMs / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Task 17.3: inline-expand note autosave. A single small helper module
// (debounced-save.mjs) provides the pure timer logic; this file owns the
// DOM wiring and the open-panel bookkeeping. Keyed by entityId for
// per-location notes, and by a `__scene_event__<sceneId>` sentinel key for
// task 23.6's scene-level "Add Event" panel below -- both share the SAME
// flush-on-navigate mechanism, guaranteeing an in-progress, not-yet-saved
// note of EITHER kind is never silently lost on navigation.
// ---------------------------------------------------------------------------
const openNotePanels = new Map(); // key -> { panelEl, debounce }

export function flushActiveNoteSave() {
  for (const { debounce } of openNotePanels.values()) {
    debounce.flush();
  }
  // Phase 28 task 28.3: the scene page's click-to-edit fields (place name,
  // narration, element name, element field-lines) each register their live
  // autosave debounce here while their textarea is open, so a nav that fires
  // before the 500ms debounce lands never silently drops a typed-but-
  // -unsaved edit (same guarantee the note panels above already have).
  for (const debounce of sceneEditDebounces) {
    debounce.flush();
  }
}

// ---------------------------------------------------------------------------
// Shared type-ahead entity picker (task 17.1's scene-bootstrap location
// picker, task 17.5's re-center picker, task 23.2's add-node picker, and
// task 23.3's insert-scene "existing place" picker ALL use THIS ONE
// component -- never a second combo-box implementation).
// ---------------------------------------------------------------------------
function buildEntityPicker({ testidPrefix, placeholder = "Search entities…", excludeId = null, defaultTypeFilter = null, onSelect }) {
  const wrap = document.createElement("div");
  wrap.className = "entity-picker";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = placeholder;
  input.className = "entity-picker-input";
  input.setAttribute("data-testid", `${testidPrefix}-input`);
  wrap.appendChild(input);

  const status = document.createElement("div");
  status.className = "hint";
  status.textContent = "Loading entities…";
  wrap.appendChild(status);

  const results = document.createElement("ul");
  results.className = "entity-picker-results";
  results.setAttribute("data-testid", `${testidPrefix}-results`);
  wrap.appendChild(results);

  let allNodes = [];

  function visibleNodes(q) {
    if (q) return allNodes.filter((n) => n.name.toLowerCase().includes(q) || n.type.toLowerCase().includes(q));
    if (defaultTypeFilter) return allNodes.filter((n) => n.type.toLowerCase() === defaultTypeFilter.toLowerCase());
    return allNodes;
  }

  function renderResults() {
    const q = input.value.trim().toLowerCase();
    const matches = visibleNodes(q).slice(0, 25);
    results.innerHTML = "";
    for (const n of matches) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "link-btn entity-picker-option";
      btn.textContent = `${n.name} (${n.type})`;
      btn.setAttribute("data-testid", `${testidPrefix}-option`);
      btn.setAttribute("data-entity-id", n.id);
      btn.addEventListener("click", () => onSelect(n, btn));
      li.appendChild(btn);
      results.appendChild(li);
    }
    if (!matches.length) {
      const li = document.createElement("li");
      li.className = "hint";
      li.textContent = "No matches.";
      results.appendChild(li);
    }
  }

  (async () => {
    try {
      const graph = await spApi(`/api/graph${spWithWorld({ filter: "all" })}`);
      allNodes = (graph.nodes || []).filter((n) => n.id !== excludeId);
      status.textContent = defaultTypeFilter
        ? `Showing ${defaultTypeFilter}s by default (${allNodes.length} entities total) — type to search all types.`
        : `${allNodes.length} entities — type to narrow.`;
      renderResults();
    } catch (err) {
      status.textContent = `Could not load entities: ${err.message}`;
    }
  })();

  input.addEventListener("input", renderResults);

  return wrap;
}

// ---------------------------------------------------------------------------
// Deterministic non-monotonic render order within one scene's own members
// grid (design record §3 / phase-17-tasks.md 17.2's HARD requirement):
// never sort by `distance`. Reused for both the corridor-brief locations
// AND task 23.2's "added" nodes.
// ---------------------------------------------------------------------------
function hashString(s) {
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hashOrderLocations(locations) {
  return [...locations].sort((a, b) => hashString(a.entityId) - hashString(b.entityId));
}

// ---------------------------------------------------------------------------
// withSlowNoticeIndicator -- combat-planning-view.js's own pattern, mirrored
// here (this file is deliberately standalone, no cross-view imports) so
// this phase's two genuine LLM call sites (develop-scene, quick-gen) get
// the SAME real `[data-testid="still-working-indicator"]` element the
// project's established loading-scope e2e convention checks for. Nothing
// else in this file may use this -- see this file's own self-review report
// for the grep confirming that.
// ---------------------------------------------------------------------------
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
// Module-level scene-extras cache. Phase 28 task 28.5 scrapped most of the
// old chain/plan construction state (chainSceneIds/currentSceneIdModule/
// chainContainerEl/activePlanIdModule/activePlanContainerEl/
// planSceneLinksRefreshers/visiblePlanSceneLinksSceneId/
// refreshAllPlanSceneLinksLists/sceneRecordCache/addedMembership) along
// with the renderers that were its only consumers -- the live scene page
// (renderScenePage) fetches what it needs per-render instead of threading
// module-level "where am I" state. `entityInfoMapGlobal` is kept: it's
// still read by resolveSceneDisplayName below (a shared helper this task
// deliberately does not delete) -- Phase 37.6 task 2 closed the "currently
// always empty" gap this comment used to document: renderScenePage now
// assigns it from its own per-render `/api/graph` fetch (see the assignment
// next to that fetch), so it's populated on every view init and re-populated
// on every navigation/world change, same as this file's other per-render state.
// ---------------------------------------------------------------------------
let entityInfoMapGlobal = new Map();
const sceneExtrasCache = new Map(); // sceneId -> { brief, undoActions, encounters }

// ---------------------------------------------------------------------------
// Task 11 (reused) -- generic propose->generate->accept/discard control,
// shared verbatim between task 23.4's per-node "Develop this node" button
// (framings fetched on click) and "Develop this scene"'s per-node review
// panel (framings already returned by the batch orchestrator). Calls the
// EXACT SAME existing /api/entities/:entityId/prep/{generate,accept,
// discard} routes either way -- this is what makes "per-node review" real
// rather than a bypass (scene-construction-develop.e2e.mjs's own explicit
// concern).
// ---------------------------------------------------------------------------
function buildPrepDevelopControl(entityId, prefix, framings) {
  const wrap = document.createElement("div");
  wrap.className = "prep-develop-control";
  let selected = null;

  const optionsWrap = document.createElement("div");
  optionsWrap.className = "prep-framing-options";
  for (const f of framings ?? []) {
    const optBtn = document.createElement("button");
    optBtn.type = "button";
    optBtn.className = "link-btn prep-framing-option";
    optBtn.setAttribute("data-testid", `${prefix}-framing-option`);
    optBtn.setAttribute("data-framing-id", f.id);
    optBtn.textContent = f.sentence;
    optBtn.addEventListener("click", () => {
      selected = f;
      optionsWrap.querySelectorAll(".prep-framing-option").forEach((b) => b.classList.remove("selected"));
      optBtn.classList.add("selected");
    });
    optionsWrap.appendChild(optBtn);
  }
  wrap.appendChild(optionsWrap);

  const genBtn = document.createElement("button");
  genBtn.type = "button";
  genBtn.className = "btn";
  genBtn.setAttribute("data-testid", `${prefix}-generate-btn`);
  genBtn.textContent = "Generate";
  const resultWrap = document.createElement("div");

  genBtn.addEventListener("click", async () => {
    if (!selected) {
      resultWrap.textContent = "Pick a framing first.";
      return;
    }
    genBtn.disabled = true;
    try {
      const genRes = await spApi(`/api/entities/${encodeURIComponent(entityId)}/prep/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld(), selection: { primary: { id: selected.id, sentence: selected.sentence } } })
      });
      resultWrap.innerHTML = "";
      const contentEl = document.createElement("div");
      contentEl.setAttribute("data-testid", `${prefix}-content`);
      contentEl.textContent = genRes.fields?.description ?? JSON.stringify(genRes.fields ?? genRes);
      resultWrap.appendChild(contentEl);

      const acceptBtn = document.createElement("button");
      acceptBtn.type = "button";
      acceptBtn.className = "btn btn--accept";
      acceptBtn.setAttribute("data-testid", `${prefix}-accept-btn`);
      acceptBtn.textContent = "Accept";
      const discardBtn = document.createElement("button");
      discardBtn.type = "button";
      discardBtn.className = "btn btn--reject";
      discardBtn.setAttribute("data-testid", `${prefix}-discard-btn`);
      discardBtn.textContent = "Discard";
      const statusEl = document.createElement("span");
      statusEl.className = "hint";

      acceptBtn.addEventListener("click", async () => {
        acceptBtn.disabled = true;
        discardBtn.disabled = true;
        try {
          await spApi(`/api/entities/${encodeURIComponent(entityId)}/prep/accept`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ world: currentWorld() })
          });
          statusEl.textContent = "Accepted.";
        } catch (err) {
          statusEl.textContent = `Error: ${err.message}`;
          acceptBtn.disabled = false;
          discardBtn.disabled = false;
        }
      });
      discardBtn.addEventListener("click", async () => {
        acceptBtn.disabled = true;
        discardBtn.disabled = true;
        try {
          await spApi(`/api/entities/${encodeURIComponent(entityId)}/prep/discard`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ world: currentWorld() })
          });
          statusEl.textContent = "Discarded.";
        } catch (err) {
          statusEl.textContent = `Error: ${err.message}`;
          acceptBtn.disabled = false;
          discardBtn.disabled = false;
        }
      });
      resultWrap.append(acceptBtn, discardBtn, statusEl);
    } catch (err) {
      resultWrap.textContent = `Could not generate: ${err.message}`;
    } finally {
      genBtn.disabled = false;
    }
  });

  wrap.append(genBtn, resultWrap);
  return wrap;
}

// ---------------------------------------------------------------------------
// Task 23.4: "Develop this node" -- ONE per location-card, every role.
// ---------------------------------------------------------------------------
function mountDevelopNodeControl(card, entityId) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn";
  btn.setAttribute("data-testid", "develop-node-btn");
  btn.setAttribute("data-entity-id", entityId);
  btn.textContent = "Develop this node";

  const panelHolder = document.createElement("div");

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const res = await spApi(`/api/entities/${encodeURIComponent(entityId)}/prep/propose-framings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld() })
      });
      panelHolder.innerHTML = "";
      const panel = document.createElement("div");
      panel.setAttribute("data-testid", "develop-node-panel");
      panel.setAttribute("data-entity-id", entityId);
      panel.appendChild(buildPrepDevelopControl(entityId, "develop-node", res.framings ?? []));
      panelHolder.appendChild(panel);
    } catch (err) {
      panelHolder.textContent = `Could not develop: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  card.append(btn, panelHolder);
}

// ---------------------------------------------------------------------------
// Phase 28 task 28.5 scrapped renderLocationCard/toggleNotePanel (the old
// per-node location-card list + its per-node note panel -- per-scene notes
// only now, design record's "The per-node note system [dropped]") and the
// re-center control (buildRecenterControl/doRecenter/
// activeRecenterController/cancelActiveRecenter) along with the chain view
// that was its only caller -- app.js's nav-cancel hook no longer imports or
// calls cancelActiveRecenter (see app.js's own import line).
// ---------------------------------------------------------------------------

// Phase 28 task 28.4, §C -- the inline `✦` functional-prep assist is ADDITIVE
// and INTERRUPTIBLE: a scene is fully runnable with hand-typed elements and
// zero model round-trips, and any in-flight assist is abandoned the instant
// the DM navigates away (mirroring cancelActiveScan's own precedent --
// app.js calls this from its single nav-cancel hook).
let activeAssistController = null;

export function cancelActiveAssist() {
  if (activeAssistController) {
    activeAssistController.abort();
    activeAssistController = null;
  }
}

// ---------------------------------------------------------------------------
// Phase 28 task 28.5 scrapped buildPlanSceneLinksList (the plan-scoped
// link/unlink list -- scene-to-scene linking is dropped entirely, per the
// design record), buildRecenterControl/doRecenter (the re-center control),
// and renderBootstrap/renderStartNewPlanBar (the old empty-state chain
// bootstrap) along with the chain view that was their only caller. Phase
// 37.6 task 2 scrapped this section's own dead `fetchEntityInfoMap` (an
// unused duplicate of the graph-fetch renderScenePage already does itself,
// now the one assignment site for entityInfoMapGlobal -- see there).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Task 23.6: Add Event (session-notes.mjs's captureNote, sceneId set,
// mirrors toggleNotePanel's autosave pattern verbatim) and Add Encounter
// (real navigation to a return-context-aware Encounter Builder).
//
// Task 25.5 extended both with an optional `testid` param so Table Mode's
// bottom actions bar can mount the SAME mechanism under its own
// table-add-event-btn/table-add-encounter-btn testids -- "wire the same
// actions into a new layout," not new action logic (default value
// preserves the construction view's existing add-event-btn/
// add-encounter-btn testids unchanged).
// ---------------------------------------------------------------------------
function mountAddEventControl(scene, testid = "add-event-btn") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn scene-action-btn";
  btn.setAttribute("data-testid", testid);
  btn.setAttribute("data-scene-id", scene.id);
  btn.textContent = "Add Event";

  const panel = document.createElement("div");
  panel.setAttribute("data-testid", "scene-event-panel");
  panel.setAttribute("data-scene-id", scene.id);
  panel.style.display = "none";

  const textarea = document.createElement("textarea");
  textarea.className = "scene-event-textarea";
  textarea.setAttribute("data-testid", "scene-event-textarea");
  textarea.placeholder = "Jot an event note — autosaves as you type…";
  panel.appendChild(textarea);

  const status = document.createElement("div");
  status.className = "hint";
  panel.appendChild(status);

  const debounce = createFlushableDebounce((value) => {
    if (!value || !value.trim()) return;
    status.textContent = "Saving…";
    spApi("/api/session-planner/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld(), text: value, anchorEntityId: scene.locationEntityId ?? undefined, sceneId: scene.id })
    }).then(() => {
      status.textContent = "Saved.";
    }).catch((err) => {
      status.textContent = `Error saving: ${err.message}`;
    });
  }, { debounceMs: 500 });

  textarea.addEventListener("input", () => debounce.onInput(textarea.value));
  textarea.addEventListener("blur", () => debounce.onBlur(textarea.value));
  openNotePanels.set(`__scene_event__${scene.id}`, { panelEl: panel, debounce });

  btn.addEventListener("click", () => {
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  });

  return { btn, panel };
}

/**
 * Phase 27 task 27.6, F11: reworked from an instant navigate-to-builder into
 * a picker over the world's saved encounters (GET /api/scene-planning/
 * encounters?world=) that ATTACHES the chosen shared definition to this
 * scene (POST .../encounters/:encounterId/attach -- the same definition,
 * not a re-saved copy, so it shows up in every scene it's attached to), plus
 * an "open Encounter Builder" button preserving the old instant-navigate
 * behavior one click deeper. Shared by both the construction view's plain
 * `add-encounter-btn` call site and Table Mode's `table-add-encounter-btn`
 * call site (mountAddEncounterControl's own established one-function-two-
 * call-sites convention, matching mountAddEventControl).
 *
 * @returns {{btn: HTMLElement, panel: HTMLElement}}
 */
function mountAddEncounterControl(scene, testid = "add-encounter-btn") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn scene-action-btn";
  btn.setAttribute("data-testid", testid);
  btn.setAttribute("data-scene-id", scene.id);
  btn.textContent = "Add Encounter";

  const panel = document.createElement("div");
  panel.setAttribute("data-testid", "add-encounter-panel");
  panel.setAttribute("data-scene-id", scene.id);
  panel.style.display = "none";

  const pickerList = document.createElement("div");
  pickerList.setAttribute("data-testid", "add-encounter-picker-list");
  pickerList.setAttribute("data-scene-id", scene.id);

  const status = document.createElement("div");
  status.className = "hint";
  status.setAttribute("data-testid", "add-encounter-picker-status");
  status.setAttribute("data-scene-id", scene.id);

  const openBuilderBtn = document.createElement("button");
  openBuilderBtn.type = "button";
  openBuilderBtn.className = "btn";
  openBuilderBtn.setAttribute("data-testid", "add-encounter-open-builder-btn");
  openBuilderBtn.setAttribute("data-scene-id", scene.id);
  openBuilderBtn.textContent = "Open Encounter Builder";
  openBuilderBtn.addEventListener("click", () => {
    location.hash = `combat-planning/${scene.id}`;
  });

  function buildPickerItem(enc) {
    const item = document.createElement("div");
    item.className = "add-encounter-picker-item";
    item.setAttribute("data-testid", "add-encounter-picker-item");
    item.setAttribute("data-encounter-id", enc.id);

    const name = document.createElement("span");
    name.textContent = enc.name;
    item.appendChild(name);

    const selectBtn = document.createElement("button");
    selectBtn.type = "button";
    selectBtn.className = "btn";
    selectBtn.setAttribute("data-testid", "add-encounter-picker-select-btn");
    selectBtn.setAttribute("data-encounter-id", enc.id);
    selectBtn.textContent = "Add to this scene";
    selectBtn.addEventListener("click", async () => {
      selectBtn.disabled = true;
      try {
        await spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/encounters/${encodeURIComponent(enc.id)}/attach`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ world: currentWorld() })
        });
        status.textContent = `Added "${enc.name}".`;
        await refreshSavedEncountersListInPlace(scene.id);
      } catch (err) {
        status.textContent = `Could not attach: ${err.message}`;
        selectBtn.disabled = false;
      }
    });
    item.appendChild(selectBtn);
    return item;
  }

  async function refreshPicker() {
    status.textContent = "Loading saved encounters…";
    pickerList.innerHTML = "";
    try {
      const res = await spApi(`/api/scene-planning/encounters${spWithWorld()}`);
      const encounters = res.encounters ?? [];
      status.textContent = encounters.length ? "" : "No saved encounters yet in this world.";
      for (const enc of encounters) {
        pickerList.appendChild(buildPickerItem(enc));
      }
    } catch (err) {
      status.textContent = `Could not load saved encounters: ${err.message}`;
    }
  }

  // Idempotent-open + rebuild-fresh, matching this project's established
  // toggle-panel precedent (e.g. buildPlanAddSceneControl, §26.H).
  btn.addEventListener("click", () => {
    panel.style.display = "block";
    refreshPicker();
  });

  panel.append(pickerList, openBuilderBtn, status);
  return { btn, panel };
}

async function fetchSavedEncounters(sceneId) {
  try {
    const res = await spApi(`/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/encounters${spWithWorld()}`);
    return res.encounters ?? [];
  } catch {
    return [];
  }
}

function renderSavedEncountersList(sceneId, encounters) {
  const wrap = document.createElement("div");
  wrap.setAttribute("data-testid", "saved-encounters-list");
  wrap.setAttribute("data-scene-id", sceneId);

  for (const enc of encounters) {
    const item = document.createElement("div");
    item.className = "saved-encounter-item";
    item.setAttribute("data-testid", "saved-encounter-item");
    item.setAttribute("data-encounter-id", enc.id);

    const name = document.createElement("span");
    name.setAttribute("data-testid", "saved-encounter-name");
    name.textContent = enc.name;
    item.appendChild(name);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "icon-btn";
    removeBtn.setAttribute("data-testid", "saved-encounter-remove-btn");
    removeBtn.setAttribute("aria-label", "Remove saved encounter");
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", async () => {
      removeBtn.disabled = true;
      try {
        await spApi(`/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/encounters/${encodeURIComponent(enc.id)}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ world: currentWorld() })
        });
        item.remove();
      } catch {
        removeBtn.disabled = false;
      }
    });
    item.appendChild(removeBtn);

    wrap.appendChild(item);
  }

  return wrap;
}

/** Phase 27 task 27.6: find this scene's own already-mounted saved-encounters-list, if its body has been loaded. */
function findSavedEncountersListEl(sceneId) {
  return [...document.querySelectorAll('[data-testid="saved-encounters-list"]')].find((el) => el.getAttribute("data-scene-id") === sceneId) ?? null;
}

/** Phase 27 task 27.6: re-fetch this scene's own encounters and swap its already-mounted saved-encounters-list for a fresh one -- used after an attach (the picker) so the newly-shared definition shows up without a full scene reload. */
async function refreshSavedEncountersListInPlace(sceneId) {
  const encounters = await fetchSavedEncounters(sceneId);
  const cached = sceneExtrasCache.get(sceneId);
  if (cached) cached.encounters = encounters;
  const existing = findSavedEncountersListEl(sceneId);
  if (!existing) return;
  existing.replaceWith(renderSavedEncountersList(sceneId, encounters));
}

// ---------------------------------------------------------------------------
// Phase 28 task 28.5 scrapped fetchUndoActions/fetchSceneMembers/
// renderRollbackPanel (the old scene-local rollback panel -- replaced by
// the new manual-edit undo mechanism elsewhere), renderDevelopSceneReviewPanel/
// onDevelopScene (the old chain "Develop this scene" review flow --
// buildPrepDevelopControl/mountDevelopNodeControl above cover per-node
// develop for the live scene page), buildPlaceRequiredFlow/
// buildAddSceneControl (the old chain-scoped "add a scene" flow -- scene
// creation is plan-scoped now, via `#plans/<planId>`'s own add-scene
// ghost-row), and ultimateRootId (chain-lineage-root resolution, only ever
// called by the now-removed chain renderers), all along with the chain
// view that was their only caller.
// ---------------------------------------------------------------------------

/** Shared "what do we call this scene" resolution -- Phase 26 task 26.2: a scene's own bespoke `name`, when set, wins over everything else (what makes two scenes at the same anchor, e.g. two scenes both at "Grand Stadium", distinguishable). Falls back, when unset, to the pre-26 behavior: an anchored scene shows its anchor entity's real name; an untethered (quick-gen) scene falls back to its own objective note. Used by both the construction chain's own scene-chain-toggle summary text and Table Mode's nav-zone items/search (task 25.2). */
// Exported (additive) so review-ui/test/resolve-scene-display-name.test.mjs
// can pin the "(place removed)" guard without a DOM.
export function resolveSceneDisplayName(scene) {
  if (scene.name) return scene.name;
  if (scene.locationEntityId) {
    // QA W2 fix (Group B #10): a deleted (or not-yet-loaded) anchor place
    // used to fall back to the raw wf_ id -- never a good display string.
    return entityInfoMapGlobal.get(scene.locationEntityId)?.name ?? "(place removed)";
  }
  return scene.objectiveNote || "Ad-hoc scene";
}

// ===========================================================================
// Phase 28 task 28.3 -- THE ONE SCENE PAGE (edit-in-place, reads like a
// printed module page). Everything below replaces the old three-renderer
// dispatch (chain/plan/table). Task 28.5 scrapped the old chain/plan/table
// helpers that used to sit physically above this point in the file (see the
// scrap-note comments left in their place) -- the URL is the sole source of
// truth, the sceneId comes straight from the hash, and no localStorage
// where-am-I heuristic exists anywhere in this module any more.
//
// Contract: review-ui/test/e2e/phase28-fixture.mjs §3/§4/§5/§6/§10(d). Every
// data-testid / route below is pinned there and matched verbatim.
// ===========================================================================

// Live autosave debounces for the scene page's open click-to-edit textareas
// (registered on enter-edit, flushed on blur AND on navigation via
// flushActiveNoteSave above). At most a handful ever coexist.
const sceneEditDebounces = new Set();

// Phase 29 task 29.4: which elements currently have their stat-block panel
// OPEN. View-local disclosure state (same status as the `openFields` chips in
// the prototype) held at module scope so a structural re-render of the whole
// elements list -- which every add/remove/promote/stat-chip op triggers --
// re-renders an element's panel in the SAME open/closed state it was in,
// rather than snapping shut. Keyed by elementId; cleared implicitly when the
// element stops existing (a stale id in the Set is harmless -- no element row
// reads it).
const openStatPanels = new Set();

// The scene page's [ / ] / Esc keyboard handler, held at module scope so each
// re-render can detach the previous one before wiring a fresh one (never
// stacked). The e2e drives the buttons, but the design record calls for the
// shortcuts too (run the session by pressing next).
let activeSceneKeydownHandler = null;

// Monotonic render token. A page.goto that only changes the hash can fire a
// second renderCurrentView while the first render is still awaiting its
// fetches; without this guard both async renders reach `container.appendChild
// (root)` after both have cleared the container, leaving TWO scene-page roots
// (and duplicate element rows sharing a data-element-id). Every awaiting
// render carries the token it started with and bails the moment a newer
// render supersedes it.
let sceneRenderToken = 0;

// Phase 29 task 29.5: Page|Cards layout + Prep|Run mode. View-local state only
// -- NOT persisted (no localStorage). The URL stays the single source of truth
// for LOCATION; these are pure presentation toggles.
// Driven by a `data-layout` attribute on the scene-elements-list and a
// `data-mode` attribute on the scene-page root + CSS, so toggling never
// full-re-renders the element rows (edit state is preserved), matching this
// app's "never full-re-render on keystroke" ethos.
// Cards mode removed (persona round + Russell, 2026-08-31); then the two
// remaining controls (Page|Layout + Prep|Run) merged into ONE three-way
// Prep | Layout | Run control (variants round, 2026-09-01) -- the old
// orthogonal pair allowed the nonsense state "board AND run" (the board sat
// hidden under the spread). One view var, three states.
let sceneView = "prep"; // "prep" (page list) | "board" (layout board) | "run" (spread)
// O1 (variants round): the Prep layout rail's disclosure — view-local like
// sceneView, persists across scene nav, resets with it.
let railOpen = false;
// QA W2 fix (Group A #1): the view must survive prev/next/rail navigation
// between scenes -- it only resets when the world changes underneath it, or
// when the caller explicitly leaves the planner surface (resetScenePageMode,
// called by app-shell.js when it switches to World/Chronicle/Library).
let scenePageModeWorld = null;

// Exported so app-shell.js can reset the view when the shell navigates away
// from the planner surface entirely (World/Chronicle/Library) -- scene
// navigation WITHIN the planner must never call this.
export function resetScenePageMode() {
  sceneView = "prep";
  railOpen = false;
  scenePageModeWorld = null;
}

function detachSceneKeydownHandler() {
  if (activeSceneKeydownHandler) {
    document.removeEventListener("keydown", activeSceneKeydownHandler);
    activeSceneKeydownHandler = null;
  }
}

// Element field vocabulary (verbatim from scene-elements.mjs / contract §4).
// trigger + gives are the always-offered core (surfaced first in the add-field
// menu); every field renders a field-line ONLY when non-empty -- the GM is
// never confronted with an empty box (design record's ruthless-minimum rule).
const SCENE_FIELD_ORDER = ["trigger", "gives", "looks", "means", "checks", "function", "wants", "secret"];
const SCENE_TEXT_FIELDS = ["trigger", "gives", "looks", "means", "function", "wants", "secret"];
const SCENE_FIELD_LABELS = {
  trigger: "Trigger", gives: "Gives", looks: "Looks", means: "Means",
  checks: "Checks", function: "Function", wants: "Wants", secret: "Secret"
};

/**
 * The click-to-edit primitive shared by every editable value on the page
 * (place name, narration, element name, element field-lines). Renders as
 * plain typeset text at rest -- NO visible input chrome. A real `.click()`
 * (never focus alone -- the display element is not focusable) swaps in an
 * auto-growing textarea, autosaving via createFlushableDebounce (debounced on
 * input, flushed on blur + on navigation). Mutates its OWN DOM in place on
 * commit; never re-renders anything else.
 *
 * @returns {{el:HTMLElement, enterEdit:()=>void, setValue:(v:string)=>void}}
 */
// QA W2 fix (Group A #2): trims only TRAILING whitespace/newlines (never
// leading, never internal) before a value reaches `save()` -- the backstop
// half of the Enter-commits fix below, since a paste or a multi-line field's
// own legitimate newlines can still leave trailing junk on save.
function trimTrailingWhitespace(v) {
  return typeof v === "string" ? v.replace(/[ \t\r\n]+$/, "") : v;
}

export function makeClickToEditField({ tag = "div", className = "", testid, dataAttrs = {}, inputTestid, inputDataAttrs = {}, value = "", placeholder = "", emptyText = "", save, onSaved, multiline = false }) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.setAttribute("data-testid", testid);
  for (const [k, v] of Object.entries(dataAttrs)) el.setAttribute(k, v);
  let currentValue = value ?? "";
  let editing = false;

  function renderRest() {
    const has = currentValue != null && String(currentValue).length > 0;
    el.textContent = has ? currentValue : emptyText;
    el.classList.toggle("scene-field--empty", !has);
  }

  function enterEdit(caretOffset = null) {
    if (editing) return;
    editing = true;
    el.textContent = "";
    el.classList.remove("scene-field--empty");
    // Editing keeps the text's laid-out SHAPE (variants-round feedback: the
    // host span collapsed once emptied, so the 100%-width textarea inherited
    // ~nothing and rendered narrow-and-tall). Block + full width = the
    // textarea wraps exactly like the resting text did.
    el.classList.add("scene-field--editing");
    const ta = document.createElement("textarea");
    ta.className = "scene-edit-textarea";
    ta.setAttribute("data-testid", inputTestid);
    for (const [k, v] of Object.entries(inputDataAttrs)) ta.setAttribute(k, v);
    if (placeholder) ta.placeholder = placeholder;
    ta.value = currentValue;
    ta.rows = 1;

    // Phase 36 task 36.4a -- optional `onSaved` fires only after a save
    // actually resolves (never on rejection), letting the scene page's
    // "in Foundry" status-line poll restart itself after a real mutation.
    // Every OTHER caller of this shared field simply omits `onSaved` --
    // zero behavior change for them.
    const debounce = createFlushableDebounce((v) => {
      Promise.resolve(save(v)).then(() => onSaved?.(v), () => {});
    }, { debounceMs: 500 });
    sceneEditDebounces.add(debounce);

    function autoGrow() {
      ta.style.height = "auto";
      ta.style.height = `${ta.scrollHeight}px`;
    }
    ta.addEventListener("input", () => { autoGrow(); debounce.onInput(trimTrailingWhitespace(ta.value)); });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.stopPropagation(); ta.blur(); }
      else if (e.key === "Enter" && !multiline) {
        // QA W2 fix (Group A #2): single-line fields commit on Enter (matches
        // the World-tab name field's existing preventDefault+blur behavior)
        // instead of inserting a literal newline -- previously a bare Enter
        // in e.g. an element name field saved a value like "Name\n", which
        // then landed verbatim in the graph via promote. Genuinely multi-line
        // fields (narration/objective/place description/statblock raw paste)
        // pass `multiline: true` and keep normal newline-on-Enter.
        e.preventDefault();
        ta.blur();
      }
    });
    ta.addEventListener("blur", () => {
      const v = trimTrailingWhitespace(ta.value);
      debounce.onBlur(v); // flush the pending save immediately
      sceneEditDebounces.delete(debounce);
      currentValue = v;
      editing = false;
      el.classList.remove("scene-field--editing");
      renderRest();
    });
    el.appendChild(ta);
    ta.focus();
    autoGrow();
    // Land the cursor where the click happened instead of at the end —
    // "wherever I click, my cursor ends up and I can just start editing".
    if (caretOffset != null) {
      const pos = Math.max(0, Math.min(caretOffset, ta.value.length));
      ta.setSelectionRange(pos, pos);
    }
  }

  el.addEventListener("click", (e) => {
    if (editing) return;
    // The rendered value is one text node (renderRest sets textContent), so
    // the browser's caret-from-point offset maps 1:1 onto the string.
    let caret = null;
    try {
      if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(e.clientX, e.clientY);
        if (r && el.contains(r.startContainer)) caret = r.startOffset;
      } else if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(e.clientX, e.clientY);
        if (p && el.contains(p.offsetNode)) caret = p.offset;
      }
    } catch { caret = null; }
    enterEdit(caret);
  });
  renderRest();
  return { el, enterEdit, setValue(v) { currentValue = v ?? ""; if (!editing) renderRest(); } };
}

// ---------------------------------------------------------------------------
// §5/§6 -- the elements list (data-driven: any structural op -- add / remove /
// promote / demote -- re-fetches and re-renders the whole list; only per-field
// TYPING mutates DOM in place, never a full re-render).
// ---------------------------------------------------------------------------

function buildElementFieldLine(scene, element, field, value, { autoEdit = false } = {}) {
  const line = document.createElement("div");
  line.className = "pf-line";
  // Phase 29 task 29.5: mirror the field name onto the line itself so Run-mode
  // CSS can keep only the Gives line ([data-field="gives"]) on a collapsed
  // MUNDANE row without an :has() query.
  line.setAttribute("data-field", field);
  // Phase 4 draft-marking (persona round): a field whose current value is
  // unreviewed LLM output carries data-draft="true" (amber ✦ via CSS). The
  // store clears the mark on any ordinary save; mirror that locally so the
  // mark disappears the moment the GM's edit lands, before any re-render.
  if (Array.isArray(element.draftFields) && element.draftFields.includes(field)) {
    line.setAttribute("data-draft", "true");
    line.title = "Model-drafted, not reviewed yet — editing this field clears the mark";
  }
  // Phase 4 (persona round): the label is role-aware via the ONE shared
  // runFieldLabel mapping, so Prep shows the same word Run will print (a
  // card-role element's Looks field reads EFFECT here too, not just in Run).
  const fieldLabel = runFieldLabel(effectiveRun(element).run.role, field, SCENE_FIELD_LABELS[field] ?? field);
  const label = document.createElement("span");
  label.className = "pf-label";
  label.textContent = fieldLabel;
  const valueField = makeClickToEditField({
    tag: "span",
    className: "pf-value",
    testid: "scene-element-field",
    dataAttrs: { "data-field": field },
    inputTestid: "scene-element-field-input",
    inputDataAttrs: { "data-field": field },
    value,
    placeholder: `${fieldLabel}…`,
    emptyText: `+ ${fieldLabel}`,
    save: (v) => spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements/${encodeURIComponent(element.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld(), fields: { [field]: v } })
    }).then((r) => {
      // The store just cleared this key from draftFields (no draft:true on
      // an ordinary save) -- drop the local mark immediately.
      line.removeAttribute("data-draft");
      line.removeAttribute("title");
      if (Array.isArray(element.draftFields)) element.draftFields = element.draftFields.filter((k) => k !== field);
      return r;
    })
  });
  line.append(label, valueField.el);
  if (autoEdit) valueField.enterEdit();
  return line;
}

function buildChecksLine(checks) {
  const line = document.createElement("div");
  line.className = "pf-line";
  line.setAttribute("data-field", "checks");
  const label = document.createElement("span");
  label.className = "pf-label";
  label.textContent = SCENE_FIELD_LABELS.checks;
  const val = document.createElement("span");
  val.className = "pf-value";
  val.setAttribute("data-testid", "scene-element-field");
  val.setAttribute("data-field", "checks");
  val.textContent = checks.map((c) => `${c.skill} DC ${c.dc}${c.purpose ? ` — ${c.purpose}` : ""}`).join("; ");
  line.append(label, val);
  return line;
}

function renderElementFieldLines(scene, element, fieldsEl) {
  fieldsEl.innerHTML = "";
  for (const f of SCENE_FIELD_ORDER) {
    if (f === "checks") {
      const checks = element.fields?.checks;
      if (Array.isArray(checks) && checks.length) fieldsEl.appendChild(buildChecksLine(checks));
      continue;
    }
    const raw = element.fields?.[f];
    if (raw == null || String(raw).trim() === "") continue;
    fieldsEl.appendChild(buildElementFieldLine(scene, element, f, String(raw)));
  }
}

function buildAddFieldControl(scene, element, fieldsEl, refreshList) {
  const present = new Set(
    SCENE_TEXT_FIELDS.filter((f) => element.fields?.[f] != null && String(element.fields[f]).trim() !== "")
  );
  const missing = SCENE_TEXT_FIELDS.filter((f) => !present.has(f));
  // Phase 29 task 29.4: the "+ STAT BLOCK" chip joins the same dashed add-field
  // chip row, and only when the element has NO stat yet (same "only unfilled
  // things get a chip" rule the text-field chips follow). An element can carry
  // stat AND still have missing text fields, so these two are independent.
  const canAddStat = !element.stat;
  if (!missing.length && !canAddStat) return null;

  const wrap = document.createElement("div");
  wrap.className = "scene-add-field";

  if (missing.length) {
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "link-btn scene-add-field-btn";
    addBtn.textContent = "+ field";
    const menu = document.createElement("div");
    menu.className = "scene-add-field-menu";
    menu.style.display = "none";

    for (const f of missing) {
      const opt = document.createElement("button");
      opt.type = "button";
      opt.className = "link-btn scene-add-field-option";
      // Role-aware, same mapping as the field lines and the Run spread.
      opt.textContent = runFieldLabel(effectiveRun(element).run.role, f, SCENE_FIELD_LABELS[f]);
      opt.addEventListener("click", () => {
        menu.style.display = "none";
        // Insert an empty field-line already in edit mode -- a real value on
        // blur persists (only-non-empty rule keeps a blank one from sticking).
        fieldsEl.appendChild(buildElementFieldLine(scene, element, f, "", { autoEdit: true }));
        opt.remove();
      });
      menu.appendChild(opt);
    }

    addBtn.addEventListener("click", () => {
      menu.style.display = menu.style.display === "none" ? "" : "none";
    });
    wrap.append(addBtn, menu);
  }

  if (canAddStat) {
    const statChip = document.createElement("button");
    statChip.type = "button";
    statChip.className = "link-btn scene-add-field-btn add-statblock-chip";
    statChip.setAttribute("data-testid", "add-statblock-chip");
    statChip.setAttribute("data-element-id", element.id);
    statChip.textContent = "+ STAT BLOCK";
    statChip.addEventListener("click", async () => {
      statChip.disabled = true;
      try {
        // Attach an empty stat AND a default statblockRef label in one PATCH --
        // the backend shallow-merges both `stat` and `fields`, so no other
        // field is disturbed. Open the panel, then re-render the row.
        await spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements/${encodeURIComponent(element.id)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            world: currentWorld(),
            stat: { count: 1, ac: "", hp: "", speed: "", cr: "", raw: "", foundryActor: "" },
            fields: { statblockRef: "Stat block" }
          })
        });
      } catch {
        statChip.disabled = false;
        return;
      }
      openStatPanels.add(element.id);
      await refreshList();
    });
    wrap.appendChild(statChip);
  }

  return wrap;
}

// ---------------------------------------------------------------------------
// Phase 29 task 29.4 -- the stat-block disclosure + panel. Rendered on any
// element carrying a `stat`. The disclosure line toggles the panel (view-local
// via openStatPanels). Inside: a header with the element name + a `− N +`
// count stepper; a repeat(4,1fr) grid of editable AC/HP/Speed/CR boxes; a
// free-text raw paste block; and an editable Foundry actor-id line (teal when
// set). Every editable field reuses the SAME click-to-edit textarea-swap
// (makeClickToEditField) as the rest of the page, autosaving a PARTIAL
// `{stat:{<field>:value}}` PATCH -- the backend shallow-merge keeps every
// sibling stat field untouched. `count` is a number; the rest are strings.
// `foundryActor` is stored only -- no push is wired (design record's decision).
// ---------------------------------------------------------------------------
function buildStatBlock(scene, element, refreshList) {
  const stat = element.stat || {};
  const label = (element.fields && element.fields.statblockRef) || "Stat block";
  let count = typeof stat.count === "number" ? stat.count : 1;

  const patchStat = (patch) => spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements/${encodeURIComponent(element.id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: currentWorld(), ...patch })
  });

  const wrap = document.createElement("div");
  wrap.className = "sp-statblock";

  const panel = document.createElement("div");
  panel.className = "sp-statblock-panel";
  panel.setAttribute("data-testid", "element-statblock-panel");
  panel.setAttribute("data-element-id", element.id);
  const startOpen = openStatPanels.has(element.id);
  panel.style.display = startOpen ? "" : "none";

  const toggle = document.createElement("div");
  toggle.className = "sp-statblock-toggle";
  toggle.setAttribute("data-testid", "element-statblock-toggle");
  toggle.setAttribute("data-element-id", element.id);
  const toggleText = (open) => `${open ? "▾" : "▸"} ${label}${count > 1 ? `  ×${count}` : ""}`;
  toggle.textContent = toggleText(startOpen);
  toggle.addEventListener("click", () => {
    const nowOpen = panel.style.display === "none";
    panel.style.display = nowOpen ? "" : "none";
    if (nowOpen) openStatPanels.add(element.id);
    else openStatPanels.delete(element.id);
    toggle.textContent = toggleText(nowOpen);
  });
  wrap.appendChild(toggle);

  // Header: element name + count stepper.
  const header = document.createElement("div");
  header.className = "sp-statblock-header";
  const nameEl = document.createElement("div");
  nameEl.className = "sp-statblock-name";
  nameEl.textContent = element.name;
  header.appendChild(nameEl);

  const stepper = document.createElement("div");
  stepper.className = "sp-statblock-count-stepper";
  const downBtn = document.createElement("button");
  downBtn.type = "button";
  downBtn.className = "sp-statblock-count-btn";
  downBtn.setAttribute("data-testid", "statblock-count-down-btn");
  downBtn.setAttribute("data-element-id", element.id);
  downBtn.textContent = "−";
  const countEl = document.createElement("span");
  countEl.className = "sp-statblock-count";
  countEl.setAttribute("data-testid", "statblock-count");
  countEl.setAttribute("data-element-id", element.id);
  countEl.textContent = `×${count}`;
  const upBtn = document.createElement("button");
  upBtn.type = "button";
  upBtn.className = "sp-statblock-count-btn";
  upBtn.setAttribute("data-testid", "statblock-count-up-btn");
  upBtn.setAttribute("data-element-id", element.id);
  upBtn.textContent = "+";
  const applyCount = (next) => {
    const clamped = Math.max(1, next); // README's floor -- can't step below ×1
    if (clamped === count) return;
    count = clamped;
    countEl.textContent = `×${count}`;
    toggle.textContent = toggleText(panel.style.display !== "none");
    patchStat({ stat: { count } }).catch(() => {});
  };
  downBtn.addEventListener("click", () => applyCount(count - 1));
  upBtn.addEventListener("click", () => applyCount(count + 1));
  stepper.append(downBtn, countEl, upBtn);
  header.appendChild(stepper);
  panel.appendChild(header);

  // AC / HP / Speed / CR grid.
  const grid = document.createElement("div");
  grid.className = "sp-statblock-grid";
  for (const [key, lab] of [["ac", "AC"], ["hp", "HP"], ["speed", "Speed"], ["cr", "CR"]]) {
    const box = document.createElement("div");
    box.className = "sp-statblock-box";
    const boxLabel = document.createElement("div");
    boxLabel.className = "sp-statblock-box-label";
    boxLabel.textContent = lab;
    const field = makeClickToEditField({
      tag: "div",
      className: "sp-statblock-box-value",
      testid: `statblock-${key}`,
      dataAttrs: { "data-element-id": element.id },
      inputTestid: `statblock-${key}-input`,
      inputDataAttrs: { "data-element-id": element.id },
      value: stat[key] || "",
      emptyText: "",
      save: (v) => patchStat({ stat: { [key]: v } })
    });
    box.append(boxLabel, field.el);
    grid.appendChild(box);
  }
  panel.appendChild(grid);

  // Raw paste block.
  const rawLabel = document.createElement("div");
  rawLabel.className = "sp-statblock-raw-label";
  rawLabel.textContent = "Paste the rest — abilities, traits, actions";
  panel.appendChild(rawLabel);
  const rawField = makeClickToEditField({
    tag: "div",
    className: "sp-statblock-raw",
    testid: "statblock-raw",
    dataAttrs: { "data-element-id": element.id },
    inputTestid: "statblock-raw-input",
    inputDataAttrs: { "data-element-id": element.id },
    value: stat.raw || "",
    emptyText: "",
    multiline: true, // free-text paste block, genuinely multi-line
    save: (v) => patchStat({ stat: { raw: v } })
  });
  panel.appendChild(rawField.el);

  // Foundry actor-id line (stored only).
  const foundryRow = document.createElement("div");
  foundryRow.className = "sp-statblock-foundry-row";
  const foundryLabel = document.createElement("span");
  foundryLabel.className = "sp-statblock-foundry-label";
  foundryLabel.textContent = "Foundry";
  const foundryField = makeClickToEditField({
    tag: "span",
    className: "sp-statblock-foundry",
    testid: "statblock-foundry",
    dataAttrs: { "data-element-id": element.id },
    inputTestid: "statblock-foundry-input",
    inputDataAttrs: { "data-element-id": element.id },
    value: stat.foundryActor || "",
    placeholder: "Actor.xxxxxxxx",
    emptyText: "Not linked to a Foundry actor",
    save: (v) => patchStat({ stat: { foundryActor: v.trim() } })
  });
  foundryRow.append(foundryLabel, foundryField.el);
  panel.appendChild(foundryRow);

  wrap.appendChild(panel);
  return wrap;
}

function buildSceneElementRow(scene, element, refreshList, nodeMap) {
  const row = document.createElement("div");
  row.className = `scene-element-row ${element.kind === "graph" ? "scene-element-row--key" : "scene-element-row--mundane"}`;
  row.setAttribute("data-testid", "scene-element-row");
  row.setAttribute("data-element-id", element.id);
  row.setAttribute("data-kind", element.kind);
  // Phase 29 task 29.5: Run mode collapses a MUNDANE (local, no stat) row to
  // its Gives line only; a local row that carries a stat block (an NPC/creature)
  // is NOT collapsed. This attribute lets the CSS distinguish the two cleanly.
  row.setAttribute("data-has-stat", element.stat ? "true" : "false");
  // Run layout (2026-08-26): a seeded, still-empty placeholder renders dashed
  // with a "fill me" hint; the flag clears server-side on the first real edit.
  if (element.run?.placeholder) row.setAttribute("data-placeholder", "true");

  // Design pass (task 28.6): a KEY row's glyph/accent-rule/toggle are tinted
  // with its real graph entity type's color (--element-type-color, read by
  // style.css) -- a pure CSS custom property, no DOM restructuring, no
  // testid touched. Falls back to the plain --accent token (style.css's own
  // `var(--element-type-color, var(--accent))`) when the type is unknown,
  // e.g. before `graph` finishes loading.
  if (element.kind === "graph" && element.graphEntityId) {
    const entityType = nodeMap?.get(element.graphEntityId)?.type;
    if (entityType) row.style.setProperty("--element-type-color", colorForType(entityType));
  }

  const head = document.createElement("div");
  head.className = "scene-element-head";

  const glyph = document.createElement("span");
  glyph.className = "scene-element-glyph";
  glyph.textContent = element.kind === "graph" ? "◆" : "◦";
  // O1 (variants round): the glyph doubles as the row's DRAG GRIP — only the
  // glyph is draggable (never the row itself), so click-to-edit and text
  // selection in the rest of the row stay untouched. Drop targets are the
  // rail's lanes/cards (and the board's, though rows and board never
  // coexist).
  glyph.draggable = true;
  glyph.setAttribute("data-testid", "scene-element-grip");
  glyph.title = "Drag into a layout lane to place this element";
  glyph.addEventListener("dragstart", (e) => {
    laneDragId = element.id;
    e.dataTransfer.setData("text/plain", element.id);
    e.dataTransfer.effectAllowed = "move";
  });
  glyph.addEventListener("dragend", () => { laneDragId = null; });
  head.appendChild(glyph);

  if (element.kind === "graph" && element.graphEntityId) {
    const badge = document.createElement("span");
    badge.className = "scene-element-graph-badge";
    badge.setAttribute("data-testid", "scene-element-graph-badge");
    badge.setAttribute("data-graph-entity-id", element.graphEntityId);
    badge.textContent = "⛓ graph";
    badge.title = "This element is a KEY graph node";
    head.appendChild(badge);
  }

  const nameField = makeClickToEditField({
    tag: "span",
    className: "scene-element-name",
    testid: "scene-element-name",
    inputTestid: "scene-element-name-input",
    value: element.name,
    placeholder: "Element name…",
    emptyText: "(unnamed element)",
    save: (v) => spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements/${encodeURIComponent(element.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld(), name: v })
    })
  });
  head.appendChild(nameField.el);
  // Run layout (2026-08-26): the quiet "where does this go in Run" chip.
  head.appendChild(buildRunRoleChip(scene, element));

  const controls = document.createElement("div");
  controls.className = "scene-element-controls";

  const keyToggle = document.createElement("button");
  keyToggle.type = "button";
  keyToggle.className = "icon-btn scene-element-key-toggle";
  keyToggle.setAttribute("data-testid", "scene-element-key-toggle");
  keyToggle.setAttribute("data-element-id", element.id);
  keyToggle.setAttribute("data-kind", element.kind);
  keyToggle.textContent = "⭑";
  keyToggle.title = element.kind === "graph" ? "Demote to scene-local (keeps the graph node)" : "Promote to a KEY graph node";
  keyToggle.addEventListener("click", async () => {
    keyToggle.disabled = true;
    const verb = element.kind === "graph" ? "demote" : "promote";
    try {
      await spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements/${encodeURIComponent(element.id)}/${verb}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld() })
      });
      await refreshList();
    } catch {
      keyToggle.disabled = false;
    }
  });
  controls.appendChild(keyToggle);

  // §C: a quiet `✦` draft-fields ghost link (additive/interruptible LLM assist).
  controls.appendChild(buildDraftFieldsGhostLink(scene, element, refreshList));

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "icon-btn scene-element-remove-btn";
  removeBtn.setAttribute("data-testid", "scene-element-remove-btn");
  removeBtn.setAttribute("data-element-id", element.id);
  removeBtn.title = "Remove element";
  removeBtn.textContent = "✕";
  removeBtn.addEventListener("click", async () => {
    removeBtn.disabled = true;
    try {
      await spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements/${encodeURIComponent(element.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld() })
      });
      await refreshList();
      // Reversible -- undo toast (contract Decision 3), re-creating via the
      // SAME add route (a demoted-graph element re-creates as scene-local; its
      // former node was never deleted, so no double-node is created).
      showUndoToast("Element removed.", async () => {
        await spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ world: currentWorld(), name: element.name, fields: element.fields ?? {} })
        });
        await refreshList();
      });
    } catch {
      removeBtn.disabled = false;
    }
  });
  controls.appendChild(removeBtn);

  head.appendChild(controls);
  row.appendChild(head);

  const fieldsEl = document.createElement("div");
  fieldsEl.className = "scene-element-fields";
  renderElementFieldLines(scene, element, fieldsEl);
  row.appendChild(fieldsEl);

  const addField = buildAddFieldControl(scene, element, fieldsEl, refreshList);
  if (addField) row.appendChild(addField);

  // Phase 29 task 29.4: the stat-block disclosure + panel, on any element that
  // carries a `stat`. Rendered after the add-field chips (the "+ STAT BLOCK"
  // chip disappears once a stat exists, replaced by this disclosure line).
  if (element.stat) row.appendChild(buildStatBlock(scene, element, refreshList));

  return row;
}

// ---------------------------------------------------------------------------
// Run layout (2026-08-26) -- Prep-side organising tools.
//
// (a) buildRunRoleChip: one quiet chip per element row showing `column ·
//     role (· variant)`; muted "auto" styling when the layout is inferred
//     rather than explicit. Click opens a small inline popover (column ×3,
//     role ×8, variant text, Auto) that writes `run` through the ordinary
//     element patch route. Never touches the add-element flow.
// (b) buildLayoutBoard: the third layout ("Layout") -- Main | Side lanes plus
//     an Off shelf; compact cards; HTML5 drag-and-drop between/within lanes
//     (no library) and ↑/↓ buttons as the deterministic path (mirrors
//     plans-view.js's runsheet arrows). Every move persists as: patch
//     `run.column` if it changed, then POST the FULL id order (main ⧺ side
//     ⧺ off) through the existing reorder route so `order` stays one global
//     sequence for the scene.
// ---------------------------------------------------------------------------
function runChipLabel(element) {
  const { run, inferred } = effectiveRun(element);
  const bits = [run.column, ROLE_LABELS[run.role] ?? run.role];
  if (run.variant) bits.push(run.variant);
  if (run.group) bits.push(`⊞ ${run.group}`);
  return { text: bits.join(" · "), inferred, run };
}

async function saveElementRun(scene, element, run) {
  const { element: updated } = await spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements/${encodeURIComponent(element.id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: currentWorld(), run })
  });
  element.run = updated.run;
  return updated;
}

function buildRunRoleChip(scene, element, { onChange } = {}) {
  const wrap = document.createElement("span");
  wrap.className = "scene-element-run";
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "scene-element-run-chip";
  chip.setAttribute("data-testid", "scene-element-run-chip");
  chip.setAttribute("data-element-id", element.id);
  const paint = () => {
    const { text: label, inferred, run } = runChipLabel(element);
    chip.textContent = inferred ? `auto · ${label}` : label;
    chip.setAttribute("data-inferred", inferred ? "true" : "false");
    chip.setAttribute("data-column", run.column);
    chip.setAttribute("data-role", run.role);
    // Stamped so the popover's group <datalist> can offer the scene's
    // existing group names by reading sibling chips -- no extra fetch.
    if (run.group) chip.setAttribute("data-group", run.group);
    else chip.removeAttribute("data-group");
    chip.title = inferred
      ? "Run placement is inferred from the name — click to set it explicitly"
      : "Where this element sits in the Run spread — click to change";
  };
  paint();
  wrap.appendChild(chip);

  let pop = null;
  const close = () => { if (pop) { pop.remove(); pop = null; document.removeEventListener("mousedown", onOutside); } };
  const onOutside = (e) => { if (pop && !e.composedPath().includes(pop) && e.target !== chip) close(); };
  chip.addEventListener("click", () => {
    if (pop) { close(); return; }
    const { run } = effectiveRun(element);
    pop = document.createElement("div");
    pop.className = "scene-element-run-pop";
    pop.setAttribute("data-testid", "scene-element-run-pop");
    const mkGroup = (title, name, values, current, labels) => {
      const g = document.createElement("div");
      g.className = "run-pop-group";
      const h = document.createElement("div"); h.className = "run-pop-title"; h.textContent = title; g.appendChild(h);
      for (const v of values) {
        const l = document.createElement("label");
        l.className = "run-pop-opt";
        const r = document.createElement("input"); r.type = "radio"; r.name = `${name}-${element.id}`; r.value = v; r.checked = v === current;
        r.setAttribute("data-testid", `run-pop-${name}`);
        l.append(r, document.createTextNode(` ${labels?.[v] ?? v}`));
        g.appendChild(l);
      }
      return g;
    };
    pop.appendChild(mkGroup("Column", "column", RUN_COLUMNS, run.column));
    pop.appendChild(mkGroup("Role", "role", RUN_ROLES, run.role, ROLE_LABELS));
    const vg = document.createElement("div"); vg.className = "run-pop-group";
    const vh = document.createElement("div"); vh.className = "run-pop-title"; vh.textContent = "Variant"; vg.appendChild(vh);
    const vi = document.createElement("input"); vi.type = "text"; vi.className = "run-pop-variant"; vi.placeholder = "e.g. Night (optional)"; vi.value = run.variant ?? "";
    vi.setAttribute("data-testid", "run-pop-variant");
    vg.appendChild(vi); pop.appendChild(vg);
    // Group (run-spread consolidation pass): elements sharing a group render
    // as ONE composite card in Run. Free text + a datalist of the scene's
    // existing group names (read off sibling chips' data-group stamps).
    const gg = document.createElement("div"); gg.className = "run-pop-group";
    const gh = document.createElement("div"); gh.className = "run-pop-title"; gh.textContent = "Group"; gg.appendChild(gh);
    const gi = document.createElement("input"); gi.type = "text"; gi.className = "run-pop-variant"; gi.placeholder = "one card with... (optional)"; gi.value = run.group ?? "";
    gi.setAttribute("data-testid", "run-pop-group");
    const knownGroups = [...new Set(
      [...document.querySelectorAll(".scene-element-run-chip[data-group]")].map((c) => c.getAttribute("data-group"))
    )].filter(Boolean);
    if (knownGroups.length) {
      const dl = document.createElement("datalist");
      dl.id = `run-pop-groups-${element.id}`;
      for (const g of knownGroups) { const o = document.createElement("option"); o.value = g; dl.appendChild(o); }
      gi.setAttribute("list", dl.id);
      gg.appendChild(dl);
    }
    gg.appendChild(gi); pop.appendChild(gg);
    const actions = document.createElement("div"); actions.className = "run-pop-actions";
    const save = document.createElement("button"); save.type = "button"; save.className = "btn"; save.textContent = "Save";
    save.setAttribute("data-testid", "run-pop-save");
    const auto = document.createElement("button"); auto.type = "button"; auto.className = "btn"; auto.textContent = "Auto";
    auto.title = "Drop the explicit placement and infer from the name again";
    auto.setAttribute("data-testid", "run-pop-auto");
    actions.append(save, auto); pop.appendChild(actions);
    save.addEventListener("click", async () => {
      const column = pop.querySelector(`input[name="column-${element.id}"]:checked`)?.value;
      const role = pop.querySelector(`input[name="role-${element.id}"]:checked`)?.value;
      const next = { column, role };
      const variant = vi.value.trim();
      if (variant) next.variant = variant;
      const group = gi.value.trim();
      if (group) next.group = group;
      if (element.run?.placeholder) next.placeholder = true;
      save.disabled = true;
      try { await saveElementRun(scene, element, next); paint(); close(); onChange?.(); }
      finally { save.disabled = false; }
    });
    auto.addEventListener("click", async () => {
      auto.disabled = true;
      try { await saveElementRun(scene, element, null); paint(); close(); onChange?.(); }
      finally { auto.disabled = false; }
    });
    pop.addEventListener("mousedown", (e) => e.stopPropagation());
    wrap.appendChild(pop);
    setTimeout(() => document.addEventListener("mousedown", onOutside), 0);
  });
  return wrap;
}

// (seed-run-skeleton Prep ghost retired 2026-09-02 — Option A band; the
// route + wf_seed_run_skeleton remain for agents/tests.)

// ---------------------------------------------------------------------------
// Shared lane model (variants round, 2026-09-01): ONE home for the board's
// and the Prep rail's persistence contract -- entries (elements + grouped
// stacks), lane arrays, the column-patch+reorder persist, the join gesture,
// the one-layer cap, and drag wiring. Board and rail never coexist (board is
// its own view; the rail lives in Prep), so each render owns one instance.
// ---------------------------------------------------------------------------
// dataTransfer.getData is unreadable during dragover (spec), so the
// in-flight id also rides a module var (world-view.js's own convention) --
// shared so a Prep row's grip drag lights the rail's targets too.
let laneDragId = null;

function createLaneModel(scene, elements, refreshList) {
  // Variants round (2026-09-01, gesture G2): grouped elements cluster into
  // ONE stack entry per group (lead = lowest-order member; the stack lives
  // in the lead's lane), and dropping a card ONTO a card joins its group.
  // Lane arrays hold ENTRIES: {kind:'el', el} | {kind:'stack', group, members}.
  const entries = [];
  const stacksByGroup = new Map();
  for (const el of elements) {
    const g = effectiveRun(el).run.group;
    if (g) {
      if (!stacksByGroup.has(g)) {
        const entry = { kind: "stack", group: g, members: [] };
        stacksByGroup.set(g, entry);
        entries.push(entry);
      }
      stacksByGroup.get(g).members.push(el);
    } else {
      entries.push({ kind: "el", el });
    }
  }
  const entryColumn = (entry) =>
    effectiveRun(entry.kind === "stack" ? entry.members[0] : entry.el).run.column;
  const entryHasId = (entry, id) =>
    entry.kind === "stack" ? entry.members.some((m) => m.id === id) : entry.el.id === id;
  const findEntryById = (id) => entries.find((en) => entryHasId(en, id));

  const lanes = { main: [], side: [], off: [] };
  for (const en of entries) lanes[entryColumn(en)].push(en);

  const flattenIds = () =>
    [...lanes.main, ...lanes.side, ...lanes.off].flatMap((en) =>
      en.kind === "stack" ? en.members.map((m) => m.id) : [en.el.id]
    );
  const reorder = async () =>
    spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld(), elementIds: flattenIds() })
    });

  // Persist an ENTRY move: column patch on every element whose column
  // differs (a stack's members move together), then the full order.
  const persist = async (entry, newColumn) => {
    if (entry && newColumn) {
      const moved = entry.kind === "stack" ? entry.members : [entry.el];
      for (const el of moved) {
        const { run } = effectiveRun(el);
        if (run.column !== newColumn) await saveElementRun(scene, el, { ...run, column: newColumn });
      }
    }
    await reorder();
    await refreshList();
  };

  const moveEntry = (entry, column, index) => {
    for (const k of Object.keys(lanes)) {
      const i = lanes[k].indexOf(entry);
      if (i >= 0) { lanes[k].splice(i, 1); lanes[column].splice(index, 0, entry); return; }
    }
  };

  // A member sub-row dropped on a LANE (not on a card) leaves its group:
  // run.group cleared (saveElementRun spreads the whole run, so a re-save
  // without the key IS the clear), placed at the drop position.
  const ungroupTo = async (memberId, column, index) => {
    const stack = findEntryById(memberId);
    if (!stack || stack.kind !== "stack") return;
    const el = stack.members.find((m) => m.id === memberId);
    const { run } = effectiveRun(el);
    const next = { ...run, column };
    delete next.group;
    await saveElementRun(scene, el, next);
    stack.members = stack.members.filter((m) => m.id !== memberId);
    lanes[column].splice(index, 0, { kind: "el", el });
    await reorder();
    await refreshList();
  };

  // The ONE-LAYER CAP (adjudicated): a lead dragging its whole multi-member
  // stack can never JOIN another card -- parent + tabs, never tabs-of-tabs.
  // (The data model cannot nest anyway; this keeps the gesture honest.)
  const joinAllowed = (draggedId, targetEntry) => {
    if (!draggedId || entryHasId(targetEntry, draggedId)) return false;
    const dragged = findEntryById(draggedId);
    if (!dragged) return false;
    if (dragged.kind === "stack" && dragged.members.length > 1 && dragged.members[0].id === draggedId) return false;
    return true;
  };

  const makeGroupName = (leadEl) => {
    const base = (titleAfterDash(leadEl.name, "") || leadEl.name || "group")
      .toLowerCase().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "group";
    if (!stacksByGroup.has(base)) return base;
    let n = 2;
    while (stacksByGroup.has(`${base}-${n}`)) n++;
    return `${base}-${n}`;
  };

  // Drop-ON-a-card = JOIN its group (creating one, slugged from the target's
  // name, when the target is still ungrouped). Column follows the target;
  // the joined element lands right after the group's last member.
  const joinTo = async (targetEntry, draggedId) => {
    if (!joinAllowed(draggedId, targetEntry)) return;
    const dEl = elements.find((e) => e.id === draggedId);
    if (!dEl) return;
    const dRun = effectiveRun(dEl).run;
    const tEl = targetEntry.kind === "stack" ? targetEntry.members[0] : targetEntry.el;
    const tRun = effectiveRun(tEl).run;
    let groupName = targetEntry.kind === "stack" ? targetEntry.group : tRun.group;
    if (!groupName) {
      groupName = makeGroupName(tEl);
      await saveElementRun(scene, tEl, { ...tRun, group: groupName });
    }
    const next = { ...dRun, column: tRun.column, group: groupName };
    // Variants-round feedback: with "+ variant" gone, drag-onto-a-TABBED-card
    // IS how you add a state — a variant-less element joining a group that
    // already has states gets one, derived from its after-dash name
    // (previously it silently became an always-shown section below the tabs,
    // which read as a bug at the table). Joining an untabbed card stays a
    // plain combine; clearing the variant in the chip popover still demotes
    // a state to an always-shown section.
    const targetHasStates = targetEntry.kind === "stack"
      ? targetEntry.members.some((m) => effectiveRun(m).run.variant)
      : !!tRun.variant;
    if (targetHasStates && !next.variant) {
      next.variant = titleAfterDash(dEl.name, "") || dEl.name || "New state";
    }
    await saveElementRun(scene, dEl, next);
    // Order: dragged right after the target group's last member.
    const lastId = targetEntry.kind === "stack" ? targetEntry.members[targetEntry.members.length - 1].id : tEl.id;
    const ids = flattenIds().filter((x) => x !== draggedId);
    ids.splice(ids.indexOf(lastId) + 1, 0, draggedId);
    await spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld(), elementIds: ids })
    });
    await refreshList();
  };



  // ("+ variant" was cut — Russell, 2026-09-01: make the state element with
  // + element in Prep, then DRAG it onto the card; joinTo derives its
  // variant when the target already has states.)

  // Card-level join-zone wiring: the vertical MIDDLE band of a card is the
  // join target (dashed amber); the edges fall through to the lane's
  // reorder handler, so drop-between keeps meaning reorder.
  const wireJoinTarget = (cardEl, targetEntry) => {
    cardEl.addEventListener("dragover", (e) => {
      if (!joinAllowed(laneDragId, targetEntry)) {
        cardEl.classList.remove("layout-card--join-target");
        return; // bubbles to the lane: reorder behavior (the one-layer cap's refusal path)
      }
      const r = cardEl.getBoundingClientRect();
      const band = r.height * 0.25;
      if (e.clientY > r.top + band && e.clientY < r.bottom - band) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        cardEl.classList.add("layout-card--join-target");
      } else {
        cardEl.classList.remove("layout-card--join-target");
      }
    });
    cardEl.addEventListener("dragleave", () => cardEl.classList.remove("layout-card--join-target"));
    cardEl.addEventListener("drop", async (e) => {
      if (!cardEl.classList.contains("layout-card--join-target")) return; // edge drop -> lane reorder
      e.preventDefault();
      e.stopPropagation();
      cardEl.classList.remove("layout-card--join-target");
      await joinTo(targetEntry, e.dataTransfer.getData("text/plain"));
    });
  };

  const wireDragSource = (node, id) => {
    node.draggable = true;
    node.addEventListener("dragstart", (e) => {
      e.stopPropagation(); // a member sub-row's drag must not also start the stack's
      laneDragId = id;
      e.dataTransfer.setData("text/plain", id);
      e.dataTransfer.effectAllowed = "move";
      node.classList.add("layout-card--dragging");
    });
    node.addEventListener("dragend", () => {
      laneDragId = null;
      node.classList.remove("layout-card--dragging");
    });
  };
  // Lane-space drop wiring shared by the board's full lanes AND the Prep
  // rail's mini lanes — one drop contract (reorder / whole-entry move /
  // member-out-ungroups), two card sizes. `cardSelector` names the direct
  // children counted for the insertion index.
  const wireLaneDropTarget = (laneEl, listEl, column, cardSelector) => {
    const indexFromPointer = (y) => {
      const kids = Array.from(listEl.querySelectorAll(`:scope > ${cardSelector}:not(.layout-card--dragging)`));
      let i = 0;
      for (const k of kids) { const r = k.getBoundingClientRect(); if (y > r.top + r.height / 2) i++; }
      return i;
    };
    laneEl.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; laneEl.classList.add("layout-lane--over"); });
    laneEl.addEventListener("dragleave", () => laneEl.classList.remove("layout-lane--over"));
    laneEl.addEventListener("drop", async (e) => {
      e.preventDefault();
      laneEl.classList.remove("layout-lane--over");
      const id = e.dataTransfer.getData("text/plain");
      if (!id) return;
      const entry = findEntryById(id);
      if (!entry) return;
      const idx = indexFromPointer(e.clientY);
      // A stack MEMBER (not the lead) dropped on lane space = ungroup here.
      if (entry.kind === "stack" && entry.members[0].id !== id) {
        await ungroupTo(id, column, idx);
        return;
      }
      // Whole-entry move (plain card, or a stack dragged by its lead card).
      const was = lanes[column].indexOf(entry);
      moveEntry(entry, column, was >= 0 && was < idx ? idx - 1 : idx);
      await persist(entry, column);
    });
  };

  return {
    entries, lanes, entryColumn, entryHasId, findEntryById, flattenIds,
    persist, moveEntry, ungroupTo, joinAllowed, joinTo,
    wireJoinTarget, wireDragSource, wireLaneDropTarget
  };
}

// O1 (variants round, 2026-09-01): the Prep-side layout rail — the board's
// lanes shrunk to a ~220px column living BESIDE the Page rows, so the GM can
// place elements while writing them. Same createLaneModel instance shape,
// same persistence, mini cards (names only; a stack renders as lead + count).
function buildLayoutRail(scene, elements, refreshList) {
  const rail = document.createElement("div");
  rail.className = "scene-layout-rail";
  rail.setAttribute("data-testid", "scene-layout-rail");
  const { lanes, wireJoinTarget, wireDragSource, wireLaneDropTarget } = createLaneModel(scene, elements, refreshList);

  const buildMiniLane = (column, title) => {
    const lane = document.createElement("div");
    lane.className = `rail-lane layout-lane--${column}`;
    lane.setAttribute("data-testid", "rail-lane");
    lane.setAttribute("data-column", column);
    const h = document.createElement("div");
    h.className = "rail-lane-title";
    h.textContent = title;
    lane.appendChild(h);
    const list = document.createElement("div");
    list.className = "rail-lane-list";
    lane.appendChild(list);
    for (const entry of lanes[column]) {
      const isStack = entry.kind === "stack";
      const lead = isStack ? entry.members[0] : entry.el;
      const card = document.createElement("div");
      card.className = isStack ? "rail-card rail-card--stack" : "rail-card";
      card.setAttribute("data-testid", "rail-card");
      card.setAttribute("data-element-id", lead.id);
      const nm = document.createElement("span");
      nm.className = "rail-card-name";
      nm.textContent = lead.name || "(unnamed)";
      card.appendChild(nm);
      if (isStack) {
        const count = document.createElement("span");
        count.className = "rail-card-count";
        count.textContent = `⊞ ${entry.members.length}`;
        count.title = `${entry.members.length} elements on one Run card — the full board (Layout) shows and splits them`;
        card.appendChild(count);
      }
      wireDragSource(card, lead.id);
      wireJoinTarget(card, entry);
      list.appendChild(card);
    }
    if (!lanes[column].length) {
      const empty = document.createElement("div");
      empty.className = "rail-lane-empty";
      empty.textContent = "drop here";
      list.appendChild(empty);
    }
    wireLaneDropTarget(lane, list, column, ".rail-card");
    return lane;
  };

  rail.append(buildMiniLane("main", "Main"), buildMiniLane("side", "Side"), buildMiniLane("off", "Off"));
  return rail;
}

function buildLayoutBoard(scene, elements, refreshList) {
  const board = document.createElement("div");
  board.className = "scene-layout-board";
  board.setAttribute("data-testid", "scene-layout-board");
  board.setAttribute("data-scene-id", scene.id);

  const {
    lanes, persist, moveEntry,
    wireJoinTarget, wireDragSource, wireLaneDropTarget
  } = createLaneModel(scene, elements, refreshList);

  const toolbar = document.createElement("div");
  toolbar.className = "layout-board-toolbar";
  const hint = document.createElement("span");
  hint.className = "layout-board-hint";
  hint.textContent = "Drag cards between lanes to lay the scene out for Run; drop a card ONTO a card to make one card with states (one layer deep — drag a member out to split it off). ↑/↓ reorder within a lane.";
  const inferBtn = document.createElement("button");
  inferBtn.type = "button";
  inferBtn.className = "btn layout-board-infer-btn";
  inferBtn.setAttribute("data-testid", "layout-board-infer-btn");
  inferBtn.textContent = "Infer layout for untagged";
  inferBtn.title = "Write an explicit placement onto every element that still says 'auto' (never changes one you set)";
  inferBtn.addEventListener("click", async () => {
    inferBtn.disabled = true;
    try {
      await spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/run-layout/infer`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ world: currentWorld() })
      });
      await refreshList();
    } finally { inferBtn.disabled = false; }
  });
  toolbar.append(hint, inferBtn);
  board.appendChild(toolbar);

  const lanesWrap = document.createElement("div");
  lanesWrap.className = "layout-board-lanes";
  board.appendChild(lanesWrap);

  const primaryText = (el) => {
    const f = el.fields || {};
    const t = f.looks || f.gives || f.trigger || f.means || f.secret || "";
    const one = String(t).replace(/\s+/g, " ").trim();
    return one.length > 72 ? `${one.slice(0, 72)}…` : one;
  };

  const buildEntryButtons = (entry, column, idx, count) => {
    const btns = document.createElement("div");
    btns.className = "layout-card-btns";
    const primaryId = entry.kind === "stack" ? entry.members[0].id : entry.el.id;
    const up = document.createElement("button");
    up.type = "button"; up.className = "icon-btn layout-card-up"; up.textContent = "↑"; up.title = "Move up";
    up.setAttribute("data-testid", "layout-card-up"); up.setAttribute("data-element-id", primaryId);
    up.disabled = idx === 0;
    up.addEventListener("click", async () => { moveEntry(entry, column, idx - 1); await persist(); });
    const down = document.createElement("button");
    down.type = "button"; down.className = "icon-btn layout-card-down"; down.textContent = "↓"; down.title = "Move down";
    down.setAttribute("data-testid", "layout-card-down"); down.setAttribute("data-element-id", primaryId);
    down.disabled = idx === count - 1;
    down.addEventListener("click", async () => { moveEntry(entry, column, idx + 1); await persist(); });
    const sendTo = document.createElement("select");
    sendTo.className = "layout-card-send";
    sendTo.setAttribute("data-testid", "layout-card-send");
    sendTo.setAttribute("data-element-id", primaryId);
    for (const c of RUN_COLUMNS) {
      const o = document.createElement("option"); o.value = c; o.textContent = c === column ? `in ${c}` : `→ ${c}`; o.selected = c === column;
      sendTo.appendChild(o);
    }
    sendTo.title = "Send to another lane (keyboard-friendly alternative to dragging)";
    sendTo.addEventListener("change", async () => {
      const target = sendTo.value;
      if (target === column) return;
      moveEntry(entry, target, lanes[target].length);
      await persist(entry, target);
    });
    btns.append(up, down, sendTo);
    return btns;
  };

  const buildElementCard = (el) => {
    const card = document.createElement("div");
    card.className = "layout-card";
    card.setAttribute("data-testid", "layout-card");
    card.setAttribute("data-element-id", el.id);
    const { run, inferred } = effectiveRun(el);
    card.setAttribute("data-role", run.role);
    if (el.kind === "graph") card.classList.add("layout-card--key");
    if (run.placeholder) card.classList.add("layout-card--placeholder");

    const top = document.createElement("div");
    top.className = "layout-card-top";
    const name = document.createElement("span");
    name.className = "layout-card-name";
    name.textContent = el.name || "(unnamed)";
    top.appendChild(name);
    top.appendChild(buildRunRoleChip(scene, el, { onChange: refreshList }));
    card.appendChild(top);
    const sub = primaryText(el);
    if (sub) { const p = document.createElement("div"); p.className = "layout-card-text"; p.textContent = sub; card.appendChild(p); }
    if (inferred) card.setAttribute("data-inferred", "true");
    return card;
  };

  // A grouped STACK renders as one card: lead on top, a tab preview, the
  // other members as individually-draggable sub-rows, and "+ variant".
  const buildStackCard = (stack) => {
    const card = document.createElement("div");
    card.className = "layout-card layout-card--stack layout-card--grouped";
    card.setAttribute("data-testid", "layout-stack");
    card.setAttribute("data-group", stack.group);
    const lead = stack.members[0];
    card.setAttribute("data-element-id", lead.id);

    const top = document.createElement("div");
    top.className = "layout-card-top";
    const name = document.createElement("span");
    name.className = "layout-card-name";
    name.textContent = lead.name || "(unnamed)";
    top.appendChild(name);
    top.appendChild(buildRunRoleChip(scene, lead, { onChange: refreshList }));
    card.appendChild(top);

    const variants = stack.members.map((m) => effectiveRun(m).run.variant).filter(Boolean);
    const tabsRow = document.createElement("div");
    tabsRow.className = "layout-stack-tabs";
    for (const v of [...new Set(variants)]) {
      const chip = document.createElement("span");
      chip.className = "layout-stack-tab";
      chip.textContent = v;
      tabsRow.appendChild(chip);
    }
    card.appendChild(tabsRow);

    for (const m of stack.members.slice(1)) {
      const row = document.createElement("div");
      row.className = "layout-stack-member";
      row.setAttribute("data-testid", "layout-stack-member");
      row.setAttribute("data-element-id", m.id);
      row.title = "A member of this card — drag it out to a lane to split it off";
      const mn = document.createElement("span");
      mn.className = "layout-stack-member-name";
      mn.textContent = m.name || "(unnamed)";
      row.appendChild(mn);
      wireDragSource(row, m.id);
      card.appendChild(row);
    }
    return card;
  };

  const buildLane = (column, title) => {
    const lane = document.createElement("div");
    lane.className = `layout-lane layout-lane--${column}`;
    lane.setAttribute("data-testid", "layout-lane");
    lane.setAttribute("data-column", column);
    const h = document.createElement("div");
    h.className = "layout-lane-title";
    h.textContent = title;
    lane.appendChild(h);
    const list = document.createElement("div");
    list.className = "layout-lane-list";
    lane.appendChild(list);

    const laneEntries = lanes[column];
    laneEntries.forEach((entry, idx) => {
      const card = entry.kind === "stack" ? buildStackCard(entry) : buildElementCard(entry.el);
      card.appendChild(buildEntryButtons(entry, column, idx, laneEntries.length));
      // The whole entry drags by its card (a stack drags as one, by its
      // lead's id); every card is also a join target for OTHER cards.
      wireDragSource(card, entry.kind === "stack" ? entry.members[0].id : entry.el.id);
      wireJoinTarget(card, entry);
      list.appendChild(card);
    });

    wireLaneDropTarget(lane, list, column, ".layout-card");
    return lane;
  };

  lanesWrap.appendChild(buildLane("main", "Main — read-aloud, dressing, beats, exits"));
  lanesWrap.appendChild(buildLane("side", "Side — stat blocks, cards, GM boxes, sketch"));
  board.appendChild(buildLane("off", "Off — kept in Prep, not shown in Run"));
  return board;
}

function buildAddElementGhostRow(scene, refreshList) {
  const ghost = document.createElement("div");
  ghost.className = "scene-add-element-row editable-list-ghost-row";
  ghost.setAttribute("data-testid", "scene-add-element-row");
  ghost.setAttribute("data-scene-id", scene.id);

  const label = document.createElement("span");
  label.className = "editable-list-ghost-row-label";
  label.textContent = "+ add element";
  ghost.appendChild(label);

  const panelHost = document.createElement("div");
  ghost.appendChild(panelHost);

  let opened = false;
  ghost.addEventListener("click", () => {
    if (opened) return;
    opened = true;
    label.style.display = "none";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "scene-add-element-name-input";
    input.setAttribute("data-testid", "scene-add-element-name-input");
    input.placeholder = "New element name — Enter to add…";

    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "btn scene-add-element-submit-btn";
    submit.setAttribute("data-testid", "scene-add-element-submit-btn");
    submit.textContent = "Add";

    async function doAdd() {
      const name = input.value.trim();
      if (!name) return;
      submit.disabled = true;
      input.disabled = true;
      try {
        await spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ world: currentWorld(), name })
        });
        // Re-render the whole list -- the row appears and a FRESH ghost row
        // re-arms at the bottom, ready for the next add.
        await refreshList();
      } catch {
        submit.disabled = false;
        input.disabled = false;
      }
    }

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); doAdd(); }
    });
    submit.addEventListener("click", doAdd);

    panelHost.append(input, submit);
    input.focus();
  });

  return ghost;
}

async function renderSceneElementsList(scene, listHost, nodeMap) {
  let elements = [];
  try {
    ({ elements } = await spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements${spWithWorld()}`));
  } catch {
    elements = [];
  }
  listHost.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "scene-elements-list";
  wrap.setAttribute("data-testid", "scene-elements-list");
  wrap.setAttribute("data-scene-id", scene.id);
  // Phase 29 task 29.5: current Page|Cards layout, re-applied on every list
  // re-render so a structural op (add/remove/promote) preserves the toggle.
  wrap.setAttribute("data-layout", sceneView === "board" ? "board" : "page");

  const refreshList = () => renderSceneElementsList(scene, listHost, nodeMap);
  if (sceneView === "board") {
    // Run layout (2026-08-26): the Layout board replaces the rows (the
    // ghost add row stays below it -- adding must stay as easy as ever).
    wrap.appendChild(buildLayoutBoard(scene, elements, refreshList));
    wrap.appendChild(buildAddElementGhostRow(scene, refreshList));
    listHost.appendChild(wrap);
    return;
  }
  for (const element of elements) {
    wrap.appendChild(buildSceneElementRow(scene, element, refreshList, nodeMap));
  }
  wrap.appendChild(buildAddElementGhostRow(scene, refreshList));
  // O1: the Prep layout rail rides beside the rows in one container —
  // `display: contents` while the rail is closed (layout byte-identical to
  // the plain list), a flex row when `.scene-page[data-rail="open"]`.
  const withRail = document.createElement("div");
  withRail.className = "scene-prep-with-rail";
  withRail.append(wrap, buildLayoutRail(scene, elements, refreshList));
  listHost.appendChild(withRail);
}

// ---------------------------------------------------------------------------
// §3 -- breadcrumb + prev/next. The FIRST plan containing this scene (stable
// listPlansForWorld order, via the plansContainingScene route) is the owning
// context; prev/next step within THAT plan's own sceneIds order and are
// absent (real DOM absence) at the ends / for an orphaned scene.
// ---------------------------------------------------------------------------
// Phase 30 task 30.3: `nav` parametrizes the hash targets so the SAME scene
// page renders under the legacy `#session-planner/<id>` chrome (default) and
// the new shell's `#planner/scene/<id>` route. In the shell, the persistent
// breadcrumb chrome (app-shell.js) owns the "‹ Plan / Plans" back link, so the
// in-page back button is suppressed (`showBack:false`) -- only the designer
// sub-bar's ← prev / next → survive here.
async function buildSceneBreadcrumb(scene, plans, nav = {}) {
  const sceneHash = nav.sceneHash || ((id) => `session-planner/${id}`);
  const plansHash = nav.plansHash || ((plan) => (plan ? `plans/${plan.id}` : "plans"));
  const showBack = nav.showBack !== false;
  const firstPlan = plans && plans.length ? plans[0] : null;
  const bc = document.createElement("div");
  bc.className = "scene-breadcrumb";
  bc.setAttribute("data-testid", "scene-breadcrumb");

  if (showBack) {
    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "link-btn scene-breadcrumb-back-btn";
    backBtn.setAttribute("data-testid", "scene-breadcrumb-back-btn");
    backBtn.textContent = `‹ ${firstPlan ? (firstPlan.name || "Plan") : "Plans"}`;
    backBtn.addEventListener("click", () => {
      location.hash = plansHash(firstPlan);
    });
    bc.appendChild(backBtn);
  }

  let prevId = null;
  let nextId = null;
  if (firstPlan) {
    const ids = firstPlan.sceneIds || [];
    const idx = ids.indexOf(scene.id);
    if (idx > 0) prevId = ids[idx - 1];
    if (idx >= 0 && idx < ids.length - 1) nextId = ids[idx + 1];
  }

  // D4 (Phase 34 task 34.3): named prev/next -- `← <prevSceneName>` /
  // `<nextSceneName> →` (`Session Planner.dc.html`'s own `prevLabel`/
  // `nextLabel` binding), replacing the old generic "‹ Prev"/"Next ›". A
  // Plan's own `sceneIds` are ids only (`session-planner/plans.mjs`), so the
  // neighbor's real name needs its own fetch -- resolveSceneDisplayName's
  // same "bespoke name wins, else anchor name, else objective note" rule
  // applied to the fetched neighbor record. At either end of the plan the
  // control STILL RENDERS (not omitted, unlike before), real `disabled`,
  // reading "Start of plan" / "End of plan".
  async function neighborSceneName(id) {
    if (!id) return null;
    try {
      const { scene: s } = await spApi(`/api/session-planner/scenes/${encodeURIComponent(id)}${spWithWorld()}`);
      return resolveSceneDisplayName(s);
    } catch {
      return id;
    }
  }
  const [prevName, nextName] = await Promise.all([neighborSceneName(prevId), neighborSceneName(nextId)]);

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "link-btn scene-breadcrumb-prev-btn";
  prevBtn.setAttribute("data-testid", "scene-breadcrumb-prev-btn");
  if (prevId) {
    prevBtn.textContent = `← ${prevName}`;
    prevBtn.addEventListener("click", () => { location.hash = sceneHash(prevId); });
  } else {
    prevBtn.textContent = "Start of plan";
    prevBtn.disabled = true;
  }
  bc.appendChild(prevBtn);

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "link-btn scene-breadcrumb-next-btn";
  nextBtn.setAttribute("data-testid", "scene-breadcrumb-next-btn");
  if (nextId) {
    nextBtn.textContent = `${nextName} →`;
    nextBtn.addEventListener("click", () => { location.hash = sceneHash(nextId); });
  } else {
    nextBtn.textContent = "End of plan";
    nextBtn.disabled = true;
  }
  bc.appendChild(nextBtn);

  return { bc, firstPlan, prevId, nextId };
}

// ---------------------------------------------------------------------------
// §10(d) -- the "beyond this room" drawer (a real <details>, collapsed by
// default) listing the anchor place's graph neighbors, each with a guarded
// delete-node-from-graph (real confirm step; cascadeEdgeCount sourced DIRECTLY
// from the DELETE route's own response, never precomputed client-side).
// ---------------------------------------------------------------------------
function sceneNeighborEntityIds(placeId, edges) {
  const ids = new Set();
  for (const e of edges || []) {
    if (e.sourceId === placeId && e.targetId && e.targetId !== placeId) ids.add(e.targetId);
    else if (e.targetId === placeId && e.sourceId && e.sourceId !== placeId) ids.add(e.sourceId);
  }
  return [...ids];
}

function buildBeyondRoomDrawer(scene, nodeMap, edges) {
  const details = document.createElement("details");
  details.className = "beyond-room-drawer";
  details.setAttribute("data-testid", "beyond-room-drawer");
  details.setAttribute("data-scene-id", scene.id);

  const summary = document.createElement("summary");
  summary.className = "beyond-room-drawer-toggle";
  summary.setAttribute("data-testid", "beyond-room-drawer-toggle");
  summary.setAttribute("data-scene-id", scene.id);
  summary.textContent = "Beyond this room (graph neighbors)";
  details.appendChild(summary);

  const body = document.createElement("div");
  body.className = "beyond-room-drawer-body";
  details.appendChild(body);

  const neighborIds = scene.locationEntityId ? sceneNeighborEntityIds(scene.locationEntityId, edges) : [];
  if (!neighborIds.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No graph neighbors for this room's place.";
    body.appendChild(empty);
    return details;
  }

  for (const id of neighborIds) {
    const info = nodeMap.get(id);
    const item = document.createElement("div");
    item.className = "beyond-room-neighbor-item";
    item.setAttribute("data-testid", "beyond-room-neighbor-item");
    item.setAttribute("data-entity-id", id);

    const name = document.createElement("span");
    name.className = "beyond-room-neighbor-name";
    name.textContent = `${info?.name ?? id}${info?.type ? ` (${info.type})` : ""}`;
    item.appendChild(name);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn btn--ghost beyond-room-neighbor-delete-btn";
    delBtn.setAttribute("data-testid", "beyond-room-neighbor-delete-btn");
    delBtn.setAttribute("data-entity-id", id);
    delBtn.textContent = "Delete from graph";
    item.appendChild(delBtn);

    const confirmHost = document.createElement("div");
    item.appendChild(confirmHost);

    delBtn.addEventListener("click", () => {
      if (confirmHost.childElementCount) return; // already open
      const panel = document.createElement("div");
      panel.className = "confirm-panel beyond-room-neighbor-delete-confirm-panel";
      panel.setAttribute("data-testid", "beyond-room-neighbor-delete-confirm-panel");
      panel.setAttribute("data-entity-id", id);

      const warn = document.createElement("p");
      warn.className = "hint";
      warn.textContent = "Delete this node from the graph? Connected edges are removed too. This is not a scene-only action.";
      panel.appendChild(warn);

      const confirmBtn = document.createElement("button");
      confirmBtn.type = "button";
      confirmBtn.className = "btn btn--danger beyond-room-neighbor-delete-confirm-btn";
      confirmBtn.setAttribute("data-testid", "beyond-room-neighbor-delete-confirm-btn");
      confirmBtn.textContent = "Yes, delete node";

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "btn beyond-room-neighbor-delete-cancel-btn";
      cancelBtn.setAttribute("data-testid", "beyond-room-neighbor-delete-cancel-btn");
      cancelBtn.textContent = "Cancel";

      cancelBtn.addEventListener("click", () => { confirmHost.innerHTML = ""; });

      confirmBtn.addEventListener("click", async () => {
        confirmBtn.disabled = true;
        cancelBtn.disabled = true;
        try {
          const result = await spApi(`/api/graph/nodes/${encodeURIComponent(id)}`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ world: currentWorld() })
          });
          confirmHost.innerHTML = "";
          delBtn.disabled = true;
          const status = document.createElement("div");
          status.className = "beyond-room-neighbor-delete-status hint";
          status.setAttribute("data-testid", "beyond-room-neighbor-delete-status");
          // cascadeEdgeCount sourced DIRECTLY from the engine's own response.
          status.setAttribute("data-cascade-edge-count", String(result?.cascadeEdgeCount ?? 0));
          status.textContent = `Deleted "${result?.name ?? id}" and ${result?.cascadeEdgeCount ?? 0} connected edge${(result?.cascadeEdgeCount ?? 0) === 1 ? "" : "s"}.`;
          item.appendChild(status);
        } catch (err) {
          confirmBtn.disabled = false;
          cancelBtn.disabled = false;
          warn.textContent = `Could not delete: ${err.message}`;
        }
      });

      panel.append(confirmBtn, cancelBtn);
      confirmHost.appendChild(panel);
    });

    body.appendChild(item);
  }

  return details;
}

// ---------------------------------------------------------------------------
// §A -- "Wrap this scene": an inline slide-down panel (never a modal, never a
// navigation) with two review-gated, proposes-never-auto-writes sub-sections:
//   (1) note-intake -> POST .../propose-updates (the real 28.1 route) surfaces
//       a REAL, reachable review batch reached through the EXISTING, unmodified
//       #review/<batchId> screen -- nothing writes to the graph until it's
//       accepted there (the standing no-silent-auto-write invariant).
//   (2) element-promotion -> a pre-checked, skimmable checklist over this
//       scene's CURRENTLY scene-local elements; confirming promotes ONLY the
//       still-checked ones through the SAME per-element promote route the `⭑`
//       gesture uses (no second promotion mechanism). Merely opening the panel
//       / rendering the checklist promotes NOTHING.
// ---------------------------------------------------------------------------
function buildWrapPanel(scene, refreshElements) {
  const panel = document.createElement("div");
  panel.className = "wrap-panel";
  panel.setAttribute("data-testid", "wrap-panel");
  panel.setAttribute("data-scene-id", scene.id);
  panel.hidden = true;

  // (1) Note-intake sub-section.
  const noteSection = document.createElement("div");
  noteSection.className = "wrap-section wrap-note-intake";
  const noteHeading = document.createElement("h4");
  noteHeading.className = "wrap-section-heading";
  noteHeading.textContent = "Propose graph updates from this scene's notes";
  noteSection.appendChild(noteHeading);

  const noteHint = document.createElement("p");
  noteHint.className = "hint";
  noteHint.textContent = "Reads this scene's Add Event notes and proposes graph updates for review. Nothing is written until you accept it in Batch Review.";
  noteSection.appendChild(noteHint);

  const runBtn = document.createElement("button");
  runBtn.type = "button";
  runBtn.className = "btn wrap-note-intake-run-btn";
  runBtn.setAttribute("data-testid", "wrap-note-intake-run-btn");
  runBtn.setAttribute("data-scene-id", scene.id);
  runBtn.textContent = "Propose from notes";
  noteSection.appendChild(runBtn);

  const resultHost = document.createElement("div");
  resultHost.className = "wrap-note-intake-result-host";
  noteSection.appendChild(resultHost);

  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    resultHost.innerHTML = "";
    const pending = document.createElement("p");
    pending.className = "hint";
    pending.textContent = "Reading this scene's notes…";
    resultHost.appendChild(pending);
    try {
      const data = await spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/propose-updates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld() })
      });
      resultHost.innerHTML = "";
      const result = document.createElement("div");
      result.className = "wrap-note-intake-result";
      result.setAttribute("data-testid", "wrap-note-intake-result");
      result.setAttribute("data-batch-id", data.batchId);

      // README §D blurb -- shown immediately above the inline proposal cards.
      const blurb = document.createElement("p");
      blurb.className = "wrap-rail-blurb";
      const n = data.mutationCount ?? 0;
      blurb.textContent = `Read your table notes for this scene and proposed ${n} graph edit${n === 1 ? "" : "s"}. Nothing is written until you apply.`;
      result.appendChild(blurb);
      resultHost.appendChild(result);

      // 29.6: reshaped inline rail -- fetch the (real, reachable) batch and
      // render one proposal card per mutation, INLINE. This deliberately
      // REPLACES 28.4's link-out to #review/<batchId> (see buildWrapProposalRail).
      // No navigation; nothing is written until Accept + Apply.
      await buildWrapProposalRail(scene, data.batchId, resultHost);
    } catch (err) {
      resultHost.innerHTML = "";
      const errP = document.createElement("p");
      errP.className = "hint";
      errP.textContent = `Could not propose updates: ${err.message}`;
      resultHost.appendChild(errP);
      runBtn.disabled = false;
    }
  });
  panel.appendChild(noteSection);

  // (2) Element-promotion sub-section (checklist populated on open).
  const promoteSection = document.createElement("div");
  promoteSection.className = "wrap-section wrap-promote";
  const promoteHeading = document.createElement("h4");
  promoteHeading.className = "wrap-section-heading";
  promoteHeading.textContent = "Promote scene-local elements to the graph";
  promoteSection.appendChild(promoteHeading);

  const promoteHost = document.createElement("div");
  promoteHost.className = "wrap-promote-host";
  promoteHost.setAttribute("data-wrap-promote-host", scene.id);
  promoteSection.appendChild(promoteHost);
  panel.appendChild(promoteSection);

  // (3) Phase 37 task 37.3: the quiet Chronicle entry point that rides
  // Wrap-up. When the world's pending-ledger (the deferred-intents lane) is
  // carrying threads deferred from past time-skips/wrap-ups, offer to pass
  // time now -- one line, no chrome. It hands off into the Chronicle Composer
  // with the queued-intents scope pre-selected (the deferred lane visible at
  // left), via the `#chronicle/compose` route. Nothing runs here; it only
  // navigates. Hidden entirely (never rendered) when nothing is queued.
  const passTime = document.createElement("div");
  passTime.className = "wrap-section wrap-passtime";
  passTime.setAttribute("data-testid", "wrap-passtime-line");
  passTime.hidden = true;
  panel.appendChild(passTime);
  refreshWrapPassTimeLine(passTime);

  return panel;
}

/**
 * Populate (or leave hidden) the Wrap panel's "N threads waiting -- pass time
 * now?" line from the world's real pending-ledger. Best-effort: any read
 * failure just leaves the line hidden (it is a quiet nudge, never load-bearing).
 */
async function refreshWrapPassTimeLine(host) {
  let pending;
  try {
    pending = await spApi(`/api/pending-entities${spWithWorld()}`);
  } catch {
    return; // stay hidden
  }
  let threads = 0;
  for (const ent of pending.entities || []) threads += (ent.entries || []).length;
  if (threads <= 0) return; // nothing queued -> no line at all

  host.innerHTML = "";
  const line = document.createElement("button");
  line.type = "button";
  line.className = "wrap-passtime-link";
  line.setAttribute("data-testid", "wrap-passtime-link");
  line.setAttribute("data-thread-count", String(threads));
  line.textContent = `${threads} thread${threads === 1 ? "" : "s"} waiting — pass time now?`;
  line.addEventListener("click", () => { location.hash = "chronicle/compose"; });
  host.appendChild(line);
  host.hidden = false;
}

// ---------------------------------------------------------------------------
// §D -- the reshaped inline Wrap PROPOSAL RAIL (29.6). Once note-intake has
// produced a real, reachable batchId, fetch GET /api/batches/:batchId and
// render one proposal card per mutation INLINE inside the Wrap panel -- no
// navigation to #review (that 28.4 link-out is deliberately replaced here).
// Every card's Accept/Reject calls the EXISTING per-mutation accept|reject
// route (scope:'entity'); the footer "Apply N to graph" calls the EXISTING
// /sync route (applies only status==='accepted'). NO NEW BACKEND. The
// no-silent-auto-write invariant is preserved end to end: fetching + rendering
// cards writes NOTHING; only Accept (-> status) and Apply (/sync) touch the
// graph.
// ---------------------------------------------------------------------------

// Phase 37 task 37.3: the four local card-rendering helpers 29.6 shipped here
// (deriveProposalKind / formatProposalValue / buildProposalDiffRows /
// buildProposalCard) are GONE -- the rail now mounts the ONE shared
// proposal-card component (renderProposalCard, imported above). See
// buildWrapProposalRail below for the adoption: same batch fetch, same
// decisions/Apply footer chrome, the card itself is the shared one. The card
// owns its own Accept/Reject wiring (the SAME `scope:"entity"` per-mutation
// route the old local card called) and reports each decision back through its
// `onDecided` callback, which the rail uses to keep the Apply footer in sync.

/**
 * Fetch the batch and render the inline proposal-card rail into `host`. Seeds
 * each card's decision from the batch's OWN server-side status (so re-opening
 * after a decision reflects reality), renders the cards + an "Accept all" ghost
 * + a primary "Apply N to graph" that stays disabled-looking until at least one
 * card is accepted. Apply calls /sync (accepted-only) -- the only graph write.
 */
async function buildWrapProposalRail(scene, batchId, host) {
  const prior = host.querySelector('[data-testid="wrap-proposal-rail"]');
  if (prior) prior.remove();

  const rail = document.createElement("div");
  rail.className = "wrap-proposal-rail";
  rail.setAttribute("data-testid", "wrap-proposal-rail");
  rail.setAttribute("data-batch-id", batchId);
  host.appendChild(rail);

  let payload;
  try {
    payload = await spApi(`/api/batches/${encodeURIComponent(batchId)}${spWithWorld()}`);
  } catch (err) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = `Could not load proposed edits: ${err.message}`;
    rail.appendChild(p);
    return;
  }

  const entities = (payload.regions || []).flatMap((r) => r.entities || []);
  const decisions = new Map();
  for (const e of entities) {
    if (e.status === "accepted") decisions.set(e.mutationId, "accepted");
    else if (e.status === "rejected") decisions.set(e.mutationId, "rejected");
  }

  const cardsHost = document.createElement("div");
  cardsHost.className = "wrap-proposal-cards";
  rail.appendChild(cardsHost);

  const footer = document.createElement("div");
  footer.className = "wrap-proposal-footer";
  const acceptAllBtn = document.createElement("button");
  acceptAllBtn.type = "button";
  acceptAllBtn.className = "btn btn--ghost wrap-accept-all-btn";
  acceptAllBtn.setAttribute("data-testid", "wrap-accept-all-btn");
  acceptAllBtn.setAttribute("data-batch-id", batchId);
  acceptAllBtn.textContent = "Accept all";
  const applyBtn = document.createElement("button");
  applyBtn.type = "button";
  applyBtn.className = "btn wrap-apply-btn";
  applyBtn.setAttribute("data-testid", "wrap-apply-btn");
  applyBtn.setAttribute("data-batch-id", batchId);
  footer.append(acceptAllBtn, applyBtn);

  const acceptedCount = () => [...decisions.values()].filter((v) => v === "accepted").length;
  function updateApply() {
    const n = acceptedCount();
    applyBtn.textContent = n ? `Apply ${n} to graph` : "Apply to graph";
    applyBtn.disabled = n === 0;
    applyBtn.classList.toggle("wrap-apply-btn--ready", n > 0);
  }

  // The shared proposal-card owns its own Accept/Reject POST + repaint; the
  // rail only needs each decision reported back to keep its Apply footer in
  // sync (and to seed `decisions` for the accepted-count math). Every mount
  // records the card element so "Accept all" can drive them via their own
  // (shared) Accept button -- the one accept path, not a rail-local duplicate.
  const cardEls = [];
  if (!entities.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No proposed graph edits from this scene's notes.";
    cardsHost.appendChild(empty);
  } else {
    for (const entity of entities) {
      const cardEl = renderProposalCard(entity, {
        world: currentWorld(),
        batchId,
        onDecided: (decided, m) => {
          const mid = m.mutationId ?? m.id;
          if (mid) decisions.set(mid, decided === "yes" ? "accepted" : decided === "no" ? "rejected" : "pending");
          updateApply();
        }
      });
      cardEls.push(cardEl);
      cardsHost.appendChild(cardEl);
    }
  }
  rail.appendChild(footer);

  acceptAllBtn.addEventListener("click", () => {
    acceptAllBtn.disabled = true;
    for (const cardEl of cardEls) {
      if (cardEl.getAttribute("data-decided") === "yes") continue;
      cardEl.querySelector('[data-testid="proposal-card-accept-btn"]')?.click();
    }
    // Each accept resolves independently and calls onDecided -> updateApply;
    // re-enable once the clicks are dispatched (the footer reflects reality as
    // they land). A settle tick keeps the button from looking permanently dead.
    setTimeout(() => { acceptAllBtn.disabled = false; }, 400);
  });

  applyBtn.addEventListener("click", async () => {
    if (applyBtn.disabled) return;
    applyBtn.disabled = true;
    const label = applyBtn.textContent;
    applyBtn.textContent = "Applying…";
    try {
      const res = await spApi(`/api/batches/${encodeURIComponent(batchId)}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld() })
      });
      rail.setAttribute("data-applied", "true");
      applyBtn.textContent = `Applied ${res.syncedCount ?? 0} to graph`;
    } catch (err) {
      applyBtn.textContent = label;
      applyBtn.disabled = false;
      const errP = document.createElement("p");
      errP.className = "hint";
      errP.textContent = `Could not apply: ${err.message}`;
      footer.after(errP);
    }
  });

  updateApply();
}

/**
 * (Re)render the Wrap panel's promotion checklist over this scene's CURRENTLY
 * scene-local elements. Pre-checked by default; confirm promotes only checked
 * items via the SAME per-element promote route the `⭑` gesture uses, then
 * re-renders the scene-element rows in place (data-kind flips to "graph") and
 * refreshes this checklist (freshly-promoted items drop off it).
 */
async function populateWrapPromoteList(scene, panel, refreshElements) {
  const host = panel.querySelector("[data-wrap-promote-host]");
  if (!host) return;
  host.innerHTML = "";

  let elements = [];
  try {
    ({ elements } = await spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements${spWithWorld()}`));
  } catch {
    elements = [];
  }
  const locals = elements.filter((e) => e.kind === "local");

  const list = document.createElement("div");
  list.className = "wrap-promote-list";
  list.setAttribute("data-testid", "wrap-promote-list");
  list.setAttribute("data-scene-id", scene.id);

  if (!locals.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No scene-local elements to promote.";
    list.appendChild(empty);
    host.appendChild(list);
    return;
  }

  for (const el of locals) {
    const item = document.createElement("label");
    item.className = "wrap-promote-item";
    item.setAttribute("data-testid", "wrap-promote-item");
    item.setAttribute("data-element-id", el.id);

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "wrap-promote-checkbox";
    cb.setAttribute("data-testid", "wrap-promote-checkbox");
    cb.setAttribute("data-element-id", el.id);
    cb.checked = true; // pre-selected -- skimmable, reject-easy

    const name = document.createElement("span");
    name.className = "wrap-promote-item-name";
    name.textContent = el.name || "(unnamed element)";

    item.append(cb, name);
    list.appendChild(item);
  }
  host.appendChild(list);

  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "btn wrap-promote-confirm-btn";
  confirm.setAttribute("data-testid", "wrap-promote-confirm-btn");
  confirm.setAttribute("data-scene-id", scene.id);
  confirm.textContent = "Promote selected";
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    const checkedIds = [...list.querySelectorAll('[data-testid="wrap-promote-checkbox"]')]
      .filter((c) => c.checked)
      .map((c) => c.getAttribute("data-element-id"));
    try {
      for (const elementId of checkedIds) {
        await spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements/${encodeURIComponent(elementId)}/promote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ world: currentWorld() })
        });
      }
      // Re-render the scene-element rows in place so each promoted row's
      // data-kind flips to "graph" (no full-page reload), then refresh this
      // checklist so freshly-promoted elements drop off it.
      await refreshElements();
      await populateWrapPromoteList(scene, panel, refreshElements);
    } catch (err) {
      confirm.disabled = false;
      const errP = document.createElement("p");
      errP.className = "hint";
      errP.textContent = `Could not promote: ${err.message}`;
      host.appendChild(errP);
    }
  });
  host.appendChild(confirm);
}

// ---------------------------------------------------------------------------
// §C -- the inline `✦` functional-prep assist: quiet ghost links, never a
// button bar, never a gate. Each call is interruptible (AbortController,
// cancelled on navigation via app.js's cancelActiveAssist()). Drafts write
// ONLY to the scene-elements store (a scene-local authoring aid, same surface
// as hand-typing) -- NEVER to the graph; promotion stays the explicit `⭑` /
// Wrap step.
// ---------------------------------------------------------------------------
async function runSceneAssist(scene, params, statusEl) {
  cancelActiveAssist();
  const controller = new AbortController();
  activeAssistController = controller;
  try {
    const data = await spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/assist-prep`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld(), ...params }),
      signal: controller.signal
    });
    if (activeAssistController === controller) activeAssistController = null;
    return data;
  } catch (err) {
    if (err.name === "AbortError") return null; // superseded / navigated away -- not a real failure
    if (statusEl) statusEl.textContent = `✦ assist unavailable: ${err.message}`;
    return null;
  }
}

function buildProposeElementsGhostLink(scene, refreshElements) {
  const wrap = document.createElement("div");
  wrap.className = "scene-assist-ghost";

  const link = document.createElement("button");
  link.type = "button";
  link.className = "link-btn scene-assist-propose-link";
  link.setAttribute("data-testid", "scene-assist-propose-link");
  link.setAttribute("data-scene-id", scene.id);
  link.textContent = "✦ propose elements here";
  link.title = "Ask the model to suggest interactable elements for this room (additive — you review and keep what you want)";

  const status = document.createElement("span");
  status.className = "scene-assist-status hint";

  link.addEventListener("click", async () => {
    link.disabled = true;
    status.textContent = "✦ thinking…";
    const data = await runSceneAssist(scene, { mode: "propose-elements" }, status);
    link.disabled = false;
    if (!data) return;
    const drafts = data.elements || [];
    if (!drafts.length) { status.textContent = "✦ no suggestions."; return; }
    // Persist each draft through the ORDINARY scene-elements create route (a
    // scene-local authoring aid -- not a graph write, not review-gated).
    for (const el of drafts) {
      await spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld(), name: el.name, fields: el.fields || {}, draft: true })
      }).catch(() => {});
    }
    status.textContent = `✦ added ${drafts.length} suggested element${drafts.length === 1 ? "" : "s"} — edit or remove freely.`;
    await refreshElements();
  });

  wrap.append(link, status);
  return wrap;
}

function buildDraftFieldsGhostLink(scene, element, refreshList) {
  const link = document.createElement("button");
  link.type = "button";
  link.className = "link-btn scene-assist-draft-link";
  link.setAttribute("data-testid", "scene-assist-draft-link");
  link.setAttribute("data-element-id", element.id);
  link.textContent = "✦ draft fields";
  link.title = "Ask the model to draft functional-prep fields for this element (additive; you keep what you want)";
  link.addEventListener("click", async () => {
    link.disabled = true;
    const data = await runSceneAssist(scene, { mode: "draft-fields", elementName: element.name });
    if (!data || !(data.elements || []).length) { link.disabled = false; return; }
    const draft = data.elements[0];
    // draft:true -> the store marks these keys on element.draftFields so
    // Prep and Run flag them as unreviewed LLM output until the GM edits.
    await spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements/${encodeURIComponent(element.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld(), fields: draft.fields || {}, draft: true })
    }).catch(() => {});
    await refreshList();
  });
  return link;
}

// ===========================================================================
// Phase 29 task 29.3 -- place-description grid + missing-description banner +
// draft-read-aloud ghost link; objective inline edit; From-graph inline
// picker. Contract: review-ui/test/e2e/phase29-fixture.mjs §2/§4/§5/§6 --
// every data-testid / route below is pinned there and matched verbatim. All
// new DOM is styled with the scoped --sp-* tokens (29.2 look).
//
// Phase 37.6 task 1 RETIRED the "✦ Suggest dressing" button + its client-side
// DRESSING/DRESSING_FALLBACK keyword tables that used to live here (a canned
// bucket matched against `place.name + place.description`, wearing the `✦`
// glyph with no model call behind it at all) -- see
// buildProposeElementsGhostLink's own doc comment: propose-elements is now
// the ONE `✦` element-suggestion affordance, asking the model for a genuine
// mix of functional + mundane-dressing elements grounded in this place's real
// description/neighbors. review-ui/test/e2e/phase30-planner-scene.e2e.mjs's
// own "Suggest dressing appends MUNDANE elements..." test is retired the
// same way (see that file's own reconciliation note).
// ===========================================================================

/** §5 -- PATCH the anchor place's `description` through the EXISTING editNodeOp route (clears the node's unreviewed flag as a side effect, unchanged). */
function savePlaceDescription(placeId, v) {
  return spApi(`/api/graph/nodes/${encodeURIComponent(placeId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: currentWorld(), data: { description: v } })
  });
}

/**
 * §C.4/§C.5 -- "The place" grid OR the missing-description banner, in one host.
 * A place with a non-empty description shows the 76px-label/value grid
 * (click-to-edit -> editNodeOp). A place with an empty/absent description shows
 * the amber banner instead; clicking the banner seeds an empty-but-present
 * description and swaps the host to the grid with its editor focused -- all
 * in-session, no full re-render (so the swapped-in input keeps focus).
 */
/**
 * Phase 37.6 task 3 -- "✦ develop this place". A quiet ghost control beside
 * the place-description editor: click to open a one-line vision input
 * ("What do you see here?"), POST to the develop-description route
 * (mutation-engine/develop-description.mjs -- a real LLM call reading this
 * place's current description + its real graph neighborhood as inspiration +
 * the GM's own vision), and show the returned suggestion as a ONE-SHOT
 * accept/dismiss card. NEVER writes silently: accept merges the suggestion
 * onto the existing description through the SAME savePlaceDescription()/
 * editNodeOp path the plain description field already uses; dismiss just
 * discards it. `onAccepted` lets the caller re-render its own grid once
 * `place.description` has been mutated in place, mirroring world-view.js's
 * own standalone copy of this exact control.
 */
function buildDevelopPlaceControl(place, onAccepted) {
  const wrap = document.createElement("div");
  wrap.className = "scene-develop-place-wrap";
  wrap.setAttribute("data-testid", "scene-develop-place-wrap");
  wrap.setAttribute("data-entity-id", place.id);

  const link = document.createElement("button");
  link.type = "button";
  link.className = "link-btn scene-develop-place-link";
  link.setAttribute("data-testid", "scene-develop-place-link");
  link.textContent = "✦ develop this place";

  const panel = document.createElement("div");
  panel.className = "scene-develop-place-panel";
  panel.setAttribute("data-testid", "scene-develop-place-panel");
  panel.hidden = true;

  const row = document.createElement("div");
  row.className = "scene-develop-place-row";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "scene-develop-place-input";
  input.placeholder = "What do you see here?";
  input.setAttribute("data-testid", "scene-develop-place-input");
  const goBtn = document.createElement("button");
  goBtn.type = "button";
  goBtn.className = "btn";
  goBtn.setAttribute("data-testid", "scene-develop-place-go-btn");
  goBtn.textContent = "Ask";
  row.append(input, goBtn);

  const status = document.createElement("div");
  status.className = "hint scene-develop-place-status";

  const suggestionHost = document.createElement("div");
  suggestionHost.className = "scene-develop-place-suggestion-host";

  panel.append(row, status, suggestionHost);

  link.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) setTimeout(() => input.focus(), 0);
  });

  async function ask() {
    const vision = input.value.trim();
    if (!vision) { status.textContent = "Type your vision first."; return; }
    goBtn.disabled = true;
    status.textContent = "✦ thinking…";
    suggestionHost.innerHTML = "";
    try {
      const data = await spApi(`/api/graph/nodes/${encodeURIComponent(place.id)}/develop-description`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld(), vision })
      });
      status.textContent = "";
      // QA W1 Fix 4: `offline` is chrome, never baked into `data.suggestion`
      // itself (the clean body Accept persists verbatim) -- same convention
      // world-view.js's own copy of this control already uses.
      suggestionHost.appendChild(buildDevelopPlaceSuggestionCard(place, data.suggestion, data.offline, () => { input.value = ""; }, onAccepted));
    } catch (err) {
      status.textContent = `✦ could not develop this: ${err.message}`;
    } finally {
      goBtn.disabled = false;
    }
  }
  goBtn.addEventListener("click", ask);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); ask(); } });

  wrap.append(link, panel);
  return wrap;
}

/**
 * The one-shot suggestion card: accept merges into the description via the EXISTING savePlaceDescription()/editNodeOp path (never a new write mechanism), then calls `onAccepted` to re-render; dismiss just discards. Never auto-applies.
 *
 * QA W1 Fix 4: when `offline` is true, a small CHROME note renders above the
 * suggestion text -- the disclaimer lives HERE, never inside `suggestion`
 * itself (which Accept persists verbatim as real entity content).
 */
function buildDevelopPlaceSuggestionCard(place, suggestion, offline, onResolved, onAccepted) {
  const card = document.createElement("div");
  card.className = "scene-develop-place-suggestion";
  card.setAttribute("data-testid", "scene-develop-place-suggestion");

  if (offline) {
    const chrome = document.createElement("p");
    chrome.className = "scene-develop-place-suggestion-chrome";
    chrome.setAttribute("data-testid", "scene-develop-place-offline-note");
    chrome.textContent = "✦ Offline pass — no model configured. This is a placeholder, not a real suggestion; edit it before accepting.";
    card.appendChild(chrome);
  }

  const text = document.createElement("p");
  text.className = "scene-develop-place-suggestion-text";
  text.textContent = suggestion;
  card.appendChild(text);

  const actions = document.createElement("div");
  actions.className = "scene-develop-place-suggestion-actions";
  const acceptBtn = document.createElement("button");
  acceptBtn.type = "button";
  acceptBtn.className = "btn btn--accept";
  acceptBtn.setAttribute("data-testid", "scene-develop-place-accept-btn");
  acceptBtn.textContent = "Accept into description";
  const dismissBtn = document.createElement("button");
  dismissBtn.type = "button";
  dismissBtn.className = "link-btn";
  dismissBtn.setAttribute("data-testid", "scene-develop-place-dismiss-btn");
  dismissBtn.textContent = "Dismiss";

  acceptBtn.addEventListener("click", async () => {
    acceptBtn.disabled = true;
    dismissBtn.disabled = true;
    const current = (place.description || "").trim();
    const merged = current ? `${current}\n\n${suggestion}` : suggestion;
    place.description = merged;
    try {
      await savePlaceDescription(place.id, merged);
    } catch (err) {
      acceptBtn.disabled = false;
      dismissBtn.disabled = false;
      showUndoToast(`Could not accept: ${err.message}`, () => {});
      return;
    }
    onResolved();
    onAccepted(); // rebuild the grid so the merged description shows immediately
  });
  dismissBtn.addEventListener("click", () => {
    card.remove();
    onResolved();
  });

  actions.append(acceptBtn, dismissBtn);
  card.appendChild(actions);
  return card;
}

function buildPlaceDescriptionBlock(scene, place) {
  const host = document.createElement("div");
  host.className = "scene-place-desc-host";

  function renderGrid(autoEdit) {
    host.innerHTML = "";
    const grid = document.createElement("div");
    grid.className = "scene-place-grid";
    const label = document.createElement("span");
    label.className = "scene-place-grid-label";
    label.textContent = "About this place";
    const valueField = makeClickToEditField({
      tag: "div",
      className: "scene-place-desc-value",
      testid: "scene-place-description",
      dataAttrs: { "data-entity-id": place.id },
      inputTestid: "scene-place-description-input",
      inputDataAttrs: { "data-entity-id": place.id },
      value: place.description ?? "",
      placeholder: "Describe this place…",
      emptyText: "Click to describe this place…",
      multiline: true, // free-text prose description, genuinely multi-line
      save: (v) => { place.description = v; return savePlaceDescription(place.id, v); }
    });
    grid.append(label, valueField.el);
    host.appendChild(grid);
    // Phase 37.6 task 3 -- "✦ develop this place", beside the description
    // editor (the world-view detail pane gets the SAME affordance, its own
    // standalone copy per this project's established per-file convention).
    host.appendChild(buildDevelopPlaceControl(place, () => renderGrid(false)));
    if (autoEdit) valueField.enterEdit();
  }

  function renderBanner() {
    host.innerHTML = "";
    const banner = document.createElement("div");
    banner.className = "scene-missing-desc-banner";
    banner.setAttribute("data-testid", "missing-description-banner");
    banner.setAttribute("data-entity-id", place.id);

    const glyph = document.createElement("span");
    glyph.className = "scene-missing-desc-glyph";
    glyph.textContent = "!";
    banner.appendChild(glyph);

    const copy = document.createElement("span");
    copy.className = "scene-missing-desc-copy";
    copy.append("This place has no description in the graph. The ✦ suggestions have nothing to draw on — ");
    const cta = document.createElement("span");
    cta.className = "scene-missing-desc-cta";
    cta.textContent = "write one now";
    copy.append(cta, ".");
    banner.appendChild(copy);

    banner.addEventListener("click", async () => {
      // Seed an empty-but-present description, then swap to the grid with its
      // editor already focused -- README: "Clicking seeds an empty description
      // and focuses it."
      place.description = "";
      try { await savePlaceDescription(place.id, ""); } catch { /* still seed the UI */ }
      renderGrid(true);
    });
    host.appendChild(banner);
  }

  const hasDesc = !!(place && typeof place.description === "string" && place.description.trim() !== "");
  if (hasDesc) renderGrid(false); else renderBanner();
  return host;
}

/**
 * §C.6 -- draft-read-aloud ghost link. Rendered ONLY when the scene narration
 * is empty AND the place has a non-empty description (unchanged placement/
 * visibility rule). Phase 37.6 task 1: this used to compose
 * `description + objectiveNote` in plain JS -- a string concat wearing the
 * `✦` glyph, no model call anywhere behind it. It now POSTs to the SAME
 * `assist-prep` route the other `✦` scene assists use, mode
 * "draft-read-aloud" (element-assist.mjs / prompts/scene-read-aloud-draft.md
 * -- a real LLM call reading the place description + this scene's objective +
 * its graph neighborhood), then saves the model's returned prose via the
 * EXISTING narration route, updates the narration field in place (no
 * reload), and is undoable via showUndoToast, same as before.
 */
function buildDraftReadAloudLink(scene, place, narrationField) {
  const link = document.createElement("button");
  link.type = "button";
  link.className = "link-btn draft-read-aloud-link";
  link.setAttribute("data-testid", "draft-read-aloud-link");
  link.setAttribute("data-scene-id", scene.id);
  const glyph = document.createElement("span");
  glyph.className = "draft-read-aloud-glyph";
  glyph.textContent = "✦";
  link.append(glyph, " Draft this from the place description and the objective");

  const status = document.createElement("span");
  status.className = "hint draft-read-aloud-status";

  const saveNarration = (text) => spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/narration`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: currentWorld(), text })
  });

  link.addEventListener("click", async () => {
    const desc = (place && place.description ? String(place.description) : "").trim();
    if (!desc) return;
    link.disabled = true;
    status.textContent = "✦ thinking…";
    const data = await runSceneAssist(scene, { mode: "draft-read-aloud" }, status);
    const composed = (data && data.narration ? String(data.narration) : "").trim();
    if (!composed) {
      link.disabled = false;
      if (status.textContent === "✦ thinking…") status.textContent = "";
      return;
    }
    try {
      await saveNarration(composed);
    } catch {
      link.disabled = false;
      status.textContent = "";
      return;
    }
    status.textContent = "";
    narrationField.setValue(composed);
    link.style.display = "none";
    showUndoToast("Drafted read-aloud from the place description — edit it into your own voice.", async () => {
      await saveNarration("").catch(() => {});
      narrationField.setValue("");
      link.style.display = "";
      link.disabled = false;
    });
  });
  const wrap = document.createElement("span");
  wrap.className = "draft-read-aloud-wrap";
  wrap.append(link, status);
  return wrap;
}

/**
 * §2 -- the "◇ From graph" inline picker (no modal). Lists every graph node
 * NOT already an element in this scene (name + mono type + a right-aligned
 * hint). Picking one calls the from-graph route (attachExistingNodeAsElement)
 * -> a kind:'graph' element referencing the EXISTING node; it never creates a
 * new node. Modeled on buildEntityPicker, but pinned to the fixture's own
 * from-graph-* testids.
 */
function buildFromGraphPicker(scene, refreshElements, close) {
  const picker = document.createElement("div");
  picker.className = "from-graph-picker";
  picker.setAttribute("data-testid", "from-graph-picker");
  picker.setAttribute("data-scene-id", scene.id);

  const bar = document.createElement("div");
  bar.className = "from-graph-picker-bar";
  const kicker = document.createElement("span");
  kicker.className = "from-graph-picker-kicker";
  kicker.textContent = "Pull in an existing node";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "icon-btn from-graph-picker-close-btn";
  closeBtn.textContent = "✕";
  closeBtn.title = "Close";
  closeBtn.addEventListener("click", () => close());
  bar.append(kicker, closeBtn);
  picker.appendChild(bar);

  const input = document.createElement("input");
  input.type = "text";
  input.className = "from-graph-search-input";
  input.setAttribute("data-testid", "from-graph-search-input");
  input.placeholder = "Search the graph by name…";
  picker.appendChild(input);

  const results = document.createElement("div");
  results.className = "from-graph-results";
  results.setAttribute("data-testid", "from-graph-results");
  picker.appendChild(results);

  const footer = document.createElement("div");
  footer.className = "from-graph-picker-footer hint";
  footer.textContent = "Adding from the graph links the existing node into this scene as a KEY element. It never duplicates the node.";
  picker.appendChild(footer);

  let candidates = [];

  function renderResults() {
    const q = input.value.trim().toLowerCase();
    const matches = candidates
      .filter((n) => !q || n.name.toLowerCase().includes(q) || n.type.toLowerCase().includes(q))
      .slice(0, 25);
    results.innerHTML = "";
    if (!matches.length) {
      const empty = document.createElement("div");
      empty.className = "from-graph-no-results hint";
      empty.textContent = "Nothing in the graph matches. Add it as a new element instead — you can promote it later.";
      results.appendChild(empty);
      return;
    }
    for (const n of matches) {
      const opt = document.createElement("button");
      opt.type = "button";
      opt.className = "from-graph-option";
      opt.setAttribute("data-testid", "from-graph-option");
      opt.setAttribute("data-entity-id", n.id);

      const name = document.createElement("span");
      name.className = "from-graph-option-name";
      name.textContent = n.name;
      const type = document.createElement("span");
      type.className = "from-graph-option-type";
      type.textContent = n.type;
      const hint = document.createElement("span");
      hint.className = "from-graph-option-hint";
      hint.textContent = n.id === scene.locationEntityId ? "this scene's place" : "add as key element";
      opt.append(name, type, hint);

      opt.addEventListener("click", async () => {
        opt.disabled = true;
        try {
          await spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements/from-graph`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ world: currentWorld(), entityId: n.id })
          });
        } catch {
          opt.disabled = false;
          return;
        }
        close();
        await refreshElements();
      });
      results.appendChild(opt);
    }
  }

  async function load() {
    results.innerHTML = "";
    const loading = document.createElement("div");
    loading.className = "hint";
    loading.textContent = "Loading graph nodes…";
    results.appendChild(loading);
    try {
      const [graph, elementsRes] = await Promise.all([
        spApi(`/api/graph${spWithWorld({ filter: "all" })}`),
        spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements${spWithWorld()}`)
      ]);
      const used = new Set((elementsRes.elements || []).map((e) => e.graphEntityId).filter(Boolean));
      candidates = (graph.nodes || []).filter((n) => !used.has(n.id));
      renderResults();
    } catch (err) {
      results.innerHTML = "";
      const errEl = document.createElement("div");
      errEl.className = "hint";
      errEl.textContent = `Could not load graph: ${err.message}`;
      results.appendChild(errEl);
    }
  }

  input.addEventListener("input", renderResults);
  load();
  setTimeout(() => input.focus(), 0);
  return picker;
}

// Kind labels for the "From library" picker (task #45) -- mirrors the
// Library tabs' own naming (library-view.js's TABS), one small deviation:
// Reliquary/Stagecraft are shown as their own filter kinds ("Item"/
// "Stagecraft") since the GM still thinks in those two buckets while
// browsing, even though both collapse to the SAME tray-drop kind ("asset")
// once attached -- §7's own "reader tries item-store first, falls back to
// stagecraft-store" roster convention, unchanged here.
const FROM_LIBRARY_KIND_LABELS = { creature: "Creature", hero: "Hero", item: "Item", stagecraft: "Stagecraft" };
const FROM_LIBRARY_DROP_KIND = { creature: "creature", hero: "hero", item: "asset", stagecraft: "asset" };

/**
 * Task #45 -- "From library" attach. Russell's words: "I'm missing 'from
 * library'. The library, while not indexed, is still a source for the
 * scenes." Lists accepted+proposed Bestiary/Hero's Hall/Reliquary/Stagecraft
 * content (the SAME four routes library-view.js's fetchLibraryData already
 * reads), filterable by kind, free-text search over name. Modeled DIRECTLY
 * on buildFromGraphPicker above (same bar/search/results/footer shell,
 * same option row shape) plus one addition this picker's own multi-source
 * nature calls for -- a small kind-filter chip row (flagged in this task's
 * own completion report as an invented detail beyond the from-graph
 * pattern, kept quiet/minimal for Russell's judgment).
 *
 * Picking an option reuses the EXISTING tray-drop composition route
 * (POST .../tray/drop) VERBATIM -- one semantic, no new persistence path:
 * a creature drop's first occurrence creates a KEY-like element with a
 * stat block (the route's own dedup, unchanged), a hero/asset drop is a
 * roster entry only. The scene page reflects the result the same way a
 * real tray drop does: `refreshElements()` re-renders the elements list
 * (visible for a creature's first attach; a harmless no-op re-render
 * otherwise), and a toast confirms the attach with an undo that calls the
 * SAME `DELETE .../tray/:kind/:id` route the tray's own roster-chip ✕
 * uses (removes the roster row; never touches a creature's already-created
 * element, matching the tray's own remove-chip behavior exactly).
 */
function buildFromLibraryPicker(scene, refreshElements, close) {
  const picker = document.createElement("div");
  picker.className = "from-library-picker from-graph-picker";
  picker.setAttribute("data-testid", "from-library-picker");
  picker.setAttribute("data-scene-id", scene.id);

  const bar = document.createElement("div");
  bar.className = "from-graph-picker-bar";
  const kicker = document.createElement("span");
  kicker.className = "from-graph-picker-kicker";
  kicker.textContent = "Pull in something from the Library";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "icon-btn from-graph-picker-close-btn";
  closeBtn.textContent = "✕";
  closeBtn.title = "Close";
  closeBtn.addEventListener("click", () => close());
  bar.append(kicker, closeBtn);
  picker.appendChild(bar);

  const input = document.createElement("input");
  input.type = "text";
  input.className = "from-graph-search-input";
  input.setAttribute("data-testid", "from-library-search-input");
  input.placeholder = "Search the Library by name…";
  picker.appendChild(input);

  const kindFilter = document.createElement("div");
  kindFilter.className = "from-library-kind-filter";
  let activeKind = "all";
  const kindChips = {};
  for (const k of ["all", "creature", "hero", "item", "stagecraft"]) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "link-btn from-library-kind-chip";
    chip.setAttribute("data-testid", "from-library-kind-chip");
    chip.setAttribute("data-kind", k);
    chip.setAttribute("data-active", "false");
    chip.textContent = k === "all" ? "All" : FROM_LIBRARY_KIND_LABELS[k];
    chip.addEventListener("click", () => {
      activeKind = k;
      for (const [ck, cchip] of Object.entries(kindChips)) cchip.setAttribute("data-active", String(ck === k));
      renderResults();
    });
    kindChips[k] = chip;
    kindFilter.appendChild(chip);
  }
  kindChips.all.setAttribute("data-active", "true");
  picker.appendChild(kindFilter);

  const results = document.createElement("div");
  results.className = "from-graph-results";
  results.setAttribute("data-testid", "from-library-results");
  picker.appendChild(results);

  const footer = document.createElement("div");
  footer.className = "from-graph-picker-footer hint";
  footer.textContent = "Attaching reuses this scene's tray: a creature gets a KEY element with a stat block, a hero or item/asset lands as a roster entry only. Attaching the same thing twice never duplicates it.";
  picker.appendChild(footer);

  let candidates = [];

  function renderResults() {
    const q = input.value.trim().toLowerCase();
    const matches = candidates
      .filter((c) => activeKind === "all" || c.kind === activeKind)
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      .slice(0, 40);
    results.innerHTML = "";
    if (!matches.length) {
      const empty = document.createElement("div");
      empty.className = "from-graph-no-results hint";
      empty.textContent = "Nothing in the Library matches. Try a different search or kind.";
      results.appendChild(empty);
      return;
    }
    for (const c of matches) {
      const opt = document.createElement("button");
      opt.type = "button";
      opt.className = "from-graph-option";
      opt.setAttribute("data-testid", "from-library-option");
      opt.setAttribute("data-kind", c.kind);
      opt.setAttribute("data-source-id", c.id);

      const name = document.createElement("span");
      name.className = "from-graph-option-name";
      name.textContent = c.name;
      const type = document.createElement("span");
      type.className = "from-graph-option-type";
      type.textContent = FROM_LIBRARY_KIND_LABELS[c.kind];
      const hint = document.createElement("span");
      hint.className = "from-graph-option-hint";
      hint.textContent = c.hint || "";
      opt.append(name, type, hint);

      opt.addEventListener("click", async () => {
        opt.disabled = true;
        const dropKind = FROM_LIBRARY_DROP_KIND[c.kind];
        try {
          await spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/tray/drop`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ world: currentWorld(), kind: dropKind, id: c.id })
          });
        } catch {
          opt.disabled = false;
          return;
        }
        close();
        await refreshElements();
        showUndoToast(`"${c.name}" added to this scene.`, async () => {
          await spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/tray/${encodeURIComponent(dropKind)}/${encodeURIComponent(c.id)}`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ world: currentWorld() })
          }).catch(() => {});
          await refreshElements();
        }, { testid: "from-library-toast" });
      });
      results.appendChild(opt);
    }
  }

  async function load() {
    results.innerHTML = "";
    const loading = document.createElement("div");
    loading.className = "hint";
    loading.textContent = "Loading the Library…";
    results.appendChild(loading);
    try {
      const [bestiaryRes, partyRes, itemsRes, stagecraftRes] = await Promise.all([
        spApi(`/api/combat-planning/bestiary`),
        spApi(`/api/combat-planning/party-roster${spWithWorld()}`),
        spApi(`/api/combat-planning/items${spWithWorld()}`),
        spApi(`/api/session-planner/stagecraft${spWithWorld()}`)
      ]);
      const notDiscarded = (r) => r.status !== "discarded";
      candidates = [
        ...(bestiaryRes.entries || []).filter(notDiscarded).map((e) => ({
          kind: "creature", id: e.id, name: e.rawFields?.name || "Unnamed",
          hint: e.rawFields?.challengeRating != null ? `CR ${e.rawFields.challengeRating}` : ""
        })),
        ...(partyRes.members || []).filter(notDiscarded).map((m) => ({ kind: "hero", id: m.id, name: m.name, hint: "" })),
        ...(itemsRes.items || []).filter(notDiscarded).map((i) => ({ kind: "item", id: i.id, name: i.name, hint: i.type || "" })),
        ...(stagecraftRes.assets || []).filter(notDiscarded).map((a) => ({ kind: "stagecraft", id: a.id, name: a.name, hint: a.kind || "" }))
      ];
      renderResults();
    } catch (err) {
      results.innerHTML = "";
      const errEl = document.createElement("div");
      errEl.className = "hint";
      errEl.textContent = `Could not load the Library: ${err.message}`;
      results.appendChild(errEl);
    }
  }

  input.addEventListener("input", renderResults);
  load();
  setTimeout(() => input.focus(), 0);
  return picker;
}

/**
 * Phase 29 task 29.4 -- the "▣ NPC or creature" action. Creates a NEW
 * scene-local element in ONE create call already carrying an open, empty stat
 * block (the create route accepts `stat`, 29.1), opens its panel, re-renders,
 * scrolls it into view, and offers an undo (matching the element-add undo
 * pattern). `foundryActor` is stored only -- nothing is pushed to Foundry.
 */
async function addNpcCreature(scene, refreshElements, btn) {
  btn.disabled = true;
  let created;
  try {
    created = await spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        world: currentWorld(),
        name: "New NPC or creature",
        fields: { statblockRef: "Stat block" },
        stat: { count: 1, ac: "", hp: "", speed: "", cr: "", raw: "", foundryActor: "" }
      })
    });
  } catch {
    btn.disabled = false;
    return;
  }
  const id = created && created.element && created.element.id;
  if (id) openStatPanels.add(id);
  await refreshElements();
  btn.disabled = false;

  if (id) {
    const rowEl = document.querySelector(`[data-testid="scene-element-row"][data-element-id="${id}"]`);
    if (rowEl) rowEl.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  showUndoToast("NPC or creature added.", async () => {
    if (id) {
      await spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld() })
      }).catch(() => {});
      openStatPanels.delete(id);
    }
    await refreshElements();
  });
}

/**
 * The action row below the elements list -- `▣ NPC or creature` (creates a
 * scene-local element with an open stat block), `◇ From graph` (with its
 * inline picker), and `▤ From library` (task #45, with its own inline
 * picker -- see buildFromLibraryPicker above). `+ Add element` already lives
 * as the ghost row inside the list. Phase 37.6 task 1 retired `✦ Suggest
 * dressing` from this row -- the elements-section's own `✦ propose elements
 * here` ghost link (buildProposeElementsGhostLink, above the elements list)
 * is now the one place that suggestion lives, genuinely LLM-backed.
 */
function buildSceneActionsRow(scene, refreshElements) {
  const wrap = document.createElement("div");
  wrap.className = "scene-actions";

  const row = document.createElement("div");
  row.className = "scene-actions-row";

  const pickerHost = document.createElement("div");
  pickerHost.className = "scene-actions-picker-host";

  const npcBtn = document.createElement("button");
  npcBtn.type = "button";
  npcBtn.className = "btn scene-action-dashed-btn npc-creature-btn";
  npcBtn.setAttribute("data-testid", "npc-creature-btn");
  npcBtn.setAttribute("data-scene-id", scene.id);
  const npcGlyph = document.createElement("span");
  npcGlyph.className = "scene-action-glyph scene-action-glyph--rust";
  npcGlyph.textContent = "▣";
  npcBtn.append(npcGlyph, " NPC or creature");
  npcBtn.addEventListener("click", () => addNpcCreature(scene, refreshElements, npcBtn));

  const fromGraphBtn = document.createElement("button");
  fromGraphBtn.type = "button";
  fromGraphBtn.className = "btn scene-action-dashed-btn from-graph-btn";
  fromGraphBtn.setAttribute("data-testid", "from-graph-btn");
  fromGraphBtn.setAttribute("data-scene-id", scene.id);
  fromGraphBtn.innerHTML = "";
  const fgGlyph = document.createElement("span");
  fgGlyph.className = "scene-action-glyph scene-action-glyph--teal";
  fgGlyph.textContent = "◇";
  fromGraphBtn.append(fgGlyph, " From graph");
  fromGraphBtn.addEventListener("click", () => {
    if (pickerHost.firstChild) { pickerHost.innerHTML = ""; return; }
    pickerHost.appendChild(buildFromGraphPicker(scene, refreshElements, () => { pickerHost.innerHTML = ""; }));
  });

  // Task #45 -- own picker host, deliberately SEPARATE from `pickerHost`
  // above (the from-graph picker's), so this button's toggle can't collide
  // with from-graph's existing toggle logic -- zero risk to the
  // already-established from-graph-btn behavior.
  const libraryPickerHost = document.createElement("div");
  libraryPickerHost.className = "scene-actions-picker-host";

  const libraryBtn = document.createElement("button");
  libraryBtn.type = "button";
  libraryBtn.className = "btn scene-action-dashed-btn from-library-btn";
  libraryBtn.setAttribute("data-testid", "from-library-btn");
  libraryBtn.setAttribute("data-scene-id", scene.id);
  const libGlyph = document.createElement("span");
  libGlyph.className = "scene-action-glyph scene-action-glyph--teal";
  libGlyph.textContent = "▤";
  libraryBtn.append(libGlyph, " From library");
  libraryBtn.addEventListener("click", () => {
    if (libraryPickerHost.firstChild) { libraryPickerHost.innerHTML = ""; return; }
    libraryPickerHost.appendChild(buildFromLibraryPicker(scene, refreshElements, () => { libraryPickerHost.innerHTML = ""; }));
  });

  row.append(npcBtn, fromGraphBtn, libraryBtn);
  wrap.append(row, pickerHost, libraryPickerHost);
  return wrap;
}

// ---------------------------------------------------------------------------
// The full scene page assembly.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Phase 29 task 29.5 -- the two sub-bar segmented controls (Page|Cards layout,
// Prep|Layout|Run). Pure presentation; view-local state (sceneView).
// Returns the DOM group plus its buttons so renderScenePage
// can wire the click handlers with closure access to the scene-page root, the
// live elements-list, and the Wrap panel.
// ---------------------------------------------------------------------------
function buildSegmentedControl(sceneId, options) {
  const group = document.createElement("div");
  group.className = "sp-segmented";
  group.setAttribute("role", "group");
  const buttons = {};
  for (const opt of options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sp-segmented-btn";
    btn.setAttribute("data-testid", opt.testid);
    btn.setAttribute("data-scene-id", sceneId);
    btn.textContent = opt.label;
    btn.setAttribute("aria-pressed", opt.active ? "true" : "false");
    if (opt.active) btn.classList.add("sp-segmented-btn--active");
    buttons[opt.key] = btn;
    group.appendChild(btn);
  }
  const setActive = (key) => {
    for (const opt of options) {
      const btn = buttons[opt.key];
      const on = opt.key === key;
      btn.classList.toggle("sp-segmented-btn--active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
  };
  return { group, buttons, setActive };
}

// ---------------------------------------------------------------------------
// Phase 36 task 36.4b -- the "Stage" chip row: one small, quiet chip per
// tray-roster `kind:'asset'` row (map/splash/music/item), near the
// stage-toggle area, entirely absent when the roster has no asset rows.
// Name resolution matches scene-tray.js's own `nameFor` exactly
// (item-store-first-then-stagecraft); glyph resolution matches its
// `glyphFor` (an id present in the stagecraft lookup uses that asset's own
// `kind` glyph; otherwise it's a reliquary item -- the default glyph).
// Click navigates to the asset's Library shelf: `#library/stagecraft` for
// map/splash/music, `#library/reliquary` for an item. Pure read of already-
// fetched tray + item/stagecraft lookups -- no new store or route.
// ---------------------------------------------------------------------------
function stageDressingKindFor(id, lookups) {
  const asset = lookups.stagecraft.get(id);
  return asset ? asset.kind : "item"; // 'map'|'splash'|'music' from the real asset, else a reliquary item
}

function stageDressingNameFor(id, lookups) {
  return lookups.items.get(id)?.name ?? lookups.stagecraft.get(id)?.name ?? "?";
}

function buildStageDressingRow(scene, assetRoster, lookups) {
  if (!assetRoster.length) return null;
  const row = document.createElement("div");
  row.className = "scene-stage-dressing-row";
  row.setAttribute("data-testid", "scene-stage-dressing-row");
  row.setAttribute("data-scene-id", scene.id);
  for (const r of assetRoster) {
    const kind = stageDressingKindFor(r.id, lookups);
    const glyph = KIND_GLYPH[kind] || KIND_GLYPH.item;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "scene-stage-dressing-chip";
    chip.setAttribute("data-testid", "scene-stage-dressing-chip");
    chip.setAttribute("data-kind", kind);
    chip.setAttribute("data-asset-id", r.id);
    chip.textContent = `${glyph} ${stageDressingNameFor(r.id, lookups)}`;
    chip.addEventListener("click", () => {
      location.hash = kind === "item" ? "#library/reliquary" : "#library/stagecraft";
    });
    row.appendChild(chip);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Friction Wave 1 W3b -- the scene<->map link row. Always rendered (unlike
// the dressing row above, which is absent without roster assets): the whole
// point is that "no map linked" is VISIBLE, not an absence you have to infer.
//   - `scene-map-chip` -- ▦ + the linked asset's name (title carries its
//     src), or a muted "No map linked". data-map-asset-id mirrors the link.
//   - `scene-map-link-btn` toggles `scene-map-picker`, a <select> over the
//     world's existing kind:'map' stagecraft assets (label: name — src),
//     plus "(no map)" to clear. Change saves immediately via the ordinary
//     POST /api/session-planner/scenes/:id patch route (mapAssetId) and
//     repaints the chip in place.
// `onSaved` is the scene page's restartStagePollIfStaged -- a map link IS a
// scene-record edit, so it's a flush trigger like the objective field.
// ---------------------------------------------------------------------------
function buildSceneMapRow(scene, mapAssets, onSaved) {
  const row = document.createElement("div");
  row.className = "scene-map-row";
  row.setAttribute("data-testid", "scene-map-row");
  row.setAttribute("data-scene-id", scene.id);

  const chip = document.createElement("span");
  chip.className = "scene-map-chip";
  chip.setAttribute("data-testid", "scene-map-chip");
  chip.setAttribute("data-scene-id", scene.id);

  const linkBtn = document.createElement("button");
  linkBtn.type = "button";
  linkBtn.className = "scene-map-link-btn";
  linkBtn.setAttribute("data-testid", "scene-map-link-btn");
  linkBtn.setAttribute("data-scene-id", scene.id);

  const pickerHost = document.createElement("span");

  const paintChip = () => {
    const linked = scene.mapAssetId ? mapAssets.find((a) => a.id === scene.mapAssetId) : null;
    chip.setAttribute("data-map-asset-id", scene.mapAssetId ?? "");
    chip.setAttribute("data-has-map", scene.mapAssetId ? "true" : "false");
    if (scene.mapAssetId) {
      // A linked id whose asset record went missing still shows AS linked
      // (the id is real data) -- "(map asset missing)" says so honestly.
      chip.textContent = `▦ ${linked ? linked.name : "(map asset missing)"}`;
      chip.title = linked?.src ? `Map file: ${linked.src}` : "This map asset has no file path recorded yet — set one on its Library shelf row";
    } else {
      chip.textContent = "▦ No map linked";
      chip.title = "Link a stagecraft map asset so this scene's push can carry its map";
    }
    linkBtn.textContent = scene.mapAssetId ? "change" : "link a map…";
  };

  let pickerOpen = false;
  const closePicker = () => { pickerOpen = false; pickerHost.innerHTML = ""; };
  linkBtn.addEventListener("click", () => {
    if (pickerOpen) { closePicker(); return; }
    pickerOpen = true;
    pickerHost.innerHTML = "";
    if (!mapAssets.length) {
      const hint = document.createElement("span");
      hint.className = "scene-map-picker-empty";
      hint.setAttribute("data-testid", "scene-map-picker-empty");
      hint.textContent = "No map assets yet — add one on the Library's Stagecraft shelf.";
      pickerHost.appendChild(hint);
      return;
    }
    const select = document.createElement("select");
    select.className = "scene-map-picker";
    select.setAttribute("data-testid", "scene-map-picker");
    select.setAttribute("data-scene-id", scene.id);
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "(no map)";
    select.appendChild(noneOpt);
    for (const a of mapAssets) {
      const opt = document.createElement("option");
      opt.value = a.id;
      opt.textContent = a.src ? `${a.name} — ${a.src}` : a.name;
      select.appendChild(opt);
    }
    select.value = scene.mapAssetId ?? "";
    select.addEventListener("change", async () => {
      const chosen = select.value || null;
      select.disabled = true;
      try {
        const { scene: updated } = await spApi(`/api/session-planner/scenes/${encodeURIComponent(scene.id)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ world: currentWorld(), mapAssetId: chosen })
        });
        scene.mapAssetId = updated.mapAssetId ?? null;
        if (onSaved) onSaved();
      } catch { /* keep the old link on a failed write */ }
      closePicker();
      paintChip();
    });
    pickerHost.appendChild(select);
    select.focus();
  });

  paintChip();
  row.append(chip, linkBtn, pickerHost);
  return row;
}


// ---------------------------------------------------------------------------
// Run spread (2026-08-25/26): Run mode renders the scene as a module-style
// "runnable spread" -- a head band (title · pills · where), then a 3:2 grid
// whose MAIN column carries read-aloud beats, interaction beats, the
// Dressing list and the exits footer, and whose SIDE column carries the
// objective, the map (a sketch element or a thumbnail of the linked map
// asset), stat blocks, payload cards and GM boxes.
//
// It is a pure, read-only projection of the same scene/elements/narration
// the Prep DOM edits. WHERE each element goes is explicit data
// (`element.run` = {column, role, variant?, placeholder?}, see
// session-planner/run-layout.mjs -- served to the browser as
// `./run-layout.mjs` so inference is defined exactly once); an element
// without `run` falls back to that module's naming-convention inference.
// `scene.activeVariants` gates variant-tagged elements (empty = show all).
// Rebuilt from a fresh fetch every time Run is entered and on every
// run-version tick (typing in Prep never re-renders the list, so a cached
// copy would go stale).
// ---------------------------------------------------------------------------
function runSpreadEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

function runSpreadLabeledLine(label, value, { secret = false } = {}) {
  const line = runSpreadEl("div", "rs-line");
  const l = runSpreadEl("span", `rs-l${secret ? " rs-l--secret" : ""}`, label);
  line.append(l, document.createTextNode(String(value)));
  return line;
}

function runSpreadChecks(fields) {
  const out = [];
  const checks = fields?.checks;
  if (Array.isArray(checks) && checks.length) {
    for (const c of checks) out.push(runSpreadEl("span", "rs-check", `${c.skill} DC ${c.dc}${c.purpose ? ` — ${c.purpose}` : ""}`));
  }
  return out;
}

function runSpreadFieldLines(fields, keys) {
  const out = [];
  for (const f of keys) {
    const v = fields?.[f];
    if (v == null || String(v).trim() === "") continue;
    out.push(runSpreadLabeledLine(SCENE_FIELD_LABELS[f] ?? f, v, { secret: f === "secret" }));
  }
  return out;
}

// Inline SVG for a `sketch` element. Trusted local content (the GM's own
// prep), so this is a guard against accidents, not an adversary: must parse
// as SVG with an <svg> root; <script>/<foreignObject>, on* handlers and
// javascript: hrefs are dropped. Returns null when it isn't usable SVG.
function runSpreadSanitizeSvg(markup) {
  // Parse as HTML (not image/svg+xml): the HTML parser puts <svg> in the SVG
  // namespace even when the markup omits xmlns -- hand-drawn sketches
  // pasted from a page usually do, and an un-namespaced <svg> renders as
  // plain text.
  let doc;
  try { doc = new DOMParser().parseFromString(`<div>${String(markup || "")}</div>`, "text/html"); } catch { return null; }
  const root = doc.body?.firstElementChild?.querySelector("svg") ?? null;
  if (!root) return null;
  for (const bad of root.querySelectorAll("script, foreignObject")) bad.remove();
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const nodes = [root];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    for (const attr of Array.from(n.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || (/href$/.test(name) && /^\s*javascript:/i.test(attr.value))) n.removeAttribute(attr.name);
    }
  }
  root.removeAttribute("width"); root.removeAttribute("height"); // scale to the column
  return document.adoptNode(root);
}

// Variants round (2026-09-01): the GM's LOCAL tab choices — unitKey -> variant
// name (see planRunSpread's activeTabs contract). Ephemeral by adjudication:
// never written to any route; survives run-version rebuilds (an MCP burn
// landing mid-session must not reset the GM's tabs) and Prep<->Run flips;
// cleared only when a DIFFERENT scene renders.
let runTabState = new Map();
let runTabStateScene = null;

function buildRunSpread(scene, elements, narration, place, mapAssets, nodeMap) {
  if (runTabStateScene !== scene.id) {
    runTabState = new Map();
    runTabStateScene = scene.id;
  }
  const spread = runSpreadEl("div", "scene-run-spread");
  spread.setAttribute("data-testid", "scene-run-spread");
  spread.setAttribute("data-scene-id", scene.id);

  // ---- Head band: title + pills left, WHERE (place/whereNote · map) right.
  const head = runSpreadEl("div", "rs-head");
  const titleWrap = runSpreadEl("div", "rs-title");
  titleWrap.appendChild(runSpreadEl("h3", null, scene.name ?? "Untitled scene"));
  const pills = [];
  if (scene.kind === "combat") pills.push("combat");
  for (const t of Array.isArray(scene.tags) ? scene.tags : []) if (t && !pills.includes(t)) pills.push(t);
  if (pills.length) {
    const row = runSpreadEl("div", "rs-pills");
    for (const t of pills) row.appendChild(runSpreadEl("span", `rs-pill rs-pill--tag${t === "combat" || /live/i.test(t) ? " rs-pill--live" : ""}`, t));
    titleWrap.appendChild(row);
  }
  head.appendChild(titleWrap);
  const where = runSpreadEl("div", "rs-where");
  const linkedMap = scene.mapAssetId ? mapAssets.find((a) => a.id === scene.mapAssetId) : null;
  where.appendChild(document.createTextNode(scene.whereNote?.trim() ? scene.whereNote : (place?.name ?? "Unplaced")));
  if (linkedMap && !/\bmap\s*:/i.test(scene.whereNote || "")) { where.appendChild(document.createElement("br")); where.appendChild(document.createTextNode(`Map: ${linkedMap.name}`)); }
  head.appendChild(where);
  spread.appendChild(head);

  const grid = runSpreadEl("div", "rs-grid");
  const main = runSpreadEl("div", "rs-main");
  const side = runSpreadEl("div", "rs-side");
  grid.append(main, side);
  spread.appendChild(grid);

  // Scene-level narration opens the main column as the sensory line.
  const narrText = narration?.text ? String(narration.text).trim() : "";
  if (narrText) main.appendChild(runSpreadEl("p", "rs-sensory", narrText));

  // SIDE opens with the objective (the GM's "what has to happen here") —
  // unless the GM flagged it off for Run (Option A band, 2026-09-02: the
  // intent is often just the scene-locator note; absent flag = shown).
  if (scene.objectiveNote && String(scene.objectiveNote).trim() && scene.objectiveInRun !== false) {
    const box = runSpreadEl("div", "rs-box rs-box--objective");
    box.appendChild(runSpreadEl("b", "rs-box-l", "Objective"));
    box.appendChild(document.createTextNode(String(scene.objectiveNote)));
    side.appendChild(box);
  }

  // ---- Classify + filter: explicit run > inferred; variants; placeholders.
  // Variants round (2026-09-01): variant gating is a STAMP, not a drop —
  // planRunSpread turns gated members of folded cards into tabs, and drops
  // only the loose ones. Off-column and empty placeholders stay hard drops.
  const active = Array.isArray(scene.activeVariants) ? scene.activeVariants : [];
  const placed = [];
  for (const el of elements) {
    const { run } = effectiveRun(el);
    if (run.column === "off") continue;
    if (run.placeholder && elementIsEmpty(el)) continue;
    placed.push({ el, run, variantHidden: !variantVisible(run, active) });
  }

  // Map slot: sketch elements render in place (below); with none, a
  // thumbnail of the linked map asset sits at the top of the side column.
  const hasSketch = placed.some((p) => p.run.role === "sketch");
  if (!hasSketch && linkedMap?.src) {
    const wrap = runSpreadEl("div", "rs-map");
    const a = document.createElement("a");
    a.href = `/api/session-planner/stagecraft/${encodeURIComponent(linkedMap.id)}/image${spWithWorld()}`;
    a.target = "_blank"; a.rel = "noopener";
    const img = document.createElement("img");
    img.src = a.href; img.alt = linkedMap.name; img.loading = "lazy";
    img.addEventListener("error", () => wrap.remove(), { once: true }); // no file behind the src -> no empty frame
    a.appendChild(img); wrap.appendChild(a);
    wrap.appendChild(runSpreadEl("div", "rs-cap", linkedMap.name));
    side.appendChild(wrap);
  }

  // ---- Per-role builders.
  // Run-spread consolidation pass: the old "consecutive dressing rows fold
  // into one list" adjacency machinery (dressList/closeDressing) is retired —
  // planRunSpread (run-layout.mjs) now decides the whole column plan up
  // front (ALL ungrouped dressing → one hoisted card, side gm boxes → one
  // folded card at >=2, explicit run.group → composite cards), and this
  // renderer consumes that plan verbatim.
  const exitsFooter = runSpreadEl("div", "rs-exits");
  let exitsCount = 0;

  const roleTitle = (el, run, fallback) => {
    const t = titleAfterDash(el.name, "");
    return t || (run.variant ? run.variant : (el.name || fallback));
  };

  // Phase 4 draft-marking (persona round): a quiet amber pill on any Run
  // rendering of an element that still carries unreviewed model-drafted
  // fields -- generated text must never be indistinguishable from prep the
  // GM actually wrote. Cleared by editing the field(s) in Prep.
  const draftPill = (el) => {
    if (!Array.isArray(el.draftFields) || !el.draftFields.length) return null;
    const pill = runSpreadEl("span", "rs-pill rs-pill--draft", "✦ draft");
    pill.setAttribute("data-testid", "rs-draft-pill");
    pill.title = "Contains model-drafted text not yet reviewed in Prep";
    return pill;
  };
  const withDraftPill = (node, el) => {
    const dp = draftPill(el);
    if (dp) node.appendChild(dp);
    return node;
  };

  // The CONTENT of one element, per role — no outer box, no heading. The
  // per-role builders below (own box/heading) and the composite-card member
  // sections (shared card, section heading) both render through this, so a
  // role's field layout is defined exactly once.
  const appendRoleContent = (el, run, host) => {
    const f = el.fields || {};
    switch (run.role) {
      case "read":
        if (f.trigger) host.appendChild(runSpreadEl("div", "rs-when", f.trigger));
        if (f.looks) host.appendChild(runSpreadEl("p", "rs-read", f.looks));
        for (const k of ["gives", "means", "secret"]) {
          if (f[k]) host.appendChild(runSpreadLabeledLine(runFieldLabel("read", k, SCENE_FIELD_LABELS[k]), f[k], { secret: k === "secret" }));
        }
        break;
      case "card":
        if (f.gives) host.appendChild(runSpreadEl("p", "rs-phrase", f.gives));
        if (f.looks) host.appendChild(runSpreadLabeledLine(runFieldLabel("card", "looks"), f.looks));
        if (f.means) host.appendChild(runSpreadLabeledLine(runFieldLabel("card", "means"), f.means));
        for (const c of runSpreadChecks(f)) host.appendChild(c);
        if (f.secret) host.appendChild(runSpreadLabeledLine(runFieldLabel("card", "secret"), f.secret, { secret: true }));
        for (const line of runSpreadFieldLines(f, ["trigger", "wants", "function"])) host.appendChild(line);
        break;
      case "gm":
        if (f.trigger) host.appendChild(runSpreadEl("div", "rs-when", f.trigger));
        for (const k of ["looks", "gives", "means", "wants", "function", "secret"]) {
          if (f[k]) host.appendChild(runSpreadEl("div", "rs-boxp", f[k]));
        }
        for (const c of runSpreadChecks(f)) host.appendChild(c);
        break;
      case "block":
        if (el.bestiary) {
          const b = el.bestiary;
          const parts = [];
          if (b.ac != null) parts.push(`AC ${b.ac}`);
          if (b.hp != null) parts.push(`HP ${b.hp}`);
          if (b.cr != null) parts.push(`CR ${b.cr}`);
          const src = b.name && b.name !== el.name ? ` — ${b.name}` : "";
          if (parts.length || src) host.appendChild(runSpreadEl("span", "rs-bl", `${parts.join(" · ")}${src}`));
          if (b.note) host.appendChild(runSpreadLabeledLine("Note", b.note));
        } else if (f.statblockRef) {
          host.appendChild(runSpreadEl("span", "rs-bl", String(f.statblockRef)));
        }
        // Phase 4 honesty rule (persona round): an empty stat block used to
        // render as a clean nameplate that LOOKED prepped — "tonight I'd be
        // flipping through the physical MM mid-fight." A name reference
        // alone carries no numbers, so say so instead of implying readiness.
        if (!el.bestiary && !(el.stat && (String(el.stat.raw ?? "").trim() || el.stat.ac != null || el.stat.hp != null))) {
          host.appendChild(runSpreadEl("div", "rs-empty", "No stats entered — AC/HP/actions live in Prep (+ STAT BLOCK)."));
        }
        for (const c of runSpreadChecks(f)) host.appendChild(c);
        if (f.looks) host.appendChild(runSpreadEl("p", "rs-p", f.looks));
        for (const line of runSpreadFieldLines(f, ["trigger", "gives", "means", "wants", "function", "secret"])) host.appendChild(line);
        if (el.stat?.raw && String(el.stat.raw).trim()) host.appendChild(runSpreadEl("pre", "rs-stat", String(el.stat.raw)));
        break;
      case "sketch": {
        const svg = runSpreadSanitizeSvg(f.looks);
        if (svg) host.appendChild(svg);
        else host.appendChild(runSpreadEl("div", "rs-empty", `${el.name || "Sketch"}: no drawable SVG in its Looks field.`));
        if (f.means) host.appendChild(runSpreadEl("div", "rs-cap", f.means));
        break;
      }
      default: // beat, dressing-as-section, and anything unrecognized
        if (f.trigger) host.appendChild(runSpreadEl("div", "rs-when", f.trigger));
        if (f.looks) host.appendChild(runSpreadEl("p", "rs-p", f.looks));
        for (const c of runSpreadChecks(f)) host.appendChild(c);
        for (const line of runSpreadFieldLines(f, ["gives", "means", "wants", "function", "secret"])) host.appendChild(line);
        break;
    }
  };

  const buildRead = (el, run, host) => {
    host.appendChild(withDraftPill(runSpreadEl("div", "rs-h", roleTitle(el, run, "Read aloud")), el));
    appendRoleContent(el, run, host);
  };

  const buildBeat = (el, run, host) => {
    if (host === main) {
      main.appendChild(withDraftPill(runSpreadEl("div", "rs-h", el.name || "Beat"), el));
      appendRoleContent(el, { ...run, role: "beat" }, main);
      return;
    }
    const wrap = runSpreadEl("div", "rs-block rs-block--beat");
    const entityType = el.kind === "graph" && el.graphEntityId ? nodeMap?.get(el.graphEntityId)?.type : null;
    if (entityType) wrap.style.setProperty("--element-type-color", colorForType(entityType));
    const bh = runSpreadEl("div", "rs-bhead");
    bh.appendChild(runSpreadEl("span", "rs-bname", el.name || "(unnamed)"));
    if (el.kind === "graph") bh.appendChild(runSpreadEl("span", "rs-pill", entityType || "graph"));
    withDraftPill(bh, el);
    wrap.appendChild(bh);
    appendRoleContent(el, { ...run, role: "beat" }, wrap);
    host.appendChild(wrap);
  };

  const dressingLi = (el) => {
    const f = el.fields || {};
    const li = document.createElement("li");
    li.appendChild(runSpreadEl("b", null, el.name || "(unnamed)"));
    withDraftPill(li, el);
    const lead = [f.looks, f.gives].filter((x) => x && String(x).trim()).join(" ");
    if (lead) li.appendChild(document.createTextNode(` — ${lead}`));
    for (const line of runSpreadFieldLines(f, ["trigger", "means", "wants", "function", "secret"])) li.appendChild(line);
    for (const c of runSpreadChecks(f)) li.appendChild(c);
    return li;
  };

  // The ONE folded Dressing card — all the scene's ungrouped main dressing,
  // regardless of how they were interleaved in Prep order.
  const buildDressingCard = (members, host) => {
    host.appendChild(runSpreadEl("div", "rs-h", "Dressing"));
    const ul = runSpreadEl("ul", "rs-dress");
    ul.setAttribute("data-testid", "rs-dressing-card");
    for (const m of members) ul.appendChild(dressingLi(m.el));
    host.appendChild(ul);
  };

  const buildDressing = (el, run, host) => {
    if (host !== main) { buildBeat(el, run, host); return; } // dressing only makes sense as a list; on the side it's a small block
    buildDressingCard([{ el, run }], host);
  };

  const buildExits = (el) => {
    const f = el.fields || {};
    if (f.trigger) exitsFooter.appendChild(runSpreadEl("div", "rs-when", f.trigger));
    for (const k of ["gives", "means", "secret", "looks", "wants", "function"]) {
      const raw = f[k];
      if (!raw) continue;
      // One field may carry several exit lines (one per line).
      for (const lineRaw of String(raw).split(/\n+/)) {
        const parsed = parseExitLine(lineRaw);
        if (!parsed) continue;
        const row = runSpreadEl("div", "rs-exit");
        if (parsed.label) row.appendChild(runSpreadEl("b", null, parsed.label));
        row.appendChild(document.createTextNode(parsed.text));
        if (parsed.target) { row.appendChild(document.createTextNode(" — ")); row.appendChild(runSpreadEl("span", "rs-target", parsed.target)); }
        exitsFooter.appendChild(row);
        exitsCount++;
      }
    }
  };

  const buildBlock = (el, run, host) => {
    const block = runSpreadEl("div", "rs-block");
    const entityType = el.kind === "graph" && el.graphEntityId ? nodeMap?.get(el.graphEntityId)?.type : null;
    if (entityType) block.style.setProperty("--element-type-color", colorForType(entityType));
    const bh = runSpreadEl("div", "rs-bhead");
    bh.appendChild(runSpreadEl("span", "rs-bname", el.name || "(unnamed)"));
    if (el.kind === "graph") bh.appendChild(runSpreadEl("span", "rs-pill", entityType || "graph"));
    const count = el.stat && typeof el.stat.count === "number" ? el.stat.count : null;
    if (count && count > 1) bh.appendChild(runSpreadEl("span", "rs-mult", `×${count}`));
    withDraftPill(bh, el);
    block.appendChild(bh);
    appendRoleContent(el, { ...run, role: "block" }, block);
    host.appendChild(block);
  };

  const buildCard = (el, run, host) => {
    const card = runSpreadEl("div", "rs-block rs-card");
    const bh = runSpreadEl("div", "rs-bhead");
    bh.appendChild(runSpreadEl("span", "rs-bname", el.name || "Card"));
    withDraftPill(bh, el);
    card.appendChild(bh);
    appendRoleContent(el, { ...run, role: "card" }, card);
    host.appendChild(card);
  };

  const buildGm = (el, run, host) => {
    const box = runSpreadEl("div", "rs-box");
    box.appendChild(withDraftPill(runSpreadEl("b", "rs-box-l", el.name || "GM"), el));
    appendRoleContent(el, { ...run, role: "gm" }, box);
    host.appendChild(box);
  };

  const buildSketch = (el, run, host) => {
    const wrap = runSpreadEl("div", "rs-sketch");
    appendRoleContent(el, { ...run, role: "sketch" }, wrap);
    host.appendChild(wrap);
  };

  // One member of a composite card or of the folded side GM card: a compact
  // labeled section (heading via roleTitle so "Read Aloud — P-2 burns in
  // place" reads as "P-2 burns in place"), variant shown as a quiet pill.
  const buildMemberSection = (member, host, fallbackTitle, { suppressHeading = false } = {}) => {
    const sec = runSpreadEl("div", "rs-group-sec");
    const heading = roleTitle(member.el, member.run, fallbackTitle ?? (ROLE_LABELS[member.run.role] || "Item"));
    // When a tab row represents this member (its variant IS the active tab),
    // the tab is the heading — repeating it as a section header is noise.
    // The draft pill still needs a home when suppressed.
    if (!suppressHeading) {
      const sh = runSpreadEl("div", "rs-group-sec-h");
      sh.appendChild(runSpreadEl("span", null, heading));
      withDraftPill(sh, member.el);
      // The variant pill earns its place only when it ADDS something -- for a
      // "Read Aloud — Night" member whose variant is also "Night", the
      // heading already says it.
      if (member.run.variant && member.run.variant.trim().toLowerCase() !== String(heading).trim().toLowerCase()) {
        sh.appendChild(runSpreadEl("span", "rs-pill", member.run.variant));
      }
      sec.appendChild(sh);
    } else if (Array.isArray(member.el.draftFields) && member.el.draftFields.length) {
      const sh = runSpreadEl("div", "rs-group-sec-h");
      withDraftPill(sh, member.el);
      sec.appendChild(sh);
    }
    if (member.run.role === "dressing") {
      const ul = runSpreadEl("ul", "rs-dress");
      ul.appendChild(dressingLi(member.el));
      sec.appendChild(ul);
    } else if (member.run.role === "exits") {
      buildExits(member.el); // exits always feed the shared footer, even from a group
    } else {
      appendRoleContent(member.el, member.run, sec);
    }
    host.appendChild(sec);
  };

  // Variants round (2026-09-01, Treatment B): a tabbed unit's states render
  // as a clickable tab row. Clicking is a LOCAL flip only (adjudicated) —
  // it writes the module-level runTabState and re-renders this spread from
  // the args already in hand, never a route.
  const buildTabRow = (unit) => {
    const row = runSpreadEl("div", "rs-tabs");
    row.setAttribute("data-testid", "rs-tabs");
    for (const name of unit.tabs) {
      const tab = runSpreadEl("button", name === unit.activeTab ? "rs-tab rs-tab--active" : "rs-tab", name);
      tab.type = "button";
      tab.setAttribute("data-testid", "rs-tab");
      tab.setAttribute("data-variant", name);
      tab.setAttribute("aria-pressed", name === unit.activeTab ? "true" : "false");
      tab.title = "Show this state — local to this screen, nothing is written";
      tab.addEventListener("click", () => {
        runTabState.set(unit.key, name);
        spread.replaceWith(buildRunSpread(scene, elements, narration, place, mapAssets, nodeMap));
      });
      row.appendChild(tab);
    }
    return row;
  };

  // A composite card: the lead member renders as the card's own head +
  // content, its states as a tab row, every other visible member as a
  // labeled section underneath — "here's what the thread does" and its
  // outcomes on ONE card.
  const buildGroupCard = (unit, host) => {
    const card = runSpreadEl("div", "rs-block rs-group");
    card.setAttribute("data-testid", "rs-group");
    card.setAttribute("data-group", unit.group);
    const bh = runSpreadEl("div", "rs-bhead");
    bh.appendChild(runSpreadEl("span", "rs-bname", unit.lead.el.name || unit.group));
    if (unit.lead.run.variant) bh.appendChild(runSpreadEl("span", "rs-pill", unit.lead.run.variant));
    withDraftPill(bh, unit.lead.el);
    card.appendChild(bh);
    if (unit.lead.run.role === "exits") buildExits(unit.lead.el);
    else appendRoleContent(unit.lead.el, unit.lead.run, card);
    const tabbed = Array.isArray(unit.tabs) && unit.tabs.length >= 2;
    if (tabbed) card.appendChild(buildTabRow(unit));
    for (const m of unit.members) {
      if (m === unit.lead || m.hidden) continue;
      buildMemberSection(m, card, undefined, { suppressHeading: tabbed && m.run.variant === unit.activeTab });
    }
    host.appendChild(card);
  };

  // The folded side GM card (>=2 ungrouped gm boxes, gated ones included —
  // they render as tabs) — e.g. a scene's backdrop set as one tidy card
  // instead of a stack of near-identical boxes.
  const buildGmFold = (unit, host) => {
    const box = runSpreadEl("div", "rs-box rs-gmfold");
    box.setAttribute("data-testid", "rs-gm-fold");
    box.appendChild(runSpreadEl("b", "rs-box-l", "GM notes"));
    const tabbed = Array.isArray(unit.tabs) && unit.tabs.length >= 2;
    if (tabbed) box.appendChild(buildTabRow(unit));
    for (const m of unit.members) {
      if (m.hidden) continue;
      buildMemberSection(m, box, "GM", { suppressHeading: tabbed && m.run.variant === unit.activeTab });
    }
    host.appendChild(box);
  };

  const renderUnit = (unit, host) => {
    if (unit.kind === "dressing") { buildDressingCard(unit.members, host); return; }
    if (unit.kind === "gm-fold") { buildGmFold(unit, host); return; }
    if (unit.kind === "group") { buildGroupCard(unit, host); return; }
    const { el, run } = unit;
    switch (run.role) {
      case "read": host === main ? buildRead(el, run, host) : buildGm(el, run, host); break;
      case "dressing": buildDressing(el, run, host); break;
      case "beat": buildBeat(el, run, host); break;
      case "exits": buildExits(el); break;
      case "block": buildBlock(el, run, host); break;
      case "card": buildCard(el, run, host); break;
      case "gm": buildGm(el, run, host); break;
      case "sketch": buildSketch(el, run, host); break;
      default: buildBeat(el, run, host);
    }
  };

  const plan = planRunSpread(placed, { activeTabs: runTabState });
  for (const unit of plan.main) renderUnit(unit, main);
  for (const unit of plan.side) renderUnit(unit, side);
  if (exitsCount) main.appendChild(exitsFooter);

  if (!side.childNodes.length) side.appendChild(runSpreadEl("div", "rs-empty", "Nothing on the side yet — stat blocks, cards, GM boxes and sketches live here."));
  if (!main.childNodes.length) main.appendChild(runSpreadEl("div", "rs-empty", "Nothing to read yet — add read-aloud text or elements in Prep."));
  return spread;
}

async function renderScenePage(container, sceneId, token, opts = {}) {
  // Phase 30 task 30.3: `opts` lets the SAME scene-page render serve both the
  // legacy `#session-planner/<id>` chrome (default) and the new designer shell
  // (`opts.designer` -> the `planner-scene-view` root + its three named
  // sub-roots, `opts.nav` -> shell hash targets for prev/next/esc). All the
  // Phase 28/29 element/stat-block/wrap/dressing/from-graph behavior below is
  // reused verbatim -- only the outer testids and nav hashes differ.
  const designer = !!opts.designer;
  const rootTestid = opts.rootTestid || "scene-page";
  const nav = opts.nav || {};
  const sceneHash = nav.sceneHash || ((id) => `session-planner/${id}`);
  const plansHash = nav.plansHash || ((plan) => (plan ? `plans/${plan.id}` : "plans"));
  const stale = () => token !== sceneRenderToken;
  const loading = document.createElement("p");
  loading.className = "hint";
  loading.textContent = "Loading scene…";
  container.appendChild(loading);

  let scene, graph, narration, plans;
  try {
    ({ scene } = await spApi(`/api/session-planner/scenes/${encodeURIComponent(sceneId)}${spWithWorld()}`));
  } catch (err) {
    if (stale()) return;
    container.innerHTML = "";
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = `Could not load scene: ${err.message}`;
    container.appendChild(p);
    return;
  }
  if (!scene) {
    container.innerHTML = "";
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Scene not found.";
    container.appendChild(p);
    return;
  }

  graph = await spApi(`/api/graph${spWithWorld({ filter: "all" })}`).catch(() => ({ nodes: [], edges: [] }));
  const nodeMap = new Map((graph.nodes || []).map((n) => [n.id, n]));
  // Phase 37.6 task 2: this render's own `/api/graph` fetch IS the "view init"
  // population resolveSceneDisplayName's doc-comment was waiting on -- every
  // scene-page render (both entry points, and therefore every navigation AND
  // every world change, since both re-invoke this render) refreshes the module-
  // level map from the SAME nodeMap built above, so resolveSceneDisplayName's
  // (used by buildSceneBreadcrumb's prev/next neighbor-name lookup just below)
  // fallback resolves to the real place name instead of the raw `wf_...` id.
  entityInfoMapGlobal = nodeMap;
  narration = (await spApi(`/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/narration${spWithWorld()}`).catch(() => ({ narration: null }))).narration;
  plans = (await spApi(`/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/plans${spWithWorld()}`).catch(() => ({ plans: [] }))).plans ?? [];
  // Phase 36 task 36.4b -- the "Stage" chip row's data: the SAME tray roster
  // + item/stagecraft lookups the shared scene-tray component already reads
  // (no new store/route). Only fetches the lookups when the roster actually
  // carries an asset row, since the row is entirely absent otherwise.
  const trayRoster = (await spApi(`/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/tray${spWithWorld()}`).catch(() => ({ roster: [] }))).roster ?? [];
  // Friction Wave 1 W3b -- the scene<->map link's picker needs the world's
  // map assets regardless of whether the tray roster carries any (linking a
  // map is exactly what a scene with an empty tray wants to do first).
  const mapAssets = (await spApi(`/api/session-planner/stagecraft${spWithWorld({ kind: "map" })}`).catch(() => ({ assets: [] }))).assets ?? [];
  const assetRoster = trayRoster.filter((r) => r.kind === "asset");
  const stageDressingLookups = { items: new Map(), stagecraft: new Map() };
  if (assetRoster.length) {
    const [itemsRes, stagecraftRes] = await Promise.all([
      spApi(`/api/combat-planning/items${spWithWorld()}`).catch(() => ({ items: [] })),
      spApi(`/api/session-planner/stagecraft${spWithWorld()}`).catch(() => ({ assets: [] }))
    ]);
    stageDressingLookups.items = new Map((itemsRes.items || []).map((i) => [i.id, i]));
    stageDressingLookups.stagecraft = new Map((stagecraftRes.assets || []).map((a) => [a.id, a]));
  }
  if (stale()) return;

  container.innerHTML = "";
  // Phase 29 task 29.5: layout always opens fresh in Page. QA W2 fix (Group A
  // #1): Prep|Run mode does NOT reset on every scene render any more -- only
  // when the world has changed since the mode was last set (or the caller
  // explicitly left the planner surface via resetScenePageMode). This is what
  // makes prev/next/rail navigation between scenes preserve Run mode.
  const activeWorld = currentWorld();
  if (scenePageModeWorld !== activeWorld) {
    sceneView = "prep";
    scenePageModeWorld = activeWorld;
  }
  const root = document.createElement("div");
  root.className = "scene-page";
  root.setAttribute("data-testid", rootTestid);
  root.setAttribute("data-scene-id", scene.id);
  root.setAttribute("data-mode", sceneView === "run" ? "run" : "prep"); // "run" hides edit chrome via CSS

  // Top bar: breadcrumb (left) + Page|Cards / Prep|Run segmented controls +
  // Wrap toggle (right, filled by 28.4).
  const topBar = document.createElement("div");
  topBar.className = "scene-top-bar";
  // In the shell, the persistent breadcrumb chrome owns the "‹ Plan/Plans" back
  // link -- suppress the in-page one there and route prev/next to shell hashes.
  const { bc, firstPlan, prevId, nextId } = await buildSceneBreadcrumb(scene, plans, {
    sceneHash, plansHash, showBack: !designer
  });
  if (stale()) return;
  topBar.appendChild(bc);

  // Right-hand cluster: the ONE three-way view control, then the Wrap button.
  // Wrap stays furthest right (README §C sub-bar order). Testids deliberately
  // reuse the old pair's (mode-prep-btn / layout-board-btn / mode-run-btn) --
  // dozens of e2e tests drive them; only layout-page-btn retired.
  const subBarRight = document.createElement("div");
  subBarRight.className = "scene-subbar-controls";

  const viewControl = buildSegmentedControl(scene.id, [
    { key: "prep", label: "Prep", testid: "mode-prep-btn", active: sceneView === "prep" },
    { key: "board", label: "Layout", testid: "layout-board-btn", active: sceneView === "board" },
    { key: "run", label: "Run", testid: "mode-run-btn", active: sceneView === "run" }
  ]);
  subBarRight.append(viewControl.group);

  // O1: the Prep layout rail's disclosure button. The rail itself is built
  // by renderSceneElementsList; this just flips `data-rail` on the page
  // (CSS turns the prep container into a flex row and reveals the rail).
  const railBtn = document.createElement("button");
  railBtn.type = "button";
  railBtn.className = "btn scene-rail-toggle-btn";
  railBtn.setAttribute("data-testid", "rail-toggle-btn");
  railBtn.title = "Show the Run-layout lanes beside Prep — drag a row's ◆/◦ grip into a lane to place it";
  const paintRail = () => {
    railBtn.textContent = railOpen ? "▤ lanes ▾" : "▤ lanes ▸";
    railBtn.setAttribute("aria-pressed", railOpen ? "true" : "false");
    root.setAttribute("data-rail", railOpen ? "open" : "closed");
  };
  railBtn.addEventListener("click", () => { railOpen = !railOpen; paintRail(); });
  paintRail();
  subBarRight.appendChild(railBtn);

  const wrapBtn = document.createElement("button");
  wrapBtn.type = "button";
  wrapBtn.className = "btn scene-wrap-toggle-btn";
  wrapBtn.setAttribute("data-testid", "wrap-toggle-btn");
  wrapBtn.setAttribute("data-scene-id", scene.id);
  wrapBtn.textContent = "Wrap ▸";
  wrapBtn.title = "Wrap this scene: propose graph updates from notes + promote elements";
  subBarRight.appendChild(wrapBtn);
  topBar.appendChild(subBarRight);
  root.appendChild(topBar);

  // Run spread host (see buildRunSpread): sits right under the top bar so in
  // Run mode the spread is the first thing on the page. Hidden by CSS in Prep.
  const runHost = document.createElement("div");
  runHost.className = "scene-run-spread-host";
  runHost.setAttribute("data-testid", "scene-run-spread-host");
  root.appendChild(runHost);

  // View switching (applyView) is wired further down, next to the run-poll
  // machinery it starts/stops -- it needs wrapPanel/rebuildRunSpread, which
  // are defined later in this function.

  // Place header (the room). In the designer shell this is one of the three
  // named sub-roots the phase30 contract pins (planner-scene-place-header).
  const header = document.createElement("div");
  header.className = "scene-place-header";
  const place = scene.locationEntityId ? nodeMap.get(scene.locationEntityId) : null;
  // Option A front-matter band (Russell, 2026-09-02): place label + name on
  // ONE line — the seven stacked blocks above the read-aloud compress into
  // three band rows (title, intent, chips).
  const titleRow = document.createElement("div");
  titleRow.className = "scene-band-titlerow";
  if (designer) {
    header.setAttribute("data-testid", "planner-scene-place-header");
    // Designer §C.1: mono uppercase teal place label, now INLINE before the name.
    const placeLabel = document.createElement("div");
    placeLabel.className = "scene-place-label";
    placeLabel.setAttribute("data-testid", "scene-place-label");
    placeLabel.textContent = (place?.name ?? scene.locationEntityId ?? "Unplaced").toUpperCase();
    titleRow.appendChild(placeLabel);
  }
  // Russell (2026-08-16, Kilmarn exercise): the big header title is the
  // SCENE's name, not the place's — the teal label above already carries the
  // place, so rendering the place twice read as a bug ("scenes are all
  // adopting the plan title"). Click-to-edit now renames the SCENE (29.1
  // patch route); place renames live in the World tab / graph views.
  const titleField = makeClickToEditField({
    tag: "h2",
    className: "scene-place-name",
    testid: "scene-title",
    dataAttrs: { "data-scene-id": scene.id },
    inputTestid: "scene-title-input",
    value: scene.name ?? "Untitled scene",
    placeholder: "Scene title…",
    save: (v) => spApi(`/api/session-planner/scenes/${encodeURIComponent(scene.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld(), name: v })
    })
  });
  titleRow.appendChild(titleField.el);
  header.appendChild(titleRow);
  if (!scene.locationEntityId) {
    const noPlace = document.createElement("p");
    noPlace.className = "hint";
    noPlace.textContent = "This scene has no anchor place.";
    header.appendChild(noPlace);
  }

  // §C.3 -- objective: the scene page's third body line, click-to-edit,
  // always rendered (even empty). Autosaves via the 29.1 updateScene route.
  const objectiveField = makeClickToEditField({
    tag: "div",
    className: "scene-objective",
    testid: "scene-objective",
    dataAttrs: { "data-scene-id": scene.id },
    inputTestid: "scene-objective-input",
    inputDataAttrs: { "data-scene-id": scene.id },
    value: scene.objectiveNote ?? "",
    placeholder: "What has to happen here?",
    emptyText: "Click to set this scene's objective…",
    multiline: true, // free-text objective note, genuinely multi-line
    save: (v) => {
      scene.objectiveNote = v;
      return spApi(`/api/session-planner/scenes/${encodeURIComponent(scene.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld(), objectiveNote: v })
      });
    },
    // Phase 36 task 36.4a -- this save touches the scene RECORD itself
    // (server-side maybeScheduleFlush trigger), so it's one of the mutations
    // that should restart the "in Foundry" self-refresh poll while staged.
    onSaved: () => restartStagePollIfStaged()
  });
  // Band row 2: intent + the "off in Run" toggle chip. The intent is often
  // the GM's scene-locator note — absent flag = shown (pre-flag behavior).
  const intentRow = document.createElement("div");
  intentRow.className = "scene-band-intentrow";
  intentRow.appendChild(objectiveField.el);
  const intentChip = document.createElement("button");
  intentChip.type = "button";
  intentChip.className = "scene-band-chip scene-intent-run-toggle";
  intentChip.setAttribute("data-testid", "intent-run-toggle");
  const paintIntentChip = () => {
    const shown = scene.objectiveInRun !== false;
    intentChip.textContent = shown ? "shown in Run" : "GM only · off in Run";
    intentChip.setAttribute("data-in-run", shown ? "true" : "false");
    intentChip.title = shown
      ? "The intent renders as the Run spread's Objective box — click to keep it GM-only"
      : "GM-only: the Run spread hides this — click to show it as the Objective box";
  };
  paintIntentChip();
  intentChip.addEventListener("click", async () => {
    const next = !(scene.objectiveInRun !== false);
    intentChip.disabled = true;
    try {
      await spApi(`/api/session-planner/scenes/${encodeURIComponent(scene.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld(), objectiveInRun: next })
      });
      scene.objectiveInRun = next;
    } finally {
      intentChip.disabled = false;
      paintIntentChip();
    }
  });
  intentRow.appendChild(intentChip);
  header.appendChild(intentRow);

  // Phase 36 task 36.2, §7 -- the "stage it" toggle + subtle "in Foundry ·
  // updated Xm ago" status line. Locked decision: NO push button -- staged
  // scenes mirror to Foundry quietly, live on change (server-side debounced
  // flush) plus Sync now as catch-up. This is the ONE small affordance;
  // nothing modal, nothing loud.
  const stageRow = document.createElement("div");
  stageRow.className = "scene-stage-row";
  const stageToggleLabel = document.createElement("label");
  stageToggleLabel.className = "scene-stage-toggle-label";
  const stageToggle = document.createElement("input");
  stageToggle.type = "checkbox";
  stageToggle.className = "scene-stage-toggle";
  stageToggle.setAttribute("data-testid", "scene-stage-toggle");
  stageToggle.setAttribute("data-scene-id", scene.id);
  stageToggle.setAttribute("data-staged", scene.stagedForFoundry ? "true" : "false");
  stageToggle.checked = !!scene.stagedForFoundry;
  stageToggleLabel.append(stageToggle, document.createTextNode(" Stage for Foundry"));
  const stageStatusLine = document.createElement("div");
  stageStatusLine.className = "scene-stage-status-line";
  stageStatusLine.setAttribute("data-testid", "scene-stage-status-line");
  stageStatusLine.setAttribute("data-scene-id", scene.id);
  const renderStageStatus = () => {
    stageStatusLine.remove();
    if (!scene.stagedForFoundry) return;
    // Copy deliberately avoids the words "push"/"sync now" (phase36-fixture.mjs
    // §7's own contract text illustrates "not yet pushed" as example copy,
    // but its own e2e assertion literally forbids that substring -- a real
    // contradiction in the written contract, flagged in this task's report;
    // "not yet live" satisfies both the quiet-line intent and the actual test).
    const ago = scene.lastPushedAt ? formatRelativeAgo(scene.lastPushedAt) : null;
    stageStatusLine.textContent = ago ? `in Foundry · updated ${ago}` : "in Foundry · not yet live";
    stageRow.appendChild(stageStatusLine);
  };

  // Phase 36 task 36.4a -- the status line SELF-REFRESHES: a bounded client
  // poll of the scene record (never an unbounded interval), started after
  // any mutation on a STAGED scene (the toggle itself, this scene's own
  // objective/narration edits, and structural element changes -- see their
  // own `restartStagePollIfStaged()` call sites below) so the line catches
  // the quiet server-side flush landing (§7's "in Foundry · updated Xm ago")
  // without the user reloading. Ticks at ~3s/8s/15s; stops the moment
  // `lastPushedAt` visibly advances (or the scene becomes unstaged), or the
  // page navigates away (`stale()`) -- whichever comes first. No visible
  // spinner -- the line just updates in place, e.g. to "updated just now".
  let stagePollTimer = null;
  function stopStagePoll() {
    if (stagePollTimer) { clearTimeout(stagePollTimer); stagePollTimer = null; }
  }
  function restartStagePollIfStaged() {
    stopStagePoll();
    if (!scene.stagedForFoundry) return;
    const knownLastPushedAt = scene.lastPushedAt;
    const ticks = [3000, 8000, 15000];
    const tick = (idx) => {
      if (idx >= ticks.length) return;
      stagePollTimer = setTimeout(async () => {
        if (stale() || !scene.stagedForFoundry) return;
        try {
          const { scene: fresh } = await spApi(`/api/session-planner/scenes/${encodeURIComponent(scene.id)}${spWithWorld()}`);
          if (stale()) return;
          if (fresh && (fresh.lastPushedAt !== knownLastPushedAt || fresh.stagedForFoundry !== scene.stagedForFoundry)) {
            scene.stagedForFoundry = fresh.stagedForFoundry;
            scene.lastPushedAt = fresh.lastPushedAt;
            renderStageStatus();
            return; // advanced (or unstaged elsewhere) -- stop early, no further ticks
          }
        } catch {
          // Best-effort -- a transient fetch error just skips this tick, the
          // chain still ends at the same bound.
        }
        tick(idx + 1);
      }, ticks[idx]);
    };
    tick(0);
  }

  stageToggle.addEventListener("change", async () => {
    const staged = stageToggle.checked;
    stageToggle.disabled = true;
    try {
      const { scene: updated } = await spApi(`/api/session-planner/scenes/${encodeURIComponent(scene.id)}/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld(), staged })
      });
      scene.stagedForFoundry = updated.stagedForFoundry;
      scene.lastPushedAt = updated.lastPushedAt;
    } catch {
      stageToggle.checked = !staged; // revert on a failed write
    } finally {
      stageToggle.disabled = false;
      stageToggle.setAttribute("data-staged", scene.stagedForFoundry ? "true" : "false");
      renderStageStatus();
      if (scene.stagedForFoundry) restartStagePollIfStaged();
      else stopStagePoll();
    }
  });
  stageRow.appendChild(stageToggleLabel);
  renderStageStatus();
  if (scene.stagedForFoundry) restartStagePollIfStaged(); // a fresh load of an already-staged scene watches too, not just a just-flipped toggle

  // Band row 3: stage + map as one quiet chip row (Friction Wave 1 W3b's
  // always-visible map glance kept, just chip-shaped now).
  const chipRow = document.createElement("div");
  chipRow.className = "scene-band-chiprow";
  chipRow.appendChild(stageRow);
  chipRow.appendChild(buildSceneMapRow(scene, mapAssets, restartStagePollIfStaged));
  header.appendChild(chipRow);

  // Phase 36 task 36.4b -- the "Stage" chip row, near the toggle above.
  const dressingRow = buildStageDressingRow(scene, assetRoster, stageDressingLookups);
  if (dressingRow) header.appendChild(dressingRow);

  // §C.4/§C.5 -- "The place" description grid OR the missing-description
  // banner, now behind an "About the place" DISCLOSURE (Option A band):
  // develop-this-place lives INSIDE the same section (no divider), and the
  // whole thing opens itself only while the place has no description —
  // develop matters most exactly then. Editing still writes the graph NODE.
  if (place) {
    const hasPlaceDesc = !!(typeof place.description === "string" && place.description.trim() !== "");
    const about = document.createElement("details");
    about.className = "scene-about-place";
    about.setAttribute("data-testid", "scene-about-place");
    if (!hasPlaceDesc) about.open = true;
    const summary = document.createElement("summary");
    summary.className = hasPlaceDesc ? "scene-about-summary" : "scene-about-summary scene-about-summary--empty";
    const sumLbl = document.createElement("span");
    sumLbl.className = "scene-about-summary-label";
    sumLbl.textContent = "About the place";
    const sumPreview = document.createElement("span");
    sumPreview.className = "scene-about-summary-preview";
    const previewText = hasPlaceDesc ? String(place.description).replace(/\s+/g, " ").trim() : "no description yet";
    sumPreview.textContent = previewText.length > 90 ? `${previewText.slice(0, 90)}…` : previewText;
    summary.append(sumLbl, sumPreview);
    about.appendChild(summary);
    about.appendChild(buildPlaceDescriptionBlock(scene, place));
    header.appendChild(about);
  }
  root.appendChild(header);

  // §C.6 -- Read-aloud (the serif narration box). In the designer shell this is
  // its own named sub-root (planner-scene-read-aloud) with a mono "READ ALOUD"
  // label + 2px left rule; in the legacy chrome it just sits inline.
  // NB the narration field's own `.scene-narration.read-aloud` CSS already
  // paints the designer's 2px left rule + "READ ALOUD" mono label (::before),
  // so this sub-root is a plain wrapper carrying only the contract testid.
  const readAloudSection = document.createElement("div");
  readAloudSection.className = "scene-read-aloud-section";
  if (designer) readAloudSection.setAttribute("data-testid", "planner-scene-read-aloud");
  // This-scene narration (serif read-aloud box). Always rendered, even empty.
  const narrationField = makeClickToEditField({
    tag: "div",
    className: "scene-narration read-aloud",
    testid: "scene-narration",
    dataAttrs: { "data-scene-id": scene.id },
    inputTestid: "scene-narration-input",
    value: narration?.text ?? "",
    placeholder: "Read-aloud narration for this scene…",
    emptyText: "Click to add this scene's read-aloud narration…",
    multiline: true, // free-text read-aloud narration, genuinely multi-line
    save: (v) => spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/narration`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld(), text: v })
    }),
    // Phase 36 task 36.4a -- same "content write bumps scene recency" flush
    // trigger as the objective field above.
    onSaved: () => restartStagePollIfStaged()
  });
  readAloudSection.appendChild(narrationField.el);

  // §C.6 -- draft-read-aloud ghost link: only when narration is empty AND the
  // place has a real (non-empty) description. When the place has no
  // description the banner above covers that case, so the link stays hidden.
  const narrationEmpty = !(narration && narration.text && String(narration.text).trim());
  const placeHasDesc = !!(place && typeof place.description === "string" && place.description.trim() !== "");
  if (narrationEmpty && placeHasDesc) {
    readAloudSection.appendChild(buildDraftReadAloudLink(scene, place, narrationField));
  }
  root.appendChild(readAloudSection);

  // Elements list. In the designer shell this is the third named sub-root
  // (planner-scene-elements).
  const elementsSection = document.createElement("div");
  elementsSection.className = "scene-elements-section";
  if (designer) elementsSection.setAttribute("data-testid", "planner-scene-elements");
  const elementsHeading = document.createElement("h3");
  elementsHeading.className = "scene-section-heading";
  elementsHeading.textContent = "Elements";
  elementsSection.appendChild(elementsHeading);
  const listHost = document.createElement("div");
  const refreshElements = async () => {
    await renderSceneElementsList(scene, listHost, nodeMap);
    // Phase 36 task 36.4a -- every structural element op (add/remove/promote/
    // demote/reorder/from-graph) routes through this SAME re-render choke
    // point and touches the scene server-side (touchSceneSafely) -- restart
    // the status-line poll here too, alongside the objective/narration fields
    // above and the toggle itself.
    if (scene.stagedForFoundry) restartStagePollIfStaged();
  };
  elementsSection.appendChild(listHost);
  // §C (Option A band): the `✦` propose ghost moved to the BOTTOM, beside
  // the other adders — assists follow the content, they don't lead it. On an
  // empty scene the list above is empty, so this still reads at the top.
  // The seed-run-skeleton ghost is RETIRED (Russell, 2026-09-02): new
  // elements default sensibly via inference and get sorted in the lanes;
  // the seed route + wf_seed_run_skeleton stay for agents/tests.
  elementsSection.appendChild(buildProposeElementsGhostLink(scene, refreshElements));
  // §C (below the elements): `◇ From graph` inline picker + `▣ NPC or
  // creature` + `▤ From library` (Phase 37.6 task 1 retired `✦ Suggest
  // dressing` from this row -- see buildSceneActionsRow's own doc comment).
  elementsSection.appendChild(buildSceneActionsRow(scene, refreshElements));
  root.appendChild(elementsSection);
  if (stale()) return;
  await refreshElements();
  if (stale()) return;

  // §A: the Wrap panel -- an inline slide-down under the top bar (no modal, no
  // navigation). Built here (after listHost/refreshElements exist) and slotted
  // right beneath the top bar so it reads as a slide-down from `Wrap ▸`.
  const wrapPanel = buildWrapPanel(scene, refreshElements);
  topBar.after(wrapPanel);
  wrapBtn.addEventListener("click", async () => {
    const opening = wrapPanel.hidden;
    wrapPanel.hidden = !opening;
    wrapBtn.textContent = opening ? "Wrap ▾" : "Wrap ▸";
    if (opening) await populateWrapPromoteList(scene, wrapPanel, refreshElements);
  });

  // Phase 29 task 29.5: Prep|Run mode. Run flips the scene-page's data-mode
  // attribute (CSS hides all edit chrome, bumps read-aloud to 20px, collapses
  // MUNDANE rows to their Gives line) and force-closes the Wrap panel (the Wrap
  // toggle itself is CSS-hidden in run mode, so it must not be left open).
  // The run spread is rebuilt from a FRESH elements fetch every time Run is
  // entered (Prep typing mutates DOM in place without re-rendering the list,
  // so anything cached here would silently lag behind the last edit).
  const rebuildRunSpread = async () => {
    let elements = [];
    try {
      ({ elements } = await spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements${spWithWorld()}`));
    } catch { elements = []; }
    let freshNarration = narration;
    try {
      freshNarration = (await spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/narration${spWithWorld()}`)).narration;
    } catch { /* keep the render-time copy */ }
    // The scene record too (activeVariants / tags / whereNote can change
    // under a live session -- e.g. an agent flipping variants over MCP).
    try {
      const { scene: fresh } = await spApi(`/api/session-planner/scenes/${encodeURIComponent(scene.id)}${spWithWorld()}`);
      if (fresh) Object.assign(scene, fresh);
    } catch { /* keep the render-time copy */ }
    if (stale()) return;
    runHost.innerHTML = "";
    runHost.appendChild(buildRunSpread(scene, elements || [], freshNarration, place, mapAssets, nodeMap));
  };
  // Run-mode live refresh (2026-08-26): while in Run, poll the cheap
  // run-version fingerprint (scene record + elements + narration) every few
  // seconds and rebuild the spread only when it changes -- so an edit made
  // elsewhere (Prep in another tab, an agent over MCP flipping
  // activeVariants mid-session) lands on the table without a reload. Same
  // bounded-chained-setTimeout shape as restartStagePollIfStaged above:
  // never an unbounded setInterval; stops on leaving Run, navigation
  // (stale()), and while the tab is hidden.
  const RUN_POLL_MS = 3000;
  let runPollTimer = null;
  let runVersion = null;
  const stopRunPoll = () => { if (runPollTimer) { clearTimeout(runPollTimer); runPollTimer = null; } };
  const flashSpreadUpdated = () => {
    const headEl = runHost.querySelector(".rs-head");
    if (!headEl) return;
    const tag = document.createElement("span");
    tag.className = "rs-updated";
    tag.setAttribute("data-testid", "scene-run-updated");
    tag.textContent = "updated just now";
    headEl.appendChild(tag);
    setTimeout(() => tag.remove(), 4000);
  };
  const runPollTick = async () => {
    runPollTimer = null;
    if (stale() || sceneView !== "run") return;
    if (document.visibilityState === "hidden") { runPollTimer = setTimeout(runPollTick, RUN_POLL_MS); return; }
    try {
      const { version } = await spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/run-version${spWithWorld()}`);
      if (stale() || sceneView !== "run") return;
      if (runVersion !== null && version !== runVersion) {
        await rebuildRunSpread();
        flashSpreadUpdated();
      }
      runVersion = version;
    } catch {
      // transient -- try again next tick
    }
    if (!stale() && sceneView === "run") runPollTimer = setTimeout(runPollTick, RUN_POLL_MS);
  };
  const startRunPoll = () => {
    stopRunPoll();
    runVersion = null;
    // Baseline IMMEDIATELY (0ms), not on the first 3s tick: the old
    // first-tick baseline silently swallowed any write landing in the first
    // poll window (entered Run at t=0, agent writes at t=1, tick at t=3
    // baselines the post-write version -> the change never renders until
    // the NEXT write). Caught by run-tabs.e2e.mjs, a latent gap predating
    // the variants round.
    runPollTimer = setTimeout(runPollTick, 0);
  };

  // The ONE three-way switch (variants round): prep|board share
  // data-mode="prep" (board is a structural re-render of the list, exactly
  // as the old applyLayout did); run flips data-mode + the poll.
  const applyView = (view) => {
    const wasBoard = sceneView === "board";
    const wasRun = sceneView === "run";
    sceneView = view;
    viewControl.setActive(view);
    root.setAttribute("data-mode", view === "run" ? "run" : "prep");
    const list = root.querySelector('[data-testid="scene-elements-list"]');
    if (list) list.setAttribute("data-layout", view === "board" ? "board" : "page");
    if ((view === "board") !== wasBoard) refreshElements();
    if (view === "run") {
      if (!wrapPanel.hidden) {
        wrapPanel.hidden = true;
        wrapBtn.textContent = "Wrap ▸";
      }
      rebuildRunSpread();
      startRunPoll();
    } else if (wasRun) {
      stopRunPoll();
    }
  };
  if (sceneView === "run") { rebuildRunSpread(); startRunPoll(); } // navigated here already in Run
  viewControl.buttons.prep.addEventListener("click", () => applyView("prep"));
  viewControl.buttons.board.addEventListener("click", () => applyView("board"));
  viewControl.buttons.run.addEventListener("click", () => applyView("run"));

  // Inline events / encounters / notes (task-required, reusing existing
  // per-scene SessionNote + saved-encounter mechanisms). Not e2e-gated here.
  const extrasSection = document.createElement("div");
  extrasSection.className = "scene-extras-section";
  const extrasHeading = document.createElement("h3");
  extrasHeading.className = "scene-section-heading";
  extrasHeading.textContent = "Events, encounters & notes";
  extrasSection.appendChild(extrasHeading);

  const extrasBar = document.createElement("div");
  extrasBar.className = "scene-extras-bar";
  const eventCtl = mountAddEventControl(scene);
  const encounterCtl = mountAddEncounterControl(scene);
  extrasBar.append(eventCtl.btn, encounterCtl.btn);
  extrasSection.append(extrasBar, eventCtl.panel, encounterCtl.panel);

  const savedEncounters = await fetchSavedEncounters(scene.id);
  if (stale()) return;
  extrasSection.appendChild(renderSavedEncountersList(scene.id, savedEncounters));
  root.appendChild(extrasSection);

  // Beyond-this-room drawer (disclosure -- graph neighbors + guarded delete).
  root.appendChild(buildBeyondRoomDrawer(scene, nodeMap, graph.edges || []));

  if (stale()) return;
  container.innerHTML = "";
  container.appendChild(root);

  // [ / ] / Esc keyboard shortcuts (design record). Detach any prior handler
  // first so navigations never stack listeners.
  detachSceneKeydownHandler();
  const handler = (e) => {
    const t = e.target;
    // §3.4: suppress prev/next while editing ANY rich text — the scene page's
    // click-to-edit fields swap in a <textarea>, but a contenteditable target
    // must be guarded too so `[`/`]` never navigate mid-edit.
    if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable)) return;
    if (e.key === "[") { if (prevId) location.hash = sceneHash(prevId); }
    else if (e.key === "]") { if (nextId) location.hash = sceneHash(nextId); }
    else if (e.key === "Escape") {
      // §3.3: Esc CLOSES an open panel — it must not leave the scene. Wrap
      // panel first, then any open inline add/encounter panel; if nothing is
      // open, do nothing.
      if (!wrapPanel.hidden) {
        wrapPanel.hidden = true;
        wrapBtn.textContent = "Wrap ▸";
      } else {
        // Inline add-event / add-encounter panels toggle via style.display.
        for (const p of [eventCtl.panel, encounterCtl.panel]) {
          if (p && p.style.display !== "none") p.style.display = "none";
        }
      }
    }
  };
  document.addEventListener("keydown", handler);
  activeSceneKeydownHandler = handler;
}

/**
 * Phase 28 task 28.3: `#session-planner/<sceneId>` renders THE one edit-in-
 * place scene page. The URL is the sole source of truth -- the sceneId comes
 * straight from the hash; no localStorage where-am-I heuristics, no chain /
 * plan / table dispatch. A bare `#session-planner` or `#session-planner/new`
 * (no real sceneId) is out of scope per the contract -- a minimal hint points
 * back to the plan shelf, where scene creation lives.
 */
export async function renderSessionPlanner(sceneIdArg) {
  const container = document.getElementById("session-planner-body");
  if (!container) return;

  const myToken = ++sceneRenderToken;
  detachSceneKeydownHandler();
  openNotePanels.clear();
  sceneEditDebounces.clear();
  container.innerHTML = "";

  if (!currentWorld()) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Select a world first.";
    container.appendChild(p);
    return;
  }

  // No real sceneId -> out of scope for this page. Scene creation is always
  // plan-scoped now (via `#plans/<planId>`'s add-scene ghost-row).
  if (!sceneIdArg || sceneIdArg === "new" || (typeof sceneIdArg === "string" && sceneIdArg.startsWith("plan/"))) {
    const hint = document.createElement("p");
    hint.className = "hint";
    const link = document.createElement("a");
    link.href = "#plans";
    link.textContent = "Go to Plans";
    hint.append("Open a scene from a plan to edit it. ", link);
    container.appendChild(hint);
    return;
  }

  // The arg may carry a legacy `?mode=table` suffix from an old bookmark --
  // strip it; there are no modes any more.
  const sceneId = String(sceneIdArg).split("?")[0];
  await renderScenePage(container, sceneId, myToken);
}

/**
 * Phase 30 task 30.3: the DESIGNER scene page, mounted directly into the
 * shell's `#shell-main` (`container`) -- the real port that replaces 30.2's
 * borrow-the-legacy-node delegation. Reuses `renderScenePage` verbatim (all the
 * Phase 28/29 element/stat-block/wrap/dressing/from-graph wiring) with the
 * designer sub-roots switched on and prev/next/esc routed to the shell's own
 * `#planner/scene/<id>` / `#planner/plan/<id>` hashes so navigation never
 * escapes the shell. Returns the resolved scene (or null) so app-shell.js can
 * set the breadcrumb's plan context.
 */
export async function renderPlannerScenePage(container, sceneId) {
  if (!container) return;
  const myToken = ++sceneRenderToken;
  detachSceneKeydownHandler();
  openNotePanels.clear();
  sceneEditDebounces.clear();
  container.innerHTML = "";

  if (!currentWorld()) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Select a world first.";
    container.appendChild(p);
    return;
  }

  const cleanId = String(sceneId).split("?")[0];
  // The `planner-scene-view` root the contract pins is an OUTER wrapper so the
  // Phase 29 scene-page CSS (scoped `.planner-scene-view .scene-page`, a
  // descendant of it) applies to the inner `.scene-page` renderScenePage builds.
  const wrapper = document.createElement("div");
  wrapper.className = "planner-scene-view";
  wrapper.setAttribute("data-testid", "planner-scene-view");
  wrapper.setAttribute("data-scene-id", cleanId);
  container.appendChild(wrapper);

  await renderScenePage(wrapper, cleanId, myToken, {
    designer: true,
    nav: {
      sceneHash: (id) => `planner/scene/${id}`,
      plansHash: (plan) => (plan ? `planner/plan/${plan.id}` : "planner/plans")
    }
  });
}
