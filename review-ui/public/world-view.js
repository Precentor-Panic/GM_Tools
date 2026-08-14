// GM Review — Phase 30 task 30.4: the World surface (Claude-Designer
// containment-tree view, `design/session-planner/World Graph.dc.html`). The
// second half of the Session planner | World shell, replacing the old
// force-directed #graph as the primary "where things are" view.
//
// One router, not two: app-shell.js's renderShell(view="world", arg) calls
// the exported renderWorldSurface(entityId) here; this module owns the World
// surface DOM inside #shell-main plus the World-only topbar controls (search
// box + type-filter chips) in the shell topbar's world slot. It holds no
// independent routing or world-selection -- world selection is the SAME
// localStorage["gmReview.world"] key every sibling view reads, and location
// (#world/<entityId>) is the single source of truth for selection.
//
// KEY TRANSLATION from the prototype: the prototype models containment as a
// `parentId` per node; the real repo models it as EDGES
// (relationshipType:"containment", child = sourceId -> parent = targetId).
// The tree is derived client-side by grouping nodes under the parent their
// containment edge points at; a node that is no containment edge's sourceId
// is a root. Reuses showUndoToast (plans-view.js), createFlushableDebounce
// (debounced-save.mjs) and colorForType (graph-view.js, the fallback hue for
// entity types outside the six canonical designer types).
"use strict";
import { showUndoToast } from "./plans-view.js";
import { createFlushableDebounce } from "./debounced-save.mjs";
// Friction Wave 1 (W5b): renderGraph is the SAME shared implementation the
// standalone Graph nav view uses (Phase 7/12/13) -- the World tab's Graph
// rail mode REUSES it against the already-fetched world graph, never a fork.
import { colorForType, renderGraph } from "./graph-view.js";
// Phase 35 task 35.3: the World inspector's own bespoke buildSceneTray/srow
// implementation is RETIRED in favor of the shared component ("one tray" —
// README's "implement once", scene-tray.js's own header). A graph-node drag
// is NOT one of the shared tray's roster kinds (creature/hero/asset) — see
// scene-tray.js's own header for the `onExternalDrop` hook this file wires
// `addToScene` (the existing, UNCHANGED `.../elements/from-graph` route) into
// so the phase33 "drop a node -> real kind:'graph' scene-element" pin
// survives the unification unchanged.
import { mountSceneTray, setTrayDragPayload } from "./scene-tray.js";
// Friction Wave 1 (W5a): the tree derivation (containment/Loyalty parent
// maps + containment-CYCLE detection) lives in the DOM-free world-tree.mjs
// so it's unit-testable under plain Node — see that module's header for the
// Kilmarn <-> Underbreach silent-disappearance bug the cycle handling fixes.
import { buildDerived, LOYALTY_PARENT_EDGE } from "./world-tree.mjs";

// ---------------------------------------------------------------------------
// Canonical designer type vocabulary (README §F glyph set + oklch accents).
// Unknown types fall back to colorForType()'s deterministic hue + the concept
// glyph, so a per-world custom entity type still renders sensibly.
// ---------------------------------------------------------------------------
const TYPES = {
  place: { label: "Place", glyph: "▢", accent: "oklch(0.55 0.075 185)" },   // ▢ teal
  person: { label: "Person", glyph: "◉", accent: "oklch(0.60 0.10 65)" },   // ◉ amber
  object: { label: "Object", glyph: "◆", accent: "oklch(0.52 0.08 300)" },  // ◆ violet
  faction: { label: "Faction", glyph: "⬗", accent: "oklch(0.50 0.09 145)" }, // ⬗ green
  event: { label: "Event", glyph: "✧", accent: "oklch(0.55 0.11 40)" },     // ✧ rust
  concept: { label: "Concept", glyph: "◌", accent: "oklch(0.55 0.03 260)" } // ◌ slate
};
const TYPE_ORDER = ["place", "person", "object", "faction", "event", "concept"];
function typeMeta(type) {
  if (TYPES[type]) return TYPES[type];
  return { label: type || "Node", glyph: "◌", accent: colorForType(type) };
}

// ---------------------------------------------------------------------------
// world/api helpers (same standalone convention as app-shell.js/plans-view.js)
// ---------------------------------------------------------------------------
function currentWorld() {
  return localStorage.getItem("gmReview.world") || null;
}
async function wApi(path, opts) {
  const res = await fetch(path, opts);
  let body = null;
  try { body = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return body;
}
function withWorld(params) {
  const p = new URLSearchParams(params || {});
  const w = currentWorld();
  if (w) p.set("world", w);
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}
function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "style") node.style.cssText = v;
    else node.setAttribute(k, v);
  }
  if (text != null) node.textContent = text;
  return node;
}
function goto(hash) { location.hash = hash; }
function short(name) {
  return name && name.length > 22 ? name.slice(0, 20) + "…" : (name || "");
}
// Friction Wave 1 (W5c): the world-name guard, World-tab half. True when an
// entity's name equals the current world id/name case-insensitively (the
// real kilmarn/"Kilmarn" ambiguity Russell chased while diagnosing W5a's
// containment bug). Non-blocking: a subtle marker, never a validation.
function sharesWorldName(n) {
  const w = currentWorld();
  return !!(w && n && n.name && n.name.trim().toLowerCase() === w.trim().toLowerCase());
}
const WORLD_NAME_MARKER_TITLE =
  "Shares the world's name — this is an entity in the world, not the world record itself. " +
  "Allowed, but searches and diagnoses can conflate the two.";

// ---------------------------------------------------------------------------
// State. Persistent UI bits survive a hash-driven re-mount (selecting a node
// sets #world/<id>, which re-runs renderShell -> renderWorldSurface); only
// selectedId comes from the URL. Cache avoids refetching the graph on every
// selection. Both reset when the world changes.
// ---------------------------------------------------------------------------
const ui = {
  world: null,
  expanded: new Set(),
  query: "",
  types: new Set(),
  looseOpen: true,
  looseFilter: null,
  // Phase 38 task 38.3: "spatial" | "loyalty" -- which derived tree the LEFT
  // tree pane renders. View-local UI state (like expanded/query), reset to
  // "spatial" on resetForWorld -- a world switch never carries Loyalty mode
  // over. SPATIAL IS THE DEFAULT; every phase30/31/33-pinned containment
  // behavior is untouched unless the GM explicitly switches.
  treeMode: "spatial",
  // Friction Wave 1 (W5b): the sub-bar rail selector -- "spatial" | "loyalty"
  // | "graph". Spatial/Loyalty show the tree body (treeMode tracks them);
  // Graph swaps the whole body for the shared full-graph view. Superseded
  // the old (clipping) in-tree-head Spatial/Loyalty toggle.
  railMode: "spatial"
};
const cache = { world: null, graph: null, derived: null, loyaltyDerived: null, scenes: null, usedInScene: null };
let selectedId = null;
let mountToken = 0;
let descSaver = null;
let descSaverForId = null;
// D5-D8 (Phase 34 task 34.3): the HYBRID remove-from-graph's in-place
// two-click arm state -- which entity id (if any) is currently armed. Reset
// whenever the selection changes (a different node, or navigating away) so
// arming never survives a selection swap; Esc/click-elsewhere clear it too
// (wired in renderInspector). `appearsCache` shares the SAME "Appears in"
// fetch between the inspector's own display and the arm's consequence-line
// N count -- no second route call for the same data.
let removeArmedId = null;
// The armed opt-in ("also remove from all N scenes") lives HERE, not only in
// the DOM: any async inspector re-render while armed (the consequence line's
// own awaited appearances fetch, a chip refresh) rebuilds the checkbox and a
// DOM-only checked state would silently reset -- a real race the phase34 e2e
// surfaced intermittently under load (check -> re-render -> execute read a
// fresh unchecked box). The module var survives re-renders; it resets on
// arm/disarm/selection-change so it can never leak across nodes.
let removeAlsoScenes = false;
let appearsCache = { id: null, promise: null };

function resetForWorld(world) {
  ui.world = world;
  ui.expanded = new Set();
  ui.query = "";
  ui.types = new Set();
  ui.looseOpen = true;
  ui.looseFilter = null;
  ui.expandedInit = false;
  ui.treeMode = "spatial";
  ui.railMode = "spatial";
  cache.world = null;
  cache.graph = null;
  cache.derived = null;
  cache.loyaltyDerived = null;
  cache.scenes = null;
  cache.usedInScene = null;
  removeArmedId = null;
  removeAlsoScenes = false;
  appearsCache = { id: null, promise: null };
}

// ---------------------------------------------------------------------------
// Tree derivation: see world-tree.mjs (buildDerived + LOYALTY_PARENT_EDGE
// imported above). Everything below reads the derived maps exactly as
// before; the ONLY W5a addition surfaced here is `derived.cycleBreaks`
// (buildTreeRow's warning badge).
// ---------------------------------------------------------------------------
function d() { return cache.derived; }
function node(id) { return d().nodesById.get(id); }
function parentIdOf(id) {
  const p = d().parentOf.get(id);
  return p != null && d().nodesById.has(p) ? p : null;
}
function childIdsOf(id) {
  return (d().childrenOf.get(id) || []).filter((cid) => d().nodesById.has(cid));
}
function rootIds() {
  return [...d().nodesById.keys()].filter((id) => parentIdOf(id) === null);
}
function ancestorChain(id) {
  const chain = [];
  let p = parentIdOf(id);
  const seen = new Set([id]);
  while (p && !seen.has(p)) { chain.unshift(p); seen.add(p); p = parentIdOf(p); }
  return chain;
}

// ---------------------------------------------------------------------------
// TREE-SCOPED helpers (Phase 38 task 38.3): everything the LEFT tree pane
// itself renders/expands/drags over -- visibleRows/toggleExpandAll/
// buildTreeRow's kid-count/the drag-drop target resolution -- reads through
// these instead of the d()-family above, so the tree can switch between the
// Spatial derivation (cache.derived, identical object to d()'s default) and
// the Loyalty derivation (cache.loyaltyDerived) while everything OUTSIDE the
// tree pane (the detail pane's breadcrumb/contents, "Mark related", and
// Loose threads' own predicate -- see looseReasons/nonContainmentEdgesFor
// below) stays CONTAINMENT-based unconditionally, per the phase38 contract's
// own explicit "loose-threads stays containment-based" instruction. When
// ui.treeMode is "spatial" (the default), activeDerived() IS cache.derived
// -- the exact same object d() returns -- so tree rendering is byte-
// identical to the pre-Phase-38 behavior.
// ---------------------------------------------------------------------------
function activeDerived() {
  return ui.treeMode === "loyalty" ? cache.loyaltyDerived : cache.derived;
}
function treeNode(id) { return activeDerived().nodesById.get(id); }
function treeParentIdOf(id) {
  const ad = activeDerived();
  const p = ad.parentOf.get(id);
  return p != null && ad.nodesById.has(p) ? p : null;
}
function treeChildIdsOf(id) {
  const ad = activeDerived();
  return (ad.childrenOf.get(id) || []).filter((cid) => ad.nodesById.has(cid));
}
function treeRootIds() {
  const ad = activeDerived();
  return [...ad.nodesById.keys()].filter((id) => treeParentIdOf(id) === null);
}
function treeAncestorChain(id) {
  const chain = [];
  let p = treeParentIdOf(id);
  const seen = new Set([id]);
  while (p && !seen.has(p)) { chain.unshift(p); seen.add(p); p = treeParentIdOf(p); }
  return chain;
}
function sortNodes(a, b) {
  return (a.type === "place" ? -1 : 1) - (b.type === "place" ? -1 : 1) ||
    (a.name || "").localeCompare(b.name || "");
}
function nonContainmentEdgesFor(id) {
  return d().nonContainment.filter((e) => e.sourceId === id || e.targetId === id);
}

