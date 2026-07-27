// GM Review — Phase 7 shared graph-rendering component. Plain JS, no
// framework, no charting/graph-visualization library (vanilla SVG + a
// small hand-rolled force layout), matching this project's zero-build-step
// convention. Used by BOTH the Batch Review screen's List/Graph toggle
// (task 7.3) and the standalone Graph nav view (task 7.4) -- one rendering
// system, not two, per plans/phase-7-review.md's explicit requirement.
//
// This module owns rendering/layout/interaction only. It never calls a
// review API route itself and never owns accept/reject/selection STATE --
// every action a node's popover offers is a caller-supplied callback, so
// the graph is always a second VIEW over app.js's existing batch-review
// state (the checkbox/accept/reject mechanism List mode already uses),
// never a second source of truth. See app.js's own wiring for how
// onToggleSelect/onAccept/onReject are implemented in terms of the exact
// same DOM checkboxes and api() calls List mode uses.
"use strict";

// ---------------------------------------------------------------------------
// entity-type fill color
// ---------------------------------------------------------------------------

// No pre-existing entity-type color mapping was found anywhere in this app
// (checked app.js/style.css/index.html before writing this) -- entityTypes
// are a per-world, game.settings-configurable vocabulary (see World
// Fabric's Type Manager), not a fixed enum this file could hardcode a
// palette against. Deterministically hash the type string to a hue instead:
// the same type name always gets the same color within and across
// sessions, without needing to know the type vocabulary in advance.
const TYPE_COLOR_CACHE = new Map();
export function colorForType(type) {
  const key = type || "unknown";
  if (TYPE_COLOR_CACHE.has(key)) return TYPE_COLOR_CACHE.get(key);
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  const color = `hsl(${hue}, 52%, 52%)`;
  TYPE_COLOR_CACHE.set(key, color);
  return color;
}

// ---------------------------------------------------------------------------
// edge directionality (a rendering concern only -- World Fabric's
// RELATIONSHIP_TYPES carries no explicit directional flag, so this is a
// judgment call made once here rather than assumed ad hoc per caller:
// asymmetric relationship types (X is a vassal OF Y, X owns Y, X caused Y)
// get an arrowhead; genuinely symmetric ones (kinship, social, unspecified)
// don't.
// ---------------------------------------------------------------------------

const DIRECTIONAL_RELATIONSHIP_TYPES = new Set([
  "fealty", "membership", "ownership", "causal", "knowledge",
  "containment", "presence", "origin"
]);
export function isDirectionalRelationship(relationshipType) {
  return DIRECTIONAL_RELATIONSHIP_TYPES.has(relationshipType);
}

// ---------------------------------------------------------------------------
// layout: dimensions + node sizing
// ---------------------------------------------------------------------------

const LAYOUT_W = 960;
const LAYOUT_H = 620;
const MIN_R = 14;
const MAX_R = 34;

function radiusForDegree(degree) {
  const r = MIN_R + Math.sqrt(Math.max(0, degree)) * 6;
  return Math.max(MIN_R, Math.min(MAX_R, r));
}

// ---------------------------------------------------------------------------
// position cache -- localStorage, keyed by caller-supplied cacheKey (a
// batch id, or a fixed key for the standalone view). Task 7's explicit
// requirement: reopening the same graph must not visibly rearrange it, and
// this must survive a genuine page reload, not just an in-session
// re-render -- localStorage (not an in-memory Map) is what makes that true
// across a reload.
// ---------------------------------------------------------------------------

function cacheStorageKey(cacheKey) {
  return `gmReview.graphLayout.${cacheKey}`;
}

