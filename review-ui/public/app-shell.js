// GM Review — Phase 30 task 30.2: the designer app shell (the persistent
// frame that replaces the "GM Review" multi-tab bar with the Session
// planner|World toggle + left rail + hyperlinked breadcrumb).
//
// One router, not two: app.js's existing renderCurrentView() calls the
// exported renderShell(view, arg) for the `#planner/*` and `#world*` hash
// prefixes (plans/phase-30-structure.md §2). This module owns the shell's
// topbar/breadcrumb/rail/main-column DOM only -- it holds no independent
// routing, world-selection, or business logic: world selection is the SAME
// localStorage["gmReview.world"] key every sibling view module reads, and the
// plan/scene main-column views DELEGATE to the existing renderPlansView /
// renderSessionPlanner render functions (the intentional, temporary "green
// between waves" seam per §5 -- 30.3 replaces the delegation with the real
// designer-faithful port).
//
// Deliberately standalone in the same way plans-view.js/session-planner-view.js
// are (own currentWorld()/api helpers reading the shared localStorage key),
// reusing showUndoToast from plans-view.js rather than a second toast host.
"use strict";
import { showUndoToast, buildAddScenePanel } from "./plans-view.js";
import { renderPlannerScenePage } from "./session-planner-view.js";
import { renderWorldSurface as renderWorldSurfaceView, clearWorldTopbar } from "./world-view.js";
import { mountConnectionChip } from "./connection-menu.js";
import { renderLibrarySurface } from "./library-view.js";
import { renderChronicleSurface } from "./chronicle-view.js";

// ---------------------------------------------------------------------------
// local api/world helpers (same standalone convention as plans-view.js)
// ---------------------------------------------------------------------------
function currentWorld() {
  return localStorage.getItem("gmReview.world") || null;
}

