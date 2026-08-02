// Phase 17 — Session Planner UI. review-ui/public/session-planner-view.js,
// the graph-view.js sibling per plans/phase-17-tasks.md task 17.2's own
// file-organization question. Renders `GET /api/session-planner/brief`
// (session-planner/brief.mjs, shipped in Phase 16) as a live, annotatable
// surface. Consumes ONLY existing routes (scenes/fork/brief/notes/notes-
// intake, plus the already-shipped GET /api/graph for entity name lookup
// and the reusable type-ahead picker) -- no new server routes anywhere in
// this file, per plans/phase-17-tasks.md's scope statement.
//
// Deliberately standalone (zero imports from app.js), mirroring
// graph-view.js's own established convention of talking to the outside
// world only via plain DOM/fetch, not shared module state -- this keeps
// app.js -> session-planner-view.js a one-directional import, no circular
// module graph. World selection is read directly from the same
// localStorage key app.js itself writes on world-select change
// ("gmReview.world").
//
// task 17.1: nav entry routing target + scene bootstrap flow + the shared
// type-ahead entity picker (also reused by task 17.5's re-center control,
// per that task's own "don't build two combo-box implementations" note).
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
// Task 17.3: inline-expand note autosave. A single small helper module
// (debounced-save.mjs) provides the pure timer logic; this file owns the
// DOM wiring and the open-panel bookkeeping. ONE createFlushableDebounce
// instance per currently-open note editor (per debounced-save.test.mjs's
// own header contract) -- multiple cards' note panels CAN be open at once
// (design record §10 explicitly protects against a rebuild "destroying any
// other inline-expanded note the DM has open elsewhere on the grid"), and
// cross-entity misattribution is prevented STRUCTURALLY (each debounce
// instance's saveFn closure is bound to exactly one entityId/sceneId at
// creation, never reused for a different entity) rather than by only
// allowing one editor open at a time.
// ---------------------------------------------------------------------------
const openNotePanels = new Map(); // entityId -> { panelEl, debounce }

/**
 * Guaranteed flush on navigate (design record §6). Wired into app.js's
 * existing hashchange/renderCurrentView() cancellation step, as a sibling
 * of cancelActiveScan() -- NOT a second navigation-hook mechanism. Safe to
 * call unconditionally on every navigation: each debounce instance's own
 * flush() is a no-op when nothing is pending (debounced-save.test.mjs), so
 * the overwhelmingly common case (no note editor open at all) costs nothing.
 */
export function flushActiveNoteSave() {
  for (const { debounce } of openNotePanels.values()) {
    debounce.flush();
  }
}

// ---------------------------------------------------------------------------
// Shared type-ahead entity picker (task 17.1's scene-bootstrap location
// picker AND task 17.5's re-center picker both use THIS ONE component --
// plans/phase-17-tasks.md 17.5 explicitly says not to build two combo-box
// implementations in one phase). Mirrors app.js's existing
// buildLinkToExistingControl pattern: ONE GET /api/graph?filter=all fetched
// once when the control mounts, every keystroke re-filters that
// already-in-memory list with zero further network round trips.
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

  // Task 20.1: both real call sites of this shared picker (scene-bootstrap
  // location, re-center) are specifically asking "which PLACE", but the
  // untyped initial result list mixed in every entity type. `defaultTypeFilter`
  // narrows the UNTYPED (no search text) result set to that one type -- a
  // DEFAULT, not a hard restriction: the instant the DM types anything, the
  // full `allNodes` set (every type) is searched again, so a genuine
  // non-Place anchor is still just as reachable as before.
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

  // Re-filters using whatever's already loaded -- if this fires before the
  // initial fetch above resolves, the fetch's own renderResults() call (once
  // it lands) re-reads input.value live and produces the correct filtered
  // list anyway, so there's no real race here for the caller to worry about.
  input.addEventListener("input", renderResults);

  return wrap;
}

