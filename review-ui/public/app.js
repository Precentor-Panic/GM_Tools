// GM Review — Phase 6 review UI frontend. Plain JS, no framework, no build step.
// Phase 7 adds review-ui/public/graph-view.js, a shared SVG graph-rendering
// module used both by the Review screen's List/Graph toggle and the
// standalone Graph nav view -- imported as an ES module (index.html's
// <script> tag was switched to type="module" for this).
"use strict";
import { renderGraph, showCreateNodeForm, armPlacementMode, seedNodePosition, removeNodePosition } from "./graph-view.js";
import { renderSessionPlanner, flushActiveNoteSave, cancelActiveAssist } from "./session-planner-view.js";
import { renderCombatPlanning, renderCombatPlanningIngest, cancelActiveCombatPlanningRequest } from "./combat-planning-view.js";
import { renderPlansView } from "./plans-view.js";
import { renderShell } from "./app-shell.js";
import { requestConnectionPanel } from "./connection-menu.js";

// ---------------------------------------------------------------------------
// world selection
// ---------------------------------------------------------------------------

let CURRENT_WORLD = localStorage.getItem("gmReview.world") || null;

async function api(path, opts) {
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

function withWorld(params) {
  const p = new URLSearchParams(params || {});
  if (CURRENT_WORLD) p.set("world", CURRENT_WORLD);
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

async function initWorldSelect() {
  const select = document.getElementById("world-select");
  try {
    const { worlds } = await api("/api/worlds");
    select.innerHTML = "";
    for (const w of worlds) {
      const opt = document.createElement("option");
      opt.value = w;
      opt.textContent = w;
      select.appendChild(opt);
    }
    if (!CURRENT_WORLD || !worlds.includes(CURRENT_WORLD)) {
      CURRENT_WORLD = worlds[0] || null;
      // Phase 17: a completely fresh browser session (no prior
      // localStorage entry) previously left CURRENT_WORLD correctly
      // auto-selected in memory but localStorage silently un-synced --
      // invisible to anything reading CURRENT_WORLD directly (every
      // pre-Phase-17 function in this file), but a real bug for
      // session-planner-view.js, which is deliberately standalone
      // (mirroring graph-view.js's zero-app.js-import convention) and reads
      // the SAME "gmReview.world" key the change handler below writes.
      // Found by actually driving this in a browser against a
      // single-world fixture, the exact shape every isolated e2e test uses.
      if (CURRENT_WORLD) localStorage.setItem("gmReview.world", CURRENT_WORLD);
    }
    if (CURRENT_WORLD) select.value = CURRENT_WORLD;
  } catch (err) {
    select.innerHTML = `<option>(no worlds found)</option>`;
  }
  select.addEventListener("change", () => {
    CURRENT_WORLD = select.value;
    localStorage.setItem("gmReview.world", CURRENT_WORLD);
    renderCurrentView();
    closeMobileMenu();
  });
}

// ---------------------------------------------------------------------------
// view routing — a single index.html, four <section>s, hash-based, no router lib
// ---------------------------------------------------------------------------

function parseHash() {
  // Phase 30: a bare/empty hash lands on the new designer app (the Session
  // Planner shelf), not the legacy `#queue` GM-Review view. Every legacy hash
  // (`#queue`, `#review/<id>`, `#graph`, ...) still resolves to its shelved
  // view when navigated to explicitly -- only the DEFAULT changed. `#scenes`
  // is the one exception (Phase 35 task 35.3): it's retired and
  // hash-redirects to `#planner/plans`, same convention as `#settings`/
  // `#import` below.
  const raw = (location.hash || "#planner/plans").slice(1);
  // Split off the leading view segment, but preserve the REST as a single arg
  // (joined on "/") -- Phase 27 introduces the multi-segment
  // `#session-planner/plan/<planId>` route, and every pre-existing arg is a
  // single segment, so `rest.join("/")` is backward-compatible for them all
  // (equal to `rest[0]`).
  const [view, ...rest] = raw.split("/");
  return { view: view || "planner", arg: rest.length ? rest.join("/") : undefined };
}

function navigate(view, arg) {
  location.hash = arg ? `${view}/${arg}` : view;
}

// ---------------------------------------------------------------------------
// Task 14.8: scan-for-mentioned-entities cancellation. A single shared slot
// (not a per-call-site variable) since at most one scan is ever meaningfully
// "the current one" from the GM's perspective, and navigating away should
// cancel whichever scan (popover shortcut or the prep-content page's own
// button) happens to be in flight.
// ---------------------------------------------------------------------------
let activeScanController = null;

function cancelActiveScan() {
  if (activeScanController) {
    activeScanController.abort();
    activeScanController = null;
  }
}

function renderCurrentView() {
  // Navigating to ANY new view cancels an in-flight scan request -- the
  // real gap this fixes: a scan left running server-side after the user
  // navigated away silently completed and created a batch they never saw
  // appear, with no way to know it happened short of stumbling onto it
  // later in the Queue.
  cancelActiveScan();
  // Phase 17 task 17.3: the SAME cancellation step cancelActiveScan() already
  // uses on every navigation -- a guaranteed flush for any open inline note
  // editor (typed text the DM expects kept, never silently lost just because
  // they navigated away before the debounce timer fired). Not a second
  // navigation-hook mechanism. (Phase 28 task 28.5 retired the sibling
  // cancelActiveRecenter() call -- the re-center feature it guarded is
  // scrapped along with the old chain view.)
  flushActiveNoteSave();
  // Phase 28 task 28.4, §C: same cancel-on-navigate convention for the scene
  // page's inline `✦` functional-prep assist (additive/interruptible LLM call).
  cancelActiveAssist();
  // Phase 19: the same cancel-on-navigate convention, for this phase's two
  // (and only two) LLM call sites (ingestion submit, non-blank theme-box
  // submit) -- see combat-planning-view.js's own header.
  cancelActiveCombatPlanningRequest();
  const { view, arg } = parseHash();

  // Phase 34 task 34.2: retire #settings / #import as standalone views. Both
  // fold into the Connection Menu panel: #settings -> panel open on the
  // "Campaign & keys" section; #import -> panel open on lore intake (paste
  // mode). We queue the open, then rewrite the hash to the shell's default
  // landing -- the hashchange re-render mounts the shell (and thus the chip),
  // which honors the queued request. The legacy view-settings/view-import
  // sections stay in the DOM (their top-level button wiring references them)
  // but are never navigated to as an active view again.
  if (view === "settings" || view === "import") {
    requestConnectionPanel({ section: view === "settings" ? "settings" : "lore" });
    location.hash = "planner/plans";
    return;
  }

  // Phase 35 task 35.3: retire #scenes -- keep-by-hash convention (Phase 34's
  // own precedent, just above). The world-scoped browse screen is superseded
  // by the planner rail's "Scene library" section (fast re-entry into any
  // scene) + the shared scene tray's own search (browsing); the delete-scene
  // guarded flow that screen uniquely owned was relocated to that SAME rail
  // section first (app-shell.js's fillRailScenes) -- see index.html's own
  // retirement comment for the full accounting. An old bookmark/link to
  // `#scenes` lands on the rail's default view instead of a dead route.
  if (view === "scenes") {
    location.hash = "planner/plans";
    return;
  }

  // Phase 37 task 37.3: retire the #queue / #review / #debt SCREENS. Chronicle
  // subsumes graph review -- the batch ROUTES (/api/batches/*) are untouched;
  // only the screens fold in. Keep-by-hash convention (Phase 34's #settings/
  // #import, Phase 35.3's #scenes), so an old bookmark / deep link / API-client
  // handoff lands on the new home instead of a dead route:
  //   #review/<batchId> -> #chronicle/batch/<batchId> (the shared proposal-card
  //                        over that batch's detail -- the ONE review surface)
  //   #queue            -> #chronicle (deferred lane + history + composer)
  //   #debt             -> #chronicle (the deferred lane lives there)
  if (view === "review") {
    location.hash = arg ? `chronicle/batch/${arg}` : "chronicle";
    return;
  }
  if (view === "queue" || view === "debt") {
    location.hash = "chronicle";
    return;
  }

  // Phase 30 task 30.2: shell-vs-legacy visibility switch. The #app-shell root
  // is shown (and the legacy header.topbar/main hidden) iff the hash's leading
  // segment is `planner` or `world`; the reverse for any legacy hash. Kept as a
  // branch INSIDE this same renderCurrentView so the 4 nav-cancel hooks above
  // fire on a shell navigation exactly as for any legacy hash (§2/§4).
  const inShell = view === "planner" || view === "world" || view === "chronicle" || view === "library";
  document.getElementById("app-shell").hidden = !inShell;
  document.querySelector("header.topbar").hidden = inShell;
  document.querySelector("main").hidden = inShell;

  for (const section of document.querySelectorAll(".view")) {
    section.classList.toggle("active", section.id === `view-${view}`);
  }
  for (const btn of document.querySelectorAll(".topnav button, .brand")) {
    btn.classList.toggle("active", btn.dataset.nav === view);
  }
  if (view === "framing") renderFramingView();
  else if (view === "graph") renderGraphStandaloneView();
  else if (view === "entity") renderEntityDetail(arg);
  else if (view === "plans") renderPlansView(arg);
  else if (view === "session-planner") renderSessionPlanner(arg);
  else if (view === "combat-planning") renderCombatPlanning(arg);
  else if (view === "combat-planning-ingest") renderCombatPlanningIngest(arg);
  else if (view === "planner" || view === "world" || view === "chronicle" || view === "library") renderShell(view, arg);
}

// Phase 15 task 15.3: closing the mobile drawer belongs on the hashchange
// listener itself, not just the [data-nav] click handler below -- a real
// gap found via actually driving this (Playwright navigating by hash, the
// same mechanism a browser back/forward/history navigation uses) rather
// than only a click: any navigation, however triggered, must close the
// drawer, since it fires unconditionally on every real view change.
window.addEventListener("hashchange", () => {
  renderCurrentView();
  closeMobileMenu();
});
document.addEventListener("click", (e) => {
  const nav = e.target.closest("[data-nav]");
  if (nav) {
    navigate(nav.dataset.nav);
    // Belt-and-suspenders alongside the hashchange listener above: clicking
    // a nav item for the CURRENT view (e.g. "Queue" while already on Queue)
    // never fires hashchange at all (the hash string doesn't change), so
    // that listener alone wouldn't close the drawer in that specific case.
    closeMobileMenu();
  }
});

// ---------------------------------------------------------------------------
// Phase 15 task 15.3: mobile topbar drawer. Only visible/interactive at
// mobile widths (style.css's media query) -- at desktop widths
// #topbar-collapsible is `display:contents` and this toggle is inert (the
// button itself is display:none there), so this wiring changes nothing
// about desktop behavior.
// ---------------------------------------------------------------------------
const mobileMenuBtn = document.getElementById("mobile-menu-btn");
const topbarCollapsible = document.getElementById("topbar-collapsible");

function closeMobileMenu() {
  topbarCollapsible?.classList.remove("open");
  mobileMenuBtn?.setAttribute("aria-expanded", "false");
}

mobileMenuBtn?.addEventListener("click", (e) => {
  e.stopPropagation(); // don't let this same click immediately trigger the outside-click closer below
  const isOpen = topbarCollapsible.classList.toggle("open");
  mobileMenuBtn.setAttribute("aria-expanded", String(isOpen));
});

document.addEventListener("click", (e) => {
  if (!topbarCollapsible?.classList.contains("open")) return;
  if (e.target.closest("#topbar-collapsible") || e.target.closest("#mobile-menu-btn")) return;
  closeMobileMenu();
});

// ---------------------------------------------------------------------------
// toast (task 6.6): inline "Undo" for ~8s after any accept/reject
// ---------------------------------------------------------------------------

function showToast(message, undoFn) {
  const container = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = "toast";
  const msg = document.createElement("span");
  msg.textContent = message;
  el.appendChild(msg);
  if (undoFn) {
    const undo = document.createElement("a");
    undo.textContent = "Undo";
    undo.addEventListener("click", async () => {
      el.remove();
      await undoFn();
    });
    el.appendChild(undo);
  }
  container.appendChild(el);
  setTimeout(() => el.remove(), 8000);
}

/**
 * Secondary "view history" affordance (task 10.5's explicit ask: a GM
 * wanting to recall what was narrated here last time). Deliberately simple
 * for v1, per the task doc: an expandable list of past entries with
 * timestamps, fetched only on demand (not preloaded for every row).
 */
function appendNarrationHistoryToggle(entity, actionArea) {
  const wrap = document.createElement("div");
  wrap.className = "narration-history";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "link-btn";
  toggle.textContent = "View narration history";

  const list = document.createElement("div");
  list.className = "narration-history-list";
  list.hidden = true;

  toggle.addEventListener("click", async () => {
    if (!list.hidden) {
      list.hidden = true;
      toggle.textContent = "View narration history";
      return;
    }
    toggle.disabled = true;
    toggle.textContent = "Loading…";
    try {
      const { history } = await api(`/api/entities/${encodeURIComponent(entity.entityId)}/narration-history${withWorld()}`);
      list.innerHTML = "";
      // Stored oldest-first; show newest-first -- "what did we say most
      // recently" is the more natural first read for this affordance.
      for (const entry of [...history].reverse()) {
        const item = document.createElement("div");
        item.className = `narration-history-item narration-history-item--${entry.status}`;
        const meta = document.createElement("div");
        meta.className = "narration-history-meta";
        meta.textContent = `${new Date(entry.createdAt).toLocaleString()} — ${entry.status === "current" ? "current" : "superseded"}`;
        const prose = document.createElement("div");
        prose.className = "narration-history-prose";
        prose.textContent = entry.prose;
        item.append(meta, prose);
        list.appendChild(item);
      }
      if (!history.length) {
        const none = document.createElement("div");
        none.className = "hint";
        none.textContent = "No prior narrations.";
        list.appendChild(none);
      }
      list.hidden = false;
      toggle.textContent = "Hide narration history";
    } catch (err) {
      toggle.textContent = "View narration history";
      showToast(`Could not load narration history: ${err.message}`);
    } finally {
      toggle.disabled = false;
    }
  });

  wrap.append(toggle, list);
  actionArea.appendChild(wrap);
}


// ---------------------------------------------------------------------------
// SETTINGS
// ---------------------------------------------------------------------------

function recordSyncPath(path) {
  if (path !== "live" && path !== "headless") return;
  localStorage.setItem("gmReview.lastSyncPath", path);
  renderSyncStatus();
}

function renderSyncStatus() {
  const dot = document.getElementById("sync-dot");
  const text = document.getElementById("sync-text");
  const last = localStorage.getItem("gmReview.lastSyncPath");
  dot.className = `status-dot status-dot--${last || "unknown"}`;
  text.textContent = last === "live" ? "Foundry: live" : last === "headless" ? "Foundry: headless" : "Unknown until a sync happens.";
}

async function renderSettings() {
  renderSyncStatus();
  document.getElementById("undo-last-status").textContent = "";
  await renderRubberDuckToggle();
}

document.getElementById("btn-undo-last").addEventListener("click", async () => {
  if (!CURRENT_WORLD) return;
  const statusEl = document.getElementById("undo-last-status");
  try {
    const { batch } = await api(`/api/last-rollbackable-batch${withWorld()}`);
    if (!batch) { statusEl.textContent = "Nothing to undo."; return; }
    if (!confirm(`Undo the most recently accepted batch (${batch.id})? This cannot be re-done.`)) return;
    const result = await api(`/api/batches/${batch.id}/rollback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: CURRENT_WORLD })
    });
    recordSyncPath(result.path);
    statusEl.textContent = `Rolled back batch ${batch.id} (${result.path} path).`;
  } catch (err) {
    statusEl.textContent = `Undo failed: ${err.message}`;
  }
});

// Task 14.2: "Create New World" -- wires bootstrapSnapshot() (already built,
// already tested per the QA finding) into a real UI path for the first time.
// Deliberately minimal: an id field and a create button, no extra fields.
document.getElementById("btn-create-world").addEventListener("click", async () => {
  const input = document.getElementById("new-world-id");
  const statusEl = document.getElementById("new-world-status");
  const worldId = input.value.trim();
  if (!worldId) { statusEl.textContent = "Enter a world id first."; return; }
  statusEl.textContent = "Creating…";
  try {
    const result = await api("/api/worlds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: worldId })
    });
    input.value = "";
    statusEl.textContent = `Created "${result.world}". Selecting it now…`;
    await initWorldSelect();
    const select = document.getElementById("world-select");
    CURRENT_WORLD = result.world;
    select.value = result.world;
    localStorage.setItem("gmReview.world", CURRENT_WORLD);
    statusEl.textContent = `World "${result.world}" created and selected. Head to New Import to get started.`;
  } catch (err) {
    statusEl.textContent = `Create failed: ${err.message}`;
  }
});

// ---------------------------------------------------------------------------
// Phase 7 task 7.4 — standalone Graph nav view: whole-graph, batch-
// independent, defaulting to the CONFIRMED unreviewed-OR-deferred-debt
// filter (never "show everything" -- that's an explicit escape hatch).
// This is NOT a review surface: nodes here have no Accept/Reject (there's
// no batch-selection state to act on), only an optional "Show in list" if
// the entity happens to belong to a currently-open batch.
// ---------------------------------------------------------------------------

// Real usage feedback: defaulting to flagged-only meant re-hitting "Show
// everything" on every single visit. Flipped per direct request -- start
// from the whole graph, use the two checkboxes to narrow down FROM there,
// rather than starting narrow and escaping out to everything.
let graphStandaloneShowAll = true;

// ---------------------------------------------------------------------------
// Phase 12: interactive graph editor -- manual node/edge create/edit/delete
// (immediate-write, no review gate), "Undo Last Manual Edit", scan-for-
// mentioned-entities triggers, and narration reset. Every write below goes
// straight to a dedicated route and is immediate -- this is the GM directly
// authoring, not an AI proposal, per the design doc's decision 1.
// ---------------------------------------------------------------------------

const GRAPH_CACHE_KEY = "standalone";
const DEFAULT_EDGE_TYPE = "unspecified"; // matches manual-edit-ops.mjs's own addEdgeOp default

// The graph edges currently rendered in the standalone view -- kept so
// handleDrawEdge can check "does a same-type edge already exist between
// these two nodes" (task 12.3's re-drag rule) without a network round trip.
let LAST_GRAPH_EDGES = [];

async function refreshUndoStatus() {
  const btn = document.getElementById("btn-graph-undo");
  if (!btn) return;
  if (!CURRENT_WORLD) { btn.disabled = true; return; }
  try {
    const { available, action } = await api(`/api/manual-undo${withWorld()}`);
    btn.disabled = !available;
    btn.title = available ? action.description : "Nothing to undo yet";
  } catch {
    btn.disabled = true;
  }
}

async function performUndo() {
  if (!CURRENT_WORLD) return;
  try {
    const result = await api("/api/manual-undo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: CURRENT_WORLD })
    });
    showToast(result.status === "undone" ? `Undone: ${result.description}` : "Nothing to undo.");
  } catch (err) {
    showToast(`Undo failed: ${err.message}`);
  } finally {
    await refreshUndoStatus();
    if (parseHash().view === "graph") await refreshGraphStandalone();
  }
}

document.getElementById("btn-graph-undo")?.addEventListener("click", performUndo);

/**
 * Phase 13 task 13.1: the standalone Graph view's own sync bar, mirroring
 * the Review screen's #review-sync-bar/renderSyncBar/btn-sync-now exactly
 * (same markup pattern, same "Still working…" slow-notice convention) --
 * just pointed at the world's ongoing manual-edit batch (GET
 * /api/manual-edit-sync-status) instead of the currently-open reviewed
 * batch, and reusing the SAME /api/batches/:batchId/sync route (unmodified)
 * to actually push.
 */
async function refreshGraphSyncBar() {
  const bar = document.getElementById("graph-sync-bar");
  const statusEl = document.getElementById("graph-sync-status");
  if (!bar || !CURRENT_WORLD) { if (bar) bar.hidden = true; return; }
  try {
    const { batchId, unsyncedCount } = await api(`/api/manual-edit-sync-status${withWorld()}`);
    if (!unsyncedCount) { bar.hidden = true; return; }
    bar.hidden = false;
    bar.dataset.batchId = batchId;
    statusEl.textContent = `${unsyncedCount} manual edit${unsyncedCount === 1 ? "" : "s"} not yet synced to Foundry.`;
  } catch {
    bar.hidden = true;
  }
}

document.getElementById("btn-graph-sync-now")?.addEventListener("click", async () => {
  const bar = document.getElementById("graph-sync-bar");
  const btn = document.getElementById("btn-graph-sync-now");
  const statusEl = document.getElementById("graph-sync-status");
  const batchId = bar?.dataset.batchId;
  if (!batchId) return;
  btn.disabled = true;
  btn.textContent = "Syncing…";
  const slowNotice = setTimeout(() => {
    statusEl.textContent = "Still working — checking whether a live Foundry client is open for this world…";
  }, 1500);
  try {
    const result = await api(`/api/batches/${batchId}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: CURRENT_WORLD })
    });
    recordSyncPath(result.path);
    showToast(`Synced ${result.syncedCount ?? 0} manual edit${result.syncedCount === 1 ? "" : "s"} to the graph (${result.path}).`);
    await refreshGraphSyncBar();
  } catch (err) {
    statusEl.textContent = `Sync failed: ${err.message}`;
  } finally {
    clearTimeout(slowNotice);
    btn.disabled = false;
    btn.textContent = "Sync to Foundry";
  }
});

