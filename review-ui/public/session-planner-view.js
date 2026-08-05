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
// deliberately does not delete), even though nothing currently populates
// it live -- see this file's own self-review note near
// resolveSceneDisplayName for the honest "currently always empty" caveat.
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
// bootstrap) along with the chain view that was their only caller.
// ---------------------------------------------------------------------------
async function fetchEntityInfoMap() {
  try {
    const graph = await spApi(`/api/graph${spWithWorld({ filter: "all" })}`);
    const map = new Map();
    for (const n of graph.nodes || []) map.set(n.id, n);
    return map;
  } catch {
    return new Map();
  }
}

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
function resolveSceneDisplayName(scene) {
  if (scene.name) return scene.name;
  if (scene.locationEntityId) {
    return entityInfoMapGlobal.get(scene.locationEntityId)?.name ?? scene.locationEntityId;
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
function makeClickToEditField({ tag = "div", className = "", testid, dataAttrs = {}, inputTestid, inputDataAttrs = {}, value = "", placeholder = "", emptyText = "", save }) {
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

  function enterEdit() {
    if (editing) return;
    editing = true;
    el.textContent = "";
    el.classList.remove("scene-field--empty");
    const ta = document.createElement("textarea");
    ta.className = "scene-edit-textarea";
    ta.setAttribute("data-testid", inputTestid);
    for (const [k, v] of Object.entries(inputDataAttrs)) ta.setAttribute(k, v);
    if (placeholder) ta.placeholder = placeholder;
    ta.value = currentValue;
    ta.rows = 1;

    const debounce = createFlushableDebounce((v) => { Promise.resolve(save(v)).catch(() => {}); }, { debounceMs: 500 });
    sceneEditDebounces.add(debounce);

    function autoGrow() {
      ta.style.height = "auto";
      ta.style.height = `${ta.scrollHeight}px`;
    }
    ta.addEventListener("input", () => { autoGrow(); debounce.onInput(ta.value); });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.stopPropagation(); ta.blur(); }
    });
    ta.addEventListener("blur", () => {
      debounce.onBlur(ta.value); // flush the pending save immediately
      sceneEditDebounces.delete(debounce);
      currentValue = ta.value;
      editing = false;
      renderRest();
    });
    el.appendChild(ta);
    ta.focus();
    autoGrow();
  }

  el.addEventListener("click", () => { if (!editing) enterEdit(); });
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
  const label = document.createElement("span");
  label.className = "pf-label";
  label.textContent = SCENE_FIELD_LABELS[field] ?? field;
  const valueField = makeClickToEditField({
    tag: "span",
    className: "pf-value",
    testid: "scene-element-field",
    dataAttrs: { "data-field": field },
    inputTestid: "scene-element-field-input",
    inputDataAttrs: { "data-field": field },
    value,
    placeholder: `${SCENE_FIELD_LABELS[field] ?? field}…`,
    emptyText: `+ ${SCENE_FIELD_LABELS[field] ?? field}`,
    save: (v) => spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements/${encodeURIComponent(element.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld(), fields: { [field]: v } })
    })
  });
  line.append(label, valueField.el);
  if (autoEdit) valueField.enterEdit();
  return line;
}

function buildChecksLine(checks) {
  const line = document.createElement("div");
  line.className = "pf-line";
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
      opt.textContent = SCENE_FIELD_LABELS[f];
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

  const refreshList = () => renderSceneElementsList(scene, listHost, nodeMap);
  for (const element of elements) {
    wrap.appendChild(buildSceneElementRow(scene, element, refreshList, nodeMap));
  }
  wrap.appendChild(buildAddElementGhostRow(scene, refreshList));
  listHost.appendChild(wrap);
}

