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
// Task 20.2: last-active-scene persistence, per world. Unchanged from
// Phase 17/20 -- still written whenever a scene successfully loads (now:
// whenever the CHAIN's own current scene loads), still read only by the
// bare `#session-planner` route.
// ---------------------------------------------------------------------------
function lastSceneKey(world) {
  return `gmReview.sessionPlanner.${world}.lastSceneId`;
}
function loadLastSceneId(world) {
  if (!world) return null;
  try {
    return localStorage.getItem(lastSceneKey(world)) || null;
  } catch {
    return null;
  }
}
function saveLastSceneId(world, sceneId) {
  if (!world || !sceneId) return;
  try {
    localStorage.setItem(lastSceneKey(world), sceneId);
  } catch {
    /* localStorage full/unavailable -- not fatal, matches graph-view.js's own precedent */
  }
}
function clearLastSceneId(world) {
  if (!world) return;
  try {
    localStorage.removeItem(lastSceneKey(world));
  } catch {
    /* not fatal */
  }
}

// ---------------------------------------------------------------------------
// Phase 26 task 26.8, §26.D: active-Plan persistence, per world -- same
// per-world-key localStorage convention as loadLastSceneId/saveLastSceneId
// above. This suite (table-mode-plan-scoped.e2e.mjs) deliberately does not
// pin the exact key name, only the observable effect: the newly-created/
// most-recently-viewed Plan is what table-active-plan-list reflects on the
// very next render, including after a full page reload.
// ---------------------------------------------------------------------------
function activePlanKey(world) {
  return `gmReview.sessionPlanner.${world}.activePlanId`;
}
function loadActivePlanId(world) {
  if (!world) return null;
  try {
    return localStorage.getItem(activePlanKey(world)) || null;
  } catch {
    return null;
  }
}
function saveActivePlanId(world, planId) {
  if (!world || !planId) return;
  try {
    localStorage.setItem(activePlanKey(world), planId);
  } catch {
    /* localStorage full/unavailable -- not fatal, matches graph-view.js's own precedent */
  }
}

/**
 * Resolves which Plan is "active" for Table Mode's current render. Priority:
 * (1) the stored active plan, IF it still exists AND the currently-viewed
 * scene is one of its members; (2) any REAL plan the currently-viewed scene
 * is already a member of (MOST RECENTLY CREATED match wins, when a scene
 * belongs to more than one Plan -- deterministic since listPlansForWorld
 * returns creation order) -- this is what makes viewing a scene that
 * belongs to a Plan become that Plan's own active view with no separate
 * activation step, favoring whichever Plan most recently pulled this scene
 * in over an older one; (3) the stored active plan regardless of
 * membership, so browsing a scene that isn't part of any Plan yet doesn't
 * lose context; (4) null (no active Plan yet -- "Start new plan"). Every
 * non-null result is written back to storage, so browsing settles on a
 * consistent, persisted choice rather than silently drifting.
 *
 * @param {string} world
 * @param {string} sceneId
 * @param {object[]} plans
 * @returns {object|null}
 */
function resolveActivePlan(world, sceneId, plans) {
  const storedId = loadActivePlanId(world);
  const stored = storedId ? plans.find((p) => p.id === storedId) : null;
  if (stored && stored.sceneIds.includes(sceneId)) return stored;

  const memberOf = [...plans].reverse().find((p) => p.sceneIds.includes(sceneId));
  if (memberOf) {
    saveActivePlanId(world, memberOf.id);
    return memberOf;
  }

  if (stored) return stored;
  return null;
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
// Module-level chain state. Split into a CHEAP, eager cache (every scene's
// own record -- id/locationEntityId/parentSceneId/objectiveNote, all
// already returned by the one GET /api/scene-planning/scenes fetch) and an
// EXPENSIVE, lazy cache (a scene's own corridor brief/undo actions/saved
// encounters -- each its own network round trip), per this file's header.
// ---------------------------------------------------------------------------
let entityInfoMapGlobal = new Map();
let chainSceneIds = [];
let currentSceneIdModule = null;
let chainContainerEl = null;
const sceneRecordCache = new Map(); // sceneId -> Scene record
const sceneExtrasCache = new Map(); // sceneId -> { brief, undoActions, encounters }
const addedMembership = new Map(); // sceneId -> Set<entityId> -- task 23.2's client-tracked "added" nodes for THIS page session (see this file's own self-review report: no GET .../members route exists yet to durably resume this across a fresh reload -- a flagged, honest gap, not a silent one)

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
// Location card (task 17.2, extended task 23.2 with a third `"added"` role
// and task 23.4 with the per-card develop-node control).
// ---------------------------------------------------------------------------
function renderLocationCard(location, role, entityInfo, sceneId, itemBodyEl) {
  const card = document.createElement("article");
  card.className = `location-card location-card--${role}`;
  card.setAttribute("data-testid", "location-card");
  card.setAttribute("data-entity-id", location.entityId);
  card.setAttribute("data-card-role", role);

  const header = document.createElement("div");
  header.className = "location-card-header";
  const name = document.createElement("h3");
  name.className = "location-card-name";
  name.textContent = entityInfo?.name || location.entityId;
  header.appendChild(name);
  if (role === "anchor") {
    const pin = document.createElement("span");
    pin.className = "location-card-anchor-badge";
    pin.textContent = "On the path";
    header.appendChild(pin);
  }
  card.appendChild(header);

  if (entityInfo?.type) {
    const typeEl = document.createElement("div");
    typeEl.className = "hint location-card-type";
    typeEl.textContent = entityInfo.type;
    card.appendChild(typeEl);
  }

  const digestEl = document.createElement("div");
  digestEl.className = "location-card-digest";
  if (location.digest) {
    const nameSpan = document.createElement("strong");
    nameSpan.textContent = location.digest.name;
    const roleSpan = document.createElement("span");
    roleSpan.className = "digest-role-tag";
    roleSpan.textContent = ` (${location.digest.roleTag})`;
    const hookSpan = document.createElement("span");
    hookSpan.className = "digest-hook";
    hookSpan.textContent = ` — ${location.digest.hook}`;
    digestEl.append(nameSpan, roleSpan, hookSpan);
  } else {
    digestEl.classList.add("location-card-digest--empty");
    digestEl.setAttribute("data-testid", "location-digest-empty");
    digestEl.textContent = "⚠ Not established yet — nothing written for this location.";
  }
  card.appendChild(digestEl);

  const flagsWrap = document.createElement("div");
  flagsWrap.className = "location-card-flags";
  if (location.contentFlag?.flagged) {
    const b = document.createElement("span");
    b.className = "flag-badge flag-badge--content";
    b.setAttribute("data-testid", "content-flag-badge");
    b.textContent = "✎ Undeveloped";
    b.title = `Content-readiness flag: ${(location.contentFlag.reasons || []).join(", ") || "flagged"}`;
    flagsWrap.appendChild(b);
  }
  if (location.structuralFlag?.flagged) {
    const b = document.createElement("span");
    b.className = "flag-badge flag-badge--structural";
    b.setAttribute("data-testid", "structural-flag-badge");
    b.textContent = `⛓ Thin connections`;
    b.title = `Structural under-connection: ${location.structuralFlag.edgeCount} edge(s), fewer than ${location.structuralFlag.minEdges}`;
    flagsWrap.appendChild(b);
  }
  if (flagsWrap.children.length) card.appendChild(flagsWrap);

  const distEl = document.createElement("div");
  distEl.className = "hint location-card-distance";
  if (role === "anchor") distEl.textContent = "On the path";
  else if (role === "added") distEl.textContent = "Manually added to this scene";
  else distEl.textContent = `${location.distance} hop${location.distance === 1 ? "" : "s"} from the path`;
  card.appendChild(distEl);

  const notesFooter = document.createElement("div");
  notesFooter.className = "location-card-notes-footer";
  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "icon-btn location-note-toggle-btn";
  toggleBtn.setAttribute("data-testid", "location-note-toggle");
  toggleBtn.setAttribute("aria-label", "Notes for this location");
  toggleBtn.textContent = location.notes?.length ? `📝 Notes (${location.notes.length})` : "📝 Add note";
  notesFooter.appendChild(toggleBtn);
  card.appendChild(notesFooter);

  toggleBtn.addEventListener("click", () => toggleNotePanel(card, location, sceneId));

  // Task 23.2: trivially easy remove, for arbitrarily-added nodes only --
  // the default corridor's own anchor/satellites aren't scene-membership
  // additions, so there's nothing to "remove" there via this mechanism.
  if (role === "added") {
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "link-btn";
    removeBtn.setAttribute("data-testid", "location-card-remove-btn");
    removeBtn.textContent = "Remove from scene";
    removeBtn.addEventListener("click", async () => {
      removeBtn.disabled = true;
      try {
        await removeEntityFromScene(sceneId, location.entityId, itemBodyEl);
      } catch {
        removeBtn.disabled = false;
      }
    });
    card.appendChild(removeBtn);
  }

  mountDevelopNodeControl(card, location.entityId);

  return card;
}

/** Inline-expand within the row -- no popover, no positioning/clamping code (design record §5). */
function toggleNotePanel(card, location, sceneId) {
  const entityId = location.entityId;

  if (openNotePanels.has(entityId)) {
    const { panelEl, debounce } = openNotePanels.get(entityId);
    debounce.flush();
    panelEl.remove();
    openNotePanels.delete(entityId);
    return;
  }

  const panel = document.createElement("div");
  panel.className = "location-note-panel";
  panel.setAttribute("data-testid", "location-note-panel");

  const entriesList = document.createElement("ul");
  entriesList.className = "location-note-entries";
  for (const note of location.notes ?? []) {
    const li = document.createElement("li");
    li.setAttribute("data-testid", "location-note-entry");
    li.className = "location-note-entry";
    const textSpan = document.createElement("span");
    textSpan.textContent = note.text;
    const meta = document.createElement("span");
    meta.className = "hint location-note-meta";
    meta.textContent = note.timestamp ? new Date(note.timestamp).toLocaleString() : "";
    li.append(textSpan, meta);
    entriesList.appendChild(li);
  }
  panel.appendChild(entriesList);

  const textarea = document.createElement("textarea");
  textarea.className = "location-note-textarea";
  textarea.setAttribute("data-testid", "location-note-textarea");
  textarea.placeholder = "Jot a note — autosaves as you type…";
  panel.appendChild(textarea);

  const status = document.createElement("div");
  status.className = "hint location-note-status";
  status.setAttribute("data-testid", "location-note-status");
  panel.appendChild(status);

  card.appendChild(panel);

  const debounce = createFlushableDebounce((value) => {
    if (!value || !value.trim()) return;
    status.textContent = "Saving…";
    spApi("/api/session-planner/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld(), text: value, anchorEntityId: entityId, sceneId })
    }).then(() => {
      status.textContent = "Saved.";
    }).catch((err) => {
      status.textContent = `Error saving note: ${err.message}`;
    });
  }, { debounceMs: 500 });

  textarea.addEventListener("input", () => debounce.onInput(textarea.value));
  textarea.addEventListener("blur", () => debounce.onBlur(textarea.value));

  openNotePanels.set(entityId, { panelEl: panel, debounce });
  textarea.focus();
}

// ---------------------------------------------------------------------------
// Task 17.5: re-center control (unchanged behavior, adapted to feed a fork
// through the SAME chain-loading pipeline as any other scene load -- see
// this file's header for why that alone makes the "exactly one anchor
// card" property hold after a re-center).
// ---------------------------------------------------------------------------
let activeRecenterController = null;

export function cancelActiveRecenter() {
  if (activeRecenterController) {
    activeRecenterController.abort();
    activeRecenterController = null;
  }
}

// Phase 26 task 26.7, §26.B: renderBeyondCorridorSummary (the collapsed
// content/structural-count summary, "Beyond this corridor") is REMOVED
// entirely -- its former DOM position now hosts buildConnectExistingSceneZone
// below, per phase26-fixture.mjs §6.

/**
 * Phase 26 task 26.7. Repurposes renderBeyondCorridorSummary's old spot with
 * two QUICK, VISIBLE (never behind a `<details>`) options: connect this
 * scene to an existing one (surfacing BOTH scene-linkage.mjs's hop-based
 * candidates AND §26.3's explicitly-linked scenes together, per §26.C --
 * two genuinely distinct mechanisms, neither replaces the other), and
 * create-ad-hoc-scene (an alias for THIS scene's own "+Scene", never a
 * second/duplicate creation mechanism).
 *
 * @param {string} sceneId
 * @param {{btn:HTMLElement, panel:HTMLElement}} addSceneControl   this scene's own already-built "+Scene" control (26.4/26.6), reused as-is
 * @returns {HTMLElement}
 */