document.getElementById("btn-graph-add-node")?.addEventListener("click", () => {
  const container = document.getElementById("graph-standalone");
  if (!container) return;
  armPlacementMode(container, (point) => {
    showCreateNodeForm(container, point, {
      onCreateNode: async (pt, fields) => {
        const result = await api("/api/graph/nodes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ world: CURRENT_WORLD, ...fields })
        });
        seedNodePosition(GRAPH_CACHE_KEY, result.entityId, pt.x, pt.y);
        showToast(`Node "${result.name}" created.`, performUndo);
        await refreshUndoStatus();
        await refreshGraphStandalone();
      }
    });
  });
});

async function handleEditNode(entityId, data) {
  await api(`/api/graph/nodes/${encodeURIComponent(entityId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: CURRENT_WORLD, data })
  });
  showToast("Node updated.", performUndo);
  await refreshUndoStatus();
  await refreshGraphStandalone();
}

async function handleDeleteNode(entityId) {
  const result = await api(`/api/graph/nodes/${encodeURIComponent(entityId)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: CURRENT_WORLD })
  });
  removeNodePosition(GRAPH_CACHE_KEY, entityId);
  const cascadeNote = result.cascadeEdgeCount ? ` (with ${result.cascadeEdgeCount} edge${result.cascadeEdgeCount === 1 ? "" : "s"})` : "";
  showToast(`"${result.name}" deleted${cascadeNote}.`, performUndo);
  await refreshUndoStatus();
  await refreshGraphStandalone();
}