async function shApi(path, opts) {
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

function shWithWorld(params) {
  const p = new URLSearchParams(params || {});
  const w = currentWorld();
  if (w) p.set("world", w);
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

function el(tag, attrs = {}) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  return node;
}

function goto(hash) {
  location.hash = hash;
}

// ---------------------------------------------------------------------------
// Entity-id -> node map + scene display-name resolution -- the SAME join and
// fallback chain every sibling view file establishes (plans-view.js's
// fetchEntityInfoMap/resolveSceneDisplayName), duplicated here per the
// established standalone convention.
// ---------------------------------------------------------------------------
async function fetchEntityInfoMap() {
  try {
    const graph = await shApi(`/api/graph${shWithWorld({ filter: "all" })}`);
    const map = new Map();
    for (const n of graph.nodes || []) map.set(n.id, n);
    return map;
  } catch {
    return new Map();
  }
}

function resolveSceneDisplayName(scene, entityInfoMap) {
  if (scene.name) return scene.name;
  if (scene.locationEntityId) {
    return entityInfoMap.get(scene.locationEntityId)?.name ?? scene.locationEntityId;
  }
  return scene.objectiveNote || "Ad-hoc scene";
}

const planNameCache = new Map();
const sceneNameCache = new Map();

async function getPlanName(planId) {
  if (planNameCache.has(planId)) return planNameCache.get(planId);
  try {
    const { plan } = await shApi(`/api/scene-planning/plans/${encodeURIComponent(planId)}${shWithWorld()}`);
    if (plan?.name) { planNameCache.set(planId, plan.name); return plan.name; }
  } catch { /* fall through to id */ }
  return planId;
}

async function getSceneName(sceneId) {
  if (sceneNameCache.has(sceneId)) return sceneNameCache.get(sceneId);
  try {
    const { scene } = await shApi(`/api/session-planner/scenes/${encodeURIComponent(sceneId)}${shWithWorld()}`);
    const infoMap = await fetchEntityInfoMap();
    const name = resolveSceneDisplayName(scene, infoMap);
    sceneNameCache.set(sceneId, name);
    return name;
  } catch { /* fall through */ }
  return "Scene";
}

// ---------------------------------------------------------------------------
// Main-column mount. Phase 30 task 30.3 replaced the 30.2 borrow/restore
// delegation (which relocated the legacy #plans-body/#session-planner-body
// nodes into #shell-main) with REAL designer-faithful renders built directly
// here -- so setMain is now a plain innerHTML swap with no node relocation.
// ---------------------------------------------------------------------------
function setMain(node) {
  const main = document.getElementById("shell-main");
  main.innerHTML = "";
  main.appendChild(node);
}

// ---------------------------------------------------------------------------
// Topbar: world select + surface toggle (static controls wired once).
// ---------------------------------------------------------------------------
let staticControlsWired = false;
let worldOptionsBuilt = false;

function currentShellRoute() {
  const raw = (location.hash || "").slice(1);
  const [head, ...rest] = raw.split("/");
  return {
    view: head === "world" ? "world" : "planner",
    arg: rest.length ? rest.join("/") : undefined
  };
}

function wireStaticControls() {
  if (staticControlsWired) return;
  staticControlsWired = true;

  // Decision 4: the toggle ALWAYS navigates to the surface's canonical entry
  // (never a remembered last-visited sub-route).
  document.querySelector('[data-testid="shell-surface-toggle-planner"]')
    ?.addEventListener("click", () => goto("planner/plans"));
  document.querySelector('[data-testid="shell-surface-toggle-world"]')
    ?.addEventListener("click", () => goto("world"));
  // Phase 34 task 34.2: the two new surfaces navigate to their canonical
  // bare hash (Decision 4's precedent, extended). We also render the surface
  // synchronously here rather than waiting only for the async hashchange --
  // setting location.hash dispatches hashchange as a later task, leaving a
  // window where the hash reads "#chronicle" but data-surface hasn't been
  // repainted yet; the hashchange re-render that follows is idempotent.
  document.querySelector('[data-testid="shell-nav-chronicle"]')
    ?.addEventListener("click", () => { goto("chronicle"); renderShell("chronicle"); });
  document.querySelector('[data-testid="shell-nav-library"]')
    ?.addEventListener("click", () => { goto("library"); renderShell("library"); });

  const sel = document.querySelector('[data-testid="shell-world-select"]');
  sel?.addEventListener("change", () => {
    // Decision 3: write the exact same key initWorldSelect writes, then
    // re-render the current shell view for the newly selected world.
    localStorage.setItem("gmReview.world", sel.value);
    planNameCache.clear();
    sceneNameCache.clear();
    const { view, arg } = currentShellRoute();
    renderShell(view, arg);
  });
}

async function populateWorldSelect() {
  const sel = document.querySelector('[data-testid="shell-world-select"]');
  if (!sel) return;
  if (!worldOptionsBuilt) {
    try {
      const { worlds } = await shApi("/api/worlds");
      sel.innerHTML = "";
      for (const w of worlds) {
        const opt = document.createElement("option");
        opt.value = w;
        opt.textContent = w;
        sel.appendChild(opt);
      }
      worldOptionsBuilt = true;
    } catch { /* leave whatever options exist */ }
  }
  const cw = currentWorld();
  if (cw && [...sel.options].some((o) => o.value === cw)) sel.value = cw;
}

// ---------------------------------------------------------------------------
// Breadcrumb (planner-surface only). Segments appear progressively per view;
// Plans + plan are clickable, scene is a non-navigating leaf. `null` clears
// the slot entirely so its DOM count is 0 on the World surface.
// ---------------------------------------------------------------------------
let railOpenPlanId = null; // the "currently open plan" context (Decision 5)

function crumbSep() {
  const s = el("span", { class: "shell-crumb-sep" });
  s.textContent = "/";
  return s;
}

function renderBreadcrumb(sub) {
  const slot = document.getElementById("shell-breadcrumb-slot");
  if (!slot) return;
  if (!sub) { slot.innerHTML = ""; return; }
  slot.innerHTML = "";

  const bc = el("nav", { class: "shell-breadcrumb", "data-testid": "shell-breadcrumb" });

  const plansCrumb = el("span", { class: "shell-crumb shell-crumb--link", "data-testid": "shell-breadcrumb-plans" });
  plansCrumb.textContent = "Plans";
  plansCrumb.addEventListener("click", () => goto("planner/plans"));
  bc.appendChild(plansCrumb);

  // The plan segment shows for view=plan, and for a scene reached WITH a plan
  // context (an orphaned/deep-linked scene omits it -- "never a dead link").
  let planIdForCrumb = null;
  if (sub.kind === "plan") planIdForCrumb = sub.id;
  else if (sub.kind === "scene" && railOpenPlanId) planIdForCrumb = railOpenPlanId;

  if (planIdForCrumb) {
    bc.appendChild(crumbSep());
    const planCrumb = el("span", {
      class: "shell-crumb shell-crumb--link",
      "data-testid": "shell-breadcrumb-plan",
      "data-plan-id": planIdForCrumb
    });
    planCrumb.textContent = planNameCache.get(planIdForCrumb) || "Plan";
    planCrumb.addEventListener("click", () => goto(`planner/plan/${planIdForCrumb}`));
    bc.appendChild(planCrumb);
    getPlanName(planIdForCrumb).then((nm) => { planCrumb.textContent = nm; });
  }

  if (sub.kind === "scene") {
    bc.appendChild(crumbSep());
    const sceneCrumb = el("span", {
      class: "shell-crumb shell-crumb--leaf",
      "data-testid": "shell-breadcrumb-scene",
      "data-scene-id": sub.id
    });
    sceneCrumb.textContent = sceneNameCache.get(sub.id) || "Scene";
    // Leaf: deliberately NO click handler -- clicking must not navigate.
    bc.appendChild(sceneCrumb);
    getSceneName(sub.id).then((nm) => { sceneCrumb.textContent = nm; });
  }

  slot.appendChild(bc);
}

// ---------------------------------------------------------------------------
// Rail (planner-surface only): Session plans list [+new] + Scene library list
// [per-row + add-to-open-plan]. `null` clears the slot so its DOM count is 0
// on the World surface.
// ---------------------------------------------------------------------------
function renderRail(sub) {
  const slot = document.getElementById("shell-rail-slot");
  if (!slot) return;
  if (!sub) { slot.innerHTML = ""; return; }
  slot.innerHTML = "";

  const rail = el("aside", { class: "shell-rail", "data-testid": "shell-rail-planner" });

  // --- Session plans section ---
  const plansHeader = el("div", { class: "shell-rail-section-header" });
  const plansTitle = el("div", { class: "shell-rail-section-title" });
  plansTitle.textContent = "Session plans";
  const newBtn = el("button", { class: "shell-new-plan-btn", "data-testid": "shell-new-plan-btn", title: "New plan", type: "button" });
  newBtn.textContent = "+";
  newBtn.addEventListener("click", createNewPlanAndOpen);
  plansHeader.append(plansTitle, newBtn);

  const plansList = el("div", { class: "shell-rail-list", "data-testid": "shell-plans-list" });

  // --- Scene library section ---
  const libHeader = el("div", { class: "shell-rail-section-header" });
  const libTitle = el("div", { class: "shell-rail-section-title" });
  libTitle.textContent = "Scene library";
  const libCount = el("div", { class: "shell-rail-section-count" });
  libHeader.append(libTitle, libCount);

  const libList = el("div", { class: "shell-rail-list", "data-testid": "shell-scene-library-list" });

  // Notice host (no-target / dedupe) -- persists between add-clicks (rail is
  // only rebuilt on navigation), reused rather than a second toast host.
  const notices = el("div", { class: "shell-rail-notices" });

  rail.append(plansHeader, plansList, libHeader, libList, notices);
  slot.appendChild(rail);

  fillRailPlans(plansList);
  fillRailScenes(libList, libCount);
}

async function fillRailPlans(listEl) {
  listEl.innerHTML = "";
  let plans = [];
  try { ({ plans } = await shApi(`/api/scene-planning/plans${shWithWorld()}`)); } catch { /* leave empty */ }
  for (const p of plans) {
    planNameCache.set(p.id, p.name);
    const activeCls = p.id === railOpenPlanId ? " shell-plan-item--active" : "";
    const item = el("div", { class: "shell-plan-item" + activeCls, "data-testid": "shell-plan-item", "data-plan-id": p.id });
    item.addEventListener("click", () => goto(`planner/plan/${p.id}`));

    // Phase 38 task 38.3: the plan rail's own ✕, mirroring fillRailScenes'
    // row-wrapper + delete-btn + confirm-panel pattern testid-for-testid
    // (shell-scene-library-item* -> shell-plan-item*, per the phase38
    // contract's §5). The EXISTING `shell-plan-item-name`/`shell-plan-item-meta`
    // testids are unchanged, just now living inside this row wrapper.
    const row = el("div", { class: "shell-plan-item-row", "data-testid": "shell-plan-item-row" });
    const main = el("div", { class: "shell-plan-item-main" });
    const name = el("div", { class: "shell-plan-item-name", "data-testid": "shell-plan-item-name" });
    name.textContent = p.name || "(untitled plan)";
    const meta = el("div", { class: "shell-plan-item-meta", "data-testid": "shell-plan-item-meta" });
    const n = (p.sceneIds || []).length;
    meta.textContent = `${n} scene${n === 1 ? "" : "s"}`;
    main.append(name, meta);
    row.appendChild(main);

    const deleteBtn = el("button", {
      class: "shell-plan-item-delete-btn",
      "data-testid": "shell-plan-item-delete-btn",
      "data-plan-id": p.id,
      title: "Delete this plan entirely",
      type: "button"
    });
    deleteBtn.textContent = "✕";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePlanDeleteConfirm(item, p);
    });
    row.appendChild(deleteBtn);

    item.appendChild(row);
    listEl.appendChild(item);
  }
}