function buildConnectExistingSceneZone(sceneId, addSceneControl) {
  const wrap = document.createElement("div");
  wrap.className = "connect-existing-scene-zone";

  const list = document.createElement("div");
  list.setAttribute("data-testid", "connect-existing-scene-list");
  list.setAttribute("data-scene-id", sceneId);

  const status = document.createElement("div");
  status.className = "hint";

  async function renderList() {
    list.innerHTML = "Loading nearby/linked scenes…";
    try {
      const [linkageRes, sceneLinksRes] = await Promise.all([
        spApi(`/api/scene-planning/linkage${spWithWorld({ sceneId })}`),
        spApi(`/api/scene-planning/scene-links${spWithWorld({ sceneId })}`)
      ]);
      list.innerHTML = "";
      const linkageCandidates = (linkageRes.linked ?? []).map((l) => ({ sceneId: l.sceneId, source: "linkage", label: l.anchorEntityName ?? l.sceneId }));
      const sceneLinkCandidates = (sceneLinksRes.linked ?? []).map((l) => ({ sceneId: l.sceneId, source: "scene-link", label: resolveSceneDisplayName(sceneRecordCache.get(l.sceneId) ?? { id: l.sceneId }) }));
      const candidates = [...linkageCandidates, ...sceneLinkCandidates];
      if (!candidates.length) {
        const empty = document.createElement("div");
        empty.className = "hint";
        empty.textContent = "No nearby or linked scenes yet.";
        list.appendChild(empty);
      }
      for (const c of candidates) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "link-btn";
        item.setAttribute("data-testid", "connect-existing-scene-item");
        item.setAttribute("data-scene-id", c.sceneId);
        item.setAttribute("data-connect-source", c.source);
        item.textContent = c.source === "linkage" ? `${c.label} (nearby)` : `${c.label} (linked)`;
        item.addEventListener("click", async () => {
          item.disabled = true;
          status.textContent = "Linking…";
          try {
            await spApi("/api/scene-planning/scene-links", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ world: currentWorld(), sceneIdA: sceneId, sceneIdB: c.sceneId })
            });
            status.textContent = "Linked.";
          } catch (err) {
            status.textContent = `Could not link: ${err.message}`;
          } finally {
            item.disabled = false;
          }
        });
        list.appendChild(item);
      }
    } catch (err) {
      list.textContent = `Could not load nearby/linked scenes: ${err.message}`;
    }
  }
  renderList();

  const adHocBtn = document.createElement("button");
  adHocBtn.type = "button";
  adHocBtn.className = "btn";
  adHocBtn.setAttribute("data-testid", "create-ad-hoc-scene-btn");
  adHocBtn.setAttribute("data-scene-id", sceneId);
  adHocBtn.textContent = "+ New ad-hoc scene";
  // §26.7: an ALIAS for this scene's own add-scene-btn -- clicking it opens
  // the EXACT SAME add-scene-panel, never a second/duplicate mechanism.
  adHocBtn.addEventListener("click", () => addSceneControl.btn.click());

  wrap.append(list, adHocBtn, status);
  return wrap;
}

function buildRecenterControl(sceneId, onRecentered) {
  const wrap = document.createElement("div");
  wrap.className = "recenter-control";

  const label = document.createElement("div");
  label.className = "hint";
  label.textContent = "Re-center on a different location:";
  wrap.appendChild(label);

  const status = document.createElement("div");
  status.className = "hint recenter-status";
  status.setAttribute("data-testid", "recenter-status");
  wrap.appendChild(status);

  const picker = buildEntityPicker({
    testidPrefix: "recenter",
    placeholder: "Search locations to re-center on…",
    defaultTypeFilter: "place",
    onSelect: (entity, btn) => doRecenter(sceneId, entity, btn, status, onRecentered)
  });
  wrap.appendChild(picker);

  return wrap;
}

async function doRecenter(sceneId, entity, btn, statusEl, onRecentered) {
  cancelActiveRecenter();
  const controller = new AbortController();
  activeRecenterController = controller;

  btn.disabled = true;
  statusEl.textContent = "Recentering…";

  try {
    const forkRes = await spApi(`/api/session-planner/scenes/${encodeURIComponent(sceneId)}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld(), locationEntityId: entity.id }),
      signal: controller.signal
    });
    const newSceneId = forkRes.scene.id;
    statusEl.textContent = "";
    if (activeRecenterController === controller) activeRecenterController = null;
    await onRecentered(newSceneId);
  } catch (err) {
    if (err.name === "AbortError") return; // superseded by a later click/navigation -- deliberate, not a real failure
    statusEl.textContent = `Recenter failed: ${err.message}`;
  } finally {
    btn.disabled = false;
    if (activeRecenterController === controller) activeRecenterController = null;
  }
}

// ---------------------------------------------------------------------------
// Task 17.1: empty-state scene bootstrap (unchanged).
// ---------------------------------------------------------------------------
function renderBootstrap(container) {
  const wrap = document.createElement("div");
  wrap.className = "session-planner-bootstrap";

  const heading = document.createElement("p");
  heading.className = "hint";
  heading.textContent = "Pick a starting location for tonight's scene.";
  wrap.appendChild(heading);

  const noteLabel = document.createElement("label");
  noteLabel.className = "session-planner-objective-label";
  const noteSpan = document.createElement("span");
  noteSpan.textContent = "Objective note (optional):";
  const noteInput = document.createElement("input");
  noteInput.type = "text";
  noteInput.placeholder = "e.g. investigate the missing caravan";
  noteInput.setAttribute("data-testid", "scene-bootstrap-objective");
  noteLabel.append(noteSpan, noteInput);
  wrap.appendChild(noteLabel);

  const status = document.createElement("div");
  status.className = "hint";

  const picker = buildEntityPicker({
    testidPrefix: "scene-bootstrap-location",
    placeholder: "Search for a starting location…",
    defaultTypeFilter: "place",
    onSelect: async (entity, btn) => {
      btn.disabled = true;
      status.textContent = "Starting…";
      try {
        const res = await spApi("/api/session-planner/scenes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            world: currentWorld(),
            locationEntityId: entity.id,
            objectiveNote: noteInput.value.trim() || undefined
          })
        });
        saveLastSceneId(currentWorld(), res.scene.id);
        location.hash = `session-planner/${res.scene.id}`;
      } catch (err) {
        btn.disabled = false;
        status.textContent = `Could not start: ${err.message}`;
      }
    }
  });
  wrap.appendChild(picker);
  wrap.appendChild(status);

  container.appendChild(wrap);
}

// ---------------------------------------------------------------------------
// Task 20.2: explicit, always-discoverable "start a new plan" escape hatch
// (unchanged).
// ---------------------------------------------------------------------------
function renderStartNewPlanBar() {
  const wrap = document.createElement("div");
  wrap.className = "session-planner-start-new";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "link-btn";
  btn.setAttribute("data-testid", "session-planner-start-new");
  btn.textContent = "Start a new plan";
  btn.addEventListener("click", () => {
    location.hash = "session-planner/new";
  });
  wrap.appendChild(btn);
  return wrap;
}

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
// Task 23.1/23.2: members-grid rendering + refresh. Reads the (lazily
// fetched, then cached) corridor brief from sceneExtrasCache, plus the
// client-tracked "added" set, for one scene at a time.
// ---------------------------------------------------------------------------
function refreshMembersGrid(sceneId, itemBodyEl) {
  const grid = itemBodyEl.querySelector(".scene-members-grid");
  const extras = sceneExtrasCache.get(sceneId);
  if (!grid || !extras) return;
  grid.innerHTML = "";
  const ordered = hashOrderLocations(extras.brief.locations ?? []);
  const briefIds = new Set(ordered.map((l) => l.entityId));
  for (const loc of ordered) {
    const role = loc.distance === 0 ? "anchor" : "satellite";
    grid.appendChild(renderLocationCard(loc, role, entityInfoMapGlobal.get(loc.entityId), sceneId, itemBodyEl));
  }
  const addedIds = hashOrderLocations([...(addedMembership.get(sceneId) ?? [])].map((id) => ({ entityId: id })));
  for (const { entityId: id } of addedIds) {
    if (briefIds.has(id)) continue; // already shown via the default corridor -- avoid a duplicate card
    const loc = { entityId: id, distance: null, digest: null, contentFlag: null, structuralFlag: null, notes: [] };
    grid.appendChild(renderLocationCard(loc, "added", entityInfoMapGlobal.get(id), sceneId, itemBodyEl));
  }
  if (!grid.children.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "Nothing in this scene yet.";
    grid.appendChild(empty);
  }
}

async function addEntityToScene(sceneId, entityId, itemBodyEl) {
  await spApi(`/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: currentWorld(), entityId })
  });
  const set = addedMembership.get(sceneId) ?? new Set();
  set.add(entityId);
  addedMembership.set(sceneId, set);
  refreshMembersGrid(sceneId, itemBodyEl);
}

