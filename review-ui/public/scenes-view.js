// Phase 24 — Scenes tab UI. review-ui/public/scenes-view.js, the
// session-planner-view.js/combat-planning-view.js sibling per
// plans/phase-24-tasks.md task 24.2's own file-organization latitude ("new
// standalone file... or fold into session-planner-view.js if cleaner --
// your call"). Kept as its own file: this is a genuinely different concern
// (world-scoped BROWSE across every scene) from session-planner-view.js's
// per-scene construction/brief surface, and review-ui/test/e2e/
// scenes-tab-browse-and-navigate.e2e.mjs's own header comment already names
// this exact file/route ("imported from a NEW standalone
// review-ui/public/scenes-view.js").
//
// Depends ONLY on already-shipped Phase 22 engine routes (GET
// /api/scene-planning/linkage) plus this phase's own thin addition (GET
// /api/scene-planning/scenes, task 24.1) and the pre-existing GET /api/graph
// entity-name lookup (session-planner-view.js's own fetchEntityInfoMap
// precedent, duplicated here in miniature rather than imported -- this file
// is deliberately standalone, zero imports from app.js or from
// session-planner-view.js, mirroring that file's own "reads
// gmReview.world from localStorage directly" convention exactly).
//
// SEARCH REUSE DECISION (documented per this phase's own instruction to
// record the reasoning either way -- see the DOM-contract test file's own
// header for the full argument): this file does NOT reuse
// session-planner-view.js's buildEntityPicker for the scenes-search-input.
// buildEntityPicker's entire contract is "pick ONE graph entity" (one row
// per entity id); a scene search is scene-shaped, not entity-shaped, since
// two different scenes can legitimately share the same anchor entity (a
// fork lineage, or two independently-planned visits to the same place) --
// that would collide with buildEntityPicker's implicit one-row-per-entity
// assumption. Below is a plain client-side substring filter over an
// already-loaded in-memory scenes array instead.
"use strict";

// ---------------------------------------------------------------------------
// local api/world helpers (deliberately not imported from app.js or from
// session-planner-view.js, mirroring both those files' own standalone
// convention)
// ---------------------------------------------------------------------------
function currentWorld() {
  return localStorage.getItem("gmReview.world") || null;
}