// Guarded confirm panel for the plan rail's ✕, same shape/idiom as
// toggleSceneDeleteConfirm below -- reuses the EXISTING, already-shipped
// DELETE /api/scene-planning/plans/:planId route (deletePlan, plans.mjs:212)
// with zero backend changes (phase38 contract §5). Copy mirrors the
// runsheet's own confirmDeletePlan verbatim, with the rail-specific "removed
// from the run list" framing the contract's §5 pins.
function togglePlanDeleteConfirm(item, plan) {
  const existing = item.querySelector('[data-testid="shell-plan-item-delete-confirm-panel"]');
  if (existing) { existing.remove(); return; }

  const panel = el("div", {
    class: "shell-plan-item-delete-confirm-panel",
    "data-testid": "shell-plan-item-delete-confirm-panel",
    "data-plan-id": plan.id
  });
  const warn = el("p", { class: "hint" });
  warn.textContent = "Delete this plan entirely? It will be removed from the run list — its scenes are untouched and stay in the Scene library.";
  const status = el("span", { class: "hint" });
  const confirmBtn = el("button", { class: "btn btn--accept", type: "button", "data-testid": "shell-plan-item-delete-confirm-btn" });
  confirmBtn.textContent = "Yes, delete";
  const cancelBtn = el("button", { class: "btn", type: "button", "data-testid": "shell-plan-item-delete-cancel-btn" });
  cancelBtn.textContent = "Cancel";

  confirmBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    confirmBtn.disabled = true;
    try {
      await shApi(`/api/scene-planning/plans/${encodeURIComponent(plan.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld() })
      });
      planNameCache.delete(plan.id);
      const wasOpenPlan = railOpenPlanId === plan.id;
      item.remove();
      if (wasOpenPlan) {
        railOpenPlanId = null;
        goto("planner/plans");
      }
    } catch (err) {
      status.textContent = `Could not delete: ${err.message}`;
      confirmBtn.disabled = false;
    }
  });
  cancelBtn.addEventListener("click", (e) => { e.stopPropagation(); panel.remove(); });

  panel.append(warn, confirmBtn, cancelBtn, status);
  item.appendChild(panel);
}

async function fillRailScenes(listEl, countEl) {
  listEl.innerHTML = "";
  let scenes = [];
  try { ({ scenes } = await shApi(`/api/scene-planning/scenes${shWithWorld()}`)); } catch { /* leave empty */ }
  const infoMap = await fetchEntityInfoMap();
  if (countEl) countEl.textContent = String(scenes.length);
  for (const s of scenes) {
    sceneNameCache.set(s.id, resolveSceneDisplayName(s, infoMap));
    const item = el("div", { class: "shell-scene-library-item", "data-testid": "shell-scene-library-item", "data-scene-id": s.id });
    // Phase 35 task 35.3: a plain flex-row wrapper for the always-visible
    // controls, keeping `item` itself a column so the relocated delete
    // flow's confirm panel (appended straight onto `item` below) renders as
    // a full-width block underneath, not squeezed into the row.
    const row = el("div", { class: "shell-scene-library-item-row" });

    const main = el("div", { class: "shell-scene-library-item-main" });
    const name = el("div", { class: "shell-scene-library-item-name", "data-testid": "shell-scene-library-item-name" });
    name.textContent = resolveSceneDisplayName(s, infoMap);
    const place = el("div", { class: "shell-scene-library-item-place" });
    place.textContent = s.locationEntityId ? (infoMap.get(s.locationEntityId)?.name ?? "") : "";
    main.append(name, place);
    // Clicking the row (not the +) opens the scene.
    main.addEventListener("click", () => goto(`planner/scene/${s.id}`));

    const addBtn = el("button", {
      class: "shell-scene-library-item-add-btn",
      "data-testid": "shell-scene-library-item-add-btn",
      "data-scene-id": s.id,
      title: "Add to the open plan",
      type: "button"
    });
    addBtn.textContent = "+";
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      addSceneToOpenPlan(s.id);
    });

    // Phase 35 task 35.3: the guarded TRUE delete-scene flow, relocated here
    // from the retired #scenes tab (scenes-view.js's own renderSceneListItem,
    // pre-retirement) -- this rail section is already the world-scoped
    // scene-browse list #scenes itself used to be, so a TRUE delete (the
    // scene record + every plan membership + every scene-link gone; the
    // place entity survives, `session-planner/scenes.mjs`'s deleteScene
    // cascade) belongs on the SAME row as every other per-scene action here.
    // Kept DISTINCT per the four-verbs rule (design/session-planner/
    // README.md:163): the + button above is remove/add-from-plan (an
    // unlink, reversible membership edit) -- a completely different verb
    // from this one.
    const deleteBtn = el("button", {
      class: "shell-scene-library-item-delete-btn",
      "data-testid": "shell-scene-library-item-delete-btn",
      "data-scene-id": s.id,
      title: "Delete this scene entirely",
      type: "button"
    });
    deleteBtn.textContent = "✕";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSceneDeleteConfirm(item, s, countEl);
    });

    row.append(main, addBtn, deleteBtn);
    item.appendChild(row);
    listEl.appendChild(item);
  }
}

// Guarded confirm panel, same shape/copy as the retired #scenes tab's own
// (scenes-view.js's renderSceneListItem) -- a second click while already
// open is a no-op (idempotent toggle-open), not a second panel.
function toggleSceneDeleteConfirm(item, scene, countEl) {
  const existing = item.querySelector('[data-testid="shell-scene-library-item-delete-confirm-panel"]');
  if (existing) { existing.remove(); return; }

  const panel = el("div", {
    class: "shell-scene-library-item-delete-confirm-panel",
    "data-testid": "shell-scene-library-item-delete-confirm-panel",
    "data-scene-id": scene.id
  });
  const warn = el("p", { class: "hint" });
  warn.textContent = "Delete this scene entirely? It will be removed from every plan it's in — the underlying location survives, but this scene itself is gone for good.";
  const status = el("span", { class: "hint" });
  const confirmBtn = el("button", { class: "btn btn--accept", type: "button", "data-testid": "shell-scene-library-item-delete-confirm-btn" });
  confirmBtn.textContent = "Yes, delete";
  const cancelBtn = el("button", { class: "btn", type: "button", "data-testid": "shell-scene-library-item-delete-cancel-btn" });
  cancelBtn.textContent = "Cancel";

  confirmBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    confirmBtn.disabled = true;
    try {
      await shApi(`/api/session-planner/scenes/${encodeURIComponent(scene.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld() })
      });
      sceneNameCache.delete(scene.id);
      item.remove();
      if (countEl) countEl.textContent = String(Math.max(0, Number(countEl.textContent || "0") - 1));
      // If the open plan's runsheet is showing and referenced this scene,
      // reflect the removal -- same precedent as removeSceneFromPlan/
      // reorderRunsheet already use elsewhere in this file.
      if (railOpenPlanId) refreshMainIfPlan(railOpenPlanId);
    } catch (err) {
      status.textContent = `Could not delete: ${err.message}`;
      confirmBtn.disabled = false;
    }
  });
  cancelBtn.addEventListener("click", (e) => { e.stopPropagation(); panel.remove(); });

  panel.append(warn, confirmBtn, cancelBtn, status);
  item.appendChild(panel);
}