function loadPositionCache(cacheKey) {
  try {
    const raw = localStorage.getItem(cacheStorageKey(cacheKey));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function savePositionCache(cacheKey, positions) {
  const plain = {};
  for (const [id, p] of positions) plain[id] = { x: p.x, y: p.y };
  try {
    localStorage.setItem(cacheStorageKey(cacheKey), JSON.stringify(plain));
  } catch {
    // localStorage full/unavailable -- layout still works for this session, just won't persist. Not fatal.
  }
}

/**
 * Compute (or reuse) node positions. Nodes with an existing cached position
 * keep it EXACTLY (no physics re-run at all) -- reopening the identical
 * node set never rearranges anything. Genuinely new node ids (a fresh
 * batch, or "expand context" pulling in a deeper neighborhood) get placed
 * by a short force-directed pass that treats every already-positioned node
 * as fixed, so existing nodes never move just because new ones arrived.
 */
function computeLayout(nodes, edges, cacheKey) {
  const cache = loadPositionCache(cacheKey);
  const positions = new Map();
  const missingIds = [];
  for (const n of nodes) {
    const p = cache[n.id];
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      positions.set(n.id, { x: p.x, y: p.y });
    } else {
      missingIds.push(n.id);
    }
  }
  if (missingIds.length) {
    runForceLayout(nodes, edges, positions, new Set(missingIds));
  }
  savePositionCache(cacheKey, positions);
  return positions;
}

/** A compact, hand-rolled force simulation (Fruchterman-Reingold-ish): pairwise repulsion, edge-spring attraction, weak centering. No D3, no external graph-viz library, per this project's zero-build-step/minimal-dependency convention. */
function runForceLayout(nodes, edges, positions, mobileIds) {
  const w = LAYOUT_W, h = LAYOUT_H;
  const cx = w / 2, cy = h / 2;
  const k = Math.sqrt((w * h) / Math.max(1, nodes.length)); // ideal spacing constant

  for (const n of nodes) {
    if (!positions.has(n.id)) {
      // Seed newcomers randomly near center rather than at a fixed origin
      // (fixed origin -> initial pairwise-repulsion NaNs/instability when
      // two nodes start at literally the same point).
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * Math.min(w, h) * 0.25;
      positions.set(n.id, { x: cx + Math.cos(angle) * dist, y: cy + Math.sin(angle) * dist });
    }
  }

  const ITERATIONS = 220;
  let temperature = Math.max(w, h) / 12;

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const disp = new Map(nodes.map((n) => [n.id, { x: 0, y: 0 }]));

    // repulsion (all pairs) -- fine at this project's scale (tens to a
    // few hundred nodes; the standalone view's default flagged-only filter
    // is the actual scaling lever per the design doc, not this loop).
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = positions.get(nodes[i].id), b = positions.get(nodes[j].id);
        let dx = a.x - b.x, dy = a.y - b.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const force = (k * k) / dist;
        dx = (dx / dist) * force;
        dy = (dy / dist) * force;
        const da = disp.get(nodes[i].id), db = disp.get(nodes[j].id);
        da.x += dx; da.y += dy;
        db.x -= dx; db.y -= dy;
      }
    }

    // attraction (edges only)
    for (const e of edges) {
      const a = positions.get(e.sourceId), b = positions.get(e.targetId);
      if (!a || !b) continue;
      let dx = a.x - b.x, dy = a.y - b.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const force = (dist * dist) / k;
      dx = (dx / dist) * force;
      dy = (dy / dist) * force;
      const da = disp.get(e.sourceId), db = disp.get(e.targetId);
      if (da) { da.x -= dx; da.y -= dy; }
      if (db) { db.x += dx; db.y += dy; }
    }

    for (const n of nodes) {
      if (!mobileIds.has(n.id)) continue; // fixed/cached nodes never move
      const p = positions.get(n.id);
      const d = disp.get(n.id);
      const dist = Math.sqrt(d.x * d.x + d.y * d.y) || 0.01;
      const clamped = Math.min(dist, temperature);
      p.x += (d.x / dist) * clamped + (cx - p.x) * 0.004; // weak centering pull
      p.y += (d.y / dist) * clamped + (cy - p.y) * 0.004;
      p.x = Math.max(MAX_R + 4, Math.min(w - MAX_R - 4, p.x));
      p.y = Math.max(MAX_R + 4, Math.min(h - MAX_R - 4, p.y));
    }
    temperature *= 0.96;
  }
}