/**
 * Task 12.3's re-drag rule: re-dragging onto a pair that already has an edge
 * of the SAME (default) relationship type opens THAT edge for editing
 * instead of creating a duplicate. Different relationship types between the
 * same pair remain legitimately parallel -- only checked against
 * DEFAULT_EDGE_TYPE, since that's the only type a fresh drag ever creates.
 * Deliberately does NOT re-render the graph before returning -- the caller
 * (graph-view.js's wireEdgeDrawing) opens an edit-mode popover against the
 * CURRENT (still-valid) DOM/positions immediately after this resolves; a
 * full re-render here would tear that DOM down out from under the popover
 * that's about to open.
 */
async function handleDrawEdge(sourceId, targetId) {
  const existingSameType = LAST_GRAPH_EDGES.find(
    (e) =>
      e.relationshipType === DEFAULT_EDGE_TYPE &&
      ((e.sourceId === sourceId && e.targetId === targetId) || (e.sourceId === targetId && e.targetId === sourceId))
  );
  if (existingSameType) return { edge: existingSameType };

  const result = await api("/api/graph/edges", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: CURRENT_WORLD, sourceId, targetId, relationshipType: DEFAULT_EDGE_TYPE })
  });
  const edge = { id: result.edgeId, sourceId: result.sourceId, targetId: result.targetId, relationshipType: result.relationshipType, label: "", strength: 0.6, valence: "neutral", notes: null };
  LAST_GRAPH_EDGES.push(edge);
  showToast("Edge created.", performUndo);
  await refreshUndoStatus();
  await refreshGraphSyncBar();
  return { edge };
}