async function createNewPlanAndOpen() {
  try {
    const { plan } = await shApi("/api/scene-planning/plans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld(), name: "Untitled plan" })
    });
    planNameCache.set(plan.id, plan.name);
    goto(`planner/plan/${plan.id}`);
  } catch (err) {
    showUndoToast(`Could not create plan: ${err.message}`, () => {});
  }
}

function railNoticeHost() {
  return document.querySelector('[data-testid="shell-rail-planner"] .shell-rail-notices');
}

// Decision 5: "which plan is open" is READ FROM THE BREADCRUMB, not a separate
// state -- active only when a shell-breadcrumb-plan segment is present.
async function addSceneToOpenPlan(sceneId) {
  const host = railNoticeHost();
  if (host) host.innerHTML = "";

  const planCrumb = document.querySelector('[data-testid="shell-breadcrumb-plan"][data-plan-id]');
  if (!planCrumb) {
    // No open plan -> no-target notice, and NO route call.
    if (host) {
      const notice = el("div", { "data-testid": "shell-add-to-plan-no-target-notice" });
      notice.textContent = "Open a plan first, then + adds this scene to it.";
      host.appendChild(notice);
    }
    return;
  }

  const planId = planCrumb.getAttribute("data-plan-id");
  let plan;
  try {
    ({ plan } = await shApi(`/api/scene-planning/plans/${encodeURIComponent(planId)}${shWithWorld()}`));
  } catch {
    return;
  }
  planNameCache.set(plan.id, plan.name);

  if ((plan.sceneIds || []).includes(sceneId)) {
    // Dedupe: a no-op that needs explaining, not an action that needs undoing
    // -- an inline notice, NOT an undo-toast (Decision 6).
    if (host) {
      const notice = el("div", {
        "data-testid": "shell-add-to-plan-dedupe-notice",
        "data-plan-id": plan.id
      });
      notice.textContent = `That scene is already in "${plan.name}".`;
      host.appendChild(notice);
    }
    return;
  }

  try {
    await shApi(`/api/scene-planning/plans/${encodeURIComponent(planId)}/scenes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld(), sceneId })
    });
    if (host) host.innerHTML = "";
    showUndoToast(`Added scene to "${plan.name}".`, async () => {
      await shApi(`/api/scene-planning/plans/${encodeURIComponent(planId)}/scenes/${encodeURIComponent(sceneId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld() })
      });
      // If the open plan's runsheet is showing, reflect the removal.
      refreshMainIfPlan(planId);
    });
    refreshMainIfPlan(planId);
  } catch (err) {
    showUndoToast(`Could not add scene: ${err.message}`, () => {});
  }
}