async function removeEntityFromScene(sceneId, entityId, itemBodyEl) {
  await spApi(`/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/members/${encodeURIComponent(entityId)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: currentWorld() })
  });
  const set = addedMembership.get(sceneId);
  if (set) set.delete(entityId);
  refreshMembersGrid(sceneId, itemBodyEl);
}

// ---------------------------------------------------------------------------
// Task 23.2: add-node control (+ the reachability-aware intervening-offer,
// an explicit, separate confirmation step -- never auto-added).
// ---------------------------------------------------------------------------
function renderInterveningOfferPanel(host, sceneId, targetEntity, interveningIds, statusEl, itemBodyEl, addNodePanel) {
  host.innerHTML = "";
  const panel = document.createElement("div");
  panel.setAttribute("data-testid", "intervening-offer-panel");
  panel.setAttribute("data-scene-id", sceneId);
  panel.setAttribute("data-target-entity-id", targetEntity.id);

  for (const id of interveningIds) {
    const node = document.createElement("div");
    node.setAttribute("data-testid", "intervening-offer-node");
    node.setAttribute("data-entity-id", id);
    const nameEl = document.createElement("span");
    nameEl.setAttribute("data-testid", "intervening-offer-node-name");
    nameEl.textContent = entityInfoMapGlobal.get(id)?.name ?? id;
    node.appendChild(nameEl);
    panel.appendChild(node);
  }

  const acceptBtn = document.createElement("button");
  acceptBtn.type = "button";
  acceptBtn.className = "btn btn--accept";
  acceptBtn.setAttribute("data-testid", "intervening-offer-accept-btn");
  acceptBtn.textContent = `Add with ${interveningIds.length} intervening node${interveningIds.length === 1 ? "" : "s"}`;

  const skipBtn = document.createElement("button");
  skipBtn.type = "button";
  skipBtn.className = "btn";
  skipBtn.setAttribute("data-testid", "intervening-offer-skip-btn");
  skipBtn.textContent = "Add target only";

  acceptBtn.addEventListener("click", async () => {
    acceptBtn.disabled = true;
    skipBtn.disabled = true;
    try {
      await addEntityToScene(sceneId, targetEntity.id, itemBodyEl);
      // "one POST .../members call per id, since scene-membership.mjs's
      // addNodeToScene has no batch form" (this file's own contract) --
      // sequential, not Promise.all, so a partial failure is easy to reason
      // about and never silently races the members-grid refresh.
      for (const id of interveningIds) {
        await addEntityToScene(sceneId, id, itemBodyEl);
      }
      statusEl.textContent = `Added "${targetEntity.name}" and ${interveningIds.length} intervening node(s).`;
      host.innerHTML = "";
      if (addNodePanel) addNodePanel.style.display = "none";
    } catch (err) {
      statusEl.textContent = `Could not add: ${err.message}`;
      acceptBtn.disabled = false;
      skipBtn.disabled = false;
    }
  });

  skipBtn.addEventListener("click", async () => {
    acceptBtn.disabled = true;
    skipBtn.disabled = true;
    try {
      await addEntityToScene(sceneId, targetEntity.id, itemBodyEl);
      statusEl.textContent = `Added "${targetEntity.name}".`;
      host.innerHTML = "";
      if (addNodePanel) addNodePanel.style.display = "none";
    } catch (err) {
      statusEl.textContent = `Could not add: ${err.message}`;
      acceptBtn.disabled = false;
      skipBtn.disabled = false;
    }
  });

  panel.append(acceptBtn, skipBtn);
  host.appendChild(panel);
}

async function onAddNodePicked(sceneId, entity, btn, statusEl, offerHolder, itemBodyEl, addNodePanel) {
  btn.disabled = true;
  statusEl.textContent = "Checking reachability…";
  try {
    const offerRes = await spApi(`/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/intervening-offer${spWithWorld({ targetEntityId: entity.id })}`);
    const offer = offerRes.offer;
    if (!offer.reachable) {
      await addEntityToScene(sceneId, entity.id, itemBodyEl);
      statusEl.textContent = `Added "${entity.name}".`;
      // Auto-close the add-node panel on a completed, no-further-input add --
      // matches this file's own established pattern (buildInsertSceneControl/
      // buildQuickAddScenePanel both close themselves on success), and is
      // what makes a subsequent open start from a genuinely fresh "closed"
      // state rather than silently flipping an already-open panel shut.
      if (addNodePanel) addNodePanel.style.display = "none";
    } else {
      statusEl.textContent = "";
      renderInterveningOfferPanel(offerHolder, sceneId, entity, offer.interveningEntityIds, statusEl, itemBodyEl, addNodePanel);
    }
  } catch (err) {
    statusEl.textContent = `Could not add: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

function mountAddNodeControl(sceneId, itemBodyEl) {
  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "btn scene-action-btn";
  toggleBtn.setAttribute("data-testid", "add-node-toggle");
  toggleBtn.textContent = "+ Add node";

  const panel = document.createElement("div");
  panel.setAttribute("data-testid", "add-node-panel");
  panel.setAttribute("data-scene-id", sceneId);
  panel.style.display = "none";

  const statusEl = document.createElement("div");
  statusEl.className = "hint";
  statusEl.setAttribute("data-testid", "add-node-status");

  const offerHolder = document.createElement("div");

  const picker = buildEntityPicker({
    testidPrefix: "add-node",
    placeholder: "Search entities to add…",
    onSelect: (entity, btn) => onAddNodePicked(sceneId, entity, btn, statusEl, offerHolder, itemBodyEl, panel)
  });

  panel.append(picker, statusEl, offerHolder);

  toggleBtn.addEventListener("click", () => {
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  });

  return { toggleBtn, panel };
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

function mountAddEncounterControl(scene, testid = "add-encounter-btn") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn scene-action-btn";
  btn.setAttribute("data-testid", testid);
  btn.setAttribute("data-scene-id", scene.id);
  btn.textContent = "Add Encounter";
  btn.addEventListener("click", () => {
    location.hash = `combat-planning/${scene.id}`;
  });
  return btn;
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

// ---------------------------------------------------------------------------
// Task 23.5: scene-local rollback -- visible directly in the scene UI
// (never behind Settings), undo-last and undo-all both present and
// distinct.
// ---------------------------------------------------------------------------
async function fetchUndoActions(sceneId) {
  try {
    const res = await spApi(`/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/undo${spWithWorld()}`);
    return res.actions ?? [];
  } catch {
    return [];
  }
}

// Closes the gap flagged in task 23.2's self-review: addedMembership was
// client-tracked-only for the page session, so a fresh reload lost every
// arbitrarily-added node even though scene-membership.mjs had already
// persisted it server-side. Reads it back through the real store.
async function fetchSceneMembers(sceneId) {
  try {
    const res = await spApi(`/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/members${spWithWorld()}`);
    return res.membership?.entityIds ?? [];
  } catch {
    return [];
  }
}

function renderRollbackPanel(sceneId, actions) {
  const panel = document.createElement("div");
  panel.setAttribute("data-testid", "scene-rollback-panel");
  panel.setAttribute("data-scene-id", sceneId);

  const heading = document.createElement("div");
  heading.className = "hint";
  heading.textContent = "This scene's own development history:";
  panel.appendChild(heading);

  const list = document.createElement("ul");
  list.setAttribute("data-testid", "scene-rollback-action-list");
  panel.appendChild(list);

  function renderList(items) {
    list.innerHTML = "";
    for (const a of items) {
      const li = document.createElement("li");
      li.setAttribute("data-testid", "scene-rollback-action-item");
      li.setAttribute("data-action-id", a.actionId);
      li.textContent = a.description;
      list.appendChild(li);
    }
  }
  renderList(actions);

  const statusEl = document.createElement("div");
  statusEl.className = "hint";
  statusEl.setAttribute("data-testid", "scene-rollback-status");

  const undoLastBtn = document.createElement("button");
  undoLastBtn.type = "button";
  undoLastBtn.className = "btn";
  undoLastBtn.setAttribute("data-testid", "scene-rollback-undo-last-btn");
  undoLastBtn.textContent = "Undo last";
  undoLastBtn.addEventListener("click", async () => {
    undoLastBtn.disabled = true;
    try {
      const res = await spApi(`/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/undo/last`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld() })
      });
      if (res.action) {
        const remaining = await fetchUndoActions(sceneId);
        renderList(remaining);
        statusEl.textContent = `Undid the most recent action: "${res.action.description}"`;
      } else {
        statusEl.textContent = "Nothing to undo in this scene.";
      }
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      undoLastBtn.disabled = false;
    }
  });

  const undoAllBtn = document.createElement("button");
  undoAllBtn.type = "button";
  undoAllBtn.className = "btn";
  undoAllBtn.setAttribute("data-testid", "scene-rollback-undo-all-btn");
  undoAllBtn.textContent = "Undo all";
  undoAllBtn.addEventListener("click", async () => {
    undoAllBtn.disabled = true;
    try {
      const res = await spApi(`/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/undo/all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld() })
      });
      renderList([]);
      statusEl.textContent = `Undid everything recorded in this scene (${res.actions?.length ?? 0} action(s)).`;
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      undoAllBtn.disabled = false;
    }
  });

  panel.append(undoLastBtn, undoAllBtn, statusEl);
  return panel;
}

// ---------------------------------------------------------------------------
// Task 23.4: "Develop this scene" -- the real batch orchestrator, wrapped
// in the ONLY other loading-indicator site this phase has, surfacing
// PER-NODE review (never a silent whole-batch auto-apply).
// ---------------------------------------------------------------------------
function renderDevelopSceneReviewPanel(host, sceneId, results) {
  host.innerHTML = "";
  const panel = document.createElement("div");
  panel.setAttribute("data-testid", "develop-scene-review-panel");
  panel.setAttribute("data-scene-id", sceneId);

  for (const r of results) {
    const node = document.createElement("div");
    node.className = "develop-scene-review-node";
    node.setAttribute("data-testid", "develop-scene-review-node");
    node.setAttribute("data-entity-id", r.entityId);

    const heading = document.createElement("div");
    heading.className = "hint";
    heading.textContent = entityInfoMapGlobal.get(r.entityId)?.name ?? r.entityId;
    node.appendChild(heading);

    if (!r.ok) {
      const err = document.createElement("div");
      err.className = "hint";
      err.textContent = `Could not develop this node: ${r.error}`;
      node.appendChild(err);
    } else {
      node.appendChild(buildPrepDevelopControl(r.entityId, "develop-scene-review", r.framings ?? []));
    }
    panel.appendChild(node);
  }

  host.appendChild(panel);
}

async function onDevelopScene(sceneId, statusEl, reviewHolder) {
  statusEl.innerHTML = "";
  const extras = sceneExtrasCache.get(sceneId);
  const briefIds = (extras?.brief?.locations ?? []).map((l) => l.entityId);
  const addedIds = [...(addedMembership.get(sceneId) ?? [])];
  const memberIds = [...new Set([...briefIds, ...addedIds])];

  // Starting the undo session and kicking off the batch develop call fire
  // CONCURRENTLY, not sequentially -- there's no real ordering dependency
  // between them for this "propose only, no selections" call (developScene
  // only ever calls recordSceneUndoAction from a later GENERATE step, which
  // can't happen until well after both of these have already resolved and
  // the per-node review panel is rendered and interactive), and firing them
  // together is what makes the batch develop request reach the network
  // essentially immediately on click rather than queued behind an
  // unrelated, purely-bookkeeping round trip.
  const promise = Promise.all([
    spApi(`/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/undo/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld() })
    }),
    spApi(`/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/develop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld(), memberEntityIds: memberIds })
    })
  ]).then(([, developResult]) => developResult);

  try {
    const result = await withSlowNoticeIndicator(statusEl, promise);
    renderDevelopSceneReviewPanel(reviewHolder, sceneId, result.results ?? []);
  } catch (err) {
    statusEl.textContent = `Could not develop scene: ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// Task 23.7 (Phase 26 task 26.5 reworked its inner flow, §26.A): mid-session
// ad-hoc "+" quick-gen -- one field, one button, exactly one LLM call.
// Top-level, not scoped to any one insertion point.
//
// Phase 26 task 26.6, §26.B: the old between-scenes "+ Insert Scene Here"
// (buildInsertSceneControl/insert-scene-control/insert-scene-picker) lived
// here and was REMOVED ENTIRELY -- it let a DM insert a scene between two
// arbitrary chain positions regardless of whether those scenes' anchors
// were actually graph-connected, the confirmed direct cause of real
// reported confusion. Replaced by "+Scene" (26.4's buildAddSceneControl,
// mounted inside each scene's own actions bar) -- an unambiguous "add a
// scene from THIS scene" trigger instead. The real-place-creation coverage
// this control used to provide lives on via add-scene-control.e2e.mjs/
// scene-creation-place-required.e2e.mjs's own new-place-creation
// assertions; transit-entity creation itself (session-planner/
// transit-entity.mjs) is UNCHANGED, just no longer reachable from this
// particular UI trigger.
// ---------------------------------------------------------------------------
function buildQuickAddScenePanel() {
  const wrap = document.createElement("div");
  wrap.className = "quick-add-scene-wrap";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn";
  btn.setAttribute("data-testid", "quick-add-scene-btn");
  btn.textContent = "+ Quick add scene";

  const panel = document.createElement("div");
  panel.setAttribute("data-testid", "quick-add-scene-panel");
  panel.style.display = "none";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.setAttribute("data-testid", "quick-add-scene-name-input");
  nameInput.placeholder = "Name this ad-hoc scene…";

  const submitBtn = document.createElement("button");
  submitBtn.type = "button";
  submitBtn.className = "btn btn--accept";
  submitBtn.setAttribute("data-testid", "quick-add-scene-submit-btn");
  submitBtn.textContent = "Create";

  const status = document.createElement("div");
  status.className = "hint";
  status.setAttribute("data-testid", "quick-add-scene-status");

  const placeStepHost = document.createElement("div");

  submitBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) {
      status.textContent = "Type a name first.";
      return;
    }
    submitBtn.disabled = true;
    status.innerHTML = "";
    const promise = spApi("/api/scene-planning/quick-gen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        world: currentWorld(),
        prompt: `Briefly and evocatively describe a location or moment called "${name}", suitable for dropping into an ongoing tabletop RPG session on short notice. Two or three sentences.`
      })
    });
    try {
      const genRes = await withSlowNoticeIndicator(status, promise);
      status.textContent = "";
      nameInput.disabled = true;
      submitBtn.style.display = "none";

      // Phase 26 task 26.5, §26.A: quick-gen's generation step is still
      // exactly one field/one button/one LLM call (unchanged from Phase
      // 23) -- what changes is the success callback, which no longer
      // creates an untethered scene. Instead it renders the SAME shared
      // place-required-flow every scene-creation path in this phase uses
      // (§3 of phase26-fixture.mjs's header), linking (if the DM chooses)
      // from the CURRENTLY-loaded scene's own anchor -- the natural
      // default target when this control is triggered mid-session.
      placeStepHost.innerHTML = "";
      const anchorEntityId = sceneRecordCache.get(currentSceneIdModule)?.locationEntityId ?? null;
      const flow = buildPlaceRequiredFlow("quick-add-scene", {
        linkFromEntityId: anchorEntityId,
        onResolved: async (placeEntityId) => {
          const flowStatus = flow.querySelector('[data-testid="quick-add-scene-status"]');
          if (flowStatus) flowStatus.textContent = "Creating scene…";
          const sceneRes = await spApi("/api/session-planner/scenes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ world: currentWorld(), locationEntityId: placeEntityId, objectiveNote: `${name} — ${genRes.text}` })
          });
          appendNewSceneRecord(sceneRes.scene);
          nameInput.value = "";
          nameInput.disabled = false;
          submitBtn.style.display = "";
          placeStepHost.innerHTML = "";
          panel.style.display = "none";
        }
      });
      placeStepHost.appendChild(flow);
    } catch (err) {
      status.textContent = `Could not generate: ${err.message}`;
      nameInput.disabled = false;
      submitBtn.style.display = "";
    } finally {
      submitBtn.disabled = false;
    }
  });

  // Idempotent-open, matching add-scene-btn's own established precedent
  // (§26.H) -- a same-scene/same-hash re-navigation never fires a fresh
  // render, so a strict toggle could close a panel a DM never actually saw
  // finish opening on THIS visit.
  btn.addEventListener("click", () => {
    panel.style.display = "block";
  });

  panel.append(nameInput, submitBtn, placeStepHost, status);
  wrap.append(btn, panel);
  return wrap;
}

