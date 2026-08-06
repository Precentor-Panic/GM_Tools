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
import { colorForType } from "./graph-view.js";

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
  sceneQuery: ""
};
const cache = { world: null, graph: null, derived: null, scenes: null, usedInScene: null };
let selectedId = null;
let mountToken = 0;
let descSaver = null;
let descSaverForId = null;

function resetForWorld(world) {
  ui.world = world;
  ui.expanded = new Set();
  ui.query = "";
  ui.types = new Set();
  ui.looseOpen = true;
  ui.looseFilter = null;
  ui.sceneQuery = "";
  ui.expandedInit = false;
  cache.world = null;
  cache.graph = null;
  cache.derived = null;
  cache.scenes = null;
  cache.usedInScene = null;
}

// ---------------------------------------------------------------------------
// Derived containment structure from the containment EDGES.
// ---------------------------------------------------------------------------
function buildDerived(graph) {
  const nodesById = new Map();
  for (const n of graph.nodes || []) nodesById.set(n.id, n);
  const parentOf = new Map();
  const childrenOf = new Map();
  const nonContainment = [];
  for (const e of graph.edges || []) {
    if (e.relationshipType === "containment") {
      parentOf.set(e.sourceId, e.targetId);
      if (!childrenOf.has(e.targetId)) childrenOf.set(e.targetId, []);
      childrenOf.get(e.targetId).push(e.sourceId);
    } else {
      nonContainment.push(e);
    }
  }
  return { nodesById, parentOf, childrenOf, nonContainment };
}
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
  const r = el("div", { class: "world-surface", "data-testid": "world-surface-root" });

  // Left: containment tree ("Where things are").
  const treePane = el("aside", { class: "wv-tree-pane" });
  const treeHead = el("div", { class: "wv-tree-head" });
  treeHead.appendChild(el("div", { class: "wv-mono-label" }, "Where things are"));
  const spacer = el("div", { style: "flex:1" });
  const expandToggle = el("div", { class: "wv-expand-toggle" });
  expandToggle.addEventListener("click", toggleExpandAll);
  treeHead.append(spacer, expandToggle);
  const treeScroll = el("div", { class: "wv-tree-scroll" });
  const tree = el("div", { class: "wv-tree", "data-testid": "world-tree" });
  const treeHint = el("div", { class: "wv-tree-hint" },
    "Drag any node onto a place to put it inside. That single edge is all the detail you owe it.");
  treeScroll.append(tree, treeHint);
  treePane.append(treeHead, treeScroll);

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

  r.append(treePane, centerPane, inspectorPane);
  container.appendChild(r);

  return { tree, expandToggle, detailHost, looseHost, inspectorPane };
}

// ===========================================================================
// Topbar (World-only): search box + six type-filter chips, mounted into the
// shell topbar's world slot. Built once per mount; chip states patched in
// place so typing/toggling never rebuilds the input (no focus loss).
// ===========================================================================
export function clearWorldTopbar() {
  const slot = document.getElementById("shell-world-topbar-slot");
  if (slot) slot.innerHTML = "";
}
function mountWorldTopbar() {
  const slot = document.getElementById("shell-world-topbar-slot");
  if (!slot) return;
  slot.innerHTML = "";
  const wrap = el("div", { class: "wv-topbar" });

  const search = el("input", {
    class: "wv-search", type: "text", placeholder: "Search the world…",
    "data-testid": "world-search", value: ui.query
  });
  search.addEventListener("input", () => {
    ui.query = search.value;
    renderTree();
  });

  const chips = el("div", { class: "wv-chips" });
  for (const t of TYPE_ORDER) {
    const meta = TYPES[t];
    const chip = el("div", { class: "wv-chip", "data-type": t, title: `Filter to ${meta.label.toLowerCase()}s` });
    chip.append(
      el("span", { class: "wv-chip-glyph", style: `color:${meta.accent}` }, meta.glyph),
      el("span", null, meta.label)
    );
    chip.addEventListener("click", () => {
      if (ui.types.has(t)) ui.types.delete(t); else ui.types.add(t);
      syncChipStates(chips);
      renderTree();
    });
    chips.appendChild(chip);
  }
  syncChipStates(chips);

  wrap.append(search, chips);
  slot.appendChild(wrap);
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
    for (const n of d().nodesById.values()) {
      if (!matches(n)) continue;
      keep.add(n.id);
      for (const a of ancestorChain(n.id)) keep.add(a);
    }
  }
  const rows = [];
  const walk = (parentId, depth) => {
    const ids = (parentId === null ? rootIds() : childIdsOf(parentId))
      .filter((id) => !filtering || keep.has(id))
      .map((id) => node(id))
      .sort(sortNodes);
    for (const n of ids) {
      const kidIds = childIdsOf(n.id).filter((id) => !filtering || keep.has(id));
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
    for (const n of d().nodesById.values()) {
      if (childIdsOf(n.id).length) ui.expanded.add(n.id);
    }
  }
  renderTree();
}
function renderTree() {
  const tree = root() && root().querySelector('[data-testid="world-tree"]');
  if (!tree) return;
  tree.innerHTML = "";
  for (const r of visibleRows()) tree.appendChild(buildTreeRow(r));
  const toggle = root().querySelector(".wv-expand-toggle");
  if (toggle) toggle.textContent = ui.expanded.size > 6 ? "collapse all" : "expand all";
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
  if (n.flaggedUnreviewed) row.appendChild(el("span", { class: "wv-unreviewed-dot", title: "Unreviewed since last session" }));
  row.appendChild(el("span", { class: "wv-tree-count" }, r.kids ? String(r.kids) : ""));

  row.addEventListener("click", () => select(n.id));
  wireReparentTarget(row, n.id, () => n.id);
  row.addEventListener("dragstart", (e) => { e.stopPropagation(); startDrag(n.id, e); });
  return row;
}