function refreshMainIfPlan(planId) {
  const planView = document.querySelector(`[data-testid="planner-plan-view"][data-plan-id="${planId}"]`);
  if (planView) renderPlanSurface(planId);
}

// ---------------------------------------------------------------------------
// Main-column dispatch over the `view` enum.
// ---------------------------------------------------------------------------
function parsePlannerArg(arg) {
  if (!arg || arg === "plans") return { kind: "plans" };
  if (arg.startsWith("plan/")) return { kind: "plan", id: arg.slice("plan/".length) };
  if (arg.startsWith("scene/")) return { kind: "scene", id: arg.slice("scene/".length) };
  return { kind: "plans" };
}

// view=plans -> the REAL designer plan shelf (README §A): a card grid, each
// card showing the plan's name, a mono meta line (N scenes · est. min), and
// its first few scene names, plus a dashed "+ New plan" card.
async function renderPlansSurface() {
  const wrapper = el("div", { class: "planner-surface planner-plans-view", "data-testid": "planner-plans-view" });
  setMain(wrapper);

  if (!currentWorld()) {
    const p = el("p", { class: "hint" });
    p.textContent = "Select a world first.";
    wrapper.appendChild(p);
    return;
  }

  const col = el("div", { class: "planner-plans-col" });
  const h1 = el("h1", { class: "planner-plans-title" });
  h1.textContent = "Session plans";
  const sub = el("div", { class: "planner-plans-sub" });
  sub.textContent = "Every plan is an ordered run of scenes. Scenes are shared by reference — reusing one here doesn't fork it.";
  const grid = el("div", { class: "planner-plans-grid" });
  col.append(h1, sub, grid);
  wrapper.appendChild(col);

  let plans = [];
  try { ({ plans } = await shApi(`/api/scene-planning/plans${shWithWorld()}`)); } catch { /* leave empty */ }
  // One scenes fetch + entity map for scene display names on the cards.
  let scenes = [];
  try { ({ scenes } = await shApi(`/api/scene-planning/scenes${shWithWorld()}`)); } catch { /* empty */ }
  const infoMap = await fetchEntityInfoMap();
  const sceneById = new Map();
  for (const s of scenes) sceneById.set(s.id, s);

  for (const p of plans) {
    planNameCache.set(p.id, p.name);
    const card = el("div", { class: "planner-plan-card", "data-testid": "planner-plan-card", "data-plan-id": p.id });
    const name = el("div", { class: "planner-plan-card-name" });
    name.textContent = p.name || "(untitled plan)";
    const ids = p.sceneIds || [];
    const meta = el("div", { class: "planner-plan-card-meta" });
    meta.textContent = `${ids.length} scene${ids.length === 1 ? "" : "s"} · est. ${ids.length * 45} min`;
    card.append(name, meta);
    const list = el("div", { class: "planner-plan-card-scenes" });
    ids.forEach((sid, i) => {
      const s = sceneById.get(sid);
      const row = el("div", { class: "planner-plan-card-scene" });
      const num = el("span", { class: "planner-plan-card-scene-num" });
      num.textContent = String(i + 1).padStart(2, "0");
      const nm = el("span");
      nm.textContent = s ? resolveSceneDisplayName(s, infoMap) : sid;
      row.append(num, nm);
      list.appendChild(row);
    });
    card.appendChild(list);
    card.addEventListener("click", () => goto(`planner/plan/${p.id}`));
    grid.appendChild(card);
  }

  const newCard = el("div", { class: "planner-plan-card planner-plan-card--new", "data-testid": "planner-new-plan-card" });
  newCard.textContent = "+ New plan";
  newCard.addEventListener("click", createNewPlanAndOpen);
  grid.appendChild(newCard);
}