// ---------------------------------------------------------------------------
// SVG element construction helpers
// ---------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
  return el;
}
function truncateLabel(s, n = 16) {
  const str = String(s ?? "");
  return str.length > n ? `${str.slice(0, n - 1)}\u2026` : str;
}

// ---------------------------------------------------------------------------
// main render entry point
// ---------------------------------------------------------------------------

/**
 * @param {HTMLElement} container   a positioned (position:relative) block-level element, cleared and (re)filled each call
 * @param {{nodes:object[], edges:object[]}} graph  each node: {id,name,type,degree,flaggedUnreviewed,hasDeferredDebt,proposed?, status?, mutationId?, rationale?}; each edge: {id,sourceId,targetId,relationshipType,proposed?}
 * @param {object} opts
 * @param {string} opts.cacheKey                localStorage layout-cache key (e.g. `batch:${batchId}` or `standalone`)
 * @param {'batch'|'standalone'} [opts.mode='standalone']
 * @param {(nodeId:string) => boolean} [opts.isSelected]        batch mode: whether this node's underlying checkbox is currently checked
 * @param {(nodeId:string, selected:boolean) => void} [opts.onToggleSelect]  batch mode: caller flips the real checkbox (the shared selection state)
 * @param {(mutationId:string) => void} [opts.onAccept]
 * @param {(mutationId:string) => void} [opts.onReject]
 * @param {(nodeId:string) => void} [opts.onShowInList]         batch mode, or standalone when the node belongs to an open batch
 * @param {(nodeId:string) => {batchId:string}|null} [opts.findOpenBatchForNode]  standalone mode only
 * @param {(nodeId:string) => void} [opts.onDevelopNode]        Phase 11, standalone mode ONLY -- "Develop this node" popover link, never rendered in batch mode
 */
