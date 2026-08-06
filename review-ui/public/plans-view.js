// Phase 28 task 28.2 -- Navigation spine: the Plan shelf (`#plans`) and Plan
// detail (`#plans/<planId>`) views, plus two reusable, EXPORTED building
// blocks task 28.3 (the Scene page) is expected to reuse rather than
// reinvent: `showUndoToast` (the shared generic undo-toast pattern, contract
// Decision 3) and `mountEditableList` (ghost-row add, hover-x remove + undo,
// up/down reorder, click-to-open -- contract §D). See
// review-ui/test/e2e/phase28-fixture.mjs §1/§2/§3 for the full DOM/route
// contract this file implements to VERBATIM.
//
// Deliberately standalone (zero imports from app.js or from
// session-planner-view.js/scenes-view.js), mirroring those files' own
// established convention exactly -- world selection is read directly from
// the same localStorage key app.js itself writes on world-select change
// ("gmReview.world"). buildEntityPicker below is a deliberate DUPLICATE of
// session-planner-view.js's own component (not an import -- that file is
// off-limits for this task, and every existing view file already follows
// this same "standalone, own copy" convention: scenes-view.js's own header
// documents the identical tradeoff for fetchEntityInfoMap).
"use strict";

// ---------------------------------------------------------------------------
// local api/world helpers (deliberately not imported from app.js or any
// sibling view file, mirroring scenes-view.js/session-planner-view.js's own
// standalone convention)
// ---------------------------------------------------------------------------
function currentWorld() {
  return localStorage.getItem("gmReview.world") || null;
}