// view=plan -> the REAL designer runsheet (README §B): mono kicker, editable
// plan title, meta row with Delete plan, ordered scene rows (index / name /
// place / element meta / objective + ↑↓✕ controls), and the inline add-scene
// panel. Scene rows navigate to the SHELL scene hash (#planner/scene/<id>).
async function renderPlanSurface(planId) {
  const wrapper = el("div", {
    class: "planner-surface planner-plan-view",
    "data-testid": "planner-plan-view",
    "data-plan-id": planId
  });
  setMain(wrapper);

  if (!currentWorld()) {
    const p = el("p", { class: "hint" });
    p.textContent = "Select a world first.";
    wrapper.appendChild(p);
    return;
  }

  let plan;
  try {
    ({ plan } = await shApi(`/api/scene-planning/plans/${encodeURIComponent(planId)}${shWithWorld()}`));
  } catch {
    const p = el("p", { class: "hint" });
    p.textContent = `Could not load plan "${planId}".`;
    wrapper.appendChild(p);
    return;
  }
  planNameCache.set(plan.id, plan.name);

  const col = el("div", { class: "planner-plan-col" });
  wrapper.appendChild(col);

  const kicker = el("div", { class: "planner-runsheet-kicker" });
  kicker.textContent = "Run sheet";
  col.appendChild(kicker);

  // Plan title -- editable (designer §B: contenteditable, rename on blur via
  // the Phase 30.5 POST .../plans/:planId/rename route). Empty shows a muted
  // placeholder; focusing an empty title clears the placeholder so the caret
  // sits on a blank line, mirroring makeClickToEditField's empty-field
  // convention one surface over.
  const title = el("div", {
    class: "planner-runsheet-title", "data-testid": "planner-plan-title", "data-plan-id": plan.id,
    contenteditable: "true", spellcheck: "false"
  });
  const PLAN_PLACEHOLDER = "Untitled plan";
  const paintTitle = () => {
    const nm = planNameCache.get(plan.id) || "";
    title.textContent = nm || PLAN_PLACEHOLDER;
    title.classList.toggle("planner-runsheet-title--empty", !nm);
  };
  paintTitle();
  title.addEventListener("focus", () => {
    if (!(planNameCache.get(plan.id) || "")) {
      title.textContent = "";
      title.classList.remove("planner-runsheet-title--empty");
    }
  });
  title.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); title.blur(); }
  });
  title.addEventListener("blur", () => savePlanName(plan.id, title.textContent.trim(), paintTitle));
  col.appendChild(title);

  const metaRow = el("div", { class: "planner-runsheet-meta" });
  const metaText = el("span");
  const nScenes = (plan.sceneIds || []).length;
  metaText.textContent = `${nScenes} scene${nScenes === 1 ? "" : "s"} · est. ${nScenes * 45} min`;
  const metaSep = el("span", { class: "planner-runsheet-meta-sep" });
  metaSep.textContent = "·";
  const deleteBtn = el("span", { class: "planner-runsheet-delete", "data-testid": "planner-plan-delete-btn", "data-plan-id": plan.id });
  deleteBtn.textContent = "Delete plan";
  deleteBtn.addEventListener("click", () => confirmDeletePlan(plan, wrapper));
  metaRow.append(metaText, metaSep, deleteBtn);
  col.appendChild(metaRow);

  const rowsHost = el("div", { class: "planner-runsheet-rows", "data-testid": "planner-runsheet-rows" });
  col.appendChild(rowsHost);
  await fillRunsheetRows(rowsHost, plan.id);

  // + Add scene -> inline place-chip panel (reuses plans-view.js's real
  // create-place -> create-scene -> attach-to-plan flow), refreshing the
  // runsheet rows on success.
  const addWrap = el("div", { class: "planner-runsheet-add" });
  const addBtn = el("div", { class: "planner-runsheet-add-btn", "data-testid": "planner-add-scene-btn" });
  addBtn.textContent = "+ Add scene";
  const panelHost = el("div");
  let addOpen = false;
  addBtn.addEventListener("click", () => {
    if (addOpen) { panelHost.innerHTML = ""; addOpen = false; return; }
    addOpen = true;
    panelHost.appendChild(buildAddScenePanel(plan.id, {
      onSceneAdded: async () => {
        panelHost.innerHTML = ""; addOpen = false;
        await renderPlanSurface(plan.id);
      }
    }));
  });
  addWrap.append(addBtn, panelHost);
  col.appendChild(addWrap);
}

async function confirmDeletePlan(plan, wrapper) {
  if (wrapper.querySelector('[data-testid="planner-plan-delete-confirm"]')) return;
  const panel = el("div", { class: "planner-runsheet-delete-confirm", "data-testid": "planner-plan-delete-confirm", "data-plan-id": plan.id });
  const warn = el("p", { class: "hint" });
  warn.textContent = "Delete this plan? Its scenes are untouched and stay in the Scene library.";
  const yes = el("button", { class: "btn btn--danger", type: "button", "data-testid": "planner-plan-delete-confirm-btn" });
  yes.textContent = "Yes, delete";
  const no = el("button", { class: "btn", type: "button" });
  no.textContent = "Cancel";
  no.addEventListener("click", () => panel.remove());
  yes.addEventListener("click", async () => {
    yes.disabled = true;
    try {
      await shApi(`/api/scene-planning/plans/${encodeURIComponent(plan.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld() })
      });
      goto("planner/plans");
    } catch { yes.disabled = false; warn.textContent = "Could not delete."; }
  });
  panel.append(warn, yes, no);
  wrapper.querySelector(".planner-plan-col").appendChild(panel);
}

// Rename-on-blur for the runsheet plan title (designer §B). Reflects the new
// name back into the planNameCache + the rail's plan list + the breadcrumb so
// every surface that shows this plan's name updates in one blur.
async function savePlanName(planId, name, repaint) {
  const prev = planNameCache.get(planId) || "";
  if (name === prev) { if (repaint) repaint(); return; }
  try {
    const { plan } = await shApi(`/api/scene-planning/plans/${encodeURIComponent(planId)}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld(), name: name || null })
    });
    planNameCache.set(planId, plan.name || "");
    if (repaint) repaint();
    const railList = document.querySelector('[data-testid="shell-plans-list"]');
    if (railList) fillRailPlans(railList);
    const { view, arg } = currentShellRoute();
    if (view === "planner") renderBreadcrumb(parsePlannerArg(arg));
  } catch (err) {
    if (repaint) repaint();
    showUndoToast(`Could not rename plan: ${err.message}`, () => {});
  }
}