// ---------------------------------------------------------------------------
// Loose-thread reasons (client-side, per the prototype's looseReasons).
// ---------------------------------------------------------------------------
function looseReasons(n) {
  const out = [];
  if (parentIdOf(n.id) === null) out.push("not placed");
  if (!(n.description || "").trim()) out.push("no detail");
  if (!(cache.usedInScene && cache.usedInScene.has(n.id))) out.push("never used in a scene");
  if (!nonContainmentEdgesFor(n.id).length) out.push("no links");
  return out;
}

// ===========================================================================
// Skeleton + mount
// ===========================================================================
function main() { return document.getElementById("shell-main"); }
function root() { return main() ? main().querySelector('[data-testid="world-surface-root"]') : null; }

function buildSkeleton() {
  const container = main();
  container.innerHTML = "";
  const r = el("div", { class: "world-surface", "data-testid": "world-surface-root", "data-rail-mode": ui.railMode });

  // Friction Wave 1 (W5b): the new sub-bar under the shell topbar, mimicking
  // the Library's own subbar idiom (library-view.js's tab bar left + filter
  // controls right). Carries the rail selector (Spatial | Loyalty | Graph)
  // plus "search the world" + the icon type-filters, both moved DOWN here
  // from the shell topbar's world slot (mountWorldTopbar, retired). The old
  // in-tree-head Spatial/Loyalty toggle -- the one whose label clipped to
  // "Spatial/Loya" in the 318px pane -- is superseded by this selector (same
  // testids, so the phase38 behavior pins carry over unchanged).
  r.appendChild(buildSubbar());

  // Body row: the tree body (Spatial/Loyalty -- the three phase30 panes,
  // completely unchanged inside) and the Graph body (W5b -- the shared
  // graph-view.js full-graph view), toggled by the rail selector.
  const bodyRow = el("div", { class: "wv-body" });

  // Left: containment tree ("Where things are").
  const treePane = el("aside", { class: "wv-tree-pane" });
  const treeHead = el("div", { class: "wv-tree-head" });
  treeHead.appendChild(el("div", { class: "wv-mono-label" }, "Where things are"));
  const spacer = el("div", { style: "flex:1" });
  // Fix 1 (QA W1 BLOCKER): an always-available, quiet "+ add" affordance --
  // unlike buildActions(sel)'s "Add something here" (only ever rendered once
  // a node is SELECTED), this lives in the tree pane header itself, so a
  // completely empty world's tree still offers a way to create the very
  // first entity. Opens the SAME kind of add-node flow (name + type picker,
  // POST /api/graph/nodes) but UNANCHORED -- no reparent call, no selected
  // node required -- so it also doubles as the only way to create a
  // standalone Person/Faction/etc. with no containing place. Deliberately
  // quiet (mirrors .wv-expand-toggle's own mono-label treatment, not a
  // heavy button) rather than the dashed/teal action-row idiom the detail
  // pane uses, since this header has far less room and needs to stay out of
  // the way for the (much more common) already-populated-world case.
  const addBtn = el("div", {
    class: "wv-tree-add-btn", "data-testid": "world-tree-add-btn",
    title: "Add a new place or person to the world"
  }, "+ add");
  addBtn.addEventListener("click", () => toggleTreeAddPanel());
  const expandToggle = el("div", { class: "wv-expand-toggle" });
  expandToggle.addEventListener("click", toggleExpandAll);
  treeHead.append(spacer, addBtn, expandToggle);
  const treeAddHost = el("div", { class: "wv-tree-add-host" });
  const treeScroll = el("div", { class: "wv-tree-scroll" });
  const tree = el("div", { class: "wv-tree", "data-testid": "world-tree", "data-tree-mode": ui.treeMode });
  const treeHint = el("div", { class: "wv-tree-hint" },
    "Drag any node onto a place to put it inside. That single edge is all the detail you owe it.");
  treeScroll.append(tree, treeHint);
  treePane.append(treeHead, treeAddHost, treeScroll);

  // Center: detail + contents + actions + loose threads.
  const centerPane = el("section", { class: "wv-center-pane" });
  const centerScroll = el("div", { class: "wv-center-scroll" });
  const centerCol = el("div", { class: "wv-center-col" });
  const detailHost = el("div", { class: "wv-detail-host" });
  const looseHost = el("div", { class: "wv-loose-host" });
  centerCol.append(detailHost, looseHost);
  centerScroll.appendChild(centerCol);
  centerPane.appendChild(centerScroll);

  // Right: inspector.
  const inspectorPane = el("aside", { class: "wv-inspector-pane" });

  const treeBody = el("div", { class: "wv-body-tree", "data-testid": "world-body-tree" });
  treeBody.append(treePane, centerPane, inspectorPane);
  treeBody.hidden = ui.railMode === "graph";

  // W5b: the Graph body -- hidden until the rail selector picks Graph. The
  // inner host is the `container` renderGraph() owns (it wraps it in its own
  // .graph-view-wrapper on first render).
  const graphBody = el("div", { class: "wv-body-graph", "data-testid": "world-body-graph" });
  graphBody.hidden = ui.railMode !== "graph";
  const graphHost = el("div", { "data-testid": "world-graph-host" });
  graphBody.appendChild(graphHost);

  bodyRow.append(treeBody, graphBody);
  r.appendChild(bodyRow);
  container.appendChild(r);

  return { tree, expandToggle, detailHost, looseHost, inspectorPane };
}

// ---------------------------------------------------------------------------
// W5b: the sub-bar -- rail selector + search + icon filters. Search/chips
// keep their exact testids/classes (world-search, wv-chip) so every existing
// pin (phase34 D9/D10) holds; they now filter BOTH the tree modes and the
// Graph mode.
// ---------------------------------------------------------------------------
function buildSubbar() {
  const bar = el("div", { class: "wv-subbar", "data-testid": "world-subbar" });

  // Rail selector: Spatial | Loyalty | Graph. Reuses the phase38 toggle's
  // testids/classes (the behavior contract carries over), plus the new
  // Graph option.
  const group = el("div", { class: "wv-tree-mode-toggle wv-rail-selector", "data-testid": "wv-tree-mode-toggle", role: "group" });
  const mk = (mode, label, testid) => {
    const btn = el("button", {
      type: "button", class: "wv-tree-mode-btn",
      "data-testid": testid, "data-rail-mode": mode,
      "aria-pressed": ui.railMode === mode ? "true" : "false"
    }, label);
    btn.addEventListener("click", () => setRailMode(mode));
    return btn;
  };
  group.append(
    mk("spatial", "Spatial", "wv-tree-mode-spatial-btn"),
    mk("loyalty", "Loyalty", "wv-tree-mode-loyalty-btn"),
    mk("graph", "Graph", "wv-rail-graph-btn")
  );

  const search = el("input", {
    class: "wv-search", type: "text", placeholder: "Search the world…",
    "data-testid": "world-search", value: ui.query
  });
  search.addEventListener("input", () => {
    ui.query = search.value;
    if (ui.railMode === "graph") renderWorldGraph(); else renderTree();
  });

  const chips = el("div", { class: "wv-chips" });
  for (const t of TYPE_ORDER) {
    const meta = TYPES[t];
    // D9/D11 (Phase 34 task 34.3): icon-only 27px round chips -- the glyph
    // is the chip's ONLY child; label text lives in the tooltip.
    const chip = el("div", {
      class: "wv-chip", "data-type": t,
      title: `${meta.label} — filter to ${meta.label.toLowerCase()}s`
    });
    chip.appendChild(el("span", { class: "wv-chip-glyph", style: `color:${meta.accent}` }, meta.glyph));
    chip.addEventListener("click", () => {
      if (ui.types.has(t)) ui.types.delete(t); else ui.types.add(t);
      syncChipStates(chips);
      if (ui.railMode === "graph") renderWorldGraph(); else renderTree();
    });
    chips.appendChild(chip);
  }
  syncChipStates(chips);

  bar.append(group, el("div", { style: "flex:1" }), search, chips);
  return bar;
}

// D5-D8 (Phase 34 task 34.3): Esc disarms a pending remove, module-wide --
// registered ONCE at import time (this module is a singleton ES module, so
// there is exactly one such listener for the life of the page) rather than
// re-added on every renderInspector() call.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || removeArmedId === null) return;
  removeArmedId = null;
  removeAlsoScenes = false;
  renderInspector();
});

// ===========================================================================
// Shell-topbar world slot: Friction Wave 1 (W5b) RETIRED the search+chips
// mount here (mountWorldTopbar) -- both moved down into the surface's own
// sub-bar (buildSubbar above), per Russell's rail-redesign request. The
// export stays: app-shell.js still calls clearWorldTopbar() when leaving the
// World surface, and renderWorldSurface below clears any stale content.
// ===========================================================================
export function clearWorldTopbar() {
  const slot = document.getElementById("shell-world-topbar-slot");
  if (slot) slot.innerHTML = "";
}
function syncChipStates(chips) {
  for (const chip of chips.querySelectorAll(".wv-chip")) {
    chip.classList.toggle("wv-chip--on", ui.types.has(chip.getAttribute("data-type")));
  }
}