// ---------------------------------------------------------------------------
// Phase 26 task 26.4, §26.A -- the ONE shared "resolve a place (existing or
// new), then offer link-or-not" sub-flow, mounted under a caller-specific
// testid `prefix`. Calls the REAL addNodeOp (POST /api/graph/nodes) and
// addEdgeOp (POST /api/graph/edges) routes directly -- zero new engine work.
// Once the place is fully resolved (an edge was created, or linking was
// explicitly declined), invokes `onResolved(placeEntityId)` so the CALLER
// decides what to do with it (26.5's quick-gen, 26.6's "+Scene" -- this is
// the one inner shape, never duplicated per caller).
//
// @param {string} prefix
// @param {{linkFromEntityId:string|null, onResolved:(placeEntityId:string)=>(void|Promise<void>)}} opts
// ---------------------------------------------------------------------------
function buildPlaceRequiredFlow(prefix, { linkFromEntityId, onResolved }) {
  const wrap = document.createElement("div");
  wrap.setAttribute("data-testid", `${prefix}-place-step`);

  const status = document.createElement("div");
  status.className = "hint";
  status.setAttribute("data-testid", `${prefix}-status`);

  const modeBar = document.createElement("div");
  const existingModeBtn = document.createElement("button");
  existingModeBtn.type = "button";
  existingModeBtn.className = "link-btn place-mode-btn place-mode-btn--active";
  existingModeBtn.setAttribute("data-testid", `${prefix}-place-mode-existing-btn`);
  existingModeBtn.textContent = "Pick existing place";
  const newModeBtn = document.createElement("button");
  newModeBtn.type = "button";
  newModeBtn.className = "link-btn place-mode-btn";
  newModeBtn.setAttribute("data-testid", `${prefix}-place-mode-new-btn`);
  newModeBtn.textContent = "Create new place";
  modeBar.append(existingModeBtn, newModeBtn);

  const existingSubpanel = document.createElement("div");
  const newSubpanel = document.createElement("div");
  newSubpanel.style.display = "none";

  function showExisting() {
    existingSubpanel.style.display = "";
    newSubpanel.style.display = "none";
    existingModeBtn.className = "link-btn place-mode-btn place-mode-btn--active";
    newModeBtn.className = "link-btn place-mode-btn";
  }
  function showNew() {
    existingSubpanel.style.display = "none";
    newSubpanel.style.display = "";
    newModeBtn.className = "link-btn place-mode-btn place-mode-btn--active";
    existingModeBtn.className = "link-btn place-mode-btn";
  }
  existingModeBtn.addEventListener("click", showExisting);
  newModeBtn.addEventListener("click", showNew);

  const linkStepHost = document.createElement("div");

  function placeResolved(placeEntityId) {
    linkStepHost.innerHTML = "";
    const linkStep = document.createElement("div");
    linkStep.setAttribute("data-testid", `${prefix}-link-step`);
    linkStep.setAttribute("data-place-entity-id", placeEntityId);

    const yesBtn = document.createElement("button");
    yesBtn.type = "button";
    yesBtn.className = "btn";
    yesBtn.setAttribute("data-testid", `${prefix}-link-yes-btn`);
    yesBtn.textContent = "Link to this scene's location";

    const noBtn = document.createElement("button");
    noBtn.type = "button";
    noBtn.className = "link-btn";
    noBtn.setAttribute("data-testid", `${prefix}-link-no-btn`);
    noBtn.textContent = "Don't link (just a hop)";

    const noteInput = document.createElement("input");
    noteInput.type = "text";
    noteInput.setAttribute("data-testid", `${prefix}-link-note-input`);
    noteInput.placeholder = "Optional: rough distance / relationship note";
    noteInput.style.display = "none";

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "btn btn--accept";
    confirmBtn.setAttribute("data-testid", `${prefix}-link-confirm-btn`);
    confirmBtn.textContent = "Confirm link";
    confirmBtn.style.display = "none";

    yesBtn.addEventListener("click", () => {
      noteInput.style.display = "";
      confirmBtn.style.display = "";
      yesBtn.disabled = true;
      noBtn.disabled = true;
    });

    confirmBtn.addEventListener("click", async () => {
      confirmBtn.disabled = true;
      status.textContent = "Linking…";
      try {
        if (linkFromEntityId) {
          await spApi("/api/graph/edges", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              world: currentWorld(),
              sourceId: linkFromEntityId,
              targetId: placeEntityId,
              notes: noteInput.value.trim() || undefined
            })
          });
        }
        await onResolved(placeEntityId);
      } catch (err) {
        status.textContent = `Could not link: ${err.message}`;
        confirmBtn.disabled = false;
      }
    });

    noBtn.addEventListener("click", async () => {
      noBtn.disabled = true;
      yesBtn.disabled = true;
      status.textContent = "";
      try {
        await onResolved(placeEntityId);
      } catch (err) {
        status.textContent = `Could not proceed: ${err.message}`;
        noBtn.disabled = false;
        yesBtn.disabled = false;
      }
    });

    linkStep.append(yesBtn, noBtn, noteInput, confirmBtn);
    linkStepHost.appendChild(linkStep);
  }

  const existingPicker = buildEntityPicker({
    testidPrefix: `${prefix}-place`,
    placeholder: "Search for an existing place…",
    defaultTypeFilter: "place",
    onSelect: (entity) => placeResolved(entity.id)
  });
  existingSubpanel.appendChild(existingPicker);

  const newNameInput = document.createElement("input");
  newNameInput.type = "text";
  newNameInput.setAttribute("data-testid", `${prefix}-new-place-name-input`);
  newNameInput.placeholder = "New place name…";
  const newSubmitBtn = document.createElement("button");
  newSubmitBtn.type = "button";
  newSubmitBtn.className = "btn";
  newSubmitBtn.setAttribute("data-testid", `${prefix}-new-place-submit-btn`);
  newSubmitBtn.textContent = "Create place";
  newSubmitBtn.addEventListener("click", async () => {
    const name = newNameInput.value.trim();
    if (!name) {
      status.textContent = "Type a name first.";
      return;
    }
    newSubmitBtn.disabled = true;
    status.textContent = "Creating place…";
    try {
      const result = await spApi("/api/graph/nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld(), name, type: "place" })
      });
      status.textContent = "";
      placeResolved(result.entityId);
    } catch (err) {
      status.textContent = `Could not create place: ${err.message}`;
    } finally {
      newSubmitBtn.disabled = false;
    }
  });
  newSubpanel.append(newNameInput, newSubmitBtn);

  wrap.append(modeBar, existingSubpanel, newSubpanel, linkStepHost, status);
  return wrap;
}

/**
 * Phase 26 task 26.4/26.6, §26.B -- "+Scene": ONE per scene, living at the
 * bottom of that scene's own box/card in BOTH views. Runs the shared
 * place-required-flow above (prefix `add-scene`), then creates the scene via
 * the EXISTING (Phase 16) POST /api/session-planner/scenes route -- no new
 * scene-creation mechanism. `onCreated(newScene)` is view-specific: the
 * construction view appends it to the chain right after this scene; Table
 * Mode (single-scene-focused) just reports success.
 *
 * @param {string} sceneId   the scene THIS control is mounted on (its own anchor is the default link target)
 * @param {(newScene:object)=>void} onCreated
 * @returns {{btn:HTMLElement, panel:HTMLElement}}
 */
function buildAddSceneControl(sceneId, onCreated) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn scene-action-btn";
  btn.setAttribute("data-testid", "add-scene-btn");
  btn.setAttribute("data-scene-id", sceneId);
  btn.textContent = "+ Scene";

  const panel = document.createElement("div");
  panel.setAttribute("data-testid", "add-scene-panel");
  panel.setAttribute("data-scene-id", sceneId);
  panel.style.display = "none";

  // Deliberately idempotent-open, NOT a strict open/close toggle -- same
  // established precedent as scenes-view.js's own toggleLinkedPanel
  // (§26.H's own hypothesis text names this exact pattern). ALSO rebuilds
  // the inner flow FRESH on every click, rather than caching/resuming a
  // previously-mounted one: a same-scene/same-hash re-navigation (the
  // confirmed root cause behind §26.H bug 1, directly reproduced against
  // this exact control while building it) never fires a fresh render, so a
  // cached flow would silently resume wherever an EARLIER visit left off
  // (a different sub-mode selected, or already past the place-step) instead
  // of the fresh flow a DM clicking "+ Scene" again genuinely expects.
  btn.addEventListener("click", () => {
    panel.style.display = "block";
    panel.innerHTML = "";
    const anchorEntityId = sceneRecordCache.get(sceneId)?.locationEntityId ?? null;
    const flow = buildPlaceRequiredFlow("add-scene", {
      linkFromEntityId: anchorEntityId,
      onResolved: async (placeEntityId) => {
        const flowStatus = flow.querySelector('[data-testid="add-scene-status"]');
        if (flowStatus) flowStatus.textContent = "Creating scene…";
        const { scene: newScene } = await spApi("/api/session-planner/scenes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ world: currentWorld(), locationEntityId: placeEntityId })
        });
        if (flowStatus) flowStatus.textContent = "Scene created.";
        onCreated(newScene);
      }
    });
    // Every `add-scene-status`/`add-scene-place-step`/`add-scene-link-step`
    // element this panel ever renders is stamped with THIS scene's own id
    // -- the fixture's own contract scopes status lookups by
    // [data-testid="add-scene-status"][data-scene-id="..."], matching
    // add-scene-btn/add-scene-panel's own established convention.
    flow.setAttribute("data-scene-id", sceneId);
    for (const el of flow.querySelectorAll("[data-testid]")) {
      if (!el.hasAttribute("data-scene-id")) el.setAttribute("data-scene-id", sceneId);
    }
    panel.appendChild(flow);
  });

  return { btn, panel };
}

// ---------------------------------------------------------------------------
// Chain assembly (this file's header). Pure helpers first, then the DOM
// builders that consume them.
// ---------------------------------------------------------------------------
function ultimateRootId(allScenes, sceneId) {
  const byId = new Map(allScenes.map((s) => [s.id, s]));
  let cur = byId.get(sceneId);
  const seen = new Set();
  while (cur && cur.parentSceneId && !seen.has(cur.id)) {
    seen.add(cur.id);
    const parent = byId.get(cur.parentSceneId);
    if (!parent) break;
    cur = parent;
  }
  return cur ? cur.id : sceneId;
}

/** Shared "what do we call this scene" resolution -- Phase 26 task 26.2: a scene's own bespoke `name`, when set, wins over everything else (what makes two scenes at the same anchor, e.g. two scenes both at "Grand Stadium", distinguishable). Falls back, when unset, to the pre-26 behavior: an anchored scene shows its anchor entity's real name; an untethered (quick-gen) scene falls back to its own objective note. Used by both the construction chain's own scene-chain-toggle summary text and Table Mode's nav-zone items/search (task 25.2). */
function resolveSceneDisplayName(scene) {
  if (scene.name) return scene.name;
  if (scene.locationEntityId) {
    return entityInfoMapGlobal.get(scene.locationEntityId)?.name ?? scene.locationEntityId;
  }
  return scene.objectiveNote || "Ad-hoc scene";
}

/**
 * Phase 26 task 26.2: a small, always-available "rename this scene" control
 * -- an edit-in-place text input, defaulting to the scene's current bespoke
 * name (empty when unset). Calls the real POST /api/session-planner/scenes/
 * :id/rename route, updates sceneRecordCache in place (so
 * resolveSceneDisplayName reflects it immediately without a full reload),
 * then invokes `onRenamed` so the caller can refresh whatever text it
 * already rendered from the old name. Shared by both views.
 *
 * @param {string} sceneId
 * @param {() => void} onRenamed
 * @returns {HTMLElement}
 */