async function fillRunsheetRows(rowsHost, planId) {
  rowsHost.innerHTML = "";
  let plan;
  try {
    ({ plan } = await shApi(`/api/scene-planning/plans/${encodeURIComponent(planId)}${shWithWorld()}`));
  } catch { return; }
  const sceneIds = plan.sceneIds || [];
  if (!sceneIds.length) {
    const empty = el("p", { class: "hint" });
    empty.textContent = "No scenes in this plan yet — add one below.";
    rowsHost.appendChild(empty);
    return;
  }
  const infoMap = await fetchEntityInfoMap();
  for (let i = 0; i < sceneIds.length; i++) {
    const sceneId = sceneIds[i];
    let scene;
    try {
      ({ scene } = await shApi(`/api/session-planner/scenes/${encodeURIComponent(sceneId)}${shWithWorld()}`));
    } catch { continue; }
    sceneNameCache.set(sceneId, resolveSceneDisplayName(scene, infoMap));

    // Element meta ("N elements · K key") -- K key = graph-backed elements.
    let elemMeta = "";
    try {
      const { elements } = await shApi(`/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/elements${shWithWorld()}`);
      const keyCount = (elements || []).filter((e) => e.kind === "graph").length;
      elemMeta = `${(elements || []).length} elements · ${keyCount} key`;
    } catch { /* leave blank */ }

    const row = el("div", { class: "planner-runsheet-row", "data-testid": "planner-runsheet-row", "data-scene-id": sceneId });
    const num = el("div", { class: "planner-runsheet-num" });
    num.textContent = String(i + 1).padStart(2, "0");

    const bodyCol = el("div", { class: "planner-runsheet-body" });
    const name = el("div", { class: "planner-runsheet-name" });
    name.textContent = resolveSceneDisplayName(scene, infoMap);
    const metaLine = el("div", { class: "planner-runsheet-row-meta" });
    const placeSpan = el("span", { class: "planner-runsheet-place" });
    placeSpan.textContent = (scene.locationEntityId ? (infoMap.get(scene.locationEntityId)?.name ?? "") : "").toUpperCase();
    const elemSpan = el("span", { class: "planner-runsheet-elem-meta" });
    elemSpan.textContent = elemMeta;
    metaLine.append(placeSpan, elemSpan);
    const obj = el("div", { class: "planner-runsheet-objective" });
    obj.textContent = scene.objectiveNote || "";
    bodyCol.append(name, metaLine, obj);
    bodyCol.addEventListener("click", () => goto(`planner/scene/${sceneId}`));

    const controls = el("div", { class: "planner-runsheet-controls" });
    if (i > 0) controls.appendChild(makeRunsheetCtl("↑", "Move up", "planner-runsheet-up-btn", sceneId, () => reorderRunsheet(planId, sceneIds, i, i - 1, rowsHost)));
    if (i < sceneIds.length - 1) controls.appendChild(makeRunsheetCtl("↓", "Move down", "planner-runsheet-down-btn", sceneId, () => reorderRunsheet(planId, sceneIds, i, i + 1, rowsHost)));
    controls.appendChild(makeRunsheetCtl("✕", "Remove from plan (the scene survives)", "planner-runsheet-remove-btn", sceneId, () => removeSceneFromPlan(planId, sceneId, rowsHost)));

    row.append(num, bodyCol, controls);
    rowsHost.appendChild(row);
  }
}

function makeRunsheetCtl(glyph, title, testid, sceneId, onClick) {
  const b = el("button", { class: "planner-runsheet-ctl", type: "button", title, "data-testid": testid, "data-scene-id": sceneId });
  b.textContent = glyph;
  b.addEventListener("click", async (e) => {
    e.stopPropagation();
    b.disabled = true;
    try { await onClick(); } catch { b.disabled = false; }
  });
  return b;
}