// ===========================================================================
// Tree
// ===========================================================================
function matches(n) {
  const q = ui.query.trim().toLowerCase();
  const okQ = !q || (n.name || "").toLowerCase().includes(q) || (n.description || "").toLowerCase().includes(q);
  const okT = !ui.types.size || ui.types.has(n.type);
  return okQ && okT;
}
function visibleRows() {
  const filtering = !!ui.query.trim() || ui.types.size > 0;
  const keep = new Set();
  if (filtering) {
    for (const n of activeDerived().nodesById.values()) {
      if (!matches(n)) continue;
      keep.add(n.id);
      for (const a of treeAncestorChain(n.id)) keep.add(a);
    }
  }
  const rows = [];
  const walk = (parentId, depth) => {
    const ids = (parentId === null ? treeRootIds() : treeChildIdsOf(parentId))
      .filter((id) => !filtering || keep.has(id))
      .map((id) => treeNode(id))
      .sort(sortNodes);
    for (const n of ids) {
      const kidIds = treeChildIdsOf(n.id).filter((id) => !filtering || keep.has(id));
      const open = filtering ? true : ui.expanded.has(n.id);
      rows.push({ node: n, depth, kids: kidIds.length, open });
      if (open && kidIds.length) walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}
function toggleExpandAll() {
  if (ui.expanded.size > 6) {
    ui.expanded = new Set();
  } else {
    ui.expanded = new Set();
    for (const n of activeDerived().nodesById.values()) {
      if (treeChildIdsOf(n.id).length) ui.expanded.add(n.id);
    }
  }
  renderTree();
}
function renderTree() {
  const tree = root() && root().querySelector('[data-testid="world-tree"]');
  if (!tree) return;
  tree.setAttribute("data-tree-mode", ui.treeMode);
  tree.innerHTML = "";
  const rows = visibleRows();
  for (const r of rows) tree.appendChild(buildTreeRow(r));
  // Fix 1: a genuinely empty world (no rows, and not just filtered down to
  // nothing) gets an inline hint pointing at the new header "+ add"
  // affordance -- previously an empty tree was just blank, with no clue
  // anywhere that creation was even possible.
  if (!rows.length) {
    const filtering = !!ui.query.trim() || ui.types.size > 0;
    tree.appendChild(el("div", { class: "wv-tree-empty-hint", "data-testid": "world-tree-empty-hint" },
      filtering ? "Nothing matches." : "Nothing here yet — add your first place or person."));
  }
  const toggle = root().querySelector(".wv-expand-toggle");
  if (toggle) toggle.textContent = ui.expanded.size > 6 ? "collapse all" : "expand all";
}

// ---------------------------------------------------------------------------
// Fix 1: the unanchored add panel -- toggled by the tree-head "+ add"
// button. Deliberately a near-mirror of toggleAddPanel(host, sel) below (the
// existing selected-node "Add something here" flow) so the two idioms stay
// visually/behaviorally consistent, but with the reparent step removed
// entirely: the created node is left as a graph ROOT (no containment edge),
// exactly like rootIds()/treeRootIds()'s own "no containment edge = root"
// definition already treats any node with no parent. The existing
// selected-node add flow (toggleAddPanel) is completely untouched.
// ---------------------------------------------------------------------------
function toggleTreeAddPanel() {
  const host = root() && root().querySelector(".wv-tree-add-host");
  if (!host) return;
  if (host.getAttribute("data-mode") === "add") { host.innerHTML = ""; host.removeAttribute("data-mode"); return; }
  host.innerHTML = ""; host.setAttribute("data-mode", "add");
  let addType = "place";
  const panel = el("div", { class: "wv-inline-panel", "data-testid": "wv-tree-add-panel" });
  const topRow = el("div", { class: "wv-inline-row" });
  const input = el("input", {
    class: "wv-inline-input", type: "text",
    placeholder: "Name it — detail can come later…", "data-testid": "wv-tree-add-input"
  });
  const commit = el("div", { class: "wv-inline-commit", "data-testid": "wv-tree-add-commit" }, "Add to the world");
  const refreshCommit = () => commit.classList.toggle("wv-inline-commit--ready", !!input.value.trim());
  input.addEventListener("input", refreshCommit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") doAdd(); });
  commit.addEventListener("click", doAdd);
  topRow.append(input, commit);
  const pills = el("div", { class: "wv-type-pills" });
  for (const t of TYPE_ORDER) {
    const meta = TYPES[t];
    const pill = el("div", { class: "wv-type-pill" + (addType === t ? " wv-type-pill--on" : ""), "data-type": t });
    pill.append(el("span", { class: "wv-mono", style: `color:${meta.accent}` }, meta.glyph), el("span", null, meta.label));
    pill.addEventListener("click", () => {
      addType = t;
      for (const p of pills.children) p.classList.toggle("wv-type-pill--on", p.getAttribute("data-type") === t);
    });
    pills.appendChild(pill);
  }
  panel.append(topRow, pills);
  host.appendChild(panel);
  input.focus();

  async function doAdd() {
    const name = input.value.trim();
    if (!name) return;
    try {
      const created = await wApi("/api/graph/nodes", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld(), name, type: addType })
      });
      host.innerHTML = ""; host.removeAttribute("data-mode");
      await reload();
      select(created.entityId);
    } catch (err) {
      showUndoToast(`Could not add: ${err.message}`, () => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Friction Wave 1 (W5b): rail-mode switching. Spatial/Loyalty carry the
// phase38 tree-mode semantics forward unchanged (same expand-reveal on a
// derivation switch); Graph swaps the whole body for the shared full-graph
// view. The selector lives in the sub-bar (buildSubbar) -- the old
// in-tree-head toggle (whose label clipped to "Spatial/Loya") is gone.
// ---------------------------------------------------------------------------
function syncRailButtons() {
  const r = root();
  if (!r) return;
  r.setAttribute("data-rail-mode", ui.railMode);
  for (const btn of r.querySelectorAll(".wv-rail-selector .wv-tree-mode-btn")) {
    btn.setAttribute("aria-pressed", btn.getAttribute("data-rail-mode") === ui.railMode ? "true" : "false");
  }
}
function setRailMode(mode) {
  if (ui.railMode === mode || !["spatial", "loyalty", "graph"].includes(mode)) return;
  ui.railMode = mode;
  const r = root();
  const treeBody = r && r.querySelector('[data-testid="world-body-tree"]');
  const graphBody = r && r.querySelector('[data-testid="world-body-graph"]');
  if (treeBody) treeBody.hidden = mode === "graph";
  if (graphBody) graphBody.hidden = mode !== "graph";
  syncRailButtons();
  if (mode === "graph") {
    renderWorldGraph();
    return;
  }
  setTreeMode(mode);
}
function setTreeMode(mode) {
  if (mode !== "spatial" && mode !== "loyalty") return;
  if (ui.treeMode === mode) { renderTree(); return; }
  ui.treeMode = mode;
  // Reveal the newly-active tree's own structure (mirrors loadGraph's own
  // first-load "expand every node with children" convention) rather than
  // carrying over an expand-state that belonged to the other derivation.
  ui.expanded = new Set();
  for (const n of activeDerived().nodesById.values()) {
    if (treeChildIdsOf(n.id).length) ui.expanded.add(n.id);
  }
  renderTree();
}

// ---------------------------------------------------------------------------
// W5b Graph mode: the shared graph-view.js renderer over the SAME cached
// world graph the tree derives from, narrowed by the sub-bar's search +
// type chips. Read-only popovers (name/type/meta + "Develop this node →" to
// the standalone entity page) -- the standalone Graph nav view keeps the
// full manual-edit surface; wiring edit/delete/edge-drawing here too was
// judged disproportionate for this pass and is left for the Designer round
// (flagged in the wave notes).
// ---------------------------------------------------------------------------
function renderWorldGraph() {
  const r = root();
  const host = r && r.querySelector('[data-testid="world-graph-host"]');
  if (!host || !cache.graph) return;
  const q = ui.query.trim().toLowerCase();
  let nodes = cache.graph.nodes || [];
  if (q) nodes = nodes.filter((n) => (n.name || "").toLowerCase().includes(q) || (n.type || "").toLowerCase().includes(q));
  if (ui.types.size) nodes = nodes.filter((n) => ui.types.has(n.type));
  const visibleIds = new Set(nodes.map((n) => n.id));
  const edges = (cache.graph.edges || []).filter((e) => visibleIds.has(e.sourceId) && visibleIds.has(e.targetId));
  renderGraph(host, { nodes, edges }, {
    mode: "standalone",
    // Per-world layout cache, DISTINCT from the standalone Graph nav view's
    // "standalone" key -- the two views can be arranged independently.
    cacheKey: `world-rail:${ui.world}`,
    onDevelopNode: (nodeId) => goto(`entity/${nodeId}`)
  });
}
function buildTreeRow(r) {
  const n = r.node;
  const meta = typeMeta(n.type);
  const row = el("div", {
    class: "wv-tree-row" + (n.id === selectedId ? " wv-tree-row--sel" : ""),
    "data-testid": "world-tree-row",
    "data-entity-id": n.id,
    draggable: "true",
    style: `padding-left:${8 + r.depth * 15}px`
  });

  const chevron = el("span", { class: "wv-tree-chevron" }, r.kids ? (r.open ? "▾" : "▸") : "");
  if (r.kids) {
    chevron.addEventListener("click", (e) => {
      e.stopPropagation();
      if (ui.expanded.has(n.id)) ui.expanded.delete(n.id); else ui.expanded.add(n.id);
      renderTree();
    });
  }
  const glyph = el("span", { class: "wv-tree-glyph", style: `color:${meta.accent}` }, meta.glyph);
  const name = el("span", {
    class: "wv-tree-name" + (n.type === "place" ? " wv-tree-name--place" : "")
  }, n.name || n.id);
  row.append(chevron, glyph, name);
  // W5c: subtle world-name marker (see sharesWorldName).
  if (sharesWorldName(n)) {
    row.appendChild(el("span", {
      class: "wv-world-name-marker",
      "data-testid": "world-name-marker",
      title: WORLD_NAME_MARKER_TITLE
    }, "≙ world"));
  }
  if (n.flaggedUnreviewed) row.appendChild(el("span", { class: "wv-unreviewed-dot", title: "Unreviewed since last session" }));
  // W5a: a containment cycle's representative renders at root with a VISIBLE
  // warning badge naming the loop — never the pre-fix silent disappearance
  // (the bug that ate Kilmarn + the Underbreach). The badge names every
  // member; fixing means flipping/removing one of the cycle's edges.
  const cycleBreak = activeDerived().cycleBreaks && activeDerived().cycleBreaks.get(n.id);
  if (cycleBreak) {
    row.appendChild(el("span", {
      class: "wv-cycle-badge",
      "data-testid": "world-tree-cycle-badge",
      "data-entity-id": n.id,
      "data-cycle-members": cycleBreak.memberIds.join(","),
      title: `Containment cycle: ${cycleBreak.memberNames.join(" → ")} → ${cycleBreak.memberNames[0]}. ` +
        `These entities contain each other, so the branch is shown at the root instead of disappearing. ` +
        `Fix it by removing or flipping one of the containment edges (drag a node onto its real parent).`
    }, "⚠ cycle"));
  }
  row.appendChild(el("span", { class: "wv-tree-count" }, r.kids ? String(r.kids) : ""));

  row.addEventListener("click", () => select(n.id));
  wireReparentTarget(row, n.id, () => n.id);
  row.addEventListener("dragstart", (e) => { e.stopPropagation(); startDrag(n.id, e); });
  row.addEventListener("dragend", endDrag);
  return row;
}

// ---------------------------------------------------------------------------
// Drag/drop reparent. dragId lives on the dataTransfer + a module var.
// ---------------------------------------------------------------------------
let dragId = null;
function startDrag(id, e) {
  dragId = id;
  // Also populate the shared tray's drag-payload channel (scene-tray.js) --
  // a graph node's own kind is "graph", never one of the tray's roster kinds,
  // so this only ever resolves through the World-specific onExternalDrop
  // hook wired in mountWorldSceneTray() below; it's a silent no-op wherever
  // else the same drag might land (e.g. a tree-row reparent target, which
  // reads `dragId` directly and ignores this channel entirely).
  setTrayDragPayload({ kind: "graph", id });
  if (e && e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", id); } catch { /* ignore */ } }
}
function endDrag() {
  dragId = null;
  setTrayDragPayload(null);
}
function wireReparentTarget(rowEl, targetIdArg, resolveTargetId) {
  rowEl.addEventListener("dragover", (e) => { e.preventDefault(); rowEl.classList.add("wv-drop-target"); });
  rowEl.addEventListener("dragleave", () => rowEl.classList.remove("wv-drop-target"));
  rowEl.addEventListener("drop", (e) => {
    e.preventDefault();
    rowEl.classList.remove("wv-drop-target");
    const src = dragId;
    const tgt = resolveTargetId ? resolveTargetId() : targetIdArg;
    dragId = null;
    if (src && tgt && src !== tgt) reparent(src, tgt);
  });
}

async function reparent(id, parentId) {
  // Phase 38 task 38.3, §6c: the SAME wireReparentTarget/startDrag/dragId
  // plumbing calls this on every drop; it branches on the CURRENT UI mode
  // at drop time rather than existing as two separate drag implementations.
  // In Spatial mode (the default) this falls through to the ORIGINAL,
  // completely unchanged containment-reparent path below.
  if (ui.treeMode === "loyalty") { await anchorLoyalty(id, parentId); return; }
  const prevParent = parentIdOf(id);
  const n = node(id);
  const pn = node(parentId);
  if (!n || !pn) return;
  try {
    await wApi(`/api/graph/nodes/${encodeURIComponent(id)}/reparent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld(), parentId })
    });
    ui.expanded.add(parentId);
    await reload();
    showUndoToast(`“${n.name}” is now inside “${pn.name}”`, async () => {
      await wApi(`/api/graph/nodes/${encodeURIComponent(id)}/reparent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld(), parentId: prevParent })
      });
      await reload();
    });
  } catch (err) {
    showUndoToast(`Could not move: ${err.message}`, () => {});
  }
}