async function handleEditEdge(edgeId, data) {
  await api(`/api/graph/edges/${encodeURIComponent(edgeId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: CURRENT_WORLD, data })
  });
  showToast("Edge updated.", performUndo);
  await refreshUndoStatus();
  await refreshGraphStandalone();
}

async function handleDeleteEdge(edgeId) {
  await api(`/api/graph/edges/${encodeURIComponent(edgeId)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: CURRENT_WORLD })
  });
  showToast("Edge deleted.", performUndo);
  await refreshUndoStatus();
  await refreshGraphStandalone();
}

/** Task 12.5's secondary trigger ("Scan this node's content" from the node popover) -- scans the entity's OWN description field, the only text the graph popover has ready access to without a second fetch. */
async function handleScanMentionsFromPopover(entityId) {
  const controller = new AbortController();
  cancelActiveScan(); // at most one meaningful in-flight scan at a time
  activeScanController = controller;
  try {
    const { entity } = await api(`/api/entities/${encodeURIComponent(entityId)}${withWorld()}`);
    const text = [entity.description, entity.summary].filter(Boolean).join("\n\n");
    if (!text.trim()) {
      showToast("This node has no description/summary text to scan yet.");
      return;
    }
    const result = await api(`/api/entities/${encodeURIComponent(entityId)}/scan-mentions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: CURRENT_WORLD, text }),
      signal: controller.signal
    });
    navigate("chronicle", `batch/${result.batchId}`);
  } catch (err) {
    if (err.name === "AbortError") return; // navigated away -- deliberate cancellation, not a real failure
    showToast(`Scan failed: ${err.message}`);
  } finally {
    if (activeScanController === controller) activeScanController = null;
  }
}

function renderGraphStandaloneView() {
  graphStandaloneShowAll = true;
  document.getElementById("graph-filter-unreviewed").checked = false;
  document.getElementById("graph-filter-debt").checked = false;
  document.getElementById("graph-search").value = "";
  refreshGraphStandalone();
}

async function refreshGraphStandalone() {
  const container = document.getElementById("graph-standalone");
  const emptyEl = document.getElementById("graph-standalone-empty");
  const countEl = document.getElementById("graph-standalone-count");
  emptyEl.hidden = true;
  countEl.textContent = "";

  if (!CURRENT_WORLD) {
    container.innerHTML = "";
    emptyEl.hidden = false;
    emptyEl.textContent = "No world configured yet.";
    return;
  }

  let filterParam;
  if (graphStandaloneShowAll) {
    filterParam = "all";
  } else {
    const tokens = [];
    if (document.getElementById("graph-filter-unreviewed").checked) tokens.push("unreviewed");
    if (document.getElementById("graph-filter-debt").checked) tokens.push("deferred-debt");
    if (!tokens.length) {
      container.innerHTML = "";
      emptyEl.hidden = false;
      emptyEl.textContent = "No status filter selected — check Unreviewed or Deferred debt, or Show everything.";
      return;
    }
    filterParam = tokens.join(",");
  }

  let graph;
  try {
    graph = await api(`/api/graph${withWorld({ filter: filterParam })}`);
  } catch (err) {
    container.innerHTML = `<p class="hint">Could not load graph: ${escapeHtml(err.message)}</p>`;
    return;
  }
  if (!graph.nodes.length) {
    container.innerHTML = "";
    emptyEl.hidden = false;
    emptyEl.textContent = graphStandaloneShowAll ? "No entities in this world yet." : "No entities need attention right now.";
    return;
  }

  // Search/filter bar narrows client-side over whatever the server already
  // returned -- the DEFAULT status filter above is what actually bounds how
  // much gets fetched/rendered (task 7.4's real scaling lever); search never
  // needs to reduce fetch size, only which of an already-small set renders.
  const q = document.getElementById("graph-search").value.trim().toLowerCase();
  const nodes = q
    ? graph.nodes.filter((n) => n.name.toLowerCase().includes(q) || n.type.toLowerCase().includes(q))
    : graph.nodes;
  const visibleIds = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => visibleIds.has(e.sourceId) && visibleIds.has(e.targetId));

  countEl.textContent = nodes.length === graph.nodes.length
    ? `${nodes.length} node${nodes.length === 1 ? "" : "s"}`
    : `${nodes.length} of ${graph.nodes.length} nodes`;

  LAST_GRAPH_EDGES = edges;
  await refreshUndoStatus();
  await refreshGraphSyncBar();

  // Best-effort: which open batch (if any) a given entity belongs to, so
  // the popover can offer "Show in list" -- this is a status dashboard, not
  // a review surface, so Accept/Reject never appear here regardless.
  const entityToBatch = new Map();
  try {
    const { batches } = await api(`/api/batches${withWorld()}`);
    for (const b of batches.filter((x) => x.status === "open")) {
      try {
        const detail = await api(`/api/batches/${b.id}${withWorld()}`);
        for (const region of detail.regions) {
          for (const entity of region.entities) {
            if (entity.entityId) entityToBatch.set(entity.entityId, b.id);
          }
        }
      } catch { /* skip an unreadable batch, don't fail the whole view */ }
    }
  } catch { /* no open batches is a completely normal state */ }

  renderGraph(container, { nodes, edges }, {
    mode: "standalone",
    cacheKey: GRAPH_CACHE_KEY,
    findOpenBatchForNode: (nodeId) => (entityToBatch.has(nodeId) ? { batchId: entityToBatch.get(nodeId) } : null),
    onShowInList: (nodeId) => {
      const batchId = entityToBatch.get(nodeId);
      if (!batchId) return;
      // Phase 37 task 37.3: "Show in list" from the standalone graph now opens
      // that batch in Chronicle's review surface (the shared proposal-card),
      // not the retired #review screen.
      navigate("chronicle", `batch/${batchId}`);
    },
    // Phase 11 task 11.5: the entry point into "develop this node" -- only
    // ever wired here, on the STANDALONE graph's popover. Batch Review's own
    // List/Graph toggle (renderReviewGraph, mode:'batch') never passes this
    // callback at all, so the button structurally cannot appear there.
    onDevelopNode: (nodeId) => navigate("entity", nodeId),
    // Phase 12: the interactive editing surface -- standalone-mode only,
    // structurally absent from Batch Review the same way onDevelopNode is
    // (renderReviewGraph, below, never passes `editable` at all). Node
    // CREATION is armed from the toolbar's own "+ Add Node" button (see
    // that button's own listener, above) rather than from an opt here --
    // renderGraph()/showPopover() never initiate placement mode themselves,
    // only showCreateNodeForm (called directly by that listener) needs an
    // onCreateNode callback.
    editable: true,
    onEditNode: handleEditNode,
    onDeleteNode: handleDeleteNode,
    onDrawEdge: handleDrawEdge,
    onEditEdge: handleEditEdge,
    onDeleteEdge: handleDeleteEdge,
    onScanMentions: handleScanMentionsFromPopover
  });
}

document.getElementById("graph-filter-unreviewed").addEventListener("change", () => { graphStandaloneShowAll = false; refreshGraphStandalone(); });
document.getElementById("graph-filter-debt").addEventListener("change", () => { graphStandaloneShowAll = false; refreshGraphStandalone(); });
document.getElementById("btn-graph-show-everything").addEventListener("click", () => { graphStandaloneShowAll = true; refreshGraphStandalone(); });
document.getElementById("graph-search").addEventListener("input", () => refreshGraphStandalone());

// ---------------------------------------------------------------------------
// misc helpers
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function truncate(s, n) {
  const str = String(s ?? "");
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

// track every sync/rollback response globally so Settings' status dot stays fresh
const originalFetch = window.fetch;
window.fetch = function patchedFetch(...args) {
  return originalFetch.apply(this, args).then((res) => {
    if (args[0] && String(args[0]).match(/\/(sync|rollback)$/)) {
      res.clone().json().then((body) => { if (body && body.path) recordSyncPath(body.path); }).catch(() => {});
    }
    return res;
  });
};

// ---------------------------------------------------------------------------
// Phase 8 — rubber-duck mode: New Import screen, First-Reactions framing
// screen, the reject-loop's quick-pick panel on Review, and the Settings
// toggle. Reuses existing visual conventions (card styling, .btn/.hint
// classes, showToast) rather than inventing a new visual language.
// ---------------------------------------------------------------------------

/**
 * Carries state between the New Import / First Reactions screens, since
 * this is a genuinely stateless two-request flow (server holds nothing in
 * between) -- the client is what remembers "what did phase A just show me."
 * Two shapes:
 *   {kind:'new', writeupText, mode, rubberDuck, framings}   -- first submission
 *   {kind:'reframe', batchId, framings}                     -- after a plain reject
 */
let importFlowState = null;

// --- New Import -------------------------------------------------------------

function renderImportView() {
  document.getElementById("import-writeup-text").value = "";
  document.getElementById("import-status").textContent = "";
}

document.getElementById("btn-import-submit").addEventListener("click", async () => {
  const textEl = document.getElementById("import-writeup-text");
  const statusEl = document.getElementById("import-status");
  const btn = document.getElementById("btn-import-submit");
  const writeupText = textEl.value;
  if (!writeupText.trim()) {
    statusEl.textContent = "Paste a writeup first.";
    return;
  }
  if (!CURRENT_WORLD) {
    statusEl.textContent = "No world configured yet.";
    return;
  }
  btn.disabled = true;
  statusEl.textContent = "Reading the writeup…";
  try {
    const result = await api("/api/writeup-propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: CURRENT_WORLD, text: writeupText })
    });
    if (result.phase === "framing") {
      importFlowState = {
        kind: "new",
        writeupText: result.writeupText,
        mode: result.mode,
        rubberDuck: result.rubberDuck,
        framings: result.framings
      };
      navigate("framing");
      return;
    }
    // rubber-duck mode is off -- a real batch was created in one shot, same
    // as Phase 5's behavior, just reached through this new screen.
    statusEl.textContent = "";
    navigate("chronicle", `batch/${result.batchId}`);
  } catch (err) {
    statusEl.textContent = `Failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// --- First Reactions (framing selection) ------------------------------------

function renderFramingView() {
  const cardsEl = document.getElementById("framing-cards");
  const blendInput = document.getElementById("framing-blend-input");
  const submitBtn = document.getElementById("btn-framing-submit");
  const statusEl = document.getElementById("framing-status");
  cardsEl.innerHTML = "";
  blendInput.value = "";
  statusEl.textContent = "";
  submitBtn.disabled = true;

  if (!importFlowState || !Array.isArray(importFlowState.framings)) {
    cardsEl.innerHTML = `<p class="hint">Nothing to show here yet &mdash; start a <a href="#import">New Import</a>.</p>`;
    return;
  }

  for (const framing of importFlowState.framings) {
    const label = document.createElement("label");
    label.className = "framing-card";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "framing-pick";
    radio.value = framing.id;
    radio.addEventListener("change", () => { submitBtn.disabled = false; });
    const body = document.createElement("div");
    body.className = "framing-card-body";
    const idEl = document.createElement("div");
    idEl.className = "framing-card-id";
    idEl.textContent = `(${framing.id})`;
    const sentenceEl = document.createElement("div");
    sentenceEl.className = "framing-card-sentence";
    sentenceEl.textContent = framing.sentence;
    body.append(idEl, sentenceEl);
    label.append(radio, body);
    cardsEl.appendChild(label);
  }

  // Option (d): none of the above -- a fully custom framing the reviewer
  // writes themselves, not anchored to any of the three generated readings.
  // Distinct from the blend line below, which only ever supplements a
  // picked a/b/c primary -- this replaces the primary entirely.
  const customLabel = document.createElement("label");
  customLabel.className = "framing-card framing-card--custom";
  const customRadio = document.createElement("input");
  customRadio.type = "radio";
  customRadio.name = "framing-pick";
  customRadio.value = "__custom__";
  const customBody = document.createElement("div");
  customBody.className = "framing-card-body";
  const customIdEl = document.createElement("div");
  customIdEl.className = "framing-card-id";
  customIdEl.textContent = "(d)";
  const customInput = document.createElement("input");
  customInput.type = "text";
  customInput.id = "framing-custom-input";
  customInput.placeholder = "None of these — describe your own direction";
  customInput.addEventListener("input", () => {
    if (customInput.value.trim()) {
      customRadio.checked = true;
      submitBtn.disabled = false;
    }
  });
  customRadio.addEventListener("change", () => {
    submitBtn.disabled = !customInput.value.trim();
    if (customRadio.checked) customInput.focus();
  });
  customBody.append(customIdEl, customInput);
  customLabel.append(customRadio, customBody);
  cardsEl.appendChild(customLabel);
}

document.getElementById("btn-framing-submit").addEventListener("click", async () => {
  const statusEl = document.getElementById("framing-status");
  const btn = document.getElementById("btn-framing-submit");
  if (!importFlowState) return;
  const picked = document.querySelector('input[name="framing-pick"]:checked');
  if (!picked) {
    statusEl.textContent = "Pick a framing first.";
    return;
  }
  let primary;
  if (picked.value === "__custom__") {
    const customText = document.getElementById("framing-custom-input").value.trim();
    if (!customText) {
      statusEl.textContent = "Write your own direction first.";
      return;
    }
    primary = { id: "d", sentence: customText };
  } else {
    primary = importFlowState.framings.find((f) => f.id === picked.value);
  }
  const blend = document.getElementById("framing-blend-input").value.trim();
  const selection = { primary, ...(blend ? { blend } : {}) };

  const body = { world: CURRENT_WORLD, framings: importFlowState.framings, selection };
  if (importFlowState.kind === "reframe") {
    body.batchId = importFlowState.batchId;
  } else {
    body.writeupText = importFlowState.writeupText;
    body.mode = importFlowState.mode;
    body.rubberDuck = importFlowState.rubberDuck;
  }

  btn.disabled = true;
  statusEl.textContent = "Running the real extraction… this can take a while.";
  try {
    const result = await api("/api/writeup-select-framing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    importFlowState = null;
    navigate("chronicle", `batch/${result.batchId}`);
  } catch (err) {
    statusEl.textContent = `Failed: ${err.message}`;
    btn.disabled = false;
  }
});


// --- Settings toggle ----------------------------------------------------------

async function renderRubberDuckToggle() {
  const checkbox = document.getElementById("rubber-duck-toggle");
  const statusEl = document.getElementById("rubber-duck-status");
  statusEl.textContent = "";
  try {
    const settings = await api("/api/settings/rubber-duck");
    checkbox.checked = !!settings.enabled;
  } catch (err) {
    statusEl.textContent = `Could not load: ${err.message}`;
  }
}

document.getElementById("rubber-duck-toggle").addEventListener("change", async (e) => {
  const statusEl = document.getElementById("rubber-duck-status");
  const desired = e.target.checked;
  try {
    const settings = await api("/api/settings/rubber-duck", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: desired })
    });
    statusEl.textContent = settings.enabled ? "Rubber-duck mode is ON." : "Rubber-duck mode is OFF.";
  } catch (err) {
    e.target.checked = !desired; // revert on failure
    statusEl.textContent = `Failed to update: ${err.message}`;
  }
});

// ---------------------------------------------------------------------------
// Phase 11 — per-node content generation ("develop this node"). Reached ONLY
// from the standalone Graph view's node popover (graph-view.js's
// onDevelopNode, wired in refreshGraphStandalone above) -- deliberately
// NEVER from Batch Review (List or Graph mode), matching the design doc's
// "triggered after commit, not in Batch Review" requirement. This whole
// section is a single-entity flow: propose framings -> pick/blend -> generate
// -> accept -> per-field regenerate. No bulk/multi-entity affordance exists
// anywhere here (a hard design constraint, not a nice-to-have) -- every
// action below always targets exactly one entityId.
// ---------------------------------------------------------------------------

// Ephemeral client-side flow state for the currently-viewed entity's framing
// pick, mirroring importFlowState's own role for writeup-import (Phase 8):
// this is a genuinely stateless two-request flow server-side (no batch/
// object persisted until generation actually runs), so the client is what
// remembers "what did propose-framings/reframe just show me."
let prepFlowState = null; // {entityId, framings, priorRoundCount} | null

const PREP_FIELD_LABELS = {
  descriptionAppearance: "Description / Appearance",
  personalityMannerisms: "Personality & Mannerisms",
  motivationGoal: "Motivation / Goal",
  secret: "Secret",
  potentialRolls: "Potential Rolls",
  hook: "Hook",
  descriptionAtmosphere: "Description / Atmosphere",
  notableFeatures: "Notable Features",
  potentialEncounter: "Potential Encounter",
  publicFaceGoals: "Public Face / Goals",
  internalConflictSecret: "Internal Conflict / Secret",
  resourcesReach: "Resources / Reach",
  hookConsequence: "Hook / Consequence",
  appearance: "Appearance",
  mechanicalProperties: "Mechanical / Plot Properties",
  originSecret: "Origin / Secret",
  discovery: "Discovery",
  publicAccount: "Public Account",
  actualTruth: "Actual Truth",
  rippleConsequences: "Ripple Consequences",
  description: "Description",
  howItSurfaces: "How It Surfaces"
};

async function renderEntityDetail(entityId) {
  const nameEl = document.getElementById("entity-detail-name");
  const metaEl = document.getElementById("entity-detail-meta");
  const bodyEl = document.getElementById("entity-detail-body");
  nameEl.textContent = "Loading…";
  metaEl.textContent = "";
  bodyEl.innerHTML = "";

  if (!entityId) {
    nameEl.textContent = "No entity selected.";
    metaEl.textContent = "Open this from the Graph view.";
    return;
  }
  if (!CURRENT_WORLD) {
    nameEl.textContent = "No world configured yet.";
    return;
  }

  // Leaving one entity's in-progress framing pick behind when navigating to
  // another -- flow state is scoped to whichever entity it belongs to.
  if (prepFlowState && prepFlowState.entityId !== entityId) prepFlowState = null;

  let entity;
  try {
    ({ entity } = await api(`/api/entities/${encodeURIComponent(entityId)}${withWorld()}`));
  } catch (err) {
    nameEl.textContent = "Entity not found";
    metaEl.textContent = err.message;
    return;
  }

  nameEl.textContent = entity.name;
  metaEl.textContent = entity.type + (entity.description ? ` — ${entity.description}` : "");

  await renderEntityNarrationSection(entity);
  await renderPrepContentSection(entity, bodyEl);
}

/**
 * Phase 12 task 12.6: the entity-detail view's PRIMARY location for
 * narration display + reset (the design doc's "entity detail view
 * (primary) and graph popover (secondary quick-path)" -- the graph
 * popover's own quick-path isn't built in this pass, matching the phase's
 * effort budget; the primary surface is fully functional). Fetches the
 * entity's current narration (Phase 10's existing GET route) and renders it
 * with Phase 6's established serif/parchment narration-card treatment, plus
 * a lighter-weight reset confirm than delete's, per the design doc's own
 * wording.
 */
/**
 * Task 14.7: the "Narrate This" button + status row for the standalone
 * entity-detail page. Never silently does nothing on failure -- a clean
 * 404 (NoNarratableBatchError, "nothing accepted for this entity yet") gets
 * its own clear, specific message rather than a generic "failed" string,
 * matching the task's own hard requirement.
 */
function appendNarrateThisButton(entity, wrap) {
  const row = document.createElement("div");
  row.className = "narrate-this-row";
  const btn = document.createElement("button");
  btn.className = "btn btn--ghost";
  btn.textContent = "Narrate This";
  const statusEl = document.createElement("span");
  statusEl.className = "hint";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    statusEl.textContent = "";
    const slowNotice = setTimeout(() => {
      statusEl.textContent = "Still working — narration calls typically take several seconds…";
    }, 1500);
    try {
      await api(`/api/entities/${encodeURIComponent(entity.id)}/narrate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: CURRENT_WORLD })
      });
      clearTimeout(slowNotice);
      showToast("Narrated.");
      await renderEntityNarrationSection(entity); // re-fetch + re-render, including this same button
    } catch (err) {
      clearTimeout(slowNotice);
      btn.disabled = false;
      statusEl.textContent = err.status === 404 && err.body?.name === "NoNarratableBatchError"
        ? "Nothing to narrate yet — this entity has no accepted change in any batch. Accept a mutation touching it first (via Batch Review, a manual edit, or an import), then try again."
        : `Narrate failed: ${err.message}`;
    }
  });
  row.append(btn, statusEl);
  wrap.appendChild(row);
}

async function renderEntityNarrationSection(entity) {
  const wrap = document.getElementById("entity-detail-narration");
  wrap.innerHTML = "";

  let narration = null;
  try {
    ({ narration } = await api(`/api/entities/${encodeURIComponent(entity.id)}/narration${withWorld()}`));
  } catch { /* treat a fetch failure as "no narration yet" */ }

  const label = document.createElement("h2");
  label.className = "section-label";
  label.textContent = "Narration";
  wrap.appendChild(label);

  // Task 14.7 (QA-pass finding): "Narrate This" was completely unreachable
  // from this page -- narrateEntity() needs a specific accepted mutation
  // within a specific batch, and this page has no batch context of its own.
  // POST /api/entities/:id/narrate (server-side) looks up the most recent
  // batch that genuinely addressed this entity and narrates that. Always
  // rendered here (whether or not a current narration already exists) --
  // works the same as a fresh narrate OR a deliberate re-narrate.
  appendNarrateThisButton(entity, wrap);

  // Real gap found via visual verification: this function used to `return`
  // early right here for the "no current narration" case (including
  // immediately after a reset, whose whole point is to CLEAR current down
  // to nothing) -- which meant the "View narration history" toggle below
  // never even got a chance to render, so there was no way to see that the
  // reset genuinely preserved every prior version. Both branches below now
  // always reach the history toggle at the bottom of this function.
  if (!narration || !narration.prose) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No current narration for this entity.";
    wrap.appendChild(empty);
    appendNarrationHistoryToggle({ entityId: entity.id }, wrap);
    return;
  }

  const card = document.createElement("div");
  card.className = "narration-card";
  card.textContent = narration.prose;
  wrap.appendChild(card);

  const row = document.createElement("div");
  row.className = "narration-reset-row";
  const resetBtn = document.createElement("button");
  resetBtn.className = "btn btn--ghost";
  resetBtn.textContent = "Reset Narration";
  resetBtn.addEventListener("click", () => {
    row.innerHTML = "";
    const confirmWrap = document.createElement("div");
    confirmWrap.className = "narration-reset-confirm";
    const msg = document.createElement("span");
    msg.className = "hint";
    msg.textContent = "Clear current narration? Previous versions remain in history.";
    const confirmBtn = document.createElement("button");
    confirmBtn.className = "btn btn--reject";
    confirmBtn.textContent = "Clear";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn--ghost";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => renderEntityNarrationSection(entity));
    confirmBtn.addEventListener("click", async () => {
      confirmBtn.disabled = true;
      try {
        await api(`/api/entities/${encodeURIComponent(entity.id)}/narration/reset`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ world: CURRENT_WORLD })
        });
        showToast("Narration reset.", performUndo);
        await refreshUndoStatus();
        await renderEntityNarrationSection(entity);
      } catch (err) {
        confirmBtn.disabled = false;
        showToast(`Reset failed: ${err.message}`);
      }
    });
    confirmWrap.append(msg, confirmBtn, cancelBtn);
    row.appendChild(confirmWrap);
  });
  row.appendChild(resetBtn);
  wrap.appendChild(row);

  // Reuses Phase 10's existing "View narration history" affordance verbatim
  // (same function, same entityId-keyed route) -- proves reset never
  // deletes anything, right on the same page a reset was just performed.
  appendNarrationHistoryToggle({ entityId: entity.id }, wrap);
}

async function renderPrepContentSection(entity, container) {
  container.innerHTML = `<p class="hint">Loading prep content…</p>`;

  if (prepFlowState && prepFlowState.entityId === entity.id) {
    renderPrepFramingPicker(entity, container, prepFlowState);
    return;
  }

  let prepContent = null;
  try {
    const result = await api(`/api/entities/${encodeURIComponent(entity.id)}/prep${withWorld()}`);
    prepContent = result.prepContent;
  } catch {
    // treat a fetch failure the same as "never developed" -- still offer the develop button
  }

  if (!container.isConnected) return; // navigated away while this fetch was in flight

  if (!prepContent) {
    renderDevelopButton(entity, container);
    return;
  }
  renderPrepContentCard(entity, container, prepContent);
}

function renderDevelopButton(entity, container) {
  container.innerHTML = "";
  const intro = document.createElement("p");
  intro.className = "hint";
  intro.textContent = "No prep content yet for this entity — description, secrets, potential rolls, and hooks, tailored to its type.";
  container.appendChild(intro);

  const btn = document.createElement("button");
  btn.className = "btn btn--accept";
  btn.textContent = "Develop This Node";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Reading the graph…";
    try {
      const result = await api(`/api/entities/${encodeURIComponent(entity.id)}/prep/propose-framings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: CURRENT_WORLD })
      });
      prepFlowState = { entityId: entity.id, framings: result.framings, priorRoundCount: result.framingRound };
      renderPrepFramingPicker(entity, container, prepFlowState);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Develop This Node";
      showToast(`Failed: ${err.message}`);
    }
  });
  container.appendChild(btn);
}