function buildSceneRenameControl(sceneId, onRenamed) {
  const wrap = document.createElement("span");
  wrap.className = "scene-rename-control";
  wrap.setAttribute("data-testid", "scene-rename-control");
  wrap.setAttribute("data-scene-id", sceneId);

  const input = document.createElement("input");
  input.type = "text";
  input.setAttribute("data-testid", "scene-rename-input");
  input.placeholder = "Name this scene…";
  input.value = sceneRecordCache.get(sceneId)?.name || "";
  input.addEventListener("click", (evt) => evt.stopPropagation()); // never toggle the enclosing <details>

  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Rename";
  btn.setAttribute("data-testid", "scene-rename-submit-btn");

  const status = document.createElement("span");
  status.setAttribute("data-testid", "scene-rename-status");

  btn.addEventListener("click", async (evt) => {
    evt.stopPropagation();
    const world = currentWorld();
    const name = input.value.trim() || null;
    status.textContent = "Saving…";
    try {
      const { scene } = await spApi(`/api/session-planner/scenes/${encodeURIComponent(sceneId)}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world, name })
      });
      sceneRecordCache.set(sceneId, scene);
      status.textContent = "Saved.";
      onRenamed?.();
    } catch (err) {
      status.textContent = `Could not rename: ${err.message}`;
    }
  });

  wrap.appendChild(input);
  wrap.appendChild(btn);
  wrap.appendChild(status);
  return wrap;
}

export function buildChainOrder(allScenes, currentSceneId, linked) {
  const currentScene = allScenes.find((s) => s.id === currentSceneId);
  if (!currentScene) return [];
  const currentRoot = ultimateRootId(allScenes, currentSceneId);
  const others = allScenes.filter((s) => s.parentSceneId === null && s.id !== currentRoot && s.id !== currentSceneId);
  const candidates = [currentScene, ...others];

  const hopOf = new Map(linked.map((l) => [l.sceneId, l.hopDistance]));
  const withHop = candidates.map((s) => ({
    scene: s,
    hop: s.id === currentSceneId ? 0 : (hopOf.has(s.id) ? hopOf.get(s.id) : Number.POSITIVE_INFINITY)
  }));
  withHop.sort((a, b) => a.hop - b.hop); // stable -- ties keep candidates' original (creation) order
  return withHop.map((w) => w.scene);
}

async function ensureSceneExtras(sceneId) {
  if (sceneExtrasCache.has(sceneId)) return sceneExtrasCache.get(sceneId);
  const [briefRes, undoActions, encounters, memberIds] = await Promise.all([
    spApi(`/api/session-planner/brief${spWithWorld({ sceneId })}`),
    fetchUndoActions(sceneId),
    fetchSavedEncounters(sceneId),
    fetchSceneMembers(sceneId)
  ]);
  if (!addedMembership.has(sceneId)) addedMembership.set(sceneId, new Set());
  const added = addedMembership.get(sceneId);
  for (const id of memberIds) added.add(id);
  const extras = { brief: briefRes.brief, undoActions, encounters };
  sceneExtrasCache.set(sceneId, extras);
  return extras;
}

function buildSceneBodyInto(body, sceneId) {
  const scene = sceneRecordCache.get(sceneId);

  const grid = document.createElement("div");
  grid.className = "scene-members-grid session-planner-grid";
  body.appendChild(grid);

  const extras = sceneExtrasCache.get(sceneId);

  // Phase 26 task 26.4/26.6, §26.B -- "+Scene", built once and reused both
  // as the actions-bar button below AND as create-ad-hoc-scene-btn's alias
  // target in the repurposed connect-existing-scene zone (task 26.7) -- one
  // control, two entry points, never a duplicate mechanism.
  const addSceneControl = buildAddSceneControl(sceneId, (newScene) => {
    insertSceneRecord(sceneId, newScene);
  });

  // Phase 26 task 26.7, §26.B: renderBeyondCorridorSummary's old "Beyond
  // this corridor" collapsed summary is REMOVED -- its former DOM position
  // now hosts connect-existing-scene / create-ad-hoc-scene, quick and
  // visible, never behind a <details>.
  body.appendChild(buildConnectExistingSceneZone(sceneId, addSceneControl));

  const actionsBar = document.createElement("div");
  actionsBar.setAttribute("data-testid", "scene-actions-bar");
  actionsBar.setAttribute("data-scene-id", sceneId);

  const { toggleBtn: addNodeToggle, panel: addNodePanel } = mountAddNodeControl(sceneId, body);

  const developSceneBtn = document.createElement("button");
  developSceneBtn.type = "button";
  developSceneBtn.className = "btn scene-action-btn";
  developSceneBtn.setAttribute("data-testid", "develop-scene-btn");
  developSceneBtn.setAttribute("data-scene-id", sceneId);
  developSceneBtn.textContent = "Develop this scene";

  const developStatus = document.createElement("div");
  developStatus.setAttribute("data-testid", "develop-scene-status");
  developStatus.setAttribute("data-scene-id", sceneId);

  const developReviewHolder = document.createElement("div");

  developSceneBtn.addEventListener("click", () => onDevelopScene(sceneId, developStatus, developReviewHolder));

  const { btn: addEventBtn, panel: addEventPanel } = mountAddEventControl(scene);
  const addEncounterBtn = mountAddEncounterControl(scene);

  // Phase 26 task 26.4/26.6, §26.B -- "+Scene" lives at the BOTTOM of this
  // scene's own actions bar, a sibling of develop-scene-btn etc. (replaces
  // the old between-scenes insert-scene-control -- task 26.6 removes that
  // mechanism entirely).
  const { btn: addSceneBtn, panel: addScenePanel } = addSceneControl;

  // DOM source order per this phase's own interface contract: add-node
  // toggle, develop-scene, add-event, add-encounter, add-scene -- all direct
  // siblings of the SAME actions bar, same button element type/class (task
  // 23.6's equal-weight requirement).
  actionsBar.append(addNodeToggle, developSceneBtn, addEventBtn, addEncounterBtn, addSceneBtn);
  body.appendChild(actionsBar);
  body.appendChild(addNodePanel);
  body.appendChild(addEventPanel);
  body.appendChild(addScenePanel);
  body.appendChild(developStatus);
  body.appendChild(developReviewHolder);

  body.appendChild(renderRollbackPanel(sceneId, extras.undoActions));
  body.appendChild(renderSavedEncountersList(sceneId, extras.encounters));

  refreshMembersGrid(sceneId, body);
}

function buildChainItem(sceneId, isCurrent) {
  const scene = sceneRecordCache.get(sceneId);
  const details = document.createElement("details");
  details.className = "scene-chain-item";
  details.setAttribute("data-testid", "scene-chain-item");
  details.setAttribute("data-scene-id", sceneId);
  if (isCurrent) details.setAttribute("data-current", "true");
  if (scene.locationEntityId === null) details.setAttribute("data-untethered", "true");

  const summary = document.createElement("summary");
  summary.setAttribute("data-testid", "scene-chain-toggle");
  summary.textContent = resolveSceneDisplayName(scene);
  details.appendChild(summary);

  details.appendChild(buildSceneRenameControl(sceneId, () => { summary.textContent = resolveSceneDisplayName(sceneRecordCache.get(sceneId)); }));

  const body = document.createElement("div");
  body.className = "scene-chain-item-body";
  details.appendChild(body);

  let loaded = false;
  async function ensureBodyLoaded() {
    if (loaded) return;
    loaded = true;
    try {
      await ensureSceneExtras(sceneId);
      buildSceneBodyInto(body, sceneId);
    } catch (err) {
      loaded = false; // allow a retry on the next expand
      body.textContent = `Could not load this scene: ${err.message}`;
    }
  }
  details._ensureBodyLoaded = ensureBodyLoaded;

  details.addEventListener("toggle", () => {
    if (details.open) ensureBodyLoaded();
  });

  if (isCurrent) details.open = true;

  return details;
}

function rerenderChainOnly() {
  if (!chainContainerEl) return;
  chainContainerEl.innerHTML = "";
  let currentItemEl = null;
  for (const id of chainSceneIds) {
    const item = buildChainItem(id, id === currentSceneIdModule);
    if (id === currentSceneIdModule) currentItemEl = item;
    // Phase 26 task 26.6, §26.B: the old between-scenes insert-scene-control
    // is REMOVED entirely -- "+Scene" (26.4's buildAddSceneControl, mounted
    // inside each scene's own actions bar by buildSceneBodyInto) replaces
    // it. No control is appended here between chain items any more.
    chainContainerEl.appendChild(item);
  }
  if (currentItemEl) currentItemEl._ensureBodyLoaded();
}

function insertSceneRecord(afterSceneId, newScene) {
  sceneRecordCache.set(newScene.id, newScene);
  const idx = chainSceneIds.indexOf(afterSceneId);
  const insertAt = idx === -1 ? chainSceneIds.length : idx + 1;
  chainSceneIds.splice(insertAt, 0, newScene.id);
  rerenderChainOnly();
}

// Phase 26 task 26.5: renamed from appendUntetheredSceneRecord -- quick-gen
// scenes are no longer ever untethered (§26.A), but this append-to-end
// positioning (as opposed to insertSceneRecord's after-a-specific-scene
// positioning) is still exactly right for a top-level, not-scoped-to-any-
// one-scene quick-add action.
function appendNewSceneRecord(newScene) {
  sceneRecordCache.set(newScene.id, newScene);
  chainSceneIds.push(newScene.id);
  rerenderChainOnly();
}

// ---------------------------------------------------------------------------
// Top-level chain load. Fetches everything CHEAP (scene records, entity
// names, linkage) up front; the current scene's own EXPENSIVE body loads
// synchronously as part of this call (so callers can rely on the anchor
// card being present once this resolves); every other item's body stays
// lazy (this file's header).
// ---------------------------------------------------------------------------
async function loadAndRenderChain(sceneId, container, opts = {}) {
  const world = currentWorld();

  const scene = (await spApi(`/api/session-planner/scenes/${encodeURIComponent(sceneId)}${spWithWorld()}`)).scene;

  const [entityInfoMapRes, allScenesRes, linkedRes] = await Promise.all([
    fetchEntityInfoMap(),
    spApi(`/api/scene-planning/scenes${spWithWorld()}`),
    spApi(`/api/scene-planning/linkage${spWithWorld({ sceneId })}`)
  ]);
  entityInfoMapGlobal = entityInfoMapRes;
  const allScenes = allScenesRes.scenes ?? [];
  const linked = linkedRes.linked ?? [];

  sceneRecordCache.clear();
  for (const s of allScenes) sceneRecordCache.set(s.id, s);
  if (!sceneRecordCache.has(sceneId)) sceneRecordCache.set(sceneId, scene);

  const ordered = buildChainOrder(allScenes.some((s) => s.id === sceneId) ? allScenes : [...allScenes, scene], sceneId, linked);
  chainSceneIds = ordered.map((s) => s.id);
  currentSceneIdModule = sceneId;
  sceneExtrasCache.clear();

  container.innerHTML = "";
  container.appendChild(renderStartNewPlanBar());

  chainContainerEl = document.createElement("div");
  chainContainerEl.setAttribute("data-testid", "scene-chain");
  container.appendChild(chainContainerEl);
  rerenderChainOnly();

  // Phase 25 task 25.2: Table Mode toggle -- top-level, sibling of
  // scene-chain (matching quick-add-scene-btn's own established
  // top-level-not-scoped-to-one-scene-item placement), always for whichever
  // scene is CURRENTLY loaded. See table-mode-fixture.mjs §1.
  const tableModeToggleBtn = document.createElement("button");
  tableModeToggleBtn.type = "button";
  tableModeToggleBtn.className = "btn";
  tableModeToggleBtn.setAttribute("data-testid", "table-mode-toggle-btn");
  tableModeToggleBtn.textContent = "🖥 Table Mode";
  tableModeToggleBtn.addEventListener("click", () => {
    location.hash = `session-planner/${currentSceneIdModule}?mode=table`;
  });
  container.appendChild(tableModeToggleBtn);

  container.appendChild(buildQuickAddScenePanel());
  container.appendChild(buildRecenterControl(sceneId, async (newSceneId) => {
    openNotePanels.clear();
    await loadAndRenderChain(newSceneId, container, { replaceState: true });
  }));

  saveLastSceneId(world, sceneId);
  if (opts.replaceState) {
    history.replaceState(null, "", `#session-planner/${sceneId}`);
  }

  // The current item's own body is guaranteed loaded before this function
  // resolves -- rerenderChainOnly() above already kicked it off; await it
  // explicitly here too so callers awaiting loadAndRenderChain() can rely
  // on the current scene's own cards being present.
  const currentItemEl = [...chainContainerEl.children].find(
    (el) => el.getAttribute && el.getAttribute("data-testid") === "scene-chain-item" && el.getAttribute("data-scene-id") === sceneId
  );
  if (currentItemEl) await currentItemEl._ensureBodyLoaded();
}

// ===========================================================================
// Phase 25: Table Mode -- the at-table live-read view. A single-scene,
// fixed-zone alternate render of the SAME #session-planner-body container
// the construction chain above populates (mutually exclusive with it), per
// plans/phase-25-review.md §3/§3a and review-ui/test/e2e/table-mode-fixture
// .mjs's full DOM/route contract. Deliberately reuses ensureSceneExtras'
// existing lazy per-scene cache (brief/undoActions/encounters) rather than
// fetching independently -- see this file's own established convention.
// ===========================================================================

/**
 * The URL scheme packs the mode signal into app.js's single `arg` slot
 * (`<sceneId>?mode=table`) rather than a third hash path segment, since
 * app.js's parseHash() only ever extracts two segments (`raw.split("/")`)
 * and would silently drop a third. See table-mode-fixture.mjs §1 for the
 * full reasoning -- this function is the "responsible for splitting arg on
 * ?mode=table itself" half of that contract.
 */
function parseSceneModeArg(raw) {
  if (!raw) return { sceneId: null, mode: "construction" };
  const idx = raw.indexOf("?mode=table");
  if (idx === -1) return { sceneId: raw, mode: "construction" };
  return { sceneId: raw.slice(0, idx), mode: "table" };
}

function tableModeHashFor(sceneId) {
  return `session-planner/${sceneId}?mode=table`;
}

// ---------------------------------------------------------------------------
// Task 25.2: top strip -- the scene's own anchor entity name/path-badge plus
// the corrected (task 25.1) flag coding, reusing the EXACT SAME CSS classes
// the construction view's location-card already uses (table-mode-fixture.mjs
// §2) so Table Mode benefits from the same token fix, not a parallel set of
// classes it wouldn't reach.
// ---------------------------------------------------------------------------
function buildTableTopStrip(scene, extras) {
  const wrap = document.createElement("div");
  wrap.className = "table-top-strip";
  wrap.setAttribute("data-testid", "table-top-strip");
  wrap.setAttribute("data-scene-id", scene.id);

  const nameEl = document.createElement("h2");
  nameEl.className = "table-top-strip-name";
  nameEl.setAttribute("data-testid", "table-top-strip-name");
  nameEl.textContent = resolveSceneDisplayName(scene);
  wrap.appendChild(nameEl);

  wrap.appendChild(buildSceneRenameControl(scene.id, () => { nameEl.textContent = resolveSceneDisplayName(sceneRecordCache.get(scene.id) ?? scene); }));

  const pathBadge = document.createElement("span");
  pathBadge.className = "location-card-anchor-badge";
  pathBadge.setAttribute("data-testid", "table-top-strip-path-badge");
  pathBadge.textContent = "On the path";
  wrap.appendChild(pathBadge);

  const flagsWrap = document.createElement("div");
  flagsWrap.className = "location-card-flags table-top-strip-flags";

  const anchorLoc = (extras?.brief?.locations ?? []).find((l) => l.distance === 0) ?? null;
  if (anchorLoc) {
    if (anchorLoc.contentFlag?.flagged) {
      const b = document.createElement("span");
      b.className = "flag-badge flag-badge--content";
      b.setAttribute("data-testid", "table-flag-badge");
      b.setAttribute("data-flag-kind", "content");
      b.textContent = "✎ Undeveloped";
      b.title = `Content-readiness flag: ${(anchorLoc.contentFlag.reasons || []).join(", ") || "flagged"}`;
      flagsWrap.appendChild(b);
    }
    if (anchorLoc.structuralFlag?.flagged) {
      const b = document.createElement("span");
      b.className = "flag-badge flag-badge--structural";
      b.setAttribute("data-testid", "table-flag-badge");
      b.setAttribute("data-flag-kind", "structural");
      b.textContent = "⛓ Thin connections";
      b.title = `Structural under-connection: ${anchorLoc.structuralFlag.edgeCount} edge(s), fewer than ${anchorLoc.structuralFlag.minEdges}`;
      flagsWrap.appendChild(b);
    }
    if (!anchorLoc.digest) {
      const b = document.createElement("span");
      b.className = "location-card-digest--empty";
      b.setAttribute("data-testid", "table-flag-badge");
      b.setAttribute("data-flag-kind", "empty");
      b.textContent = "⚠ Not established yet — nothing written for this location.";
      flagsWrap.appendChild(b);
    }
  }
  wrap.appendChild(flagsWrap);

  return wrap;
}

// ---------------------------------------------------------------------------
// Task 25.2: navigation zone -- adjacent-scenes strip (hop-1 only) + an
// in-place search bar above it + a collapsed-by-default full scene list.
// Replaces the idea of a single "Advance" button entirely (design record
// §3a) -- this zone is the whole navigation surface.
// ---------------------------------------------------------------------------
/**
 * Phase 26 task 26.8, §26.D: Plan-scoped scene item, shared shape for both
 * the active-plan-list and each other-plan-item's own revealed list.
 * Explicitly closes `closeOnClick` (its own containing <details>, when
 * given) on EVERY click -- including a same-scene no-op-navigation click --
 * per §26.H bug 1's confirmed root cause (a no-op navigation never fires
 * hashchange, so nothing re-renders to close it otherwise). Built this way
 * from the start rather than discovering the gap again in task 26.12.
 */
function buildPlanSceneItem(testid, s, currentSceneId, onNavigate, closeOnClick) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "link-btn";
  item.setAttribute("data-testid", testid);
  item.setAttribute("data-scene-id", s.id);
  if (s.id === currentSceneId) item.setAttribute("data-current", "true");
  item.textContent = resolveSceneDisplayName(s);
  item.addEventListener("click", () => {
    if (closeOnClick) closeOnClick.open = false;
    onNavigate(s.id);
  });
  return item;
}

function buildTableNavZone(scene, allScenes, linked, plans, activePlan) {
  const wrap = document.createElement("div");
  wrap.className = "table-nav-zone";
  wrap.setAttribute("data-testid", "table-nav-zone");
  wrap.setAttribute("data-scene-id", scene.id);

  // In-place search -- client-side substring filter over the SAME
  // GET /api/scene-planning/scenes fetch the full list below uses (and
  // Phase 24's scenes-view.js already established this pattern for).
  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.className = "table-nav-search-input";
  searchInput.setAttribute("data-testid", "table-nav-search-input");
  searchInput.placeholder = "Search all scenes…";

  const searchResults = document.createElement("div");
  searchResults.className = "table-nav-search-results";
  searchResults.setAttribute("data-testid", "table-nav-search-results");
  searchResults.style.display = "none";

  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim().toLowerCase();
    searchResults.innerHTML = "";
    if (!q) {
      searchResults.style.display = "none";
      return;
    }
    const matches = allScenes.filter((s) => resolveSceneDisplayName(s).toLowerCase().includes(q));
    for (const s of matches) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "link-btn table-nav-search-result";
      item.setAttribute("data-testid", "table-nav-search-result");
      item.setAttribute("data-scene-id", s.id);
      item.textContent = resolveSceneDisplayName(s);
      item.addEventListener("click", () => {
        location.hash = tableModeHashFor(s.id);
      });
      searchResults.appendChild(item);
    }
    if (!matches.length) {
      const none = document.createElement("div");
      none.className = "hint";
      none.textContent = "No matches.";
      searchResults.appendChild(none);
    }
    searchResults.style.display = "block";
  });

  wrap.append(searchInput, searchResults);

  // Adjacent-scenes strip -- hop-1 neighbors only, a single tap, no picker.
  const adjacentStrip = document.createElement("div");
  adjacentStrip.className = "table-adjacent-strip";
  adjacentStrip.setAttribute("data-testid", "table-adjacent-strip");

  const hop1 = linked.filter((x) => x.hopDistance === 1);
  for (const l of hop1) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "btn table-adjacent-scene-item";
    item.setAttribute("data-testid", "table-adjacent-scene-item");
    item.setAttribute("data-scene-id", l.sceneId);
    item.textContent = l.anchorEntityName ?? sceneRecordCache.get(l.sceneId)?.locationEntityId ?? l.sceneId;
    item.addEventListener("click", () => {
      location.hash = tableModeHashFor(l.sceneId);
    });
    adjacentStrip.appendChild(item);
  }
  if (!hop1.length) {
    // A real, visible (non-zero-area) placeholder -- an empty container with
    // no children/CSS would collapse to a zero-height box, which is
    // indistinguishable from "not rendered" to a real bounding-box check.
    const empty = document.createElement("span");
    empty.className = "hint";
    empty.textContent = "No adjacent scenes yet.";
    adjacentStrip.appendChild(empty);
  }
  wrap.appendChild(adjacentStrip);

  // Phase 26 task 26.8, §26.D: replaces the old flat "All scenes"
  // table-full-list entirely with Plan-scoped browsing -- "Start new plan" /
  // active Plan's own scenes (current expanded, rest collapsed) / other
  // Plans (collapsed, revealed on expand).
  const world = currentWorld();

  const startBtn = document.createElement("button");
  startBtn.type = "button";
  startBtn.className = "btn";
  startBtn.setAttribute("data-testid", "table-start-new-plan-btn");
  startBtn.textContent = "+ Start new plan";

  const startPanel = document.createElement("div");
  startPanel.setAttribute("data-testid", "table-start-new-plan-panel");
  startPanel.style.display = "none";

  const startNameInput = document.createElement("input");
  startNameInput.type = "text";
  startNameInput.setAttribute("data-testid", "table-start-new-plan-name-input");
  startNameInput.placeholder = "Name this plan…";

  const startSubmitBtn = document.createElement("button");
  startSubmitBtn.type = "button";
  startSubmitBtn.className = "btn btn--accept";
  startSubmitBtn.setAttribute("data-testid", "table-start-new-plan-submit-btn");
  startSubmitBtn.textContent = "Create";

  const startStatus = document.createElement("div");
  startStatus.className = "hint";

  startSubmitBtn.addEventListener("click", async () => {
    const name = startNameInput.value.trim();
    if (!name) {
      startStatus.textContent = "Type a name first.";
      return;
    }
    startSubmitBtn.disabled = true;
    startStatus.textContent = "Creating…";
    try {
      const { plan } = await spApi("/api/scene-planning/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world, name })
      });
      await spApi(`/api/scene-planning/plans/${encodeURIComponent(plan.id)}/scenes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world, sceneId: scene.id })
      });
      saveActivePlanId(world, plan.id);
      const container = document.getElementById("session-planner-body");
      await loadAndRenderTableMode(scene.id, container);
    } catch (err) {
      startStatus.textContent = `Could not create plan: ${err.message}`;
      startSubmitBtn.disabled = false;
    }
  });

  // Idempotent-open, matching add-scene-btn's own established precedent (§26.H).
  startBtn.addEventListener("click", () => {
    startPanel.style.display = "block";
  });

  startPanel.append(startNameInput, startSubmitBtn, startStatus);
  wrap.append(startBtn, startPanel);

  if (activePlan) {
    const activeList = document.createElement("details");
    activeList.setAttribute("data-testid", "table-active-plan-list");
    activeList.setAttribute("data-plan-id", activePlan.id);
    activeList.open = true;

    const activeSummary = document.createElement("summary");
    activeSummary.setAttribute("data-testid", "table-active-plan-toggle");
    activeSummary.textContent = activePlan.name || "(untitled plan)";
    activeList.appendChild(activeSummary);

    for (const sceneIdInPlan of activePlan.sceneIds) {
      const s = sceneRecordCache.get(sceneIdInPlan) ?? allScenes.find((x) => x.id === sceneIdInPlan);
      if (!s) continue; // a stale/removed scene id -- skip rather than render a broken entry
      activeList.appendChild(buildPlanSceneItem(
        "table-active-plan-scene-item",
        s,
        scene.id,
        (id) => { location.hash = tableModeHashFor(id); },
        activeList
      ));
    }
    wrap.appendChild(activeList);

    // Phase 26 task 26.9, §26.E -- "Propose graph updates from this plan's
    // notes." Lives here (the one place in this phase's UI a "current Plan"
    // is already a first-class concept). Calls the real POST /api/scene-
    // planning/plans/:planId/propose-updates route, then navigates to the
    // produced batch's Batch Review screen -- the EXISTING, unmodified
    // review surface, never a second/parallel one.
    const proposeBtn = document.createElement("button");
    proposeBtn.type = "button";
    proposeBtn.className = "btn";
    proposeBtn.setAttribute("data-testid", "propose-graph-updates-btn");
    proposeBtn.setAttribute("data-plan-id", activePlan.id);
    proposeBtn.textContent = "Propose graph updates from this plan's notes";

    const proposeStatus = document.createElement("div");
    proposeStatus.className = "hint";
    proposeStatus.setAttribute("data-testid", "propose-graph-updates-status");
    proposeStatus.setAttribute("data-plan-id", activePlan.id);

    proposeBtn.addEventListener("click", async () => {
      proposeBtn.disabled = true;
      const promise = spApi(`/api/scene-planning/plans/${encodeURIComponent(activePlan.id)}/propose-updates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world })
      });
      try {
        const result = await withSlowNoticeIndicator(proposeStatus, promise);
        proposeStatus.textContent = result.headline ?? "Proposed graph updates.";
        location.hash = `review/${result.batchId}`;
      } catch (err) {
        proposeStatus.textContent = `Could not propose updates: ${err.message}`;
        proposeBtn.disabled = false;
      }
    });

    wrap.append(proposeBtn, proposeStatus);
  }

  const otherPlans = plans.filter((p) => !activePlan || p.id !== activePlan.id);
  if (otherPlans.length) {
    const otherPlansWrap = document.createElement("div");
    otherPlansWrap.setAttribute("data-testid", "table-other-plans-list");

    for (const p of otherPlans) {
      const item = document.createElement("details");
      item.setAttribute("data-testid", "table-other-plan-item");
      item.setAttribute("data-plan-id", p.id);
      item.open = false;

      const itemSummary = document.createElement("summary");
      itemSummary.setAttribute("data-testid", "table-other-plan-toggle");
      itemSummary.textContent = p.name || "(untitled plan)";
      item.appendChild(itemSummary);

      for (const sceneIdInPlan of p.sceneIds) {
        const s = sceneRecordCache.get(sceneIdInPlan) ?? allScenes.find((x) => x.id === sceneIdInPlan);
        if (!s) continue;
        item.appendChild(buildPlanSceneItem(
          "table-other-plan-scene-item",
          s,
          scene.id,
          (id) => {
            saveActivePlanId(world, p.id);
            location.hash = tableModeHashFor(id);
          },
          item
        ));
      }
      otherPlansWrap.appendChild(item);
    }
    wrap.appendChild(otherPlansWrap);
  }

  return wrap;
}