// Phase 38 task 38.3, §6d: dropping tree row A onto tree row B in Loyalty
// mode calls the NEW anchor-membership route instead of .../reparent --
// manual-edit-ops.mjs's anchorMembership, a genuinely separate sibling op
// (reparentNode itself is never touched). Undo-toast copy family: "“<name>”
// now serves “<parent>”" (mirrors the containment toast's own "is now
// inside" structure), same undo-restores-prior-parent mechanism.
async function anchorLoyalty(id, parentId) {
  const prevParent = treeParentIdOf(id);
  const n = node(id);
  const pn = node(parentId);
  if (!n || !pn) return;
  try {
    await wApi(`/api/graph/nodes/${encodeURIComponent(id)}/anchor-membership`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld(), parentId })
    });
    ui.expanded.add(parentId);
    await reload();
    showUndoToast(`“${n.name}” now serves “${pn.name}”`, async () => {
      await wApi(`/api/graph/nodes/${encodeURIComponent(id)}/anchor-membership`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld(), parentId: prevParent })
      });
      await reload();
    });
  } catch (err) {
    showUndoToast(`Could not re-anchor: ${err.message}`, () => {});
  }
}

// ===========================================================================
// Center detail pane
// ===========================================================================
function detailHostEl() { return root() && root().querySelector(".wv-detail-host"); }
function looseHostEl() { return root() && root().querySelector(".wv-loose-host"); }

function renderDetail() {
  const host = detailHostEl();
  if (!host) return;
  host.innerHTML = "";
  const sel = selectedId ? node(selectedId) : null;
  if (!sel) {
    host.appendChild(el("div", { class: "wv-empty-detail" },
      "Select a node from the tree to see where it sits and what it touches."));
    return;
  }
  const meta = typeMeta(sel.type);
  const target = el("div", { class: "wv-detail", "data-testid": "world-detail", "data-entity-id": sel.id });
  host.appendChild(target);

  // Breadcrumb of ancestor names.
  const chain = ancestorChain(sel.id).map((id) => (node(id) || {}).name).filter(Boolean);
  target.appendChild(el("div", { class: "wv-breadcrumb" },
    chain.length ? chain.join("  ›  ") : "nowhere in particular"));

  // Header: glyph + editable name + mono type.
  const header = el("div", { class: "wv-detail-header" });
  header.appendChild(el("span", { class: "wv-detail-glyph", style: `color:${meta.accent}` }, meta.glyph));
  const nameEl = el("span", {
    class: "wv-detail-name", "data-testid": "world-detail-name",
    contenteditable: "true", spellcheck: "false"
  }, sel.name || "");
  nameEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); nameEl.blur(); } });
  nameEl.addEventListener("blur", () => saveName(sel.id, nameEl.textContent.trim()));
  header.appendChild(nameEl);
  header.appendChild(el("span", { class: "wv-detail-type", "data-testid": "world-detail-type" }, sel.type || ""));
  // W5c: the same subtle world-name marker in the detail header.
  if (sharesWorldName(sel)) {
    header.appendChild(el("span", {
      class: "wv-world-name-marker",
      "data-testid": "world-name-marker-detail",
      title: WORLD_NAME_MARKER_TITLE
    }, "≙ shares the world's name"));
  }
  target.appendChild(header);

  // Editable description (autosave -> editNodeOp, which clears unreviewed).
  const desc = el("div", {
    class: "wv-detail-desc", "data-testid": "world-detail-description",
    contenteditable: "true", spellcheck: "false"
  });
  desc.textContent = sel.description || "";
  if (!descSaver || descSaverForId !== sel.id) {
    descSaverForId = sel.id;
    descSaver = createFlushableDebounce((value) => saveDescription(sel.id, value));
  }
  desc.addEventListener("input", () => descSaver.onInput(desc.textContent));
  desc.addEventListener("blur", () => descSaver.onBlur(desc.textContent));
  target.appendChild(desc);

  // Phase 37.6 task 3 -- "✦ develop this place", place-typed nodes only (this
  // detail pane covers every entity type; this affordance is specifically
  // Russell's "adding detail to a place I'm working on" use case).
  if (sel.type === "place") {
    target.appendChild(buildDevelopPlaceControl(sel));
  }

  // Contents ("Inside <name>"), grouped by type.
  const kids = childIdsOf(sel.id).map((id) => node(id));
  const meta2 = el("div", { class: "wv-contents-head" });
  meta2.appendChild(el("div", { class: "wv-mono-label" }, `Inside ${short(sel.name)}`));
  meta2.appendChild(el("div", { class: "wv-contents-meta" }, `${kids.length} ${kids.length === 1 ? "thing" : "things"}`));
  target.appendChild(meta2);

  if (kids.length) {
    const groupsWrap = el("div", { class: "wv-contents-groups" });
    for (const t of TYPE_ORDER.concat([...new Set(kids.map((k) => k.type))].filter((x) => !TYPE_ORDER.includes(x)))) {
      const items = kids.filter((k) => k.type === t);
      if (!items.length) continue;
      const g = el("div");
      g.appendChild(el("div", { class: "wv-group-label" }, typeMeta(t).label + "s"));
      const chipRow = el("div", { class: "wv-chip-row" });
      for (const k of items) chipRow.appendChild(buildContentChip(k));
      g.appendChild(chipRow);
      groupsWrap.appendChild(g);
    }
    target.appendChild(groupsWrap);
  } else {
    target.appendChild(el("div", { class: "wv-contents-empty" },
      `Nothing is recorded inside ${short(sel.name)} yet. Drag something here from Loose threads below, or add it directly.`));
  }

  // Actions.
  target.appendChild(buildActions(sel));

  // Friction Wave 1 (W5d, Review-UX round 3 item 6): the one-hop LOCAL
  // graph -- this node + every directly-connected node, edges color-coded
  // by relationship type. Sits after the action row, above the Loose
  // threads lane (Russell's own top-to-bottom panel order).
  const local = buildLocalGraph(sel);
  if (local) target.appendChild(local);
}