/**
 * The framing-pick step -- reuses Phase 8's exact "First Reactions" visual
 * pattern (.framing-cards/.framing-card CSS, the same radio-card + custom
 * "(d) none of these" affordance) rather than inventing a second one, per
 * task 11.5's explicit instruction.
 */
function renderPrepFramingPicker(entity, container, flow) {
  container.innerHTML = "";

  const intro = document.createElement("p");
  intro.className = "hint";
  intro.textContent = "Three quick angles on this entity. Pick one, or blend, then generate the full prep content.";
  container.appendChild(intro);

  const cardsEl = document.createElement("div");
  cardsEl.className = "framing-cards";

  for (const framing of flow.framings) {
    const label = document.createElement("label");
    label.className = "framing-card";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "prep-framing-pick";
    radio.value = framing.id;
    const body = document.createElement("div");
    body.className = "framing-card-body";
    const idEl = document.createElement("div");
    idEl.className = "framing-card-id";
    idEl.textContent = `(${framing.id})`;
    const sentenceEl = document.createElement("div");
    sentenceEl.className = "framing-card-sentence";
    sentenceEl.textContent = framing.sentence;
    body.append(idEl, sentenceEl);
    label.append(radio, body);
    cardsEl.appendChild(label);
  }

  const customLabel = document.createElement("label");
  customLabel.className = "framing-card framing-card--custom";
  const customRadio = document.createElement("input");
  customRadio.type = "radio";
  customRadio.name = "prep-framing-pick";
  customRadio.value = "__custom__";
  const customBody = document.createElement("div");
  customBody.className = "framing-card-body";
  const customIdEl = document.createElement("div");
  customIdEl.className = "framing-card-id";
  customIdEl.textContent = "(d)";
  const customInput = document.createElement("input");
  customInput.type = "text";
  customInput.id = "prep-framing-custom-input";
  customInput.placeholder = "None of these — describe your own direction";
  customBody.append(customIdEl, customInput);
  customLabel.append(customRadio, customBody);
  cardsEl.appendChild(customLabel);
  container.appendChild(cardsEl);

  const blendWrap = document.createElement("div");
  blendWrap.className = "framing-blend";
  const blendLabel = document.createElement("label");
  blendLabel.setAttribute("for", "prep-framing-blend-input");
  blendLabel.textContent = "Also blend in (optional):";
  const blendInput = document.createElement("input");
  blendInput.type = "text";
  blendInput.id = "prep-framing-blend-input";
  blendInput.placeholder = "e.g. also bring in the debt angle";
  blendWrap.append(blendLabel, blendInput);
  container.appendChild(blendWrap);

  const actions = document.createElement("div");
  actions.className = "import-actions";
  const genBtn = document.createElement("button");
  genBtn.className = "btn btn--accept";
  genBtn.textContent = "Generate";
  genBtn.disabled = true;
  const statusEl = document.createElement("span");
  statusEl.className = "hint";
  actions.append(genBtn, statusEl);
  container.appendChild(actions);

  function updateGenEnabled() {
    const picked = cardsEl.querySelector("input:checked");
    genBtn.disabled = !picked || (picked.value === "__custom__" && !customInput.value.trim());
  }
  cardsEl.addEventListener("change", updateGenEnabled);
  customInput.addEventListener("input", () => {
    if (customInput.value.trim()) customRadio.checked = true;
    updateGenEnabled();
  });

  genBtn.addEventListener("click", async () => {
    const picked = cardsEl.querySelector("input:checked");
    if (!picked) return;
    let primary;
    if (picked.value === "__custom__") {
      const customText = customInput.value.trim();
      if (!customText) { statusEl.textContent = "Write your own direction first."; return; }
      primary = { id: "d", sentence: customText };
    } else {
      primary = flow.framings.find((f) => f.id === picked.value);
    }
    const blend = blendInput.value.trim();
    const selection = { primary, ...(blend ? { blend } : {}) };

    genBtn.disabled = true;
    statusEl.textContent = "Generating… this can take a while.";
    try {
      const doc = await api(`/api/entities/${encodeURIComponent(entity.id)}/prep/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: CURRENT_WORLD, selection })
      });
      prepFlowState = null;
      renderPrepContentCard(entity, container, doc);
    } catch (err) {
      genBtn.disabled = false;
      statusEl.textContent = `Failed: ${err.message}`;
    }
  });

  const reframeRow = document.createElement("div");
  reframeRow.className = "import-actions";
  const reframeBtn = document.createElement("button");
  reframeBtn.className = "btn";
  reframeBtn.textContent = "None of these — try again";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "link-btn";
  cancelBtn.textContent = "Cancel";
  reframeRow.append(reframeBtn, cancelBtn);
  container.appendChild(reframeRow);

  reframeBtn.addEventListener("click", async () => {
    reframeBtn.disabled = true;
    try {
      const result = await api(`/api/entities/${encodeURIComponent(entity.id)}/prep/reframe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: CURRENT_WORLD, priorRoundCount: flow.priorRoundCount })
      });
      prepFlowState = { entityId: entity.id, framings: result.framings, priorRoundCount: result.framingRound };
      renderPrepFramingPicker(entity, container, prepFlowState);
    } catch (err) {
      reframeBtn.disabled = false;
      if (err.status === 409) {
        showToast("Already used the one bounded re-try — pick one of the current framings, or write your own.");
      } else {
        showToast(`Failed: ${err.message}`);
      }
    }
  });

  cancelBtn.addEventListener("click", () => {
    prepFlowState = null;
    renderDevelopButton(entity, container);
  });
}