async function plApi(path, opts) {
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

function plWithWorld(params) {
  const p = new URLSearchParams(params || {});
  const w = currentWorld();
  if (w) p.set("world", w);
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

/** Same "one GET /api/graph?filter=all, id -> node map" join every sibling view file already establishes as this project's standard entity-id -> name lookup (session-planner-view.js's fetchEntityInfoMap, duplicated here per this file's own standalone convention). */
async function fetchEntityInfoMap() {
  try {
    const graph = await plApi(`/api/graph${plWithWorld({ filter: "all" })}`);
    const map = new Map();
    for (const n of graph.nodes || []) map.set(n.id, n);
    return map;
  } catch {
    return new Map();
  }
}

/** Verbatim mirror of session-planner-view.js's own resolveSceneDisplayName: a scene's own bespoke name wins; falls back to its anchor place's real name; falls back to its objective note; falls back to "Ad-hoc scene". */
function resolveSceneDisplayName(scene, entityInfoMap) {
  if (scene.name) return scene.name;
  if (scene.locationEntityId) {
    return entityInfoMap.get(scene.locationEntityId)?.name ?? scene.locationEntityId;
  }
  return scene.objectiveNote || "Ad-hoc scene";
}

// ---------------------------------------------------------------------------
// Shared type-ahead entity picker -- a duplicate of session-planner-view.js's
// buildEntityPicker (same shape/testid-prefix mechanism), used by both place
// pickers in the add-scene ghost-row flow below.
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
      const graph = await plApi(`/api/graph${plWithWorld({ filter: "all" })}`);
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
// Contract Decision 3 -- shared, generic undo toast. At most one live at a
// time (a second remove replaces it -- "latest wins"). Appends into the
// EXISTING #toast-container (index.html, already positioned/styled), reusing
// its infrastructure rather than adding a second toast host. EXPORTED for
// 28.3's own scene-element removal to reuse verbatim.
// ---------------------------------------------------------------------------
let currentUndoToastEl = null;

export function showUndoToast(message, undoFn, { testid = "undo-toast" } = {}) {
  const container = document.getElementById("toast-container");
  if (!container) return;

  if (currentUndoToastEl) {
    currentUndoToastEl.remove();
    currentUndoToastEl = null;
  }

  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("data-testid", testid);

  const msg = document.createElement("span");
  msg.textContent = message;
  el.appendChild(msg);

  const undoBtn = document.createElement("a");
  undoBtn.textContent = "Undo";
  undoBtn.setAttribute("data-testid", "undo-toast-undo-btn");
  undoBtn.addEventListener("click", async () => {
    el.remove();
    if (currentUndoToastEl === el) currentUndoToastEl = null;
    await undoFn();
  });
  el.appendChild(undoBtn);

  container.appendChild(el);
  currentUndoToastEl = el;
  setTimeout(() => {
    if (currentUndoToastEl === el) {
      el.remove();
      currentUndoToastEl = null;
    }
  }, 20000);
}

// ---------------------------------------------------------------------------
// Contract §D -- ONE reusable helper: ghost-row add, hover-x remove + undo
// toast, up/down reorder, click-to-open. Instantiated below for
// plan-scene-rows; EXPORTED so 28.3 can instantiate it again for
// scene-element rows without a second implementation of this same shape.
//
// Deliberately data-driven, not DOM-driven: every mutating action
// (reorder/remove/restore) re-fetches the authoritative item list via
// `fetchItems` and does a full re-render, matching this project's
// established "server is the source of truth, re-render from a fresh fetch"
// convention (session-planner-view.js's refreshMembersGrid, scenes-view.js's
// renderScenesBody) rather than hand-patching DOM state.
//
// @param {object} opts
// @param {HTMLElement} opts.container        cleared and rebuilt on every render
// @param {() => Promise<object[]>} opts.fetchItems   returns items in their real, current order
// @param {(item:object) => string} opts.getId
// @param {string} opts.idAttrName             e.g. "data-scene-id" -- stamped on each row/its open/remove buttons
// @param {string} opts.listTestid             wrapper testid when items.length > 0
// @param {string} opts.rowTestid              per-row testid; -open-btn/-up-btn/-down-btn/-remove-btn are derived
// @param {string} opts.emptyTestid            wrapper testid when items.length === 0 (contains ONLY the ghost row)
// @param {object} [opts.dataAttrs]            extra data-* attrs stamped on the list/empty wrapper (e.g. {"data-plan-id": id})
// @param {(item:object, bodyEl:HTMLElement, index:number) => void} opts.renderRowBody
// @param {(item:object) => void} [opts.onOpen]              omit to disable open-btn/click-to-open entirely
// @param {(items:object[], fromIndex:number, toIndex:number) => Promise<void>} [opts.onReorder]   omit to disable up/down entirely
// @param {(item:object) => Promise<void>} [opts.onRemove]   omit to disable remove entirely
// @param {(item:object) => Promise<void>} [opts.onRestore]  called by the undo toast's Undo button; omit to suppress the toast
// @param {string} opts.ghostTestid
// @param {object} [opts.ghostDataAttrs]
// @param {(panelHost:HTMLElement, ctrl:{refresh:() => Promise<void>}) => void} opts.buildGhostPanel
// @returns {{refresh: () => Promise<void>}}
// ---------------------------------------------------------------------------
export function mountEditableList(opts) {
  const {
    container,
    fetchItems,
    getId,
    idAttrName,
    listTestid,
    rowTestid,
    emptyTestid,
    dataAttrs = {},
    renderRowBody,
    onOpen,
    onReorder,
    onRemove,
    onRestore,
    ghostTestid,
    ghostDataAttrs = {},
    buildGhostPanel
  } = opts;

  function applyDataAttrs(el, attrs) {
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  }

  async function refresh() {
    const items = await fetchItems();
    render(items);
  }

  function render(items) {
    container.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "editable-list";
    wrap.setAttribute("data-testid", items.length ? listTestid : emptyTestid);
    applyDataAttrs(wrap, dataAttrs);
    container.appendChild(wrap);

    for (let i = 0; i < items.length; i++) {
      wrap.appendChild(buildRow(items, i));
    }

    wrap.appendChild(buildGhostRow());
  }

  function buildRow(items, index) {
    const item = items[index];
    const row = document.createElement("div");
    row.className = "editable-list-row";
    row.setAttribute("data-testid", rowTestid);
    row.setAttribute(idAttrName, getId(item));
    row.setAttribute("data-order", String(index));

    if (onOpen) {
      row.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        onOpen(item);
      });
      row.classList.add("editable-list-row--openable");
    }

    const body = document.createElement("div");
    body.className = "editable-list-row-body";
    renderRowBody(item, body, index);
    row.appendChild(body);

    const controls = document.createElement("div");
    controls.className = "editable-list-row-controls";

    if (onOpen) {
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "btn btn--ghost";
      openBtn.setAttribute("data-testid", `${rowTestid}-open-btn`);
      openBtn.setAttribute(idAttrName, getId(item));
      openBtn.textContent = "Open";
      openBtn.addEventListener("click", () => onOpen(item));
      controls.appendChild(openBtn);
    }

    if (onReorder) {
      if (index > 0) {
        const upBtn = document.createElement("button");
        upBtn.type = "button";
        upBtn.className = "icon-btn editable-list-row-reorder-btn";
        upBtn.setAttribute("data-testid", `${rowTestid}-up-btn`);
        upBtn.title = "Move up";
        upBtn.textContent = "↑";
        upBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          upBtn.disabled = true;
          try {
            await onReorder(items, index, index - 1);
            await refresh();
          } catch (err) {
            upBtn.disabled = false;
          }
        });
        controls.appendChild(upBtn);
      }
      if (index < items.length - 1) {
        const downBtn = document.createElement("button");
        downBtn.type = "button";
        downBtn.className = "icon-btn editable-list-row-reorder-btn";
        downBtn.setAttribute("data-testid", `${rowTestid}-down-btn`);
        downBtn.title = "Move down";
        downBtn.textContent = "↓";
        downBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          downBtn.disabled = true;
          try {
            await onReorder(items, index, index + 1);
            await refresh();
          } catch (err) {
            downBtn.disabled = false;
          }
        });
        controls.appendChild(downBtn);
      }
    }

    if (onRemove) {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "icon-btn editable-list-row-remove";
      removeBtn.setAttribute("data-testid", `${rowTestid}-remove-btn`);
      removeBtn.setAttribute(idAttrName, getId(item));
      removeBtn.title = "Remove";
      removeBtn.textContent = "✕";
      removeBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        removeBtn.disabled = true;
        try {
          await onRemove(item);
          await refresh();
          if (onRestore) {
            showUndoToast("Removed.", async () => {
              await onRestore(item);
              await refresh();
            });
          }
        } catch (err) {
          removeBtn.disabled = false;
        }
      });
      controls.appendChild(removeBtn);
    }

    row.appendChild(controls);
    return row;
  }

  function buildGhostRow() {
    const ghost = document.createElement("div");
    ghost.className = "editable-list-ghost-row";
    ghost.setAttribute("data-testid", ghostTestid);
    applyDataAttrs(ghost, ghostDataAttrs);

    const label = document.createElement("span");
    label.className = "editable-list-ghost-row-label";
    label.textContent = "+ Add";
    ghost.appendChild(label);

    const panelHost = document.createElement("div");
    let opened = false;

    ghost.addEventListener("click", () => {
      if (opened) return;
      opened = true;
      label.style.display = "none";
      buildGhostPanel(panelHost, { refresh });
    });

    ghost.appendChild(panelHost);
    return ghost;
  }

  refresh();
  return { refresh };
}