// ---------------------------------------------------------------------------
// Deterministic non-monotonic render order (design record §3 / phase-17-
// tasks.md 17.2's HARD requirement): never sort by `distance` or anything
// else monotonic. A stable hash of entityId gives an order that's
// uncorrelated with distance AND doesn't reshuffle on every reload of the
// SAME underlying data (friendlier at the table than a fresh Math.random()
// shuffle each render would be), while still satisfying "never chapter
// numbering with the digits filed off."
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
// Location card (task 17.2: anchor/satellite + always-visible digest + two
// independent flag badges). Notes land in task 17.3.
// ---------------------------------------------------------------------------
function renderLocationCard(location, role, entityInfo, sceneId) {
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

  // --- Ambient digest: always visible, unconditionally rendered -- never
  // gated behind a click. `digest: null` gets its own CONSPICUOUS state
  // (never blank space, per design record §4). ---
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

  // --- Two independent flag badges (design record §4): NEVER merged into
  // one combined indicator. Icon/shape-coded (not color-only) since this is
  // explicitly an ambient/improv-use surface, plausibly read at a table in
  // low light. ---
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
  distEl.textContent = role === "anchor"
    ? "On the path"
    : `${location.distance} hop${location.distance === 1 ? "" : "s"} from the path`;
  card.appendChild(distEl);

  // --- Notes footer: a small note-icon affordance, NEVER the entity name
  // itself (design record §5 -- avoids accidental edits while browsing). ---
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

  return card;
}