const PREP_STATUS_LABEL = {
  proposed: "Draft — not yet accepted",
  accepted: "Accepted",
  stale: "Accepted"
};

function summarizeFraming(framingUsed) {
  // framingUsed is the full composed steering note (composePrepFramingNote's
  // output, e.g. `The reviewer's chosen framing for developing this entity:
  // "..." Steer the generated content toward this reading.`) -- pull out
  // just the quoted sentence for a compact one-line summary here.
  const match = /"([^"]+)"/.exec(framingUsed || "");
  return match ? match[1] : framingUsed || "(no framing recorded)";
}

/** Renders the type-specific fields, per-field regenerate controls (once accepted), and the accept/discard bar (while still 'proposed'). */
function renderPrepContentCard(entity, container, doc) {
  container.innerHTML = "";

  if (doc.status === "stale") {
    const badge = document.createElement("div");
    badge.className = "prep-stale-badge";
    badge.textContent = "This entity has changed since this prep content was written — it may be out of date. Nothing below was deleted; regenerate a field to refresh it.";
    container.appendChild(badge);
  }

  const meta = document.createElement("div");
  meta.className = "hint prep-content-meta";
  meta.textContent = `${PREP_STATUS_LABEL[doc.status] ?? doc.status} · framed as: "${summarizeFraming(doc.framingUsed)}"`;
  container.appendChild(meta);

  const fieldsWrap = document.createElement("div");
  fieldsWrap.className = "prep-fields";
  for (const [fieldName, value] of Object.entries(doc.fields)) {
    fieldsWrap.appendChild(renderPrepField(entity, doc, container, fieldName, value));
  }
  container.appendChild(fieldsWrap);

  // Phase 12 task 12.5: PRIMARY trigger, next to the already-displayed
  // generated text -- the design doc's explicit reason this whole feature
  // exists ("reading generated content that mentions an 'arena champion' or
  // a quartermaster with no way to turn those into real, linked graph
  // entities"). Only offered once content is ACCEPTED (not a still-'proposed'
  // draft that might be discarded outright) -- scanning throwaway text for
  // entities to create would be premature.
  if (doc.status !== "proposed") {
    const scanRow = document.createElement("div");
    scanRow.className = "row-actions";
    const scanBtn = document.createElement("button");
    scanBtn.className = "btn";
    scanBtn.textContent = "Scan for Mentioned Entities";
    scanBtn.addEventListener("click", async () => {
      scanBtn.disabled = true;
      scanBtn.textContent = "Scanning…";
      const controller = new AbortController();
      cancelActiveScan(); // at most one meaningful in-flight scan at a time
      activeScanController = controller;
      try {
        const text = Object.values(doc.fields)
          .map((v) => (Array.isArray(v) ? v.map((r) => `${r.skill} (DC ${r.dc}): ${r.purpose}`).join("; ") : v))
          .join("\n\n");
        const result = await api(`/api/entities/${encodeURIComponent(entity.id)}/scan-mentions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ world: CURRENT_WORLD, text }),
          signal: controller.signal
        });
        navigate("chronicle", `batch/${result.batchId}`);
      } catch (err) {
        if (err.name === "AbortError") return; // navigated away -- deliberate cancellation, not a real failure
        scanBtn.disabled = false;
        scanBtn.textContent = "Scan for Mentioned Entities";
        showToast(`Scan failed: ${err.message}`);
      } finally {
        if (activeScanController === controller) activeScanController = null;
      }
    });
    scanRow.appendChild(scanBtn);
    container.appendChild(scanRow);
  }

  if (doc.status === "proposed") {
    const actions = document.createElement("div");
    actions.className = "row-actions";

    const acceptBtn = document.createElement("button");
    acceptBtn.className = "btn btn--accept";
    acceptBtn.textContent = "Accept";
    acceptBtn.addEventListener("click", async () => {
      acceptBtn.disabled = true;
      try {
        const updated = await api(`/api/entities/${encodeURIComponent(entity.id)}/prep/accept`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ world: CURRENT_WORLD })
        });
        showToast("Prep content accepted.");
        renderPrepContentCard(entity, container, updated);
      } catch (err) {
        acceptBtn.disabled = false;
        showToast(`Failed: ${err.message}`);
      }
    });

    const discardBtn = document.createElement("button");
    discardBtn.className = "btn btn--reject";
    discardBtn.textContent = "Discard Draft";
    discardBtn.addEventListener("click", async () => {
      if (!confirm("Discard this draft? It was never accepted, so nothing about the entity itself changes.")) return;
      try {
        await api(`/api/entities/${encodeURIComponent(entity.id)}/prep/discard`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ world: CURRENT_WORLD })
        });
        showToast("Draft discarded.");
        renderDevelopButton(entity, container);
      } catch (err) {
        showToast(`Failed: ${err.message}`);
      }
    });

    actions.append(acceptBtn, discardBtn);
    container.appendChild(actions);
  }
}

/** One field's card: label, rendered value (plain text, or a roll list for an array field), and — only once accepted, per the design doc's "field-granular regeneration after the initial full-block accept" — its own independent regenerate control. */
function renderPrepField(entity, doc, container, fieldName, value) {
  const card = document.createElement("div");
  card.className = "prep-field-card";

  const label = document.createElement("div");
  label.className = "prep-field-label";
  label.textContent = PREP_FIELD_LABELS[fieldName] ?? fieldName;
  card.appendChild(label);

  const valueEl = document.createElement("div");
  valueEl.className = "prep-field-value";
  if (Array.isArray(value)) {
    if (value.length) {
      const ul = document.createElement("ul");
      ul.className = "prep-roll-list";
      for (const roll of value) {
        const li = document.createElement("li");
        li.innerHTML = `<strong>${escapeHtml(roll.skill)}</strong> DC ${escapeHtml(String(roll.dc))} — ${escapeHtml(roll.purpose)}`;
        ul.appendChild(li);
      }
      valueEl.appendChild(ul);
    } else {
      valueEl.textContent = "(none)";
    }
  } else {
    valueEl.textContent = value;
  }
  card.appendChild(valueEl);

  if (doc.status !== "proposed") {
    const regenBox = document.createElement("div");
    regenBox.className = "regenerate-box";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Steering note for this field (optional)…";
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.textContent = "Regenerate";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Regenerating…";
      try {
        const updated = await api(`/api/entities/${encodeURIComponent(entity.id)}/prep/regenerate-field`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ world: CURRENT_WORLD, fieldName, note: input.value })
        });
        // Re-render the WHOLE card from the server's updated doc (the
        // source of truth) -- confirms visually and structurally that only
        // this one field changed, since every OTHER field's own markup is
        // rebuilt from the exact same values it already had.
        renderPrepContentCard(entity, container, updated);
        showToast(`Regenerated "${PREP_FIELD_LABELS[fieldName] ?? fieldName}" — every other field left untouched.`);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Regenerate";
        showToast(`Failed: ${err.message}`);
      }
    });
    regenBox.append(input, btn);
    card.appendChild(regenBox);
  }

  return card;
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

(async function boot() {
  await initWorldSelect();
  // Reflect the new default in the URL bar so a refresh/bookmark stays on the
  // designer app (parseHash already renders it; this just makes the hash explicit).
  //
  // QA W2 fix (Group C #16): setting `location.hash` from empty to a real
  // value fires the `hashchange` listener below (asynchronously) -- the
  // unconditional renderCurrentView() call that used to follow it
  // UNCONDITIONALLY fired a SECOND, redundant render immediately, so a cold
  // boot with no prior hash rendered (and fetched everything it fetches)
  // TWICE. Only call directly when no hash change is about to happen (an
  // already-set hash, e.g. a bookmark/refresh) -- otherwise let the single
  // hashchange event do the one real render.
  if (!location.hash) {
    location.hash = "planner/plans";
  } else {
    renderCurrentView();
  }
})();