// ---------------------------------------------------------------------------
// Task 25.3: member roster -- one compact row per scene member (anchor,
// satellite, added), each with a persistent (non-hover) expand revealing
// description/summary/imageUrl/tags. Deliberately NO cap on how many rows
// can be expanded simultaneously (design record §5's direct adjudication --
// "start unbounded," let real usage surface whether a cap is ever actually
// needed) -- each row's own detail toggle is fully independent local state,
// never a shared "close the others" mechanism. playerKnown gets its own
// separate, harder gate (buildPlayerKnownGate below): it must NEVER be
// present in the DOM at all until its own explicit confirm step fires, not
// merely CSS-hidden -- so the real value is only ever created (never just
// shown/hidden) on that confirm click.
// ---------------------------------------------------------------------------
function buildTableRosterDetail(entityId, info) {
  const detail = document.createElement("div");
  detail.className = "table-roster-detail";
  detail.setAttribute("data-testid", "table-roster-detail");
  detail.setAttribute("data-entity-id", entityId);
  detail.style.display = "none";

  const descEl = document.createElement("p");
  descEl.className = "table-roster-detail-description";
  descEl.setAttribute("data-testid", "table-roster-detail-description");
  descEl.textContent = info?.description || "No description written yet.";
  detail.appendChild(descEl);

  const summaryEl = document.createElement("p");
  summaryEl.className = "hint table-roster-detail-summary";
  summaryEl.setAttribute("data-testid", "table-roster-detail-summary");
  summaryEl.textContent = info?.summary || "";
  detail.appendChild(summaryEl);

  if (info?.imageUrl) {
    const img = document.createElement("img");
    img.className = "table-roster-detail-image";
    img.setAttribute("data-testid", "table-roster-detail-image");
    img.src = info.imageUrl;
    img.alt = info?.name ?? "";
    detail.appendChild(img);
  }

  // Phase 26 task 26.11, §26.G: tags rendering removed entirely -- "the
  // tags are relatively meaningless... I'm going to let an LLM deal with
  // the tags" (the project owner's own assessment). The underlying
  // `info.tags` data fetch is completely UNTOUCHED (still fetched, just not
  // rendered here) -- this is a display change, not a data-removal.

  detail.appendChild(buildFoundryPushControl(entityId));

  return detail;
}