export function renderGraph(container, graph, opts = {}) {
  const mode = opts.mode ?? "standalone";
  container.innerHTML = "";
  container.classList.add("graph-view-container");

  if (!graph.nodes.length) {
    const empty = document.createElement("div");
    empty.className = "graph-empty-state";
    empty.textContent = "Nothing to show here.";
    container.appendChild(empty);
    return;
  }

  const positions = computeLayout(graph.nodes, graph.edges, opts.cacheKey ?? "default");

  const svg = svgEl("svg", {
    viewBox: `0 0 ${LAYOUT_W} ${LAYOUT_H}`,
    class: "graph-svg",
    "data-testid": "graph-svg"
  });

  const defs = svgEl("defs");
  const marker = svgEl("marker", {
    id: "graph-arrowhead", viewBox: "0 0 10 10", refX: "9", refY: "5",
    markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse"
  });
  marker.appendChild(svgEl("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "var(--text-muted)" }));
  defs.appendChild(marker);
  svg.appendChild(defs);

  const edgeLayer = svgEl("g", { class: "graph-edges" });
  const nodeLayer = svgEl("g", { class: "graph-nodes" });
  svg.appendChild(edgeLayer);
  svg.appendChild(nodeLayer);

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  for (const e of graph.edges) {
    const a = positions.get(e.sourceId), b = positions.get(e.targetId);
    if (!a || !b) continue;
    const line = svgEl("line", {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      class: `graph-edge${e.proposed ? " graph-edge--proposed" : ""}`
    });
    if (isDirectionalRelationship(e.relationshipType)) line.setAttribute("marker-end", "url(#graph-arrowhead)");
    edgeLayer.appendChild(line);
  }

  const selectedIds = new Set();

  for (const n of graph.nodes) {
    const p = positions.get(n.id);
    if (!p) continue;
    const r = radiusForDegree(n.degree ?? 0);
    const g = svgEl("g", {
      class: `graph-node${n.status === "accepted" ? " graph-node--accepted" : ""}${n.status === "rejected" ? " graph-node--rejected" : ""}`,
      transform: `translate(${p.x}, ${p.y})`,
      "data-node-id": n.id
    });

    const fill = svgEl("circle", { r, class: "graph-node-fill", fill: colorForType(n.type) });
    const border = svgEl("circle", {
      r, class: `graph-node-border${n.flaggedUnreviewed ? " graph-node-border--unreviewed" : ""}`,
      "stroke-dasharray": n.proposed ? "4,3" : null
    });
    g.append(fill, border);

    if (n.hasDeferredDebt) {
      g.appendChild(svgEl("circle", {
        class: "graph-node-debt-badge",
        cx: r * 0.68, cy: -r * 0.68, r: 5
      }));
    }

    if (n.status === "accepted") {
      const check = svgEl("text", { class: "graph-node-decided-mark", x: 0, y: 4, "text-anchor": "middle" });
      check.textContent = "\u2713";
      g.appendChild(check);
    } else if (n.status === "rejected") {
      const cross = svgEl("text", { class: "graph-node-decided-mark", x: 0, y: 4, "text-anchor": "middle" });
      cross.textContent = "\u2715";
      g.appendChild(cross);
    }

    const label = svgEl("text", { class: "graph-node-label", x: 0, y: r + 13, "text-anchor": "middle" });
    label.textContent = truncateLabel(n.name);
    g.appendChild(label);

    if (mode === "batch" && opts.isSelected?.(n.id)) {
      g.classList.add("graph-node--selected");
      selectedIds.add(n.id);
    }

    g.addEventListener("mouseenter", (evt) => showTooltip(container, n, evt));
    g.addEventListener("mousemove", (evt) => moveTooltip(container, evt));
    g.addEventListener("mouseleave", () => hideTooltip(container));

    g.addEventListener("mousedown", (evt) => evt.stopPropagation()); // don't let a node click start a rubber-band drag

    g.addEventListener("click", (evt) => {
      evt.stopPropagation();
      if (evt.shiftKey && mode === "batch") {
        // Only a node with its OWN pending mutation is actually selectable
        // (matches List mode's checkbox.disabled rule for the same
        // mutation) -- a purely-contextual neighbor (pulled in only by
        // neighborhood() expansion, or already accepted/rejected) has
        // nothing for the bulk bar to act on, so it must never visually
        // suggest it was selected.
        if (!n.mutationId || n.status !== "pending") return;
        const nowSelected = !g.classList.contains("graph-node--selected");
        g.classList.toggle("graph-node--selected", nowSelected);
        opts.onToggleSelect?.(n.id, nowSelected);
        return;
      }
      showPopover(container, n, p, opts);
    });

    nodeLayer.appendChild(g);
  }

  container.appendChild(svg);
  wireRubberBandSelection(container, svg, graph.nodes, positions, mode, opts);
  applyZoom(container, svg, container._graphZoom ?? 1);
  wireZoomControls(container);
}

// ---------------------------------------------------------------------------
// zoom/pan (real-usage feedback: the fixed 420px box read as "very small"
// with no way to see more detail or move around a dense graph). Deliberately
// implemented as a CSS size change on the SVG element itself, inside a
// scrollable container -- NOT a viewBox/transform change -- specifically so
// the existing screen<->layout coordinate math in showPopover() and
// wireRubberBandSelection() (both already ratio-based off
// getBoundingClientRect() vs LAYOUT_W/LAYOUT_H) keeps working completely
// unchanged and correct at any zoom level, with zero risk to that
// already-hardened code. Panning is native browser scroll once the SVG is
// larger than its container -- no custom drag-to-pan gesture, so there's no
// conflict with batch mode's own background-drag rubber-band select.
// ---------------------------------------------------------------------------

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.25;
const ZOOM_BASE_HEIGHT = 420; // matches .graph-svg's CSS default at zoom 1

function applyZoom(container, svg, zoom) {
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
  container._graphZoom = clamped;
  svg.style.width = `${clamped * 100}%`;
  svg.style.height = `${Math.round(ZOOM_BASE_HEIGHT * clamped)}px`;
  const label = container.querySelector(".graph-zoom-label");
  if (label) label.textContent = `${Math.round(clamped * 100)}%`;
}

function wireZoomControls(container) {
  let bar = container.querySelector(".graph-zoom-controls");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "graph-zoom-controls";
    const zoomBy = (delta) => {
      const svg = container.querySelector(".graph-svg");
      if (svg) applyZoom(container, svg, (container._graphZoom ?? 1) + delta);
    };
    const outBtn = document.createElement("button");
    outBtn.type = "button";
    outBtn.className = "graph-zoom-btn";
    outBtn.textContent = "−";
    outBtn.title = "Zoom out";
    outBtn.addEventListener("click", () => zoomBy(-ZOOM_STEP));
    const label = document.createElement("span");
    label.className = "graph-zoom-label";
    label.textContent = "100%";
    const inBtn = document.createElement("button");
    inBtn.type = "button";
    inBtn.className = "graph-zoom-btn";
    inBtn.textContent = "+";
    inBtn.title = "Zoom in";
    inBtn.addEventListener("click", () => zoomBy(ZOOM_STEP));
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "graph-zoom-btn graph-zoom-reset";
    resetBtn.textContent = "Reset";
    resetBtn.title = "Reset zoom";
    resetBtn.addEventListener("click", () => {
      const svg = container.querySelector(".graph-svg");
      if (svg) applyZoom(container, svg, 1);
    });
    bar.append(outBtn, label, inBtn, resetBtn);
  }
  // The zoom bar must survive renderGraph()'s `container.innerHTML = ""`
  // teardown-and-rebuild-on-every-refresh (same reason wireRubberBandSelection
  // guards its own window listeners) -- re-append every call rather than
  // relying on it having stuck around, since it definitely didn't.
  container.appendChild(bar);

  // Ctrl/Cmd+wheel zooms; plain wheel is left alone so normal page/container
  // scroll (the actual pan mechanism once zoomed in) isn't hijacked. Bound
  // once per container, same de-dup pattern as the rubber-band listeners.
  if (!container._graphWheelWired) {
    container._graphWheelWired = true;
    container.addEventListener(
      "wheel",
      (evt) => {
        if (!evt.ctrlKey && !evt.metaKey) return;
        evt.preventDefault();
        const svg = container.querySelector(".graph-svg");
        if (svg) applyZoom(container, svg, (container._graphZoom ?? 1) + (evt.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
      },
      { passive: false }
    );
  }
}

// ---------------------------------------------------------------------------
// tooltip (hover)
// ---------------------------------------------------------------------------

function statusText(n) {
  const parts = [];
  if (n.flaggedUnreviewed) parts.push("unreviewed");
  if (n.hasDeferredDebt) parts.push("deferred debt");
  if (n.status) parts.push(n.status);
  return parts.length ? parts.join(", ") : "no flags";
}

function ensureTooltipEl(container) {
  let el = container.querySelector(".graph-tooltip");
  if (!el) {
    el = document.createElement("div");
    el.className = "graph-tooltip";
    el.hidden = true;
    container.appendChild(el);
  }
  return el;
}

function showTooltip(container, node, evt) {
  const el = ensureTooltipEl(container);
  el.innerHTML = `<strong>${escapeHtmlLocal(node.name)}</strong><br>${escapeHtmlLocal(node.type)} \u00b7 ${escapeHtmlLocal(statusText(node))}`;
  el.hidden = false;
  moveTooltip(container, evt);
}
function moveTooltip(container, evt) {
  const el = container.querySelector(".graph-tooltip");
  if (!el || el.hidden) return;
  const rect = container.getBoundingClientRect();
  el.style.left = `${evt.clientX - rect.left + 12}px`;
  el.style.top = `${evt.clientY - rect.top + 12}px`;
}
function hideTooltip(container) {
  const el = container.querySelector(".graph-tooltip");
  if (el) el.hidden = true;
}
function escapeHtmlLocal(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// popover (click)
// ---------------------------------------------------------------------------

function closePopover(container) {
  container.querySelector(".graph-popover")?.remove();
}

function showPopover(container, node, pos, opts) {
  closePopover(container);
  const mode = opts.mode ?? "standalone";
  const el = document.createElement("div");
  el.className = "graph-popover";
  // A real bug found only by actually clicking Reject in a browser (not
  // visible from reading the code): the popover is a direct child of
  // `container`, the SAME element wireRubberBandSelection binds its
  // rubber-band-drag `mousedown` listener to (moved there from the
  // per-render `svg` element to fix a listener-leak issue) -- without
  // this stopPropagation, a mousedown on the popover's own Accept/Reject
  // button bubbles up to that listener, which calls closePopover() and
  // removes the button from the DOM before its `click` ever fires, so
  // Accept/Reject from the popover silently did nothing.
  el.addEventListener("mousedown", (evt) => evt.stopPropagation());
  // Position relative to the SVG's own coordinate box, scaled to the
  // container's actual rendered size (the SVG uses a fixed viewBox and
  // scales to fit its container).
  const svg = container.querySelector(".graph-svg");
  const svgRect = svg.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const scaleX = svgRect.width / LAYOUT_W;
  const scaleY = svgRect.height / LAYOUT_H;
  const left = (svgRect.left - containerRect.left) + pos.x * scaleX;
  const top = (svgRect.top - containerRect.top) + pos.y * scaleY;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;

  const title = document.createElement("div");
  title.className = "graph-popover-title";
  title.textContent = node.name;
  el.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "graph-popover-meta";
  meta.textContent = `${node.type} \u00b7 ${statusText(node)}`;
  el.appendChild(meta);

  if (node.rationale) {
    const rationale = document.createElement("div");
    rationale.className = "graph-popover-rationale";
    rationale.textContent = node.rationale;
    el.appendChild(rationale);
  }

  if (mode === "batch" && node.mutationId && node.status === "pending") {
    const actions = document.createElement("div");
    actions.className = "graph-popover-actions";
    const acceptBtn = document.createElement("button");
    acceptBtn.className = "btn btn--accept";
    acceptBtn.textContent = "Accept";
    acceptBtn.addEventListener("click", () => { opts.onAccept?.(node.mutationId); closePopover(container); });
    const rejectBtn = document.createElement("button");
    rejectBtn.className = "btn btn--reject";
    rejectBtn.textContent = "Reject";
    rejectBtn.addEventListener("click", () => { opts.onReject?.(node.mutationId); closePopover(container); });
    actions.append(acceptBtn, rejectBtn);
    el.appendChild(actions);
  }

  let showInListTarget = null;
  if (mode === "batch") {
    showInListTarget = node.id;
  } else if (mode === "standalone" && opts.findOpenBatchForNode) {
    const found = opts.findOpenBatchForNode(node.id);
    if (found) showInListTarget = node.id;
  }
  if (showInListTarget) {
    const link = document.createElement("button");
    link.className = "link-btn graph-popover-showinlist";
    link.textContent = "Show in list \u2192";
    link.addEventListener("click", () => { opts.onShowInList?.(showInListTarget); closePopover(container); });
    el.appendChild(link);
  }

  // Phase 11 task 11.5: "Develop this node" -- the entry point into the new
  // per-entity prep-content pipeline. Deliberately STANDALONE-MODE ONLY: a
  // batch-mode node (Batch Review's own List/Graph toggle) is a proposed-or-
  // not-yet-committed mutation, and the design doc is explicit that
  // "develop this node" is reached from an already-settled, already-
  // committed entity, NOT a Batch Review row/node action. This `mode ===
  // "standalone"` guard is the actual mechanism that keeps it off Batch
  // Review, not just a convention -- there is no code path in this file
  // that renders this button for mode==='batch'.
  if (mode === "standalone" && opts.onDevelopNode) {
    const developLink = document.createElement("button");
    developLink.className = "link-btn graph-popover-develop";
    developLink.textContent = "Develop this node \u2192";
    developLink.addEventListener("click", () => { opts.onDevelopNode(node.id); closePopover(container); });
    el.appendChild(developLink);
  }

  container.appendChild(el);

  // Close on outside click (deferred one tick so this same click doesn't immediately close it).
  setTimeout(() => {
    document.addEventListener("click", function onDocClick(evt) {
      if (!el.contains(evt.target)) {
        el.remove();
        document.removeEventListener("click", onDocClick);
      }
    });
  }, 0);
}

// ---------------------------------------------------------------------------
// multi-select: rubber-band drag over the SVG background
// ---------------------------------------------------------------------------

/**
 * Self-review remediation: a batch's graph re-renders on every accept/
 * reject/refresh (renderGraph() tears down and rebuilds the SVG each
 * time), so binding fresh `window`-level mousemove/mouseup listeners on
 * every call -- as an earlier version of this function did -- would leak
 * one more pair of listeners per render, forever, for the life of the
 * page. Fixed by binding those two `window` listeners EXACTLY ONCE per
 * container (guarded by `container._graphRubberBandWired`), reading the
 * CURRENT nodes/positions/svg from a small mutable record
 * (`container._graphRubberBand`) that every renderGraph() call refreshes.
 * `mousedown` is bound on `container` (stable across re-renders) rather
 * than the per-render `svg` element; a node's own `mousedown` handler
 * already calls stopPropagation(), so this container-level listener only
 * ever sees a genuine background drag, never a click that started on a
 * node.
 */
function wireRubberBandSelection(container, svg, nodes, positions, mode, opts) {
  if (mode !== "batch") return; // selection only makes sense where there's something to select FOR (the bulk accept/reject bar)
  container._graphRubberBand = { nodes, positions, svg, opts };
  if (container._graphRubberBandWired) return;
  container._graphRubberBandWired = true;

  let dragStart = null;
  let rectEl = null;

  function svgPoint(evt) {
    const currentSvg = container._graphRubberBand.svg;
    const rect = currentSvg.getBoundingClientRect();
    const x = ((evt.clientX - rect.left) / rect.width) * LAYOUT_W;
    const y = ((evt.clientY - rect.top) / rect.height) * LAYOUT_H;
    return { x, y };
  }

  container.addEventListener("mousedown", (evt) => {
    closePopover(container);
    dragStart = svgPoint(evt);
    rectEl = svgEl("rect", { class: "graph-selection-rect", x: dragStart.x, y: dragStart.y, width: 0, height: 0 });
    container._graphRubberBand.svg.appendChild(rectEl);
  });

  window.addEventListener("mousemove", (evt) => {
    if (!dragStart || !rectEl) return;
    const cur = svgPoint(evt);
    const x = Math.min(dragStart.x, cur.x), y = Math.min(dragStart.y, cur.y);
    const width = Math.abs(cur.x - dragStart.x), height = Math.abs(cur.y - dragStart.y);
    rectEl.setAttribute("x", x); rectEl.setAttribute("y", y);
    rectEl.setAttribute("width", width); rectEl.setAttribute("height", height);
  });

  window.addEventListener("mouseup", (evt) => {
    if (!dragStart || !rectEl) return;
    const cur = svgPoint(evt);
    const x0 = Math.min(dragStart.x, cur.x), x1 = Math.max(dragStart.x, cur.x);
    const y0 = Math.min(dragStart.y, cur.y), y1 = Math.max(dragStart.y, cur.y);
    const draggedEnough = (x1 - x0) > 4 || (y1 - y0) > 4;
    const { nodes: currentNodes, positions: currentPositions, svg: currentSvg, opts: currentOpts } = container._graphRubberBand;
    if (draggedEnough) {
      for (const n of currentNodes) {
        // Same selectability rule as shift-click: only a node with its own
        // pending mutation can actually be fed to the bulk accept/reject
        // bar -- a rubber-band sweeping over a purely-contextual neighbor
        // must not visually claim it as selected when nothing happens.
        if (!n.mutationId || n.status !== "pending") continue;
        const p = currentPositions.get(n.id);
        if (!p) continue;
        if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) {
          const g = currentSvg.querySelector(`.graph-node[data-node-id="${cssEscape(n.id)}"]`);
          g?.classList.add("graph-node--selected");
          currentOpts.onToggleSelect?.(n.id, true);
        }
      }
    }
    rectEl.remove();
    rectEl = null;
    dragStart = null;
  });
}

function cssEscape(s) {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&");
}