/** Inline-expand within the row -- no popover, no positioning/clamping code (design record §5). */
function toggleNotePanel(card, location, sceneId) {
  const entityId = location.entityId;

  if (openNotePanels.has(entityId)) {
    const { panelEl, debounce } = openNotePanels.get(entityId);
    debounce.flush(); // guaranteed-flush on manual close too, same safety net as navigate
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

  // Task 17.3: debounce `input` (~500ms), flush immediately on `blur`,
  // guaranteed flush on hashchange via flushActiveNoteSave() above. Save
  // success/error updates ONLY this row's own small status indicator --
  // NEVER calls the container-level rebuild (design record §10: doing so
  // would tear down every card on every blur, including any other
  // inline-expanded note the DM has open elsewhere on the grid).
  const debounce = createFlushableDebounce((value) => {
    if (!value || !value.trim()) return; // zero-ceremony, but don't POST an empty note
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
// Task 17.5: re-center race guard. Single shared, replaced-on-every-
// invocation abort slot, mirroring app.js's activeScanController exactly.
// ---------------------------------------------------------------------------
let activeRecenterController = null;

export function cancelActiveRecenter() {
  if (activeRecenterController) {
    activeRecenterController.abort();
    activeRecenterController = null;
  }
}

// ---------------------------------------------------------------------------
// Task 17.4: beyond-corridor summary -- two SEPARATE figures, never summed.
// Collapsed by default (a plain <details>/<summary> gives free, JS-free
// collapse/expand -- design record §11 correctly leaves this reactive-only,
// no proactive e2e test needed).
// ---------------------------------------------------------------------------
function renderBeyondCorridorSummary(beyondCorridor) {
  const wrap = document.createElement("details");
  wrap.className = "beyond-corridor-summary";
  wrap.setAttribute("data-testid", "beyond-corridor-summary");

  const summary = document.createElement("summary");
  summary.textContent = "Beyond this corridor";
  wrap.appendChild(summary);

  const body = document.createElement("div");
  body.className = "beyond-corridor-body";

  const contentP = document.createElement("p");
  contentP.setAttribute("data-testid", "beyond-corridor-content-count");
  const contentCount = beyondCorridor?.contentReadinessCount ?? 0;
  contentP.textContent = `${contentCount} ${contentCount === 1 ? "entity" : "entities"} beyond the corridor still need content.`;
  body.appendChild(contentP);

  const structP = document.createElement("p");
  structP.setAttribute("data-testid", "beyond-corridor-structural-count");
  const structCount = beyondCorridor?.structuralUnderConnectionCount ?? 0;
  structP.textContent = `${structCount} ${structCount === 1 ? "entity is" : "entities are"} beyond the corridor and thinly connected.`;
  body.appendChild(structP);

  wrap.appendChild(body);
  return wrap;
}

// ---------------------------------------------------------------------------
// Task 17.5: re-center control. Type-ahead/search-as-you-select (never a
// plain <select>), reusing buildEntityPicker above. Race guard: the shared
// activeRecenterController slot (abort any earlier in-flight sequence
// first) PLUS disabling only the specific clicked option button for the
// duration of ITS OWN fetch, as defense-in-depth on top of (never instead
// of) the abort guard.
// ---------------------------------------------------------------------------
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
  cancelActiveRecenter(); // abort any earlier still-in-flight recenter sequence first
  const controller = new AbortController();
  activeRecenterController = controller;

  btn.disabled = true; // defense-in-depth ON TOP OF the abort guard, not instead of it
  statusEl.textContent = "Recentering…";

  try {
    const forkRes = await spApi(`/api/session-planner/scenes/${encodeURIComponent(sceneId)}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld(), locationEntityId: entity.id }),
      signal: controller.signal
    });
    const newSceneId = forkRes.scene.id;
    const briefRes = await spApi(`/api/session-planner/brief${spWithWorld({ sceneId: newSceneId })}`, {
      signal: controller.signal
    });

    statusEl.textContent = "";
    if (activeRecenterController === controller) activeRecenterController = null;
    onRecentered(newSceneId, briefRes.brief);
  } catch (err) {
    if (err.name === "AbortError") return; // superseded by a later click/navigation -- deliberate, not a real failure
    statusEl.textContent = `Recenter failed: ${err.message}`;
  } finally {
    btn.disabled = false;
    if (activeRecenterController === controller) activeRecenterController = null;
  }
}

// ---------------------------------------------------------------------------
// Task 17.1: empty-state scene bootstrap.
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
        // A genuine navigation (empty state -> a real scene) -- goes
        // through the hash router like every other view transition in this
        // app.
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
// Task 17.1/17.2: full-container rebuild of the brief. Matches every other
// view's convention (renderQueue, renderReview, etc.) -- no virtualization,
// a few hundred DOM nodes for a normal corridor size is trivially cheap.
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

function renderBriefBody(container, brief, entityInfoMap, sceneId) {
  container.innerHTML = "";

  const grid = document.createElement("div");
  grid.className = "session-planner-grid";
  const ordered = hashOrderLocations(brief.locations ?? []);
  for (const loc of ordered) {
    const role = loc.distance === 0 ? "anchor" : "satellite";
    grid.appendChild(renderLocationCard(loc, role, entityInfoMap.get(loc.entityId), sceneId));
  }
  container.appendChild(grid);

  if (!ordered.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "Nothing found in the corridor around this scene yet.";
    container.appendChild(empty);
  }

  container.appendChild(renderBeyondCorridorSummary(brief.beyondCorridor));

  container.appendChild(buildRecenterControl(sceneId, (newSceneId, newBrief) => {
    // Re-center replaces the rendered brief directly -- NOT via the hash
    // router (avoids a redundant GET .../brief round trip triggered by our
    // own hashchange listener). history.replaceState keeps the URL bar/
    // bookmark/reload behavior correct WITHOUT firing a hashchange event.
    history.replaceState(null, "", `#session-planner/${newSceneId}`);
    openNotePanels.clear(); // old cards (and their debounce instances) are gone
    renderBriefBody(container, newBrief, entityInfoMap, newSceneId);
  }));
}

/**
 * Entry point, called from app.js's renderCurrentView() dispatch when
 * view === "session-planner". `sceneIdArg` is the hash route's arg
 * (`#session-planner/<sceneId>`) -- undefined/empty means "no scene yet",
 * the task 17.1 bootstrap flow.
 */
export async function renderSessionPlanner(sceneIdArg) {
  const container = document.getElementById("session-planner-body");
  if (!container) return;

  // Any navigation into (or within) this view starts from a clean slate --
  // old open note panels belong to DOM nodes about to be discarded.
  openNotePanels.clear();
  container.innerHTML = "";

  if (!currentWorld()) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Select a world first.";
    container.appendChild(p);
    return;
  }

  if (!sceneIdArg) {
    renderBootstrap(container);
    return;
  }

  const loading = document.createElement("p");
  loading.className = "hint";
  loading.textContent = "Loading session brief…";
  container.appendChild(loading);

  let brief, entityInfoMap;
  try {
    [brief, entityInfoMap] = await Promise.all([
      spApi(`/api/session-planner/brief${spWithWorld({ sceneId: sceneIdArg })}`).then((r) => r.brief),
      fetchEntityInfoMap()
    ]);
  } catch (err) {
    container.innerHTML = "";
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = `Could not load session brief: ${err.message}`;
    container.appendChild(p);
    return;
  }

  renderBriefBody(container, brief, entityInfoMap, sceneIdArg);
}