// ---------------------------------------------------------------------------
// Drag/drop reparent. dragId lives on the dataTransfer + a module var.
// ---------------------------------------------------------------------------
let dragId = null;
function startDrag(id, e) {
  dragId = id;
  if (e && e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", id); } catch { /* ignore */ } }
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
  header.append(el("span", { style: "flex:1" }), el("span", { class: "wv-inspector-openfull" }, "Open full page →"));
  insp.appendChild(header);

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

  // Scene tray
  insp.appendChild(buildSceneTray(sel));

  pane.appendChild(insp);
  fillAppearsIn(sel.id, appears);
}

async function fillAppearsIn(id, target) {
  const captured = id;
  try {
    const { appearances } = await wApi(`/api/scene-planning/entities/${encodeURIComponent(id)}/scenes${withWorld()}`);
    if (captured !== selectedId) return;
    target.innerHTML = "";
    if (!appearances || !appearances.length) {
      target.textContent = "No scene has used this yet.";
      return;
    }
    for (const a of appearances) {
      const nm = sceneDisplayName(a.scene);
      const isAnchor = (a.roles || []).includes("anchor");
      const line = el("div", { class: "wv-appears-line" }, nm + (isAnchor ? " (anchor place)" : ""));
      target.appendChild(line);
    }
  } catch {
    if (captured === selectedId) target.textContent = "No scene has used this yet.";
  }
}

function sceneDisplayName(scene) {
  if (!scene) return "Scene";
  if (scene.name) return scene.name;
  if (scene.locationEntityId && node(scene.locationEntityId)) return node(scene.locationEntityId).name;
  return scene.objectiveNote || scene.id || "Ad-hoc scene";
}

function buildSceneTray(sel) {
  const tray = el("div", { class: "wv-scene-tray" });
  const head = el("div", { class: "wv-scene-tray-head" });
  head.append(
    el("div", { class: "wv-mono-label" }, "Drop into a scene"),
    el("div", { style: "flex:1" }),
    // §3.2(b): label the gesture so the scene-add tray reads distinctly from a
    // tree-row reparent drop. Text-only, in the existing hint slot.
    el("div", { class: "wv-mono wv-scene-tray-hint" }, "drag a node here → in the scene")
  );
  const search = el("input", { class: "wv-scene-tray-search", type: "text", placeholder: "Find a scene…", value: ui.sceneQuery });
  const list = el("div", { class: "wv-scene-tray-list" });
  const renderList = () => {
    list.innerHTML = "";
    const q = ui.sceneQuery.trim().toLowerCase();
    const scenes = (cache.scenes || []).filter((s) => {
      if (!q) return true;
      const pn = (node(s.locationEntityId) || {}).name || "";
      return sceneDisplayName(s).toLowerCase().includes(q) || pn.toLowerCase().includes(q);
    });
    if (!scenes.length) { list.appendChild(el("div", { class: "wv-hint" }, "No scenes yet.")); return; }
    for (const s of scenes) {
      srow(s, sel, list);
    }
  };
  search.addEventListener("input", () => { ui.sceneQuery = search.value; renderList(); });
  head.appendChild(search);
  tray.append(head, list);
  renderList();
  return tray;
}
function srow(s, sel, list) {
  const placeName = (node(s.locationEntityId) || {}).name || "—";
  const row = el("div", { class: "wv-scene-drop", "data-testid": "world-scene-drop-row", "data-scene-id": s.id });
  row.appendChild(el("div", { class: "wv-scene-drop-name" }, sceneDisplayName(s)));
  // Meta reads `place · N elements · ago` (prototype World Graph.dc.html:608).
  // N is fetched async from the SAME /scenes/:id/elements count app-shell.js:680
  // uses, PLUS explicit scene members (a tree->tray drop adds a MEMBER, not a
  // scene-element, so the count only visibly ticks if members are included).
  const meta = el("div", { class: "wv-scene-drop-meta" }, `${placeName} · ${agoLabel(s)}`);
  row.appendChild(meta);
  sceneContentCount(s.id).then((n) => {
    if (n != null) meta.textContent = `${placeName} · ${n} elements · ${agoLabel(s)}`;
  });
  row.addEventListener("dragover", (e) => { e.preventDefault(); row.classList.add("wv-drop-target"); });
  row.addEventListener("dragleave", () => row.classList.remove("wv-drop-target"));
  row.addEventListener("drop", (e) => {
    e.preventDefault();
    row.classList.remove("wv-drop-target");
    const src = dragId; dragId = null;
    if (src) addToScene(src, s);
  });
  list.appendChild(row);
}
// Element count for the scene-tray meta. Elements (scene-elements store, the
// same list app-shell.js:680 counts) PLUS explicit scene members, since a
// tree->tray drop records a MEMBER — so a successful add visibly ticks +1.
async function sceneContentCount(sceneId) {
  try {
    const [er, mr] = await Promise.all([
      wApi(`/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/elements${withWorld()}`),
      wApi(`/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/members${withWorld()}`)
    ]);
    const e = (er.elements || []).length;
    const m = (mr.membership && Array.isArray(mr.membership.entityIds)) ? mr.membership.entityIds.length : 0;
    return e + m;
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

async function addToScene(entityId, scene) {
  const n = node(entityId);
  if (!n) return;
  try {
    await wApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/members`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: currentWorld(), entityId })
    });
    await refreshScenes();
    await recomputeUsedInScene();
    renderInspector();
    renderLoose();
    flashSceneDropRow(scene.id);
    showUndoToast(`Added “${n.name}” to ${sceneDisplayName(scene)}`, async () => {
      try {
        await wApi(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/members/${encodeURIComponent(entityId)}${withWorld()}`, {
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
// Best-effort "used in a scene" set (anchors + members) for the loose lane.
// Elements-as-usage is approximated by anchors+members here to bound calls;
// the selected node's own precise usage still comes from scenesForEntity in
// the inspector. Flagged as a minor fidelity approximation.
async function recomputeUsedInScene() {
  const used = new Set();
  const scenes = cache.scenes || [];
  for (const s of scenes) {
    if (s.locationEntityId) used.add(s.locationEntityId);
  }
  await Promise.all(scenes.map(async (s) => {
    try {
      const { membership } = await wApi(`/api/scene-planning/scenes/${encodeURIComponent(s.id)}/members${withWorld()}`);
      for (const eid of (membership && membership.entityIds) || []) used.add(eid);
    } catch { /* ignore */ }
  }));
  cache.usedInScene = used;
}
async function reload() {
  await loadGraph();
  await recomputeUsedInScene();
  applySelection(selectedId);
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

  if (alreadyMounted) {
    // hash-driven re-mount within the same world: reuse cached data.
    if (!document.getElementById("shell-world-topbar-slot").firstChild) mountWorldTopbar();
    applySelection(selectedId);
    return;
  }

  const token = ++mountToken;
  buildSkeleton();
  mountWorldTopbar();
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
  } catch (err) {
    const host = detailHostEl();
    if (host) { host.innerHTML = ""; host.appendChild(el("div", { class: "wv-empty-detail" }, `Could not load the world graph: ${err.message}`)); }
  }
}