// ---------------------------------------------------------------------------
// §3 -- breadcrumb + prev/next. The FIRST plan containing this scene (stable
// listPlansForWorld order, via the plansContainingScene route) is the owning
// context; prev/next step within THAT plan's own sceneIds order and are
// absent (real DOM absence) at the ends / for an orphaned scene.
// ---------------------------------------------------------------------------
function buildSceneBreadcrumb(scene, plans) {
  const firstPlan = plans && plans.length ? plans[0] : null;
  const bc = document.createElement("div");
  bc.className = "scene-breadcrumb";
  bc.setAttribute("data-testid", "scene-breadcrumb");

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "link-btn scene-breadcrumb-back-btn";
  backBtn.setAttribute("data-testid", "scene-breadcrumb-back-btn");
  backBtn.textContent = `‹ ${firstPlan ? (firstPlan.name || "Plan") : "Plans"}`;
  backBtn.addEventListener("click", () => {
    location.hash = firstPlan ? `plans/${firstPlan.id}` : "plans";
  });
  bc.appendChild(backBtn);

  let prevId = null;
  let nextId = null;
  if (firstPlan) {
    const ids = firstPlan.sceneIds || [];
    const idx = ids.indexOf(scene.id);
    if (idx > 0) prevId = ids[idx - 1];
    if (idx >= 0 && idx < ids.length - 1) nextId = ids[idx + 1];
  }

  if (prevId) {
    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "link-btn scene-breadcrumb-prev-btn";
    prevBtn.setAttribute("data-testid", "scene-breadcrumb-prev-btn");
    prevBtn.textContent = "‹ Prev";
    prevBtn.addEventListener("click", () => { location.hash = `session-planner/${prevId}`; });
    bc.appendChild(prevBtn);
  }
  if (nextId) {
    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "link-btn scene-breadcrumb-next-btn";
    nextBtn.setAttribute("data-testid", "scene-breadcrumb-next-btn");
    nextBtn.textContent = "Next ›";
    nextBtn.addEventListener("click", () => { location.hash = `session-planner/${nextId}`; });
    bc.appendChild(nextBtn);
  }

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

      const headline = document.createElement("p");
      headline.className = "wrap-note-intake-headline";
      headline.textContent = data.headline || `${data.mutationCount ?? 0} proposed update${(data.mutationCount ?? 0) === 1 ? "" : "s"} from this scene's notes.`;
      result.appendChild(headline);

      const link = document.createElement("button");
      link.type = "button";
      link.className = "link-btn wrap-review-batch-link";
      link.setAttribute("data-testid", "wrap-review-batch-link");
      link.setAttribute("data-batch-id", data.batchId);
      link.textContent = "Review proposed updates →";
      link.addEventListener("click", () => { location.hash = `review/${data.batchId}`; });
      result.appendChild(link);

      resultHost.appendChild(result);
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

  return panel;
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
        body: JSON.stringify({ world: currentWorld(), name: el.name, fields: el.fields || {} })
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
    await spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements/${encodeURIComponent(element.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld(), fields: draft.fields || {} })
    }).catch(() => {});
    await refreshList();
  });
  return link;
}

// ===========================================================================
// Phase 29 task 29.3 -- place-description grid + missing-description banner +
// draft-read-aloud ghost link; objective inline edit; Suggest-dressing;
// From-graph inline picker. Contract: review-ui/test/e2e/phase29-fixture.mjs
// §2/§4/§5/§6 -- every data-testid / route below is pinned there and matched
// verbatim. All new DOM is styled with the scoped --sp-* tokens (29.2 look).
// ===========================================================================