async function svApi(path, opts) {
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

function svWithWorld(params) {
  const p = new URLSearchParams(params || {});
  const w = currentWorld();
  if (w) p.set("world", w);
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

/** Same "one GET /api/graph?filter=all, id -> node map" join
 * session-planner-view.js's own fetchEntityInfoMap already establishes as
 * this project's standard scene-anchor-entity-id -> name lookup -- no new
 * lookup mechanism, just this file's own standalone copy of it (per this
 * file's own "zero imports from session-planner-view.js" convention above). */
async function fetchEntityInfoMap() {
  try {
    const graph = await svApi(`/api/graph${svWithWorld({ filter: "all" })}`);
    const map = new Map();
    for (const n of graph.nodes || []) map.set(n.id, n);
    return map;
  } catch {
    return new Map();
  }
}

function anchorNameFor(scene, entityInfoMap) {
  if (!scene.locationEntityId) return null;
  return entityInfoMap.get(scene.locationEntityId)?.name ?? scene.locationEntityId;
}

// ---------------------------------------------------------------------------
// Linked-scenes inline panel (scene-list-item-linked-toggle ->
// linked-scenes-panel). A separate, explicit "inspect this scene's chain"
// action from scene-list-item-open's "jump into planning it" navigation --
// see this file's sibling DOM-contract test (scenes-tab-linkage.e2e.mjs)
// header for why those two intents must stay independently reachable.
// ---------------------------------------------------------------------------

function renderLinkedSceneItem(entry) {
  const li = document.createElement("li");
  li.className = "linked-scene-item";
  li.setAttribute("data-testid", "linked-scene-item");
  li.setAttribute("data-scene-id", entry.sceneId);

  const nameEl = document.createElement("span");
  nameEl.className = "linked-scene-anchor-name";
  nameEl.setAttribute("data-testid", "linked-scene-anchor-name");
  // linkedScenesForScene already resolves anchorEntityName server-side --
  // no second graph lookup needed for this specific field.
  nameEl.textContent = entry.anchorEntityName ?? entry.anchorEntityId;
  li.appendChild(nameEl);

  const hopEl = document.createElement("span");
  hopEl.className = "hint linked-scene-hop-distance";
  hopEl.setAttribute("data-testid", "linked-scene-hop-distance");
  hopEl.textContent = ` — ${entry.hopDistance} hop${entry.hopDistance === 1 ? "" : "s"} away`;
  li.appendChild(hopEl);

  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "btn btn--ghost";
  openBtn.setAttribute("data-testid", "linked-scene-open");
  openBtn.textContent = "Open";
  openBtn.addEventListener("click", () => {
    // Same real-navigation convention session-planner-view.js's own
    // renderBootstrap onSelect uses (location.hash assignment, not
    // history.replaceState) -- this genuinely leaves the Scenes tab.
    location.hash = `session-planner/${entry.sceneId}`;
  });
  li.appendChild(openBtn);

  return li;
}

/**
 * Opens (never closes) the inline linked-scenes panel for one scene-list
 * item. Deliberately idempotent rather than a strict open/close toggle: each
 * scene-list item owns its OWN panelSlot (independent of every other item),
 * so there is no shared/global "currently open panel" to manage, and no
 * test in this phase's DOM contract exercises a close affordance -- a
 * second click while already open/loading is a safe no-op rather than
 * collapsing a panel the DM may still be reading.
 */
async function toggleLinkedPanel(sceneId, panelSlot) {
  if (panelSlot.querySelector('[data-testid="linked-scenes-panel"]')) return;

  const panel = document.createElement("div");
  panel.className = "linked-scenes-panel";
  panel.setAttribute("data-testid", "linked-scenes-panel");
  panel.setAttribute("data-scene-id", sceneId);
  const loading = document.createElement("div");
  loading.className = "hint";
  loading.textContent = "Loading linked scenes…";
  panel.appendChild(loading);
  panelSlot.appendChild(panel);

  let linked;
  try {
    ({ linked } = await svApi(`/api/scene-planning/linkage${svWithWorld({ sceneId })}`));
  } catch (err) {
    panel.innerHTML = "";
    const errEl = document.createElement("div");
    errEl.className = "hint";
    errEl.textContent = `Could not load linked scenes: ${err.message}`;
    panel.appendChild(errEl);
    return;
  }

  panel.innerHTML = "";

  if (!linked.length) {
    const empty = document.createElement("div");
    empty.setAttribute("data-testid", "linked-scenes-empty");
    empty.className = "hint";
    empty.textContent = "No linked scenes nearby.";
    panel.appendChild(empty);
    return;
  }

  // `linked` arrives from GET /api/scene-planning/linkage ALREADY sorted
  // ascending by hopDistance -- linkedScenesForScene's own documented
  // contract (session-planner/scene-linkage.mjs). Rendered in that exact
  // order below; no client-side re-sort.
  const list = document.createElement("ul");
  list.className = "linked-scenes-list";
  for (const entry of linked) {
    list.appendChild(renderLinkedSceneItem(entry));
  }
  panel.appendChild(list);
}

// ---------------------------------------------------------------------------
// Browse list
// ---------------------------------------------------------------------------

function renderSceneListItem(scene, entityInfoMap) {
  const li = document.createElement("li");
  li.className = "scene-list-item";
  li.setAttribute("data-testid", "scene-list-item");
  li.setAttribute("data-scene-id", scene.id);

  const nameEl = document.createElement("div");
  nameEl.className = "scene-list-item-anchor-name";
  nameEl.setAttribute("data-testid", "scene-list-item-anchor-name");
  const anchorName = anchorNameFor(scene, entityInfoMap);
  nameEl.textContent = anchorName ?? "(no anchor location)";
  li.appendChild(nameEl);

  // Always rendered, even when objectiveNote is null -- this project's own
  // "never blank space, render an explicit empty state" discipline
  // (session-planner-view.js's location-card-digest--empty precedent).
  const objectiveEl = document.createElement("div");
  objectiveEl.className = "scene-list-item-objective hint";
  objectiveEl.setAttribute("data-testid", "scene-list-item-objective");
  objectiveEl.textContent = scene.objectiveNote ?? "(no objective note)";
  li.appendChild(objectiveEl);

  const actions = document.createElement("div");
  actions.className = "scene-list-item-actions";

  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "btn btn--accept";
  openBtn.setAttribute("data-testid", "scene-list-item-open");
  openBtn.textContent = "Open in Session Planner";
  openBtn.addEventListener("click", () => {
    location.hash = `session-planner/${scene.id}`;
  });
  actions.appendChild(openBtn);

  const linkedToggle = document.createElement("button");
  linkedToggle.type = "button";
  linkedToggle.className = "btn btn--ghost";
  linkedToggle.setAttribute("data-testid", "scene-list-item-linked-toggle");
  linkedToggle.textContent = "Linked scenes";
  actions.appendChild(linkedToggle);

  // Phase 27 task 27.8, F1: a TRUE delete -- the scene record, every plan
  // membership, and every scene-link are gone; the place entity survives
  // (session-planner/scenes.mjs's deleteScene cascade, 27.1). Distinct from
  // the plan-first view's own "remove from plan" (unlink-only, below in
  // session-planner-view.js) -- this is the Scenes tab's own affordance,
  // where a scene is genuinely deleted, not just unlinked from one plan.
  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "btn btn--ghost";
  deleteBtn.setAttribute("data-testid", "scene-list-item-delete");
  deleteBtn.setAttribute("data-scene-id", scene.id);
  deleteBtn.textContent = "Delete";
  actions.appendChild(deleteBtn);

  li.appendChild(actions);

  const panelSlot = document.createElement("div");
  panelSlot.className = "scene-list-item-panel-slot";
  li.appendChild(panelSlot);

  linkedToggle.addEventListener("click", () => toggleLinkedPanel(scene.id, panelSlot));

  let confirmPanel = null;
  deleteBtn.addEventListener("click", () => {
    if (confirmPanel) return; // already open -- a second click is a no-op, not a second panel
    confirmPanel = document.createElement("div");
    confirmPanel.className = "scene-list-item-delete-confirm-panel";
    confirmPanel.setAttribute("data-testid", "scene-list-item-delete-confirm-panel");
    confirmPanel.setAttribute("data-scene-id", scene.id);

    const warning = document.createElement("p");
    warning.className = "hint";
    warning.textContent = "Delete this scene entirely? It will be removed from every plan and every scene-link -- the underlying location survives, but this scene itself is gone for good.";
    confirmPanel.appendChild(warning);

    const status = document.createElement("span");
    status.className = "hint";

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "btn btn--accept";
    confirmBtn.setAttribute("data-testid", "scene-list-item-delete-confirm-btn");
    confirmBtn.textContent = "Yes, delete";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn";
    cancelBtn.setAttribute("data-testid", "scene-list-item-delete-cancel-btn");
    cancelBtn.textContent = "Cancel";

    confirmBtn.addEventListener("click", async () => {
      confirmBtn.disabled = true;
      try {
        await svApi(`/api/session-planner/scenes/${encodeURIComponent(scene.id)}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ world: currentWorld() })
        });
        li.remove();
      } catch (err) {
        status.textContent = `Could not delete: ${err.message}`;
        confirmBtn.disabled = false;
      }
    });

    cancelBtn.addEventListener("click", () => {
      confirmPanel.remove();
      confirmPanel = null;
    });

    confirmPanel.append(confirmBtn, cancelBtn, status);
    li.appendChild(confirmPanel);
  });

  return li;
}

function matchesQuery(scene, entityInfoMap, query) {
  if (!query) return true;
  const name = (anchorNameFor(scene, entityInfoMap) ?? "").toLowerCase();
  return name.includes(query);
}

function renderScenesBody(container, scenes, entityInfoMap) {
  container.innerHTML = "";

  const searchWrap = document.createElement("div");
  searchWrap.className = "scenes-search-wrap";
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.placeholder = "Search by location name…";
  searchInput.className = "search-box";
  searchInput.setAttribute("data-testid", "scenes-search-input");
  searchWrap.appendChild(searchInput);
  container.appendChild(searchWrap);

  const listWrap = document.createElement("div");
  container.appendChild(listWrap);

  function renderList(rawQuery) {
    listWrap.innerHTML = "";

    // Empty state (no scenes at all for this world) instead of scenes-list --
    // per the DOM contract, rendered instead of the list, not alongside it.
    if (!scenes.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.setAttribute("data-testid", "scenes-empty-state");
      empty.textContent = "No scenes prepared yet for this world — start one from Plan Session.";
      listWrap.appendChild(empty);
      return;
    }

    const query = (rawQuery || "").trim().toLowerCase();
    const filtered = scenes.filter((s) => matchesQuery(s, entityInfoMap, query));

    const list = document.createElement("ul");
    list.className = "scenes-list";
    list.setAttribute("data-testid", "scenes-list");
    for (const scene of filtered) {
      list.appendChild(renderSceneListItem(scene, entityInfoMap));
    }
    listWrap.appendChild(list);
  }

  // Client-side, over the already-loaded `scenes` array -- no new network
  // round trip per keystroke.
  searchInput.addEventListener("input", () => renderList(searchInput.value));
  renderList("");
}

// ---------------------------------------------------------------------------
// Entry point, called from app.js's renderCurrentView() dispatch when
// view === "scenes". Bare `#scenes` hash, no argument -- world-scoped
// browse, not a per-scene view (unlike #session-planner/<sceneId>).
// ---------------------------------------------------------------------------
export async function renderScenesTab() {
  const container = document.getElementById("scenes-body");
  if (!container) return;

  container.innerHTML = "";

  if (!currentWorld()) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Select a world first.";
    container.appendChild(p);
    return;
  }

  const loading = document.createElement("p");
  loading.className = "hint";
  loading.textContent = "Loading scenes…";
  container.appendChild(loading);

  let scenes, entityInfoMap;
  try {
    [scenes, entityInfoMap] = await Promise.all([
      svApi(`/api/scene-planning/scenes${svWithWorld()}`).then((r) => r.scenes),
      fetchEntityInfoMap()
    ]);
  } catch (err) {
    container.innerHTML = "";
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = `Could not load scenes: ${err.message}`;
    container.appendChild(p);
    return;
  }

  renderScenesBody(container, scenes, entityInfoMap);
}
