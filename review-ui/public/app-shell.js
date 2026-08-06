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
import { renderPlansView, showUndoToast } from "./plans-view.js";
import { renderSessionPlanner } from "./session-planner-view.js";

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
// Borrowed legacy body nodes. renderPlansView/renderSessionPlanner are
// hardcoded to render into #plans-body / #session-planner-body (getElementById),
// which live inside the shelved legacy <main>. To DELEGATE to them inside the
// shell's #shell-main without duplicate ids, we RELOCATE the single real node
// into a shell wrapper and restore it to its legacy home on the next shell
// render or on leaving the shell (app.js calls restoreShellBorrowedNodes()
// when navigating to any legacy hash). This is the §5 seam, replaced by the
// real port in 30.3.
// ---------------------------------------------------------------------------
const borrowed = [];

function borrowInto(host, id) {
  const node = document.getElementById(id);
  if (!node) return;
  borrowed.push({ node, home: node.parentNode });
  host.appendChild(node);
}

export function restoreShellBorrowedNodes() {
  while (borrowed.length) {
    const { node, home } = borrowed.pop();
    if (home && node.parentNode !== home) home.appendChild(node);
  }
}

function setMain(node) {
  // restoreShellBorrowedNodes() has already run at the top of renderShell, so
  // any node still in #shell-main here is throwaway DOM -- the newly-borrowed
  // node (if any) lives in `node`, which is still detached at this point.
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
    const item = el("div", { class: "shell-plan-item", "data-testid": "shell-plan-item", "data-plan-id": p.id });
    const name = el("div", { class: "shell-plan-item-name", "data-testid": "shell-plan-item-name" });
    name.textContent = p.name || "(untitled plan)";
    const meta = el("div", { class: "shell-plan-item-meta", "data-testid": "shell-plan-item-meta" });
    const n = (p.sceneIds || []).length;
    meta.textContent = `${n} scene${n === 1 ? "" : "s"}`;
    item.append(name, meta);
    item.addEventListener("click", () => goto(`planner/plan/${p.id}`));
    listEl.appendChild(item);
  }
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

    item.append(main, addBtn);
    listEl.appendChild(item);
  }
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

// view=plans -> DELEGATE to renderPlansView()'s shelf, mounted inside the
// planner-plans-view root (§5 seam). Reuses plans-view.js's shelf logic.
async function renderPlansSurface() {
  const wrapper = el("div", { class: "planner-surface planner-plans-surface", "data-testid": "planner-plans-view" });
  borrowInto(wrapper, "plans-body");
  setMain(wrapper);
  try { await renderPlansView(undefined); } catch { /* renderPlansView surfaces its own error state */ }
}

// view=plan -> a thin runsheet whose scene rows navigate to the SHELL scene
// hash (#planner/scene/<id>). Deliberately NOT a delegation to
// renderPlansView's plan-detail: that render's scene-open hardcodes the legacy
// `#session-planner/<id>` hash, which would break the shell navigation
// contract (the planner-surface e2e asserts `#planner/scene/<id>`). The full
// designer runsheet is 30.3's port; this is enough to satisfy the shell root +
// scene-open navigation this wave targets.
async function renderPlanSurface(planId) {
  const wrapper = el("div", {
    class: "planner-surface planner-plan-surface",
    "data-testid": "planner-plan-view",
    "data-plan-id": planId
  });
  setMain(wrapper);

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

  const title = el("h2", { class: "planner-plan-title" });
  title.textContent = plan.name || "(untitled plan)";
  wrapper.appendChild(title);

  const runsheet = el("div", { class: "planner-plan-runsheet" });
  wrapper.appendChild(runsheet);

  const sceneIds = plan.sceneIds || [];
  if (!sceneIds.length) {
    const empty = el("p", { class: "hint" });
    empty.textContent = "No scenes in this plan yet — add one from the Scene library.";
    runsheet.appendChild(empty);
    return;
  }

  const infoMap = await fetchEntityInfoMap();
  for (let i = 0; i < sceneIds.length; i++) {
    const sceneId = sceneIds[i];
    let scene;
    try {
      ({ scene } = await shApi(`/api/session-planner/scenes/${encodeURIComponent(sceneId)}${shWithWorld()}`));
    } catch {
      continue;
    }
    sceneNameCache.set(sceneId, resolveSceneDisplayName(scene, infoMap));
    const row = el("div", { class: "planner-runsheet-row", "data-scene-id": sceneId });
    const num = el("span", { class: "planner-runsheet-num" });
    num.textContent = String(i + 1);
    const name = el("span", { class: "planner-runsheet-name" });
    name.textContent = resolveSceneDisplayName(scene, infoMap);
    row.append(num, name);
    row.addEventListener("click", () => goto(`planner/scene/${sceneId}`));
    runsheet.appendChild(row);
  }
}

// view=scene -> DELEGATE to renderSessionPlanner (the legacy scene page DOM),
// mounted inside the planner-scene-view root, plus the three light stub
// sub-roots the shell-integration contract pins (planner-scene-place-header /
// -read-aloud / -elements). The delegated legacy DOM under the new frame is
// the expected §5 seam; the real designer scene page is 30.3's port.
async function renderSceneSurface(sceneId) {
  const wrapper = el("div", {
    class: "planner-surface planner-scene-surface",
    "data-testid": "planner-scene-view",
    "data-scene-id": sceneId
  });

  for (const testid of ["planner-scene-place-header", "planner-scene-read-aloud", "planner-scene-elements"]) {
    wrapper.appendChild(el("div", { class: "shell-scene-stub", "data-testid": testid }));
  }

  const delegated = el("div", { class: "planner-scene-delegated" });
  wrapper.appendChild(delegated);
  borrowInto(delegated, "session-planner-body");
  setMain(wrapper);

  try { await renderSessionPlanner(sceneId); } catch { /* renderSessionPlanner surfaces its own error state */ }
}

// view=world -> a minimal placeholder root (the real World surface is 30.4).
// Enough that the surface-toggle test sees the root swap in; the deep World
// tests stay red for 30.4.
function renderWorldSurface(/* entityId */) {
  const wrapper = el("div", { class: "world-surface", "data-testid": "world-surface-root" });
  const placeholder = el("div", { class: "world-surface-placeholder" });
  placeholder.textContent = "World surface — arriving in task 30.4.";
  wrapper.appendChild(placeholder);
  setMain(wrapper);
}

// ---------------------------------------------------------------------------
// Entry point, called by app.js's renderCurrentView for #planner/* and #world*.
// ---------------------------------------------------------------------------
export function renderShell(view, arg) {
  wireStaticControls();
  restoreShellBorrowedNodes(); // before we wipe #shell-main below

  const shell = document.getElementById("app-shell");
  const titleEl = document.getElementById("shell-world-title");
  if (titleEl) titleEl.textContent = currentWorld() || "";
  populateWorldSelect();

  if (view === "world") {
    shell.setAttribute("data-surface", "world");
    railOpenPlanId = null;
    renderBreadcrumb(null);
    renderRail(null);
    renderWorldSurface(arg);
    return;
  }

  shell.setAttribute("data-surface", "planner");
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