// The DRESSING keyword map, reproduced VERBATIM from
// design/session-planner/Session Planner.dc.html (~lines 516-543) -- five
// keyword groups + a generic fallback, each item `[name, gives]`. The exact
// item names are pinned by the e2e suite; do NOT re-derive different wording.
const DRESSING = [
  { match: /forge|smith|foundry|anvil/, items: [
    ["Quench barrel", "Cloudy water, and a film of scale on top. Loud if something goes in."],
    ["Rack of unclaimed work", "Six pieces, each with a name-tag. Two of the names are dead people."],
    ["Coal heap and shovel", "Improvised weapon, or a place to hide something small."],
    ["Wall of tongs", "Every size but one — the largest pair is missing."]] },
  { match: /vault|crypt|tomb|temple|shrine|chapel/, items: [
    ["Collection box, forced", "Empty, and the hinge is bent outward."],
    ["Chalk tallies on a pillar", "Someone counted something. It stops at eleven."],
    ["Votive niches", "Cover, and forty years of dust that shows a recent handprint."]] },
  { match: /waystation|inn|tavern|common|hall/, items: [
    ["Board of nailed notices", "Three bounties, one of them for someone at this table."],
    ["Long trestle table", "Cover, and it takes two people to overturn."],
    ["Stabled horses through the wall", "They go quiet a full round before anything arrives."]] },
  { match: /tower|bell|spire/, items: [
    ["Frayed bell rope", "Holds one person's weight. Probably."],
    ["Nesting birds in the louvres", "They break for the windows at any loud noise."],
    ["Stair landing with a missing rail", "A twenty-foot fall to the floor below."]] },
  { match: /market|dock|harbour|harbor|street|square/, items: [
    ["Awning of stitched sailcloth", "Full concealment, and it comes down if cut."],
    ["Crate stack, badly balanced", "One good shove blocks the alley."],
    ["Fishmonger's ice trough", "Cold storage — and something already in it."]] }
];
const DRESSING_FALLBACK = [
  ["Something to hide behind", "Half cover for one creature."],
  ["Something that makes noise", "Anyone touching it is heard two rooms away."],
  ["Something recently disturbed", "Whoever was here left in a hurry."]
];

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
function buildPlaceDescriptionBlock(scene, place) {
  const host = document.createElement("div");
  host.className = "scene-place-desc-host";

  function renderGrid(autoEdit) {
    host.innerHTML = "";
    const grid = document.createElement("div");
    grid.className = "scene-place-grid";
    const label = document.createElement("span");
    label.className = "scene-place-grid-label";
    label.textContent = "The place";
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
      save: (v) => { place.description = v; return savePlaceDescription(place.id, v); }
    });
    grid.append(label, valueField.el);
    host.appendChild(grid);
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
    copy.append("This place has no description in the graph. Read-aloud and dressing suggestions have nothing to draw on — ");
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
 * is empty AND the place has a non-empty description. Composes
 * `description + objectiveNote` into a narration string, saves it via the
 * EXISTING narration route, updates the narration field in place (no reload),
 * and is undoable via showUndoToast.
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

  const saveNarration = (text) => spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/narration`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: currentWorld(), text })
  });

  link.addEventListener("click", async () => {
    const desc = (place && place.description ? String(place.description) : "").trim();
    if (!desc) return;
    const objective = (scene.objectiveNote || "").trim();
    const composed = objective ? `${desc} ${objective}` : desc;
    link.disabled = true;
    try {
      await saveNarration(composed);
    } catch {
      link.disabled = false;
      return;
    }
    narrationField.setValue(composed);
    link.style.display = "none";
    showUndoToast("Drafted read-aloud from the place description — edit it into your own voice.", async () => {
      await saveNarration("").catch(() => {});
      narrationField.setValue("");
      link.style.display = "";
      link.disabled = false;
    });
  });
  return link;
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

/**
 * §6 -- Suggest dressing. Matches `(place.name + " " + place.description)`
 * against the reproduced DRESSING map, appends up to 3 MUNDANE (kind:'local')
 * elements (skipping names already present) via the EXISTING element-create
 * route, each with `fields:{gives}`; falls back to the generic set on no
 * match. The batch is undoable (showUndoToast, testid `suggest-dressing-toast`
 * per the fixture). Toast copy distinguishes the three prototype cases.
 */
async function suggestDressing(scene, place, refreshElements, btn) {
  btn.disabled = true;
  let taken = [];
  try {
    const { elements } = await spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements${spWithWorld()}`);
    taken = (elements || []).map((e) => e.name);
  } catch { /* treat as none present */ }

  const placeName = place && place.name ? place.name : "";
  const placeDesc = place && place.description ? place.description : "";
  const haystack = `${placeName} ${placeDesc}`.toLowerCase();
  const set = DRESSING.find((d) => d.match.test(haystack));
  const ideas = (set ? set.items : DRESSING_FALLBACK).filter((it) => !taken.includes(it[0])).slice(0, 3);

  if (!ideas.length) {
    btn.disabled = false;
    showUndoToast("No new dressing left for this place — write your own.", () => {}, { testid: "suggest-dressing-toast" });
    return;
  }

  const createdIds = [];
  for (const [name, gives] of ideas) {
    try {
      const res = await spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld(), name, fields: { gives } })
      });
      if (res && res.element && res.element.id) createdIds.push(res.element.id);
    } catch { /* skip a failed create, keep the rest */ }
  }
  await refreshElements();
  btn.disabled = false;

  const hasDesc = !!(place && place.description && String(place.description).trim());
  const message = hasDesc && set
    ? `Added ${ideas.length} dressing suggestions drawn from this place's description.`
    : set
      ? `Added ${ideas.length} suggestions from this place's name — add a description for sharper ones.`
      : `No place description to draw on — added ${ideas.length} generic dressing.`;
  showUndoToast(message, async () => {
    for (const id of createdIds) {
      await spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld() })
      }).catch(() => {});
    }
    await refreshElements();
  }, { testid: "suggest-dressing-toast" });
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
 * inline picker) and `✦ Suggest dressing`. `+ Add element` already lives as
 * the ghost row inside the list.
 */
function buildSceneActionsRow(scene, refreshElements, place) {
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

  const dressBtn = document.createElement("button");
  dressBtn.type = "button";
  dressBtn.className = "btn scene-action-dashed-btn suggest-dressing-btn";
  dressBtn.setAttribute("data-testid", "suggest-dressing-btn");
  dressBtn.setAttribute("data-scene-id", scene.id);
  const dsGlyph = document.createElement("span");
  dsGlyph.className = "scene-action-glyph scene-action-glyph--teal";
  dsGlyph.textContent = "✦";
  dressBtn.append(dsGlyph, " Suggest dressing");
  dressBtn.addEventListener("click", () => suggestDressing(scene, place, refreshElements, dressBtn));

  row.append(npcBtn, fromGraphBtn, dressBtn);
  wrap.append(row, pickerHost);
  return wrap;
}