// ---------------------------------------------------------------------------
// W5d: the local one-hop graph. Deliberately a tiny bespoke radial layout
// (selected node centered, neighbors on an ellipse), NOT graph-view.js's
// force layout -- there is no layout state worth caching for a per-selection
// one-hop view, and a stable radial arrangement re-renders identically every
// time. Node fills reuse the shared typeMeta/colorForType vocabulary; edge
// strokes are color-coded by relationship type via the SAME deterministic
// colorForType hash (a per-world free-string vocabulary, so a hash is the
// only honest palette), with a legend + midpoint labels naming each type.
// Clicking a neighbor selects it -- the fast "walk the graph" loop Russell
// wants for post-batch relationship cleanup. Edge EDITING stays in the
// inspector's "Tied to" list (remove) and the standalone Graph view (full
// edit surface) -- not duplicated here.
// ---------------------------------------------------------------------------
const LOCAL_GRAPH_MAX_NEIGHBORS = 12;
function svgNode(tag, attrs = {}) {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  return n;
}
function buildLocalGraph(sel) {
  const allEdges = ((cache.graph && cache.graph.edges) || []).filter(
    (e) => (e.sourceId === sel.id || e.targetId === sel.id) &&
      d().nodesById.has(e.sourceId) && d().nodesById.has(e.targetId) &&
      e.sourceId !== e.targetId
  );
  if (!allEdges.length) return null;

  const neighborIds = [...new Set(allEdges.map((e) => (e.sourceId === sel.id ? e.targetId : e.sourceId)))];
  const shown = neighborIds.slice(0, LOCAL_GRAPH_MAX_NEIGHBORS);
  const shownSet = new Set([sel.id, ...shown]);
  const edges = allEdges.filter((e) => shownSet.has(e.sourceId) && shownSet.has(e.targetId));
  const omitted = neighborIds.length - shown.length;

  const wrap = el("div", { class: "wv-local-graph-wrap", "data-testid": "world-local-graph", "data-entity-id": sel.id });
  const head = el("div", { class: "wv-contents-head" });
  head.appendChild(el("div", { class: "wv-mono-label" }, `Around ${short(sel.name)}`));
  head.appendChild(el("div", { class: "wv-contents-meta" },
    `${shown.length} connected${omitted > 0 ? ` · +${omitted} more not shown` : ""}`));
  wrap.appendChild(head);

  const W = 560, H = Math.max(210, 130 + shown.length * 14);
  const cx = W / 2, cy = H / 2;
  const rx = W / 2 - 95, ry = H / 2 - 34;
  const pos = new Map([[sel.id, { x: cx, y: cy }]]);
  shown.forEach((id, i) => {
    const angle = (2 * Math.PI * i) / shown.length - Math.PI / 2;
    pos.set(id, { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) });
  });

  const svg = svgNode("svg", { viewBox: `0 0 ${W} ${H}`, class: "wv-local-graph-svg" });

  // Edges first (under the nodes), color-coded by relationship type.
  for (const e of edges) {
    const a = pos.get(e.sourceId), b = pos.get(e.targetId);
    const kind = e.relationshipType || "related";
    const color = colorForType(kind);
    const line = svgNode("line", {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      class: "wv-local-graph-edge",
      "data-testid": "world-local-graph-edge",
      "data-relationship-type": kind,
      stroke: color
    });
    svg.appendChild(line);
    // Midpoint label naming the type, nudged off the line.
    const label = svgNode("text", {
      x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 4,
      class: "wv-local-graph-edge-label", fill: color, "text-anchor": "middle"
    });
    label.textContent = kind;
    svg.appendChild(label);
  }

  for (const id of [sel.id, ...shown]) {
    const n = node(id);
    const meta = typeMeta(n.type);
    const p = pos.get(id);
    const isCenter = id === sel.id;
    const g = svgNode("g", {
      class: "wv-local-graph-node" + (isCenter ? " wv-local-graph-node--center" : ""),
      "data-testid": "world-local-graph-node",
      "data-entity-id": id,
      transform: `translate(${p.x}, ${p.y})`
    });
    g.appendChild(svgNode("circle", { r: isCenter ? 17 : 12, fill: meta.accent, class: "wv-local-graph-dot" }));
    const glyph = svgNode("text", { y: 3.5, "text-anchor": "middle", class: "wv-local-graph-glyph" });
    glyph.textContent = meta.glyph;
    g.appendChild(glyph);
    const nm = svgNode("text", { y: (isCenter ? 17 : 12) + 12, "text-anchor": "middle", class: "wv-local-graph-name" });
    nm.textContent = short(n.name || id);
    g.appendChild(nm);
    if (!isCenter) {
      g.addEventListener("click", () => select(id));
      g.appendChild(svgNode("title", {})).textContent = `${n.name} — click to open`;
    }
    svg.appendChild(g);
  }
  wrap.appendChild(svg);

  // Legend: one swatch per distinct relationship type, same colors.
  const kinds = [...new Set(edges.map((e) => e.relationshipType || "related"))];
  const legend = el("div", { class: "wv-local-graph-legend", "data-testid": "world-local-graph-legend" });
  for (const kind of kinds) {
    const item = el("span", { class: "wv-local-graph-legend-item", "data-relationship-type": kind });
    item.appendChild(el("span", { class: "wv-local-graph-swatch", style: `background:${colorForType(kind)}` }));
    item.appendChild(el("span", null, kind));
    legend.appendChild(item);
  }
  wrap.appendChild(legend);
  return wrap;
}

function buildContentChip(k) {
  const meta = typeMeta(k.type);
  const kidCount = childIdsOf(k.id).length;
  const chip = el("div", {
    class: "wv-content-chip", draggable: "true",
    style: `border-left-color:${meta.accent}`,
    title: "Drag onto a scene at right, or onto another place to move it"
  });
  chip.append(
    el("span", { class: "wv-content-chip-glyph", style: `color:${meta.accent}` }, meta.glyph),
    el("span", { class: "wv-content-chip-name" }, k.name || k.id)
  );
  if (k.flaggedUnreviewed) chip.appendChild(el("span", { class: "wv-unreviewed-dot", title: "Unreviewed" }));
  chip.appendChild(el("span", { class: "wv-content-chip-sub" },
    kidCount ? `${kidCount} inside` : ((k.description || "").trim() ? "" : "no detail")));
  chip.addEventListener("click", () => select(k.id));
  chip.addEventListener("dragstart", (e) => { e.stopPropagation(); startDrag(k.id, e); });
  chip.addEventListener("dragend", endDrag);
  return chip;
}

function buildActions(sel) {
  const wrap = el("div", { class: "wv-actions-wrap" });
  const row = el("div", { class: "wv-actions-row" });

  const addBtn = el("div", { class: "wv-action wv-action--dashed" });
  addBtn.append(el("span", null, "+"), el("span", null, "Add something here"));
  const relBtn = el("div", { class: "wv-action wv-action--dashed" });
  relBtn.append(el("span", { class: "wv-mono" }, "⁁"), el("span", null, "Mark something related"));
  row.append(addBtn, relBtn);

  if (sel.type === "place") {
    const sceneBtn = el("div", {
      class: "wv-action wv-action--teal",
      "data-testid": "world-create-scene-here-btn",
      "data-entity-id": sel.id
    });
    sceneBtn.append(el("span", { class: "wv-mono" }, "▸"), el("span", null, "Create a scene here"));
    sceneBtn.addEventListener("click", () => createSceneHere(sel));
    row.appendChild(sceneBtn);
  }
  wrap.appendChild(row);

  const panelHost = el("div", { class: "wv-action-panel-host" });
  wrap.appendChild(panelHost);
  addBtn.addEventListener("click", () => toggleAddPanel(panelHost, sel));
  relBtn.addEventListener("click", () => toggleRelPanel(panelHost, sel));
  return wrap;
}

function toggleAddPanel(host, sel) {
  if (host.getAttribute("data-mode") === "add") { host.innerHTML = ""; host.removeAttribute("data-mode"); return; }
  host.innerHTML = ""; host.setAttribute("data-mode", "add");
  let addType = "object";
  const panel = el("div", { class: "wv-inline-panel" });
  const topRow = el("div", { class: "wv-inline-row" });
  const input = el("input", { class: "wv-inline-input", type: "text", placeholder: "Name it — detail can come later…" });
  const commit = el("div", { class: "wv-inline-commit" }, `Add inside ${short(sel.name)}`);
  const refreshCommit = () => commit.classList.toggle("wv-inline-commit--ready", !!input.value.trim());
  input.addEventListener("input", refreshCommit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") doAdd(); });
  commit.addEventListener("click", doAdd);
  topRow.append(input, commit);
  const pills = el("div", { class: "wv-type-pills" });
  for (const t of TYPE_ORDER) {
    const meta = TYPES[t];
    const pill = el("div", { class: "wv-type-pill" + (addType === t ? " wv-type-pill--on" : ""), "data-type": t });
    pill.append(el("span", { class: "wv-mono", style: `color:${meta.accent}` }, meta.glyph), el("span", null, meta.label));
    pill.addEventListener("click", () => {
      addType = t;
      for (const p of pills.children) p.classList.toggle("wv-type-pill--on", p.getAttribute("data-type") === t);
    });
    pills.appendChild(pill);
  }
  panel.append(topRow, pills);
  host.appendChild(panel);
  input.focus();

  async function doAdd() {
    const name = input.value.trim();
    if (!name) return;
    try {
      const created = await wApi("/api/graph/nodes", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld(), name, type: addType })
      });
      await wApi(`/api/graph/nodes/${encodeURIComponent(created.entityId)}/reparent`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld(), parentId: sel.id })
      });
      host.innerHTML = ""; host.removeAttribute("data-mode");
      ui.expanded.add(sel.id);
      await reload();
      select(created.entityId);
    } catch (err) {
      showUndoToast(`Could not add: ${err.message}`, () => {});
    }
  }
}

function toggleRelPanel(host, sel) {
  if (host.getAttribute("data-mode") === "rel") { host.innerHTML = ""; host.removeAttribute("data-mode"); return; }
  host.innerHTML = ""; host.setAttribute("data-mode", "rel");
  const panel = el("div", { class: "wv-inline-panel" });
  const head = el("div", { class: "wv-inline-panel-head" });
  head.appendChild(el("div", { class: "wv-mono-label" }, `${short(sel.name)} is related to…`));
  const closer = el("div", { class: "wv-inline-close" }, "✕");
  closer.addEventListener("click", () => { host.innerHTML = ""; host.removeAttribute("data-mode"); });
  head.append(el("div", { style: "flex:1" }), closer);
  const search = el("input", { class: "wv-inline-input", type: "text", placeholder: "Search…" });
  const results = el("div", { class: "wv-rel-results" });
  const linkedIds = new Set(nonContainmentEdgesFor(sel.id).map((e) => (e.sourceId === sel.id ? e.targetId : e.sourceId)));
  const renderResults = () => {
    const q = search.value.trim().toLowerCase();
    results.innerHTML = "";
    const cands = [...d().nodesById.values()]
      .filter((n) => n.id !== sel.id && !linkedIds.has(n.id))
      .filter((n) => !q || (n.name || "").toLowerCase().includes(q))
      .slice(0, 40);
    for (const n of cands) {
      const meta = typeMeta(n.type);
      const rrow = el("div", { class: "wv-rel-row" });
      rrow.append(
        el("span", { class: "wv-mono", style: `color:${meta.accent}` }, meta.glyph),
        el("span", { class: "wv-rel-name" }, n.name || n.id),
        el("span", { class: "wv-rel-type" }, n.type || "")
      );
      rrow.addEventListener("click", () => markRelated(sel, n));
      results.appendChild(rrow);
    }
    if (!cands.length) results.appendChild(el("div", { class: "wv-hint" }, "No matches."));
  };
  search.addEventListener("input", renderResults);
  const caption = el("div", { class: "wv-inline-caption" },
    "Creates an untyped related edge. Wrap-up reads your session notes and proposes what it actually is — you approve it then.");
  panel.append(head, search, results, caption);
  host.appendChild(panel);
  renderResults();
  search.focus();
}

async function markRelated(sel, other) {
  try {
    const created = await wApi("/api/graph/edges", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld(), sourceId: sel.id, targetId: other.id, relationshipType: "related" })
    });
    await reload();
    showUndoToast("Marked related — Wrap-up will propose what it really is", async () => {
      if (created && created.edgeId) {
        await wApi(`/api/graph/edges/${encodeURIComponent(created.edgeId)}`, {
          method: "DELETE", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ world: currentWorld() })
        });
        await reload();
      }
    });
  } catch (err) {
    showUndoToast(`Could not mark related: ${err.message}`, () => {});
  }
}