// ---------------------------------------------------------------------------
// Ghost add-scene panel (contract §2's "Ghost-row add-scene, ALWAYS
// present"). Mirrors session-planner-view.js's buildPlaceRequiredFlow shape
// (mode toggle -> existing/new place -> [new-place only] contained-in step)
// but under this contract's own testid prefixes and ending in a real
// scene-create + attach-to-plan, not that file's own scene-to-scene link
// mechanism.
// ---------------------------------------------------------------------------
export function buildAddScenePanel(planId, { onSceneAdded }) {
  const panel = document.createElement("div");
  panel.className = "place-required-flow";
  panel.setAttribute("data-testid", "plan-add-scene-panel");
  panel.setAttribute("data-plan-id", planId);

  const status = document.createElement("div");
  status.className = "hint";
  status.setAttribute("data-testid", "plan-add-scene-status");

  const modeBar = document.createElement("div");
  modeBar.className = "place-mode-bar";
  const existingModeBtn = document.createElement("button");
  existingModeBtn.type = "button";
  existingModeBtn.className = "link-btn place-mode-btn place-mode-btn--active";
  existingModeBtn.setAttribute("data-testid", "plan-add-scene-place-mode-existing-btn");
  existingModeBtn.textContent = "Pick existing place";
  const newModeBtn = document.createElement("button");
  newModeBtn.type = "button";
  newModeBtn.className = "link-btn place-mode-btn";
  newModeBtn.setAttribute("data-testid", "plan-add-scene-place-mode-new-btn");
  newModeBtn.textContent = "Create new place";
  modeBar.append(existingModeBtn, newModeBtn);

  const existingSubpanel = document.createElement("div");
  existingSubpanel.className = "place-subpanel";
  const newSubpanel = document.createElement("div");
  newSubpanel.className = "place-subpanel";
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

  const containedInHost = document.createElement("div");

  async function createSceneAndAttach(placeEntityId) {
    status.textContent = "Creating scene…";
    try {
      const sceneRes = await plApi("/api/session-planner/scenes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld(), locationEntityId: placeEntityId })
      });
      await plApi(`/api/scene-planning/plans/${encodeURIComponent(planId)}/scenes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld(), sceneId: sceneRes.scene.id })
      });
      status.textContent = "";
      await onSceneAdded();
    } catch (err) {
      status.textContent = `Could not add scene: ${err.message}`;
    }
  }

  function offerContainedIn(newPlaceEntityId) {
    containedInHost.innerHTML = "";
    const step = document.createElement("div");
    step.className = "link-step";
    step.setAttribute("data-testid", "plan-add-scene-contained-in-step");
    step.setAttribute("data-place-entity-id", newPlaceEntityId);

    const prompt = document.createElement("span");
    prompt.className = "hint";
    prompt.textContent = "Contained in an existing place?";
    step.appendChild(prompt);

    const yesBtn = document.createElement("button");
    yesBtn.type = "button";
    yesBtn.className = "btn";
    yesBtn.setAttribute("data-testid", "plan-add-scene-contained-in-yes-btn");
    yesBtn.textContent = "Yes, pick a container…";

    const noBtn = document.createElement("button");
    noBtn.type = "button";
    noBtn.className = "link-btn";
    noBtn.setAttribute("data-testid", "plan-add-scene-contained-in-no-btn");
    noBtn.textContent = "No, leave it floating";

    const pickerHost = document.createElement("div");

    yesBtn.addEventListener("click", () => {
      if (pickerHost.childElementCount) return; // already opened
      yesBtn.disabled = true;
      noBtn.disabled = true;

      let pickedContainerId = null;
      const picker = buildEntityPicker({
        testidPrefix: "plan-add-scene-contained-in",
        placeholder: "Search for a containing place…",
        defaultTypeFilter: "place",
        excludeId: newPlaceEntityId,
        onSelect: (entity) => {
          pickedContainerId = entity.id;
          status.textContent = `Selected "${entity.name}" — click Confirm to link containment.`;
          confirmBtn.disabled = false;
        }
      });
      pickerHost.appendChild(picker);

      const confirmBtn = document.createElement("button");
      confirmBtn.type = "button";
      confirmBtn.className = "btn btn--accept";
      confirmBtn.setAttribute("data-testid", "plan-add-scene-contained-in-confirm-btn");
      confirmBtn.textContent = "Confirm containment";
      confirmBtn.disabled = true;
      confirmBtn.addEventListener("click", async () => {
        if (!pickedContainerId) return;
        confirmBtn.disabled = true;
        status.textContent = "Linking containment…";
        try {
          await plApi("/api/graph/edges", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              world: currentWorld(),
              sourceId: newPlaceEntityId,
              targetId: pickedContainerId,
              relationshipType: "containment"
            })
          });
          status.textContent = "";
          await createSceneAndAttach(newPlaceEntityId);
        } catch (err) {
          status.textContent = `Could not link containment: ${err.message}`;
          confirmBtn.disabled = false;
        }
      });
      pickerHost.appendChild(confirmBtn);
    });

    noBtn.addEventListener("click", async () => {
      yesBtn.disabled = true;
      noBtn.disabled = true;
      await createSceneAndAttach(newPlaceEntityId);
    });

    step.append(yesBtn, noBtn, pickerHost);
    containedInHost.appendChild(step);
  }

  const existingPicker = buildEntityPicker({
    testidPrefix: "plan-add-scene-place",
    placeholder: "Search for an existing place…",
    defaultTypeFilter: "place",
    onSelect: (entity) => createSceneAndAttach(entity.id)
  });
  existingSubpanel.appendChild(existingPicker);

  const newNameInput = document.createElement("input");
  newNameInput.type = "text";
  newNameInput.setAttribute("data-testid", "plan-add-scene-new-place-name-input");
  newNameInput.placeholder = "New place name…";
  const newSubmitBtn = document.createElement("button");
  newSubmitBtn.type = "button";
  newSubmitBtn.className = "btn";
  newSubmitBtn.setAttribute("data-testid", "plan-add-scene-new-place-submit-btn");
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
      const result = await plApi("/api/graph/nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld(), name, type: "place" })
      });
      status.textContent = "";
      offerContainedIn(result.entityId);
    } catch (err) {
      status.textContent = `Could not create place: ${err.message}`;
    } finally {
      newSubmitBtn.disabled = false;
    }
  });
  newSubpanel.append(newNameInput, newSubmitBtn);

  panel.append(modeBar, existingSubpanel, newSubpanel, containedInHost, status);
  return panel;
}

// ---------------------------------------------------------------------------
// #plans -- the plan shelf (contract §1)
// ---------------------------------------------------------------------------

function mountNewPlanControl(host, onCreated) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn--accept";
  btn.setAttribute("data-testid", "new-plan-btn");
  btn.textContent = "+ New Plan";

  const panel = document.createElement("div");
  panel.className = "place-required-flow";
  panel.setAttribute("data-testid", "new-plan-panel");
  panel.style.display = "none";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.setAttribute("data-testid", "new-plan-name-input");
  nameInput.placeholder = "Plan name…";

  const submitBtn = document.createElement("button");
  submitBtn.type = "button";
  submitBtn.className = "btn btn--accept";
  submitBtn.setAttribute("data-testid", "new-plan-submit-btn");
  submitBtn.textContent = "Create";

  const status = document.createElement("div");
  status.className = "hint";
  status.setAttribute("data-testid", "new-plan-status");

  btn.addEventListener("click", () => {
    panel.style.display = panel.style.display === "none" ? "" : "none";
  });

  submitBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) {
      status.textContent = "Type a name first.";
      return;
    }
    submitBtn.disabled = true;
    status.textContent = "Creating…";
    try {
      const { plan } = await plApi("/api/scene-planning/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld(), name })
      });
      status.textContent = "";
      // "the 'open it and start adding scenes' flow this suite treats as the
      // natural next step" (phase28-fixture.mjs §1) -- straight to the new
      // plan's own detail view, not back to the shelf.
      onCreated?.(plan);
      location.hash = `plans/${plan.id}`;
    } catch (err) {
      status.textContent = `Could not create plan: ${err.message}`;
      submitBtn.disabled = false;
    }
  });

  panel.append(nameInput, submitBtn, status);
  host.append(btn, panel);
}

function renderShelfItem(plan, li) {
  li.className = "plan-shelf-item";
  li.setAttribute("data-testid", "plan-shelf-item");
  li.setAttribute("data-plan-id", plan.id);
  li.innerHTML = "";

  const nameEl = document.createElement("div");
  nameEl.className = "plan-shelf-name";
  nameEl.setAttribute("data-testid", "plan-shelf-name");
  nameEl.textContent = plan.name || "(untitled plan)";
  li.appendChild(nameEl);

  const countEl = document.createElement("div");
  countEl.className = "hint plan-shelf-scene-count";
  countEl.setAttribute("data-testid", "plan-shelf-scene-count");
  const n = plan.sceneIds.length;
  countEl.textContent = `${n} scene${n === 1 ? "" : "s"}`;
  li.appendChild(countEl);

  const actions = document.createElement("div");
  actions.className = "plan-shelf-actions";

  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "btn btn--accept";
  openBtn.setAttribute("data-testid", "plan-shelf-open-btn");
  openBtn.setAttribute("data-plan-id", plan.id);
  openBtn.textContent = "Open";
  openBtn.addEventListener("click", () => {
    location.hash = `plans/${plan.id}`;
  });
  actions.appendChild(openBtn);

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "btn btn--ghost";
  deleteBtn.setAttribute("data-testid", "plan-shelf-delete-btn");
  deleteBtn.setAttribute("data-plan-id", plan.id);
  deleteBtn.textContent = "Delete";
  actions.appendChild(deleteBtn);

  li.appendChild(actions);

  let confirmPanel = null;
  deleteBtn.addEventListener("click", () => {
    if (confirmPanel) return; // already open -- a second click is a no-op, not a second panel
    confirmPanel = document.createElement("div");
    confirmPanel.className = "confirm-panel";
    confirmPanel.setAttribute("data-testid", "plan-shelf-delete-confirm-panel");
    confirmPanel.setAttribute("data-plan-id", plan.id);

    const warning = document.createElement("p");
    warning.className = "hint";
    warning.textContent = "Delete this plan? Its scenes are untouched and stay reachable from the Scenes tab.";
    confirmPanel.appendChild(warning);

    const status = document.createElement("span");
    status.className = "hint";

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "btn btn--accept";
    confirmBtn.setAttribute("data-testid", "plan-shelf-delete-confirm-btn");
    confirmBtn.textContent = "Yes, delete";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn";
    cancelBtn.setAttribute("data-testid", "plan-shelf-delete-cancel-btn");
    cancelBtn.textContent = "Cancel";

    confirmBtn.addEventListener("click", async () => {
      confirmBtn.disabled = true;
      try {
        await plApi(`/api/scene-planning/plans/${encodeURIComponent(plan.id)}`, {
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
}

async function renderShelfList(host) {
  host.innerHTML = "";
  const loading = document.createElement("p");
  loading.className = "hint";
  loading.textContent = "Loading plans…";
  host.appendChild(loading);

  let plans;
  try {
    ({ plans } = await plApi(`/api/scene-planning/plans${plWithWorld()}`));
  } catch (err) {
    host.innerHTML = "";
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = `Could not load plans: ${err.message}`;
    host.appendChild(p);
    return;
  }

  host.innerHTML = "";

  if (!plans.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.setAttribute("data-testid", "plans-empty-state");
    empty.textContent = "No plans yet — start one above.";
    host.appendChild(empty);
    return;
  }

  const list = document.createElement("ul");
  list.className = "plans-shelf-list";
  list.setAttribute("data-testid", "plans-shelf");
  for (const plan of plans) {
    const li = document.createElement("li");
    renderShelfItem(plan, li);
    list.appendChild(li);
  }
  host.appendChild(list);
}

async function renderPlansShelf(container) {
  container.innerHTML = "";
  if (!currentWorld()) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Select a world first.";
    container.appendChild(p);
    return;
  }

  const newPlanHost = document.createElement("div");
  container.appendChild(newPlanHost);
  mountNewPlanControl(newPlanHost);

  const listHost = document.createElement("div");
  container.appendChild(listHost);
  await renderShelfList(listHost);
}

// ---------------------------------------------------------------------------
// #plans/<planId> -- plan detail (contract §2)
// ---------------------------------------------------------------------------

async function renderPlanDetail(container, planId) {
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
  loading.textContent = "Loading plan…";
  container.appendChild(loading);

  let plan;
  try {
    ({ plan } = await plApi(`/api/scene-planning/plans/${encodeURIComponent(planId)}${plWithWorld()}`));
  } catch {
    container.innerHTML = "";
    const notFound = document.createElement("div");
    notFound.className = "empty-state";
    notFound.setAttribute("data-testid", "plan-detail-not-found");
    notFound.textContent = `No plan found for "${planId}".`;
    container.appendChild(notFound);
    return;
  }

  container.innerHTML = "";

  const root = document.createElement("div");
  root.setAttribute("data-testid", "plan-detail");
  root.setAttribute("data-plan-id", plan.id);
  container.appendChild(root);

  const nameEl = document.createElement("h2");
  nameEl.setAttribute("data-testid", "plan-detail-name");
  nameEl.textContent = plan.name || "(untitled plan)";
  root.appendChild(nameEl);

  const listHost = document.createElement("div");
  root.appendChild(listHost);

  async function fetchItems() {
    const { plan: freshPlan } = await plApi(`/api/scene-planning/plans/${encodeURIComponent(plan.id)}${plWithWorld()}`);
    const entityInfoMap = await fetchEntityInfoMap();
    const scenes = await Promise.all(
      freshPlan.sceneIds.map((sceneId) =>
        plApi(`/api/session-planner/scenes/${encodeURIComponent(sceneId)}${plWithWorld()}`).then((r) => r.scene)
      )
    );
    for (const scene of scenes) scene.__displayName = resolveSceneDisplayName(scene, entityInfoMap);
    return scenes;
  }

  mountEditableList({
    container: listHost,
    fetchItems,
    getId: (s) => s.id,
    idAttrName: "data-scene-id",
    listTestid: "plan-scene-list",
    rowTestid: "plan-scene-row",
    emptyTestid: "plan-empty-state",
    dataAttrs: { "data-plan-id": plan.id },
    renderRowBody(scene, bodyEl) {
      const nameSpan = document.createElement("span");
      nameSpan.className = "plan-scene-row-name";
      nameSpan.setAttribute("data-testid", "plan-scene-row-name");
      nameSpan.textContent = scene.__displayName;
      bodyEl.appendChild(nameSpan);
    },
    onOpen(scene) {
      location.hash = `session-planner/${scene.id}`;
    },
    async onReorder(items, fromIndex, toIndex) {
      const newIds = items.map((s) => s.id);
      [newIds[fromIndex], newIds[toIndex]] = [newIds[toIndex], newIds[fromIndex]];
      await plApi(`/api/scene-planning/plans/${encodeURIComponent(plan.id)}/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld(), sceneIds: newIds })
      });
    },
    async onRemove(scene) {
      await plApi(`/api/scene-planning/plans/${encodeURIComponent(plan.id)}/scenes/${encodeURIComponent(scene.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld() })
      });
    },
    async onRestore(scene) {
      await plApi(`/api/scene-planning/plans/${encodeURIComponent(plan.id)}/scenes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld(), sceneId: scene.id })
      });
    },
    ghostTestid: "plan-add-scene-row",
    ghostDataAttrs: { "data-plan-id": plan.id },
    buildGhostPanel(panelHost, { refresh }) {
      const panel = buildAddScenePanel(plan.id, {
        onSceneAdded: refresh
      });
      panelHost.appendChild(panel);
    }
  });
}

// ---------------------------------------------------------------------------
// Entry point, called from app.js's renderCurrentView() dispatch when
// view === "plans". No arg -> shelf (`#plans`); arg -> that plan's own
// detail (`#plans/<planId>`).
// ---------------------------------------------------------------------------
export async function renderPlansView(arg) {
  const container = document.getElementById("plans-body");
  if (!container) return;
  if (!arg) {
    await renderPlansShelf(container);
  } else {
    await renderPlanDetail(container, arg);
  }
}