async function reorderRunsheet(planId, sceneIds, from, to, rowsHost) {
  const newIds = sceneIds.slice();
  [newIds[from], newIds[to]] = [newIds[to], newIds[from]];
  await shApi(`/api/scene-planning/plans/${encodeURIComponent(planId)}/reorder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: currentWorld(), sceneIds: newIds })
  });
  await fillRunsheetRows(rowsHost, planId);
}

async function removeSceneFromPlan(planId, sceneId, rowsHost) {
  await shApi(`/api/scene-planning/plans/${encodeURIComponent(planId)}/scenes/${encodeURIComponent(sceneId)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: currentWorld() })
  });
  await fillRunsheetRows(rowsHost, planId);
  showUndoToast("Removed scene from plan.", async () => {
    await shApi(`/api/scene-planning/plans/${encodeURIComponent(planId)}/scenes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld(), sceneId })
    });
    await fillRunsheetRows(rowsHost, planId);
  });
}

// view=scene -> the REAL designer scene page, ported into #shell-main directly
// (no borrow). renderPlannerScenePage reuses ALL the Phase 28/29 scene wiring
// under the designer sub-roots + shell nav hashes.
async function renderSceneSurface(sceneId) {
  const wrapper = el("div", { class: "planner-surface planner-scene-surface" });
  setMain(wrapper);
  await renderPlannerScenePage(wrapper, sceneId);
}

// view=world -> the real World containment-tree surface (task 30.4). The
// world-view module owns #shell-main + the topbar world slot itself, so it can
// do incremental (non-teardown) updates across selection hash changes.
function renderWorldSurface(entityId) {
  renderWorldSurfaceView(entityId);
}

// view=chronicle / view=library -> designed placeholder surfaces (Phase 34
// task 34.2 scaffold). Correct chrome (a sub-bar with the mono kicker, per the
// prototypes) + a short placeholder body in the design's voice. No planner
// rail (like the World surface). The scaffold root is the SOLE occupant of
// #shell-main (the e2e asserts a child count of exactly 1).
const SCAFFOLD_COPY = {
  chronicle: {
    kicker: "Chronicle",
    title: "Let time pass",
    body: "This is where advances are composed and reviewed — queued intents ride along on the next passage of time, and the world moves once instead of eleven times. The Chronicle arrives in Phase 37."
  },
  library: {
    kicker: "Library",
    title: "The bestiary and Hero's Hall",
    body: "This is where the bestiary, party and compendium mirror will live — everything a scene can reach for, browsable and taggable. The Library arrives in Phase 35."
  }
};

function renderScaffoldSurface(surface) {
  const copy = SCAFFOLD_COPY[surface];
  const root = el("div", { class: "surface-scaffold", "data-testid": `${surface}-surface-root` });

  const subbar = el("div", { class: "surface-scaffold-subbar" });
  const kicker = el("div", { class: "surface-scaffold-kicker" });
  kicker.textContent = copy.kicker;
  subbar.appendChild(kicker);
  root.appendChild(subbar);

  const bodyWrap = el("div", { class: "surface-scaffold-body" });
  const h1 = el("div", { class: "surface-scaffold-title" });
  h1.textContent = copy.title;
  const p = el("p", { class: "surface-scaffold-note" });
  p.textContent = copy.body;
  bodyWrap.append(h1, p);
  root.appendChild(bodyWrap);

  setMain(root);
}

// Paint the active nav button off the shell root's data-surface (planner/world
// keep their Phase-30 CSS active rule; the two new surfaces are painted here).
function paintNavActive(surface) {
  const map = {
    planner: '[data-testid="shell-surface-toggle-planner"]',
    world: '[data-testid="shell-surface-toggle-world"]',
    chronicle: '[data-testid="shell-nav-chronicle"]',
    library: '[data-testid="shell-nav-library"]'
  };
  for (const [surf, sel] of Object.entries(map)) {
    const btn = document.querySelector(sel);
    if (btn) btn.classList.toggle("shell-surface-btn--active", surf === surface);
  }
}

// ---------------------------------------------------------------------------
// Entry point, called by app.js's renderCurrentView for #planner/* and #world*.
// ---------------------------------------------------------------------------
export function renderShell(view, arg) {
  wireStaticControls();

  const shell = document.getElementById("app-shell");
  const titleEl = document.getElementById("shell-world-title");
  if (titleEl) titleEl.textContent = currentWorld() || "";
  populateWorldSelect();
  // Phase 34 task 34.2: the Connection Menu chip lives in the topbar right
  // slot on every shell surface. mountConnectionChip is idempotent (builds
  // once, then refreshes) and also honors any queued #settings/#import
  // redirect that asked the panel to open.
  mountConnectionChip();

  if (view === "world") {
    shell.setAttribute("data-surface", "world");
    paintNavActive("world");
    railOpenPlanId = null;
    renderBreadcrumb(null);
    renderRail(null);
    renderWorldSurface(arg);
    return;
  }

  if (view === "chronicle" || view === "library") {
    shell.setAttribute("data-surface", view);
    paintNavActive(view);
    railOpenPlanId = null;
    clearWorldTopbar();
    renderBreadcrumb(null);
    renderRail(null);
    // Phase 35 task 35.2: the Library is a real four-tab surface
    // (library-view.js). Phase 37 task 37.2: the Chronicle is now the real
    // page (chronicle-view.js) -- both own #shell-main themselves (a single
    // root child, per the phase34 "sole occupant" e2e).
    if (view === "library") renderLibrarySurface(arg);
    else renderChronicleSurface(arg);
    return;
  }

  shell.setAttribute("data-surface", "planner");
  paintNavActive("planner");
  clearWorldTopbar();
  const sub = parsePlannerArg(arg);
  if (sub.kind === "plans") railOpenPlanId = null;
  else if (sub.kind === "plan") railOpenPlanId = sub.id;
  // scene: keep whatever plan context we arrived from (null if deep-linked).

  renderRail(sub);
  renderBreadcrumb(sub);

  if (sub.kind === "plans") renderPlansSurface();
  else if (sub.kind === "plan") renderPlanSurface(sub.id);
  else renderSceneSurface(sub.id);
}