async function createSceneHere(sel) {
  try {
    const { scene } = await wApi("/api/session-planner/scenes", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld(), locationEntityId: sel.id })
    });
    await refreshScenes();
    // Cross-surface jump (Phase 30.5): this seam's design intent is to land the
    // GM in the Session planner with the brand-new scene open, not merely toast
    // a hint. Navigate to #planner/scene/<id> (switches surface + opens the
    // scene). The undo toast lives in the document-level #toast-container, so it
    // survives the surface switch; Undo deletes the just-created scene and
    // returns to the World surface at the place we created it from.
    goto(`planner/scene/${scene.id}`);
    showUndoToast(`Scene created at “${sel.name}” — opened in the planner`, async () => {
      try {
        await wApi(`/api/session-planner/scenes/${encodeURIComponent(scene.id)}`, {
          method: "DELETE", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ world: currentWorld() })
        });
        cache.scenes = null;
        goto(`world/${sel.id}`);
      } catch { /* best effort */ }
    });
  } catch (err) {
    showUndoToast(`Could not create scene: ${err.message}`, () => {});
  }
}

// ---------------------------------------------------------------------------
// Loose threads lane
// ---------------------------------------------------------------------------
function renderLoose() {
  const host = looseHostEl();
  if (!host) return;
  host.innerHTML = "";
  const sel = selectedId ? node(selectedId) : null;

  const scored = [...d().nodesById.values()]
    .map((n) => ({ n, reasons: looseReasons(n) }))
    .filter((x) => x.reasons.length);

  const list = scored
    .filter((x) => (ui.looseFilter ? x.reasons.includes(ui.looseFilter) : x.reasons.length >= 2))
    .filter((x) => !sel || x.n.id !== sel.id)
    .sort((a, b) => b.reasons.length - a.reasons.length)
    .slice(0, ui.looseFilter ? 24 : 8);

  const head = el("div", { class: "wv-loose-head" });
  const label = el("span", { class: "wv-mono-label" }, (ui.looseOpen ? "▾" : "▸") + "  Loose threads");
  const count = el("span", { class: "wv-loose-count" }, String(list.length));
  head.append(label, count, el("span", { class: "wv-loose-sub" }, "introduced, never placed or paid off"));
  head.addEventListener("click", () => { ui.looseOpen = !ui.looseOpen; renderLoose(); });
  host.appendChild(head);

  const filters = el("div", { class: "wv-loose-filters" });
  for (const reason of ["not placed", "no detail", "never used in a scene", "no links"]) {
    const on = ui.looseFilter === reason;
    const c = scored.filter((x) => x.reasons.includes(reason)).length;
    const chip = el("div", { class: "wv-loose-filter" + (on ? " wv-loose-filter--on" : "") });
    chip.append(el("span", null, reason), el("span", { class: "wv-mono wv-loose-filter-count" }, String(c)));
    chip.addEventListener("click", (e) => { e.stopPropagation(); ui.looseFilter = on ? null : reason; ui.looseOpen = true; renderLoose(); });
    filters.appendChild(chip);
  }
  host.appendChild(filters);

  if (!ui.looseOpen) return;
  const rows = el("div", { class: "wv-loose-rows" });
  for (const { n, reasons } of list) {
    const meta = typeMeta(n.type);
    const lrow = el("div", { class: "wv-loose-row", draggable: "true" });
    lrow.append(
      el("span", { class: "wv-mono", style: `color:${meta.accent}` }, meta.glyph),
      el("span", { class: "wv-loose-name" }, n.name || n.id),
      el("span", { class: "wv-loose-type" }, n.type || ""),
      el("span", { style: "flex:1" })
    );
    for (const r of reasons.slice(0, 3)) lrow.appendChild(el("span", { class: "wv-loose-reason" }, r));
    if (sel && sel.type === "place" && sel.id !== n.id) {
      const placeBtn = el("span", { class: "wv-loose-place", title: "Put it inside the selected place" }, `place in ${short(sel.name)}`);
      placeBtn.addEventListener("click", (e) => { e.stopPropagation(); reparent(n.id, sel.id); });
      lrow.appendChild(placeBtn);
    }
    lrow.addEventListener("click", () => select(n.id));
    lrow.addEventListener("dragstart", (e) => { e.stopPropagation(); startDrag(n.id, e); });
    lrow.addEventListener("dragend", endDrag);
    rows.appendChild(lrow);
  }
  host.appendChild(rows);
}

// ===========================================================================
// Right inspector
// ===========================================================================
function inspectorPaneEl() { return root() && root().querySelector(".wv-inspector-pane"); }
function renderInspector() {
  const pane = inspectorPaneEl();
  if (!pane) return;
  pane.innerHTML = "";
  const sel = selectedId ? node(selectedId) : null;
  if (!sel) {
    pane.appendChild(el("div", { class: "wv-inspector-empty" }, "No node selected."));
    return;
  }
  const insp = el("div", { class: "wv-inspector", "data-testid": "world-inspector", "data-entity-id": sel.id });

  const header = el("div", { class: "wv-inspector-header" });
  header.appendChild(el("span", { class: "wv-inspector-title" }, sel.name || sel.id));
  // D5-D8 (Phase 34 task 34.3): the HYBRID remove-from-graph -- the design's
  // inline two-click ARM (`World Graph.dc.html`'s own `armRemove`/
  // `removeLabel`), replacing Phase 33's separate confirm panel. First click
  // arms in place (button's own label flips); second click executes. Same
  // right-aligned header slot, same testid, no layout change.
  const armed = removeArmedId === sel.id;
  const removeBtn = el("button", {
    type: "button",
    class: "wv-inspector-remove" + (armed ? " wv-inspector-remove--armed" : ""),
    "data-testid": "world-remove-from-graph-btn",
    "data-entity-id": sel.id
  }, armed ? "remove — sure?" : "Remove from graph");
  header.append(el("span", { style: "flex:1" }), removeBtn);
  insp.appendChild(header);

  // Host for the armed state's consequence line + opt-in checkbox (Russell's
  // locked HYBRID rule: rendered only when K/M/N aren't all zero). Sits
  // directly under the header, same slot the old confirm panel occupied.
  const consequenceHost = el("div", { class: "wv-remove-consequence-host" });
  insp.appendChild(consequenceHost);
  removeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    handleRemoveClick(sel, removeBtn, consequenceHost);
  });
  // Disarm gestures: clicking anywhere ELSE in the inspector, or Esc
  // (wired once at module scope below). Excluded from "elsewhere": the
  // remove button's own click (so the SAME click that just armed it doesn't
  // immediately disarm it again via bubbling), and anything inside the
  // consequence host (the opt-in checkbox/label ARE part of the armed UI,
  // not "elsewhere" -- checking the box must not itself disarm and yank the
  // checkbox out of the DOM mid-click).
  insp.addEventListener("click", (e) => {
    if (e.target === removeBtn || removeBtn.contains(e.target)) return;
    if (consequenceHost.contains(e.target)) return;
    if (removeArmedId !== null) {
      removeArmedId = null;
      removeAlsoScenes = false;
      renderInspector();
    }
  });

  const body = el("div", { class: "wv-inspector-body" });

  // Contained in
  body.appendChild(el("div", { class: "wv-mono-label wv-inspector-label" }, "Contained in"));
  const pid = parentIdOf(sel.id);
  if (pid && node(pid)) {
    const prow = el("div", { class: "wv-inspector-parent" }, node(pid).name || pid);
    prow.addEventListener("click", () => select(pid));
    body.appendChild(prow);
  } else {
    body.appendChild(el("div", { class: "wv-inspector-nowhere" }, "Nowhere in particular — drag it onto a place to fix that."));
  }

  // Tied to
  body.appendChild(el("div", { class: "wv-mono-label wv-inspector-label" }, "Tied to"));
  const rels = nonContainmentEdgesFor(sel.id);
  if (rels.length) {
    const relWrap = el("div", { class: "wv-tied-list" });
    for (const e of rels) {
      const otherId = e.sourceId === sel.id ? e.targetId : e.sourceId;
      const other = node(otherId) || { name: otherId };
      const kind = e.relationshipType || "related";
      const trow = el("div", { class: "wv-tied-row" });
      const nm = el("span", { class: "wv-tied-name" }, other.name || otherId);
      nm.addEventListener("click", () => select(otherId));
      trow.append(nm, el("span", { style: "flex:1" }),
        el("span", { class: "wv-tied-kind" + (kind === "related" ? " wv-tied-kind--unrefined" : "") }, kind));
      const rm = el("span", { class: "wv-tied-remove", title: "Remove link" }, "✕");
      rm.addEventListener("click", () => removeLink(e));
      trow.appendChild(rm);
      relWrap.appendChild(trow);
    }
    body.appendChild(relWrap);
  } else {
    body.appendChild(el("div", { class: "wv-inspector-hint" }, "No links yet. That's fine — say it's related and let Wrap-up sharpen it later."));
  }

  // Appears in (async via scenesForEntity)
  body.appendChild(el("div", { class: "wv-mono-label wv-inspector-label" }, "Appears in"));
  const appears = el("div", { class: "wv-appears-in", "data-testid": "world-inspector-appears-in" }, "…");
  body.appendChild(appears);

  insp.appendChild(body);

  // Scene tray (Phase 35 task 35.3: the shared component, unified — see the
  // import comment above + mountWorldSceneTray's own comment below).
  const trayHost = el("div");
  insp.appendChild(trayHost);
  mountWorldSceneTray(trayHost);

  pane.appendChild(insp);
  fillAppearsIn(sel.id, appears);
  renderRemoveConsequence(sel, consequenceHost);
}

// Shared "used in" fetch -- the SAME `scenesForEntity` appearances both the
// "Appears in" section AND the armed remove-consequence line's N count read,
// cached per entity id so arming never triggers a second route call for data
// the inspector already fetched for its own render (D5-D8's own "zero extra
// route call" contract).
function fetchAppearances(id) {
  if (appearsCache.id === id) return appearsCache.promise;
  const promise = wApi(`/api/scene-planning/entities/${encodeURIComponent(id)}/scenes${withWorld()}`)
    .then((r) => (r && r.appearances) || [])
    .catch(() => []);
  appearsCache = { id, promise };
  return promise;
}

async function fillAppearsIn(id, target) {
  const captured = id;
  const appearances = await fetchAppearances(id);
  if (captured !== selectedId) return;
  target.innerHTML = "";
  if (!appearances.length) {
    target.textContent = "No scene has used this yet.";
    return;
  }
  for (const a of appearances) {
    const nm = sceneDisplayName(a.scene);
    const isAnchor = (a.roles || []).includes("anchor");
    const line = el("div", { class: "wv-appears-line" }, nm + (isAnchor ? " (anchor place)" : ""));
    target.appendChild(line);
  }
}