/**
 * Phase 26 task 26.10, §26.F: "Drop this into Foundry" -- replaces the old
 * buildPlayerKnownGate (a pure read-only status display with no real action
 * behind it) with a genuine action: pushing this entity's own description
 * text into live Foundry chat. Gated behind the SAME kind of deliberate
 * confirm step the old gate used (a plain expand tap is NOT enough), but
 * for a real action this time -- confirming calls the real
 * POST /api/entities/:entityId/foundry-push route (genuinely slow/external:
 * headless Chromium login + ChatMessage.create, per gm-say.mjs), shown with
 * this app's established still-working-indicator loading affordance.
 */
function buildFoundryPushControl(entityId) {
  const wrap = document.createElement("div");
  wrap.className = "table-roster-foundry-push-wrap";

  const pushBtn = document.createElement("button");
  pushBtn.type = "button";
  pushBtn.className = "btn";
  pushBtn.setAttribute("data-testid", "table-roster-foundry-push-btn");
  pushBtn.setAttribute("data-entity-id", entityId);
  pushBtn.textContent = "Drop this into Foundry…";

  const status = document.createElement("div");
  status.className = "hint";
  status.setAttribute("data-testid", "table-roster-foundry-push-status");
  status.setAttribute("data-entity-id", entityId);

  let confirmPanel = null;

  pushBtn.addEventListener("click", () => {
    if (confirmPanel) return; // already open -- a second click is a no-op, not a second panel
    confirmPanel = document.createElement("div");
    confirmPanel.className = "table-roster-foundry-push-confirm-panel";
    confirmPanel.setAttribute("data-testid", "table-roster-foundry-push-confirm-panel");

    const warning = document.createElement("p");
    warning.className = "hint";
    warning.textContent = "This posts this entity's description into live Foundry chat, visible to anyone connected — are you sure?";
    confirmPanel.appendChild(warning);

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "btn btn--accept";
    confirmBtn.setAttribute("data-testid", "table-roster-foundry-push-confirm-btn");
    confirmBtn.textContent = "Yes, post it";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn";
    cancelBtn.setAttribute("data-testid", "table-roster-foundry-push-cancel-btn");
    cancelBtn.textContent = "Cancel";

    confirmBtn.addEventListener("click", async () => {
      confirmBtn.disabled = true;
      const promise = spApi(`/api/entities/${encodeURIComponent(entityId)}/foundry-push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld() })
      });
      try {
        await withSlowNoticeIndicator(status, promise);
        status.textContent = "Posted to Foundry chat.";
      } catch (err) {
        status.textContent = `Could not post to Foundry: ${err.message}`;
      } finally {
        confirmPanel.remove();
        confirmPanel = null;
      }
    });

    cancelBtn.addEventListener("click", () => {
      confirmPanel.remove();
      confirmPanel = null;
    });

    confirmPanel.append(confirmBtn, cancelBtn);
    wrap.appendChild(confirmPanel);
  });

  wrap.append(pushBtn, status);
  return wrap;
}

function buildTableRosterRow(location, role) {
  const entityId = location.entityId;
  const info = entityInfoMapGlobal.get(entityId);

  const row = document.createElement("div");
  row.className = `table-roster-row table-roster-row--${role}`;
  row.setAttribute("data-testid", "table-roster-row");
  row.setAttribute("data-entity-id", entityId);
  row.setAttribute("data-card-role", role);

  const nameEl = document.createElement("span");
  nameEl.className = "table-roster-row-name";
  nameEl.setAttribute("data-testid", "table-roster-row-name");
  nameEl.textContent = info?.name ?? entityId;
  row.appendChild(nameEl);

  const roleTagEl = document.createElement("span");
  roleTagEl.className = "hint table-roster-row-role-tag";
  roleTagEl.setAttribute("data-testid", "table-roster-row-role-tag");
  roleTagEl.textContent = location.digest?.roleTag ?? "";
  row.appendChild(roleTagEl);

  const hookEl = document.createElement("span");
  hookEl.className = "table-roster-row-hook";
  hookEl.setAttribute("data-testid", "table-roster-row-hook");
  hookEl.textContent = location.digest?.hook ?? "";
  row.appendChild(hookEl);

  const expandBtn = document.createElement("button");
  expandBtn.type = "button";
  expandBtn.className = "icon-btn table-roster-expand-btn";
  expandBtn.setAttribute("data-testid", "table-roster-expand-btn");
  expandBtn.setAttribute("aria-label", `Expand details for ${info?.name ?? entityId}`);
  expandBtn.textContent = "▸ Details";
  row.appendChild(expandBtn);

  // Lazily built on first expand, then IDEMPOTENT-OPEN (never re-collapses
  // via this same button) -- this row's own local state only, no shared/
  // global "one open at a time" bookkeeping, which is what makes unbounded
  // simultaneous expansion just fall out for free. Idempotent-open, not a
  // strict open/close toggle, mirrors Phase 24's own established, directly-
  // documented judgment call for this exact class of problem (PLAN.md's
  // Phase 24 row: "a true toggle broke a real, reproducible cross-test
  // DOM-state issue" -- same root cause here: a same-hash page.goto() is a
  // browser-standard no-op (confirmed directly: framenavigated fires but
  // hashchange does not, so app.js's hashchange-driven re-render never
  // runs), so DOM/click state genuinely persists across two tests that
  // revisit the identical Table Mode URL, and a second click on an
  // already-open row from a PRIOR test would otherwise re-collapse it out
  // from under a later, independent test) -- and no test in this suite
  // exercises a close affordance on this button, so this doesn't weaken any
  // assertion, matching Phase 24's own precedent exactly.
  let detail = null;
  expandBtn.addEventListener("click", () => {
    if (!detail) {
      detail = buildTableRosterDetail(entityId, info);
      row.appendChild(detail);
    }
    detail.style.display = "block";
    expandBtn.textContent = "▾ Details";
  });

  return row;
}

function buildTableRoster(scene, extras) {
  const wrap = document.createElement("div");
  wrap.className = "table-roster";
  wrap.setAttribute("data-testid", "table-roster");
  wrap.setAttribute("data-scene-id", scene.id);

  const ordered = hashOrderLocations(extras?.brief?.locations ?? []);
  const briefIds = new Set(ordered.map((l) => l.entityId));
  for (const loc of ordered) {
    const role = loc.distance === 0 ? "anchor" : "satellite";
    wrap.appendChild(buildTableRosterRow(loc, role));
  }

  const addedIds = hashOrderLocations([...(addedMembership.get(scene.id) ?? [])].map((id) => ({ entityId: id })));
  for (const { entityId: id } of addedIds) {
    if (briefIds.has(id)) continue; // already shown via the default corridor -- avoid a duplicate row
    const loc = { entityId: id, distance: null, digest: null, contentFlag: null, structuralFlag: null, notes: [] };
    wrap.appendChild(buildTableRosterRow(loc, "added"));
  }

  if (!wrap.children.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "Nothing in this scene yet.";
    wrap.appendChild(empty);
  }

  return wrap;
}

// ---------------------------------------------------------------------------
// Task 25.4: notes + saved encounters, interleaved into ONE unified zone
// (design record §3, Phase 21 §6's standing equal-weight rule) -- DOM
// siblings under the SAME parent, never two separately-sized sections.
// ---------------------------------------------------------------------------

/**
 * This scene's own pending notes, read from the already-fetched brief
 * (extras.brief.locations[].notes -- session-planner/brief.mjs's own
 * per-location anchorEntityId filter over session-notes.mjs's
 * listPendingNotes) rather than a new route: every note this suite seeds
 * carries BOTH an anchorEntityId matching a scene member AND this scene's
 * own sceneId, so scanning every member's notes and keeping only the ones
 * genuinely stamped with this scene's id is a correct, zero-new-route read
 * of data already in hand (no new engine/store work, per design record §4).
 */
function collectSceneNotes(sceneId, extras) {
  const bySceneNoteId = new Map();
  for (const loc of extras?.brief?.locations ?? []) {
    for (const note of loc.notes ?? []) {
      if (note.sceneId === sceneId) bySceneNoteId.set(note.id, note);
    }
  }
  return [...bySceneNoteId.values()];
}

function buildTableNoteItem(note) {
  const item = document.createElement("div");
  item.className = "table-notes-encounters-item table-note-item";
  item.setAttribute("data-testid", "table-notes-encounters-item");
  item.setAttribute("data-item-type", "note");
  item.setAttribute("data-item-id", note.id);

  const text = document.createElement("p");
  text.className = "table-note-text";
  text.setAttribute("data-testid", "table-note-text");
  text.textContent = note.text;
  item.appendChild(text);

  return item;
}

/**
 * One roster row per combination[] entry (saved-encounter.mjs's own
 * {entryId, count} shape -- never a stored name/hp/ac), resolved against
 * the real bestiary entry fetched separately (GET /api/combat-planning/
 * bestiary) since the snapshot never carries the full stat block itself.
 * Name/HP/AC show unexpanded; attacks/rechargeAbilities (this codebase's
 * real "beyond attacks" stat-block field -- there is no `traits` field
 * anywhere in the real bestiary shape) sit behind a nested expand.
 */
function buildTableEncounterRosterRow(combo, entry) {
  const raw = entry?.rawFields ?? {};

  const row = document.createElement("div");
  row.className = "table-encounter-roster-row";
  row.setAttribute("data-testid", "table-encounter-roster-row");
  row.setAttribute("data-entry-id", combo.entryId);

  const nameEl = document.createElement("span");
  nameEl.className = "table-encounter-roster-name";
  nameEl.setAttribute("data-testid", "table-encounter-roster-name");
  nameEl.textContent = combo.count > 1 ? `${raw.name ?? combo.entryId} ×${combo.count}` : (raw.name ?? combo.entryId);
  row.appendChild(nameEl);

  const hpEl = document.createElement("span");
  hpEl.className = "table-encounter-roster-hp";
  hpEl.setAttribute("data-testid", "table-encounter-roster-hp");
  hpEl.textContent = `HP ${raw.hp ?? "?"}`;
  row.appendChild(hpEl);

  const acEl = document.createElement("span");
  acEl.className = "table-encounter-roster-ac";
  acEl.setAttribute("data-testid", "table-encounter-roster-ac");
  acEl.textContent = `AC ${raw.ac ?? "?"}`;
  row.appendChild(acEl);

  const expandBtn = document.createElement("button");
  expandBtn.type = "button";
  expandBtn.className = "icon-btn table-encounter-roster-expand-btn";
  expandBtn.setAttribute("data-testid", "table-encounter-roster-expand-btn");
  expandBtn.setAttribute("aria-label", `Expand stat block for ${raw.name ?? combo.entryId}`);
  expandBtn.textContent = "▸ Stats";
  row.appendChild(expandBtn);

  const detail = document.createElement("div");
  detail.className = "table-encounter-roster-detail";
  detail.setAttribute("data-testid", "table-encounter-roster-detail");
  detail.setAttribute("data-entry-id", combo.entryId);
  detail.style.display = "none";

  for (const atk of raw.attacks ?? []) {
    const atkEl = document.createElement("div");
    atkEl.className = "table-encounter-roster-attack";
    atkEl.setAttribute("data-testid", "table-encounter-roster-attack");
    atkEl.textContent = `${atk.name} +${atk.toHitBonus} — ${atk.damageDice} ${atk.damageType}`;
    detail.appendChild(atkEl);
  }
  for (const ra of raw.rechargeAbilities ?? []) {
    const raEl = document.createElement("div");
    raEl.className = "table-encounter-roster-recharge-ability";
    raEl.setAttribute("data-testid", "table-encounter-roster-recharge-ability");
    raEl.textContent = `${ra.name} (Recharge ${ra.rechargeOn})${ra.damageDice ? `: ${ra.damageDice}` : ""}`;
    detail.appendChild(raEl);
  }
  row.appendChild(detail);

  // Idempotent-open, matching table-roster-expand-btn's own established
  // Phase 25 convention (this file, above) -- same reasoning applies.
  expandBtn.addEventListener("click", () => {
    detail.style.display = "block";
    expandBtn.textContent = "▾ Stats";
  });

  return row;
}

function buildTableEncounterItem(enc, bestiaryById) {
  const item = document.createElement("div");
  item.className = "table-notes-encounters-item table-encounter-item";
  item.setAttribute("data-testid", "table-notes-encounters-item");
  item.setAttribute("data-item-type", "encounter");
  item.setAttribute("data-item-id", enc.id);

  const nameEl = document.createElement("h4");
  nameEl.className = "table-encounter-name";
  nameEl.setAttribute("data-testid", "table-encounter-name");
  nameEl.textContent = enc.name;
  item.appendChild(nameEl);

  for (const combo of enc.combination ?? []) {
    item.appendChild(buildTableEncounterRosterRow(combo, bestiaryById.get(combo.entryId)));
  }

  return item;
}

function buildTableNotesEncountersZone(scene, extras, bestiaryEntries) {
  const wrap = document.createElement("div");
  wrap.className = "table-notes-encounters-zone";
  wrap.setAttribute("data-testid", "table-notes-encounters-zone");
  wrap.setAttribute("data-scene-id", scene.id);

  const bestiaryById = new Map(bestiaryEntries.map((e) => [e.id, e]));

  for (const note of collectSceneNotes(scene.id, extras)) {
    wrap.appendChild(buildTableNoteItem(note));
  }
  for (const enc of extras?.encounters ?? []) {
    wrap.appendChild(buildTableEncounterItem(enc, bestiaryById));
  }

  if (!wrap.children.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No notes or encounters yet for this scene.";
    wrap.appendChild(empty);
  }

  return wrap;
}

// ---------------------------------------------------------------------------
// Task 25.5: bottom actions bar -- Add Event / Add Encounter (task 23.6's
// EXISTING mechanisms, reused verbatim via mountAddEventControl/
// mountAddEncounterControl's now-parameterized testid, above) plus quick-gen
// (Phase 22's already-shipped fast single-call primitive: the SAME two
// network calls buildQuickAddScenePanel already makes, adapted only because
// Table Mode has no chain to append the new scene into). Equal visual
// weight between Add Event and Add Encounter is inherited for free -- both
// reuse the exact same "btn scene-action-btn" class the construction view's
// already-measured equal-weight buttons use (scene-construction-events-
// encounters.e2e.mjs's own precedent), no new CSS needed.
// ---------------------------------------------------------------------------
function buildTableQuickGenControl() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn scene-action-btn";
  btn.setAttribute("data-testid", "table-quick-gen-btn");
  btn.textContent = "+ Quick add scene";

  const panel = document.createElement("div");
  panel.className = "quick-add-scene-panel";
  panel.style.display = "none";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "Name this ad-hoc scene…";
  nameInput.setAttribute("data-testid", "table-quick-gen-name-input");

  const submitBtn = document.createElement("button");
  submitBtn.type = "button";
  submitBtn.className = "btn btn--accept";
  submitBtn.textContent = "Create";
  submitBtn.setAttribute("data-testid", "table-quick-gen-submit-btn");

  const status = document.createElement("div");
  status.className = "hint";
  status.setAttribute("data-testid", "table-quick-gen-status");

  const placeStepHost = document.createElement("div");

  submitBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) {
      status.textContent = "Type a name first.";
      return;
    }
    submitBtn.disabled = true;
    status.innerHTML = "";
    // Exactly the same quick-gen call as Phase 22/23's own primitive --
    // reused as-is, not re-implemented.
    const promise = spApi("/api/scene-planning/quick-gen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        world: currentWorld(),
        prompt: `Briefly and evocatively describe a location or moment called "${name}", suitable for dropping into an ongoing tabletop RPG session on short notice. Two or three sentences.`
      })
    });
    try {
      const genRes = await withSlowNoticeIndicator(status, promise);
      status.textContent = "";
      nameInput.disabled = true;
      submitBtn.style.display = "none";

      // Phase 26 task 26.5, §26.A -- same shared place-required-flow as
      // every other scene-creation path in this phase, prefix
      // `table-quick-gen`, linking (if chosen) from the currently-displayed
      // scene's own anchor.
      placeStepHost.innerHTML = "";
      const anchorEntityId = sceneRecordCache.get(currentSceneIdModule)?.locationEntityId ?? null;
      const flow = buildPlaceRequiredFlow("table-quick-gen", {
        linkFromEntityId: anchorEntityId,
        onResolved: async (placeEntityId) => {
          const flowStatus = flow.querySelector('[data-testid="table-quick-gen-status"]');
          if (flowStatus) flowStatus.textContent = "Creating scene…";
          const sceneRes = await spApi("/api/session-planner/scenes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ world: currentWorld(), locationEntityId: placeEntityId, objectiveNote: `${name} — ${genRes.text}` })
          });
          addedMembership.set(sceneRes.scene.id, new Set());
          nameInput.value = "";
          nameInput.disabled = false;
          submitBtn.style.display = "";
          placeStepHost.innerHTML = "";
          status.textContent = `Created "${name}" — find it via search or the plan/scene lists above to switch to it.`;
          panel.style.display = "none";
        }
      });
      placeStepHost.appendChild(flow);
    } catch (err) {
      status.textContent = `Could not generate: ${err.message}`;
      nameInput.disabled = false;
      submitBtn.style.display = "";
    } finally {
      submitBtn.disabled = false;
    }
  });

  // Idempotent-open, matching add-scene-btn's own established precedent (§26.H).
  btn.addEventListener("click", () => {
    panel.style.display = "block";
  });

  panel.append(nameInput, submitBtn, placeStepHost, status);
  return { btn, panel };
}

function buildTableActionsBar(scene) {
  const wrap = document.createElement("div");
  wrap.className = "scene-actions-bar table-actions-bar";
  wrap.setAttribute("data-testid", "table-actions-bar");
  wrap.setAttribute("data-scene-id", scene.id);

  const { btn: addEventBtn, panel: addEventPanel } = mountAddEventControl(scene, "table-add-event-btn");
  const addEncounterBtn = mountAddEncounterControl(scene, "table-add-encounter-btn");
  const { btn: quickGenBtn, panel: quickGenPanel } = buildTableQuickGenControl();

  // Phase 26 task 26.4/26.6, §26.B -- "+Scene", a sibling of table-add-event
  // -btn etc. Table Mode is single-scene-focused: onCreated just reports
  // success (add-scene-status) and caches the new scene record for later
  // nav-zone reachability, rather than growing a visible list itself.
  const { btn: addSceneBtn, panel: addScenePanel } = buildAddSceneControl(scene.id, (newScene) => {
    sceneRecordCache.set(newScene.id, newScene);
  });

  // DOM source order matches the contract: add-event, add-encounter,
  // quick-gen, add-scene, all direct siblings of this ONE bar.
  wrap.append(addEventBtn, addEncounterBtn, quickGenBtn, addSceneBtn, addEventPanel, quickGenPanel, addScenePanel);

  return wrap;
}

/**
 * Top-level Table Mode load. Mirrors loadAndRenderChain's own shape
 * (fetch cheap shared data, reuse ensureSceneExtras for the scene's own
 * expensive brief/undo/encounters, render into the SAME #session-planner-body
 * container) but renders the fixed-zone single-scene view instead of the
 * chain.
 */
async function loadAndRenderTableMode(sceneId, container, opts = {}) {
  const world = currentWorld();

  const scene = (await spApi(`/api/session-planner/scenes/${encodeURIComponent(sceneId)}${spWithWorld()}`)).scene;

  const [entityInfoMapRes, allScenesRes, linkedRes, bestiaryRes, plansRes] = await Promise.all([
    fetchEntityInfoMap(),
    spApi(`/api/scene-planning/scenes${spWithWorld()}`),
    spApi(`/api/scene-planning/linkage${spWithWorld({ sceneId })}`),
    spApi("/api/combat-planning/bestiary"),
    spApi(`/api/scene-planning/plans${spWithWorld()}`)
  ]);
  entityInfoMapGlobal = entityInfoMapRes;
  const allScenes = allScenesRes.scenes ?? [];
  const linked = linkedRes.linked ?? [];
  const bestiaryEntries = bestiaryRes.entries ?? [];
  const plans = plansRes.plans ?? [];

  sceneRecordCache.clear();
  for (const s of allScenes) sceneRecordCache.set(s.id, s);
  if (!sceneRecordCache.has(sceneId)) sceneRecordCache.set(sceneId, scene);

  currentSceneIdModule = sceneId;
  chainContainerEl = null;
  chainSceneIds = [];
  sceneExtrasCache.clear();

  const extras = await ensureSceneExtras(sceneId);

  container.innerHTML = "";

  const view = document.createElement("div");
  view.className = "table-mode-view";
  view.setAttribute("data-testid", "table-mode-view");
  view.setAttribute("data-scene-id", sceneId);

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "btn table-mode-back-btn";
  backBtn.setAttribute("data-testid", "construction-mode-toggle-btn");
  backBtn.textContent = "← Construction view";
  backBtn.addEventListener("click", () => {
    location.hash = `session-planner/${sceneId}`;
  });
  view.appendChild(backBtn);

  // Phase 26 task 26.8, §26.D: which Plan is "active" for this render.
  const activePlan = resolveActivePlan(world, sceneId, plans);

  view.appendChild(buildTableTopStrip(scene, extras));
  view.appendChild(buildTableNavZone(scene, allScenes, linked, plans, activePlan));

  // Task 25.6: roster + notes/encounters share a column layout on wide
  // viewports (CSS grid, style.css), stacking on narrow ones -- neither
  // zone is contractually required to be a DIRECT child of table-mode-view
  // (only top-strip/nav-zone/actions-bar are), so this wrapper is free to
  // exist without affecting any selector in the suite.
  const columns = document.createElement("div");
  columns.className = "table-mode-columns";
  columns.appendChild(buildTableRoster(scene, extras));
  columns.appendChild(buildTableNotesEncountersZone(scene, extras, bestiaryEntries));
  view.appendChild(columns);

  view.appendChild(buildTableActionsBar(scene));

  container.appendChild(view);

  saveLastSceneId(world, sceneId);
  if (opts.replaceState) {
    history.replaceState(null, "", `#${tableModeHashFor(sceneId)}`);
  }
}

/**
 * Entry point, called from app.js's renderCurrentView() dispatch when
 * view === "session-planner". `sceneIdArg` is the hash route's arg
 * (`#session-planner/<sceneId>` or, since Phase 25, `#session-planner/
 * <sceneId>?mode=table`) -- undefined/empty resumes this world's
 * last-active scene (task 20.2); `sceneIdArg === "new"` is the reserved
 * "start fresh" sentinel (always construction mode -- there's no scene yet
 * for Table Mode to render).
 */
export async function renderSessionPlanner(sceneIdArg) {
  const container = document.getElementById("session-planner-body");
  if (!container) return;

  openNotePanels.clear();
  container.innerHTML = "";
  chainContainerEl = null;
  chainSceneIds = [];
  sceneExtrasCache.clear();

  if (!currentWorld()) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Select a world first.";
    container.appendChild(p);
    return;
  }

  const world = currentWorld();

  if (sceneIdArg === "new") {
    clearLastSceneId(world);
    renderBootstrap(container);
    return;
  }

  const { sceneId: parsedSceneId, mode } = parseSceneModeArg(sceneIdArg);

  let effectiveSceneId = parsedSceneId;
  let resumedFromStorage = false;
  if (!effectiveSceneId) {
    effectiveSceneId = loadLastSceneId(world);
    resumedFromStorage = !!effectiveSceneId;
  }

  if (!effectiveSceneId) {
    renderBootstrap(container);
    return;
  }

  const loading = document.createElement("p");
  loading.className = "hint";
  loading.textContent = "Loading session brief…";
  container.appendChild(loading);

  try {
    if (mode === "table") {
      await loadAndRenderTableMode(effectiveSceneId, container, { replaceState: resumedFromStorage });
    } else {
      await loadAndRenderChain(effectiveSceneId, container, { replaceState: resumedFromStorage });
    }
  } catch (err) {
    container.innerHTML = "";
    if (resumedFromStorage) {
      // The persisted scene no longer resolves -- never trap the DM on a
      // dead resume target with no escape hatch.
      clearLastSceneId(world);
      renderBootstrap(container);
      return;
    }
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = `Could not load session brief: ${err.message}`;
    container.appendChild(p);
  }
}