// ---------------------------------------------------------------------------
// The full scene page assembly.
// ---------------------------------------------------------------------------
async function renderScenePage(container, sceneId, token) {
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
  narration = (await spApi(`/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/narration${spWithWorld()}`).catch(() => ({ narration: null }))).narration;
  plans = (await spApi(`/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/plans${spWithWorld()}`).catch(() => ({ plans: [] }))).plans ?? [];
  if (stale()) return;

  container.innerHTML = "";
  const root = document.createElement("div");
  root.className = "scene-page";
  root.setAttribute("data-testid", "scene-page");
  root.setAttribute("data-scene-id", scene.id);

  // Top bar: breadcrumb (left) + Wrap toggle placeholder (right, filled by 28.4).
  const topBar = document.createElement("div");
  topBar.className = "scene-top-bar";
  const { bc, firstPlan, prevId, nextId } = buildSceneBreadcrumb(scene, plans);
  topBar.appendChild(bc);

  const wrapBtn = document.createElement("button");
  wrapBtn.type = "button";
  wrapBtn.className = "btn scene-wrap-toggle-btn";
  wrapBtn.setAttribute("data-testid", "wrap-toggle-btn");
  wrapBtn.setAttribute("data-scene-id", scene.id);
  wrapBtn.textContent = "Wrap ▸";
  wrapBtn.title = "Wrap this scene: propose graph updates from notes + promote elements";
  topBar.appendChild(wrapBtn);
  root.appendChild(topBar);

  // Place header (the room).
  const header = document.createElement("div");
  header.className = "scene-place-header";
  const place = scene.locationEntityId ? nodeMap.get(scene.locationEntityId) : null;
  if (scene.locationEntityId) {
    const placeName = place?.name ?? scene.locationEntityId;
    const nameField = makeClickToEditField({
      tag: "h2",
      className: "scene-place-name",
      testid: "scene-place-name",
      dataAttrs: { "data-entity-id": scene.locationEntityId },
      inputTestid: "scene-place-name-input",
      value: placeName,
      placeholder: "Place name…",
      save: (v) => spApi(`/api/graph/nodes/${encodeURIComponent(scene.locationEntityId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld(), data: { name: v } })
      })
    });
    header.appendChild(nameField.el);
  } else {
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
    save: (v) => {
      scene.objectiveNote = v;
      return spApi(`/api/session-planner/scenes/${encodeURIComponent(scene.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld(), objectiveNote: v })
      });
    }
  });
  header.appendChild(objectiveField.el);

  // §C.4/§C.5 -- "The place" description grid OR the missing-description
  // banner. Editing writes back to the graph NODE, not the scene.
  if (place) header.appendChild(buildPlaceDescriptionBlock(scene, place));

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
    save: (v) => spApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/narration`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld(), text: v })
    })
  });
  header.appendChild(narrationField.el);

  // §C.6 -- draft-read-aloud ghost link: only when narration is empty AND the
  // place has a real (non-empty) description. When the place has no
  // description the banner above covers that case, so the link stays hidden.
  const narrationEmpty = !(narration && narration.text && String(narration.text).trim());
  const placeHasDesc = !!(place && typeof place.description === "string" && place.description.trim() !== "");
  if (narrationEmpty && placeHasDesc) {
    header.appendChild(buildDraftReadAloudLink(scene, place, narrationField));
  }
  root.appendChild(header);

  // Elements list.
  const elementsSection = document.createElement("div");
  elementsSection.className = "scene-elements-section";
  const elementsHeading = document.createElement("h3");
  elementsHeading.className = "scene-section-heading";
  elementsHeading.textContent = "Elements";
  elementsSection.appendChild(elementsHeading);
  const listHost = document.createElement("div");
  const refreshElements = () => renderSceneElementsList(scene, listHost, nodeMap);
  // §C: a quiet, scene-level `✦` ghost link to propose elements for this room
  // (additive/interruptible; the room is fully runnable without it).
  elementsSection.appendChild(buildProposeElementsGhostLink(scene, refreshElements));
  elementsSection.appendChild(listHost);
  // §C (below the elements): `◇ From graph` inline picker + `✦ Suggest
  // dressing` (task 29.4 adds `▣ NPC or creature` to this same row later).
  elementsSection.appendChild(buildSceneActionsRow(scene, refreshElements, place));
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
    if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) return;
    if (e.key === "[") { if (prevId) location.hash = `session-planner/${prevId}`; }
    else if (e.key === "]") { if (nextId) location.hash = `session-planner/${nextId}`; }
    else if (e.key === "Escape") { location.hash = firstPlan ? `plans/${firstPlan.id}` : "plans"; }
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