// ---------------------------------------------------------------------------
// D5-D8: the armed state's consequence line + opt-in checkbox. K =
// containment children (they reparent up), M = non-containment edges
// touching the node (dropped), N = scenesForEntity appearances (used-in).
// ALL zero -> the flipped button label IS the entire armed UI (Russell's own
// locked HYBRID rule) -- no line, no checkbox.
// ---------------------------------------------------------------------------
async function renderRemoveConsequence(sel, host) {
  host.innerHTML = "";
  if (removeArmedId !== sel.id) return;
  const appearances = await fetchAppearances(sel.id);
  if (removeArmedId !== sel.id) return; // disarmed (or selection changed) while awaiting

  const K = childIdsOf(sel.id).length;
  const M = nonContainmentEdgesFor(sel.id).length;
  const N = appearances.length;
  if (K === 0 && M === 0 && N === 0) return;

  host.appendChild(el("div", {
    class: "wv-remove-consequence-line",
    "data-testid": "world-remove-consequence-line",
    "data-entity-id": sel.id
  }, `reparents ${K} inside · drops ${M} link${M === 1 ? "" : "s"} · used in ${N} scene${N === 1 ? "" : "s"}`));

  const optLabel = el("label", { class: "wv-remove-checkbox-row" });
  const checkbox = el("input", { type: "checkbox", "data-testid": "world-remove-from-all-scenes-checkbox" });
  // Render FROM and write TO the module flag so the choice survives any async
  // re-render of the armed state (see removeAlsoScenes's own comment).
  checkbox.checked = removeAlsoScenes;
  checkbox.addEventListener("change", () => { removeAlsoScenes = checkbox.checked; });
  optLabel.append(checkbox, el("span", {}, `also remove from all ${N} scene${N === 1 ? "" : "s"}`));
  host.appendChild(optLabel);
}

// ---------------------------------------------------------------------------
// D5-D8: first click ARMS (re-render only), second click EXECUTES --
// POST .../remove-reparent-up (§4, always) preceded by POST
// .../remove-from-scenes (Phase 33, unchanged) only when the opt-in checkbox
// is checked. ONE atomic undo slot covers the node+edges+reparent topology;
// the opt-in scene cleanup is a deliberate separate action NOT reversed by
// that same undo -- surfaced honestly in the toast, same convention Phase
// 33's own confirm panel used.
// ---------------------------------------------------------------------------
async function handleRemoveClick(sel, btn, consequenceHost) {
  if (removeArmedId !== sel.id) {
    removeArmedId = sel.id;
    removeAlsoScenes = false; // fresh arm = fresh choice
    renderInspector();
    return;
  }

  btn.disabled = true;
  const name = sel.name || sel.id;
  // Read the module flag (kept in sync by the checkbox's change listener), NOT
  // the live DOM -- an async re-render may have rebuilt the checkbox since the
  // user checked it, but the flag survives. Fall back to the DOM only if the
  // flag is unset and a checked box exists (belt-and-suspenders).
  const domCheckbox = consequenceHost.querySelector('[data-testid="world-remove-from-all-scenes-checkbox"]');
  const alsoScenes = removeAlsoScenes || !!(domCheckbox && domCheckbox.checked);
  try {
    // Opt-in scene-reference cleanup FIRST (not covered by the node's undo).
    if (alsoScenes) {
      await wApi(`/api/graph/nodes/${encodeURIComponent(sel.id)}/remove-from-scenes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld() })
      });
    }
    // Then the guarded hybrid delete: reparent children up one level, THEN
    // delete the node cascading its remaining edges -- one atomic undo slot.
    await wApi(`/api/graph/nodes/${encodeURIComponent(sel.id)}/remove-reparent-up`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld() })
    });
    removeArmedId = null;
    removeAlsoScenes = false;
    // The node is gone -- reload re-fetches the graph and re-renders; the
    // stale selection self-clears to the empty inspector (renderInspector's
    // own `if (!sel)` path).
    await reload();
    const undoNote = alsoScenes ? " (not the scene cleanup)" : "";
    showUndoToast(`Removed “${name}” from the graph. Undo restores the node${undoNote}.`, async () => {
      await wApi("/api/manual-undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld() })
      });
      await reload();
    });
  } catch (err) {
    btn.disabled = false;
    showUndoToast(`Could not remove: ${err.message}`, () => {});
  }
}

function sceneDisplayName(scene) {
  if (!scene) return "Scene";
  if (scene.name) return scene.name;
  if (scene.locationEntityId && node(scene.locationEntityId)) return node(scene.locationEntityId).name;
  return scene.objectiveNote || scene.id || "Ad-hoc scene";
}

// Phase 35 task 35.3: mounts the SHARED scene-tray component (scene-tray.js)
// in place of the retired buildSceneTray/srow above. Every DOM/behavior
// contract the phase30/33/34 e2e suite pins (`world-scene-drop-row`,
// `world-scene-tray-hint` reading "Drop into a scene" verbatim, the
// `.wv-scene-drop-meta` "place · N elements · ago" line ticking after a
// drop) is preserved via scene-tray.js's own additive opts -- see its header
// comment. `onExternalDrop` is the actual unification seam: a graph-node
// drop's payload.kind is "graph" (set by startDrag above), never one of the
// shared tray's own roster kinds, so it's routed here to the EXISTING,
// UNCHANGED `addToScene` (the `.../elements/from-graph` route, its own
// dedupe/undo-toast/flash) instead of the generic `POST .../tray/drop` --
// the "roster-drop and element-creation flows are complementary" reading of
// the task brief. `addToScene` itself already calls `renderInspector()` on
// success, which remounts this tray fresh with up-to-date data (including
// the ticked element count) -- no separate refresh() call needed here.
function mountWorldSceneTray(host) {
  mountSceneTray(host, {
    world: currentWorld(),
    rowTestid: "world-scene-drop-row",
    hintText: "Drop into a scene",
    hintTestid: "world-scene-tray-hint",
    metaClass: "wv-scene-drop-meta",
    computeMeta: (scene) => `${(node(scene.locationEntityId) || {}).name || "—"} · ${agoLabel(scene)}`,
    computeMetaAsync: (scene) => sceneContentCount(scene.id).then((n) => {
      if (n == null) return null;
      return `${(node(scene.locationEntityId) || {}).name || "—"} · ${n} elements · ${agoLabel(scene)}`;
    }),
    onExternalDrop: (scene, payload) => {
      if (payload.kind !== "graph") return false;
      return addToScene(payload.id, scene).then(() => true);
    }
  });
}
// Element count for the scene-tray meta (Phase 33 task 33.1: a tree->tray
// drop now creates a REAL scene-ELEMENT, same store app-shell.js:680 counts
// for the Planner surface — so a successful add visibly ticks +1 with no
// second, now-retired scene-membership term to add in).
async function sceneContentCount(sceneId) {
  try {
    const er = await wApi(`/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/elements${withWorld()}`);
    return (er.elements || []).length;
  } catch { return null; }
}

// Brief teal confirmation flash on the dropped-on scene row (reuses the
// existing .wv-drop-target token — no new visual look), so a successful add is
// anchored to the row, not only the transient toast.
function flashSceneDropRow(sceneId) {
  const pane = inspectorPaneEl();
  if (!pane) return;
  const row = pane.querySelector(`[data-testid="world-scene-drop-row"][data-scene-id="${sceneId}"]`);
  if (!row) return;
  row.classList.add("wv-drop-target");
  setTimeout(() => row.classList.remove("wv-drop-target"), 600);
}

function agoLabel(s) {
  const ts = s.lastTouchedAt || s.updatedAt || s.createdAt;
  if (!ts) return "new";
  const then = typeof ts === "number" ? ts : Date.parse(ts);
  if (!then) return "new";
  const days = (Date.now() - then) / 86400000;
  if (days < 0.04) return "just now";
  if (days < 1) return Math.max(1, Math.round(days * 24)) + "h ago";
  if (days < 14) return Math.round(days) + "d ago";
  return Math.round(days / 7) + "w ago";
}

// Phase 33 task 33.1: redirected from the retired scene-membership store to
// the SAME `POST .../elements/from-graph` route the Planner scene page's own
// "◇ From graph" picker already calls (attachExistingNodeAsElement) — a
// World-tray drop and a scene-page From-graph pick are now the literal same
// action, so the dropped node shows up on the Planner scene page with zero
// new read-side logic there.
//
// "Already in scene" detection: attachExistingNodeAsElement is itself
// idempotent (dedupe by graphEntityId, scene-elements.mjs), so the POST
// below is always safe to call and never creates a second element — but we
// still need to know, client-side, whether THIS call was the one that
// created the element, so undo never deletes a pre-existing element the
// user didn't just add. Cleanest available signal: a pre-check read of the
// scene's own elements immediately before the write (no new route/response
// shape needed) — a real race against a concurrent second drop is
// vanishingly unlikely for this single-operator tool and, even if it
// happened, would at worst mislabel the toast, never mis-delete (the DELETE
// undo path only ever targets the element id THIS call's own response
// returned).
async function addToScene(entityId, scene) {
  const n = node(entityId);
  if (!n) return;
  try {
    const before = await wApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements${withWorld()}`);
    const alreadyPresent = (before.elements || []).some((el) => el.kind === "graph" && el.graphEntityId === entityId);

    const { element } = await wApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements/from-graph`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld(), entityId })
    });
    await refreshScenes();
    await recomputeUsedInScene();
    renderInspector();
    renderLoose();
    flashSceneDropRow(scene.id);

    if (alreadyPresent) {
      // No destructive undo offered — this element predates this drop, so
      // deleting it on "Undo" would destroy something the user didn't just
      // create here.
      showUndoToast(`“${n.name}” is already in ${sceneDisplayName(scene)}`, () => {});
      return;
    }

    showUndoToast(`Added “${n.name}” to ${sceneDisplayName(scene)}`, async () => {
      try {
        await wApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements/${encodeURIComponent(element.id)}${withWorld()}`, {
          method: "DELETE", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ world: currentWorld() })
        });
        await refreshScenes();
        await recomputeUsedInScene();
        renderInspector();
        renderLoose();
      } catch { /* best effort */ }
    });
  } catch (err) {
    showUndoToast(`Could not add to scene: ${err.message}`, () => {});
  }
}

async function removeLink(edge) {
  try {
    const snapshot = { sourceId: edge.sourceId, targetId: edge.targetId, relationshipType: edge.relationshipType };
    await wApi(`/api/graph/edges/${encodeURIComponent(edge.id)}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld() })
    });
    await reload();
    showUndoToast("Link removed", async () => {
      await wApi("/api/graph/edges", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld(), ...snapshot })
      });
      await reload();
    });
  } catch (err) {
    showUndoToast(`Could not remove link: ${err.message}`, () => {});
  }
}

// ===========================================================================
// Inline text saves (do not rebuild the focused element)
// ===========================================================================
async function saveName(id, value) {
  const n = node(id);
  if (!n || value === n.name || !value) return;
  try {
    await wApi(`/api/graph/nodes/${encodeURIComponent(id)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld(), data: { name: value } })
    });
    n.name = value;
    renderTree();
    renderInspector();
    const bc = detailHostEl() && detailHostEl().querySelector(".wv-breadcrumb");
    if (bc) { /* breadcrumb of ancestors unaffected by own rename */ }
  } catch (err) {
    showUndoToast(`Could not rename: ${err.message}`, () => {});
  }
}
async function saveDescription(id, value) {
  const n = node(id);
  if (!n || value === (n.description || "")) return;
  try {
    await wApi(`/api/graph/nodes/${encodeURIComponent(id)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld(), data: { description: value } })
    });
    n.description = value;
    n.flaggedUnreviewed = false; // editing description clears the unreviewed flag (editNodeOp)
    renderTree();
    renderLoose();
  } catch (err) {
    showUndoToast(`Could not save: ${err.message}`, () => {});
  }
}

// ===========================================================================
// Phase 37.6 task 3 -- "✦ develop this place". A quiet ghost control beside
// the place-description editor: click to open a one-line vision input
// ("What do you see here?"), POST to the new develop-description route
// (mutation-engine/develop-description.mjs -- a real LLM call reading this
// node's current description + its real graph neighborhood as inspiration +
// the GM's own vision), and show the returned suggestion as a ONE-SHOT
// accept/dismiss card. NEVER writes silently: accept merges the suggestion
// onto the existing description through the SAME saveDescription()/editNodeOp
// path the plain description field already uses; dismiss just discards it.
// ===========================================================================
function buildDevelopPlaceControl(entity) {
  const wrap = document.createElement("div");
  wrap.className = "wv-develop-place-wrap";
  wrap.setAttribute("data-testid", "wv-develop-place-wrap");
  wrap.setAttribute("data-entity-id", entity.id);

  const link = document.createElement("button");
  link.type = "button";
  link.className = "link-btn wv-develop-place-link";
  link.setAttribute("data-testid", "wv-develop-place-link");
  link.textContent = "✦ develop this place";

  const panel = el("div", { class: "wv-inline-panel wv-develop-place-panel", "data-testid": "wv-develop-place-panel" });
  panel.hidden = true;

  const row = el("div", { class: "wv-inline-row" });
  const input = el("input", {
    class: "wv-inline-input", type: "text",
    placeholder: "What do you see here?", "data-testid": "wv-develop-place-input"
  });
  const goBtn = el("button", { class: "wv-inline-commit", type: "button", "data-testid": "wv-develop-place-go-btn" }, "Ask");
  row.append(input, goBtn);

  const status = el("div", { class: "hint wv-develop-place-status" });
  const suggestionHost = el("div", { class: "wv-develop-place-suggestion-host" });

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
      // QA W1 Fix 4: `offline` is a machine flag on the response, never
      // baked into `suggestion` itself -- the suggestion card renders it as
      // CHROME (a small note above the text), and Accept persists ONLY
      // `suggestion` (the clean body), unchanged from before this fix.
      const { suggestion, offline } = await wApi(`/api/graph/nodes/${encodeURIComponent(entity.id)}/develop-description`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: currentWorld(), vision })
      });
      status.textContent = "";
      suggestionHost.appendChild(buildDevelopPlaceSuggestionCard(entity, suggestion, offline, () => { input.value = ""; }));
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
 * The one-shot suggestion card: accept merges into the description via the EXISTING saveDescription()/editNodeOp path (never a new write mechanism); dismiss just discards. Never auto-applies.
 *
 * QA W1 Fix 4: when `offline` is true, a small CHROME note renders above the
 * suggestion text -- the disclaimer lives HERE, never inside `suggestion`
 * itself (which Accept persists verbatim as real entity content).
 */
function buildDevelopPlaceSuggestionCard(entity, suggestion, offline, onResolved) {
  const card = el("div", { class: "wv-develop-place-suggestion", "data-testid": "wv-develop-place-suggestion" });
  if (offline) {
    card.appendChild(el("p", { class: "wv-develop-place-suggestion-chrome", "data-testid": "wv-develop-place-offline-note" },
      "✦ Offline pass — no model configured. This is a placeholder, not a real suggestion; edit it before accepting."));
  }
  card.appendChild(el("p", { class: "wv-develop-place-suggestion-text" }, suggestion));

  const actions = el("div", { class: "wv-develop-place-suggestion-actions" });
  const acceptBtn = el("button", { class: "btn btn--accept", type: "button", "data-testid": "wv-develop-place-accept-btn" }, "Accept into description");
  const dismissBtn = el("button", { class: "link-btn", type: "button", "data-testid": "wv-develop-place-dismiss-btn" }, "Dismiss");

  acceptBtn.addEventListener("click", async () => {
    acceptBtn.disabled = true;
    dismissBtn.disabled = true;
    const n = node(entity.id);
    const current = ((n && n.description) || "").trim();
    const merged = current ? `${current}\n\n${suggestion}` : suggestion;
    await saveDescription(entity.id, merged); // same path/route the plain description field already uses; never a new write mechanism
    onResolved();
    renderDetail(); // description changed -- rebuild the pane so the grid shows the merged text
  });
  dismissBtn.addEventListener("click", () => {
    card.remove();
    onResolved();
  });

  actions.append(acceptBtn, dismissBtn);
  card.appendChild(actions);
  return card;
}

// ===========================================================================
// Selection + navigation
// ===========================================================================
function select(id) {
  if (!id) return;
  // expand ancestors so the row is reachable in the tree
  for (const a of ancestorChain(id)) ui.expanded.add(a);
  if (location.hash !== `#world/${id}`) {
    goto(`world/${id}`); // hashchange -> renderShell -> renderWorldSurface(id)
  } else {
    applySelection(id);
  }
}
function applySelection(id) {
  // Selecting a different node always disarms a pending remove (D5-D8's own
  // "selecting another node disarms" rule) -- do this BEFORE reassigning
  // selectedId so the comparison is against the outgoing selection.
  if (selectedId !== id) { removeArmedId = null; removeAlsoScenes = false; }
  selectedId = id || null;
  if (!cache.derived) return;
  if (selectedId) for (const a of ancestorChain(selectedId)) ui.expanded.add(a);
  renderTree();
  renderDetail();
  renderLoose();
  renderInspector();
}

// ===========================================================================
// Data loading
// ===========================================================================
async function loadGraph() {
  const graph = await wApi(`/api/graph${withWorld({ filter: "all" })}`);
  cache.graph = graph;
  cache.derived = buildDerived(graph);
  cache.loyaltyDerived = buildDerived(graph, LOYALTY_PARENT_EDGE);
  cache.world = currentWorld();
  // First load of a world: reveal the structure by expanding every node that
  // has children (one-time; a later user collapse-all is respected).
  if (!ui.expandedInit) {
    ui.expandedInit = true;
    for (const n of cache.derived.nodesById.values()) {
      if (childIdsOf(n.id).length) ui.expanded.add(n.id);
    }
  }
}
async function refreshScenes() {
  try {
    const { scenes } = await wApi(`/api/session-planner/scenes${withWorld({ sort: "recency" })}`);
    cache.scenes = scenes || [];
  } catch {
    cache.scenes = [];
  }
}
// "Used in a scene" set (anchors + graph-elements) for the loose lane. Phase
// 33 task 33.1: previously approximated via anchors+members (scene-membership
// was a coarser, separate store); now that a World-tray drop creates the
// SAME kind:'graph' scene-element the Planner surface renders, this is an
// EXACT match to "appears somewhere in the Planner" rather than an
// approximation — the selected node's own precise usage still comes from
// scenesForEntity in the inspector (unchanged, that route already reasons
// over anchor+element roles the same way).
async function recomputeUsedInScene() {
  const used = new Set();
  const scenes = cache.scenes || [];
  for (const s of scenes) {
    if (s.locationEntityId) used.add(s.locationEntityId);
  }
  await Promise.all(scenes.map(async (s) => {
    try {
      const { elements } = await wApi(`/api/scene-planning/scenes/${encodeURIComponent(s.id)}/elements${withWorld()}`);
      for (const el of elements || []) {
        if (el.kind === "graph" && el.graphEntityId) used.add(el.graphEntityId);
      }
    } catch { /* ignore */ }
  }));
  cache.usedInScene = used;
}
async function reload() {
  await loadGraph();
  await recomputeUsedInScene();
  applySelection(selectedId);
  // W5b: keep the Graph rail mode in sync with fresh data too.
  if (ui.railMode === "graph") renderWorldGraph();
}

// ===========================================================================
// Entry point
// ===========================================================================
export async function renderWorldSurface(entityId) {
  const world = currentWorld();
  const container = main();
  if (!container) return;

  if (!world) {
    container.innerHTML = "";
    const r = el("div", { class: "world-surface", "data-testid": "world-surface-root" });
    r.appendChild(el("div", { class: "wv-empty-detail" }, "Select a world first."));
    container.appendChild(r);
    clearWorldTopbar();
    return;
  }

  const worldChanged = cache.world && cache.world !== world;
  if (worldChanged || ui.world !== world) resetForWorld(world);

  const alreadyMounted = !!root() && cache.graph && cache.world === world;
  selectedId = entityId || null;

  // W5b: the shell topbar's world slot is retired (search/filters live in
  // the surface's own sub-bar now) -- keep it empty.
  clearWorldTopbar();

  if (alreadyMounted) {
    // hash-driven re-mount within the same world: reuse cached data.
    applySelection(selectedId);
    return;
  }

  const token = ++mountToken;
  buildSkeleton();
  // The root (world-surface-root) exists synchronously from buildSkeleton;
  // the panes fill once the graph loads (guarded below).
  try {
    await loadGraph();
    if (token !== mountToken) return;
    await refreshScenes();
    if (token !== mountToken) return;
    await recomputeUsedInScene();
    if (token !== mountToken) return;
    applySelection(selectedId);
    // W5b: a rebuilt skeleton (e.g. returning from another surface with
    // Graph mode still selected for this world) needs the graph re-rendered.
    if (ui.railMode === "graph") renderWorldGraph();
  } catch (err) {
    const host = detailHostEl();
    if (host) { host.innerHTML = ""; host.appendChild(el("div", { class: "wv-empty-detail" }, `Could not load the world graph: ${err.message}`)); }
  }
}
