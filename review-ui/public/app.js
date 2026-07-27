// GM Review — Phase 6 review UI frontend. Plain JS, no framework, no build step.
// Phase 7 adds review-ui/public/graph-view.js, a shared SVG graph-rendering
// module used both by the Review screen's List/Graph toggle and the
// standalone Graph nav view -- imported as an ES module (index.html's
// <script> tag was switched to type="module" for this).
"use strict";
import { renderGraph } from "./graph-view.js";

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
    }
    if (CURRENT_WORLD) select.value = CURRENT_WORLD;
  } catch (err) {
    select.innerHTML = `<option>(no worlds found)</option>`;
  }
  select.addEventListener("change", () => {
    CURRENT_WORLD = select.value;
    localStorage.setItem("gmReview.world", CURRENT_WORLD);
    renderCurrentView();
  });
}

// ---------------------------------------------------------------------------
// view routing — a single index.html, four <section>s, hash-based, no router lib
// ---------------------------------------------------------------------------

function parseHash() {
  const raw = (location.hash || "#queue").slice(1);
  const [view, arg] = raw.split("/");
  return { view: view || "queue", arg };
}

function navigate(view, arg) {
  location.hash = arg ? `${view}/${arg}` : view;
}

function renderCurrentView() {
  const { view, arg } = parseHash();
  for (const section of document.querySelectorAll(".view")) {
    section.classList.toggle("active", section.id === `view-${view}`);
  }
  for (const btn of document.querySelectorAll(".topnav button, .brand")) {
    btn.classList.toggle("active", btn.dataset.nav === view);
  }
  if (view === "queue") renderQueue();
  else if (view === "review") renderReview(arg);
  else if (view === "debt") renderDebt();
  else if (view === "settings") renderSettings();
  else if (view === "import") renderImportView();
  else if (view === "framing") renderFramingView();
  else if (view === "graph") renderGraphStandaloneView();
  else if (view === "entity") renderEntityDetail(arg);
}

window.addEventListener("hashchange", renderCurrentView);
document.addEventListener("click", (e) => {
  const nav = e.target.closest("[data-nav]");
  if (nav) navigate(nav.dataset.nav);
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

// ---------------------------------------------------------------------------
// QUEUE
// ---------------------------------------------------------------------------

async function renderQueue() {
  const emptyEl = document.getElementById("queue-empty");
  const batchesWrap = document.getElementById("queue-batches-wrap");
  const flaggedWrap = document.getElementById("queue-flagged-wrap");
  const batchesList = document.getElementById("queue-batches");
  const flaggedList = document.getElementById("queue-flagged");
  emptyEl.hidden = true; batchesWrap.hidden = true; flaggedWrap.hidden = true;
  batchesList.innerHTML = ""; flaggedList.innerHTML = "";
  if (!CURRENT_WORLD) { emptyEl.hidden = false; emptyEl.textContent = "No world configured yet."; return; }

  let batches = [];
  let flagged = [];
  try {
    ({ batches } = await api(`/api/batches${withWorld()}`));
  } catch { /* leave empty */ }
  try {
    ({ entities: flagged } = await api(`/api/unreviewed-entities${withWorld()}`));
  } catch { /* leave empty */ }

  // GM's stated sort: explicitly-requested work (open batches, newest first --
  // listBatches already returns newest-first) before auto-flagged accumulation.
  // status==='open' alone isn't enough: a batch only ever transitions to
  // 'synced'/'rolled-back', never anything on "every mutation rejected" --
  // real usage feedback ("I can't dispose of the previously queued mistake")
  // traced to a fully-rejected batch staying listed here forever with
  // nothing left to actually do. A batch belongs here only if it still has
  // a pending decision OR accepted-but-unsynced work; "everything rejected"
  // now quietly drops off on its own instead of needing a dismiss action.
  const openBatches = batches.filter((b) => b.status === "open" && (b.pendingCount > 0 || b.acceptedCount > 0));

  if (!openBatches.length && !flagged.length) {
    emptyEl.hidden = false;
    return;
  }

  if (openBatches.length) {
    batchesWrap.hidden = false;
    for (const b of openBatches) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.className = "queue-item";
      const headline = document.createElement("span");
      headline.className = "queue-item-headline";
      headline.textContent = `${b.mutationCount} mutation${b.mutationCount === 1 ? "" : "s"} — ${scopeLabel(b.scope)}${b.elapsedTimeDescriptor ? ` (${b.elapsedTimeDescriptor})` : ""}`;
      const meta = document.createElement("span");
      meta.className = "queue-item-meta";
      meta.textContent = new Date(b.createdAt).toLocaleString();
      btn.append(headline, meta);
      btn.addEventListener("click", () => navigate("review", b.id));
      li.appendChild(btn);
      batchesList.appendChild(li);
    }
  }

  if (flagged.length) {
    flaggedWrap.hidden = false;
    for (const f of flagged) {
      const li = document.createElement("li");
      const row = document.createElement("div");
      row.className = "queue-item";
      const headline = document.createElement("span");
      headline.className = "queue-item-headline";
      headline.innerHTML = `<span class="flag-dot"></span>${escapeHtml(f.entityId)} — ${flagReasonLabel(f)}`;
      row.appendChild(headline);

      // Real gap found via hands-on use: this list was previously read-only
      // -- an entity with no currently-open batch touching it had no way to
      // be acknowledged at all and just sat here indefinitely. A plain
      // dismiss, no batch/review context required.
      const dismissBtn = document.createElement("button");
      dismissBtn.className = "btn btn--ghost queue-flagged-dismiss";
      dismissBtn.textContent = "Mark Reviewed";
      dismissBtn.addEventListener("click", async () => {
        dismissBtn.disabled = true;
        try {
          await api(`/api/unreviewed-entities/${encodeURIComponent(f.entityId)}/mark-reviewed`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ world: CURRENT_WORLD })
          });
          li.remove();
          if (!flaggedList.children.length) flaggedWrap.hidden = true;
          if (!batchesList.children.length && !flaggedList.children.length) {
            emptyEl.hidden = false;
          }
        } catch (err) {
          dismissBtn.disabled = false;
          dismissBtn.title = `Failed: ${err.message}`;
        }
      });
      row.appendChild(dismissBtn);

      li.appendChild(row);
      flaggedList.appendChild(li);
    }
  }
}

function scopeLabel(scope) {
  if (!scope) return "manual";
  if (scope.mode === "seed") return `seed @ ${scope.anchorId ?? "?"}`;
  if (scope.mode === "resolve-pending") return `resolved backlog @ ${scope.requestedEntityId ?? "?"}`;
  return scope.mode || "batch";
}

function flagReasonLabel(f) {
  if (f.reason === "never-reviewed") return "never reviewed";
  if (f.reason === "stale") return `last reviewed ${new Date(f.lastHumanReviewedAt).toLocaleDateString()}`;
  if (f.reason === "accumulated") return `${f.unreviewedAcceptCount} unreviewed accepts`;
  return f.reason;
}

// ---------------------------------------------------------------------------
// REVIEW — the core of the phase
// ---------------------------------------------------------------------------

let reviewState = {
  batchId: null,
  detail: null,
  expanded: new Set(), // mutationIds the GM has actually opened this session
  focusIndex: -1,
  mode: "list", // Phase 7 task 7.3: 'list' | 'graph' -- List stays the confirmed default on every fresh batch load
  graphDepth: 1
};

// Phase 7 task 7.4: set by the standalone Graph view's "Show in list" action
// so renderReviewFromState can scroll to and expand the right row once the
// batch it navigates to has loaded -- cleared immediately after use.
let pendingScrollToEntityId = null;

async function renderReview(batchId) {
  reviewState = { batchId, detail: null, expanded: new Set(), focusIndex: -1, mode: "list", graphDepth: 1 };
  setReviewModeToggle("list");
  const listEl = document.getElementById("review-list");
  listEl.innerHTML = "<p class='hint'>Loading&hellip;</p>";
  try {
    reviewState.detail = await api(`/api/batches/${batchId}${withWorld()}`);
  } catch (err) {
    listEl.innerHTML = `<p class="hint">Could not load batch: ${escapeHtml(err.message)}</p>`;
    return;
  }
  renderReviewFromState();
}

/** mutationIds whose <details> is currently open, so an in-place refresh (accept/reject/regenerate/narrate) doesn't collapse rows the GM is actively looking at -- a real bug found via actually testing this in a browser, not visible from reading the code alone: without this, EVERY in-place update (including the one the GM just triggered) re-collapsed its own row, so narration/regenerate results never stayed visible. */
function currentlyOpenMutationIds() {
  return new Set(
    [...document.querySelectorAll(".mutation-row")]
      .filter((row) => row.querySelector("details")?.open)
      .map((row) => row.dataset.mutationId)
  );
}

/**
 * Re-fetch and re-render, preserving which rows were open.
 * @param {string} [openEntityIdHint] regenerate replaces a mutationId entirely
 *   (a new mutation object for the same target entity) -- pass the OLD
 *   entity's entityId here so the row that takes its place opens too, per
 *   the design doc's "regenerating swaps only that row's diff ... collapsing
 *   back to the same expanded state".
 */
async function refreshReviewDetail(openEntityIdHint) {
  const openMutationIds = currentlyOpenMutationIds();
  reviewState.detail = await api(`/api/batches/${reviewState.batchId}${withWorld()}`);
  renderReviewFromState(openMutationIds, openEntityIdHint);
}

// One-line plain-language explanation of what actually produced this batch --
// a real gap found via hands-on use: the review screen never said what kind
// of thing it was looking at (e.g. "this took a pasted writeup and proposed
// entities/edges to add to the graph"), leaving the GM to guess.
function batchExplainerText(scope) {
  const mode = scope?.mode;
  if (mode === "writeup-import") {
    return "This batch extracted entities and relationships from a pasted writeup and proposed adding them to the graph.";
  }
  if (mode === "seed" || mode === "ambient" || mode === "tag" || mode === "region" || mode === "contained-in") {
    return "This batch proposes consequences of time passing in the world, starting from the scope you requested.";
  }
  if (mode === "resolve-pending") {
    return "This batch resolves a backlog of deferred changes for an entity you asked about, synthesized across every cycle that touched it.";
  }
  return "";
}

function renderReviewFromState(openMutationIds, openEntityIdHint) {
  const { detail } = reviewState;
  document.getElementById("review-headline").textContent = detail.headline;
  const meta = [];
  if (detail.batch.elapsedTimeDescriptor) meta.push(detail.batch.elapsedTimeDescriptor);
  meta.push(`status: ${detail.batch.status}`);
  document.getElementById("review-meta").textContent = meta.join(" · ");
  document.getElementById("review-explainer").textContent = batchExplainerText(detail.batch.scope);

  const actionBar = document.getElementById("review-actionbar");
  actionBar.style.display = detail.batch.mutationCount === 0 ? "none" : "";

  renderSyncBar(detail);

  renderRubberDuckRejectPanel(detail); // Phase 8: only renders anything for a rubber-duck-mode writeup-import batch

  const listEl = document.getElementById("review-list");
  listEl.innerHTML = "";

  let rowIndex = 0;
  for (const region of detail.regions) {
    for (const entity of region.entities) {
      const row = buildMutationRow(entity, rowIndex, openMutationIds, openEntityIdHint);
      listEl.appendChild(row);
      rowIndex++;
    }
  }
  reviewState.focusIndex = -1;

  // Phase 7 task 7.4: a "Show in list" jump from the standalone Graph view
  // lands here once this batch has (re)loaded -- scroll to and expand the
  // matching row, same mechanism as an in-page row expansion.
  if (pendingScrollToEntityId) {
    const targetEntityId = pendingScrollToEntityId;
    pendingScrollToEntityId = null;
    const target = detail.regions
      .flatMap((r) => r.entities)
      .find((e) => e.entityId === targetEntityId);
    if (target) {
      const row = document.querySelector(`.mutation-row[data-mutation-id="${cssEscapeId(target.mutationId)}"]`);
      const details = row?.querySelector("details");
      if (details && !details.open) details.open = true; // triggers onRowExpanded via the 'toggle' listener
      row?.scrollIntoView({ block: "center" });
    }
  }

  // Phase 7 task 7.3: Graph mode renders from this SAME reviewState.detail
  // (never a second fetch/copy of batch state) -- re-render it in lockstep
  // with every List rebuild so switching back to Graph after an accept/
  // reject/regenerate always reflects the latest state.
  if (reviewState.mode === "graph") renderReviewGraph();
}

function cssEscapeId(s) {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : String(s);
}

function opLabel(op) {
  return { upsert_entity: "update", upsert_edge: "update edge", delete_entity: "delete", delete_edge: "delete edge" }[op] || op;
}

function buildMutationRow(entity, index, openMutationIds, openEntityIdHint) {
  const row = document.createElement("div");
  row.className = "mutation-row";
  row.dataset.mutationId = entity.mutationId;
  row.dataset.index = String(index);
  if (entity.flaggedUnreviewed) row.classList.add("flagged");
  if (entity.collapsed) row.classList.add("boring");

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "row-check";
  checkbox.disabled = entity.status !== "pending";
  row.appendChild(checkbox);

  const details = document.createElement("details");
  const summary = document.createElement("summary");
  const headline = document.createElement("span");
  headline.className = "row-headline";
  headline.innerHTML =
    (entity.flaggedUnreviewed ? `<span class="flag-dot"></span>` : "") +
    `<span class="op-label">${opLabel(entity.op)}</span>${escapeHtml(entity.name)} — ${escapeHtml(truncate(entity.rationale, 80))}`;
  const pill = document.createElement("span");
  pill.className = `status-pill status-pill--${entity.status}`;
  pill.textContent = entity.status;
  summary.append(headline, pill);
  details.appendChild(summary);

  const body = document.createElement("div");
  body.className = "row-body";
  details.appendChild(body);
  row.appendChild(details);

  // Decide open state BEFORE attaching the toggle listener, then render the
  // body directly if it should start open -- doesn't rely on a 'toggle'
  // event firing from a programmatic `.open = true` (inconsistent across
  // browser versions), so this is correct regardless.
  const shouldOpen = !!(openMutationIds?.has(entity.mutationId) || (openEntityIdHint && entity.entityId === openEntityIdHint));
  if (shouldOpen) details.open = true;

  details.addEventListener("toggle", () => {
    if (details.open) onRowExpanded(entity, body);
  });

  if (shouldOpen) onRowExpanded(entity, body);

  return row;
}

async function onRowExpanded(entity, body) {
  // Mark human-review (Phase 4 task 4.2's entity-grain "genuine view" trigger)
  // exactly once we know the GM actually looked -- idempotent, safe to fire
  // again on re-expand.
  if (entity.entityId) {
    reviewState.expanded.add(entity.mutationId);
    try {
      await api(`/api/batches/${reviewState.batchId}/view`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: CURRENT_WORLD, grain: "entity", entityId: entity.entityId })
      });
      // The server-side flag is now cleared (markHumanReviewed already ran),
      // but the row was rendered with the flag BEFORE this call resolved --
      // a real bug found via hands-on use: the amber border/dot otherwise
      // silently persisted on screen until the whole view was reloaded, even
      // though the underlying state was already correct. Update the DOM to
      // match reality immediately instead of waiting for a reload.
      if (entity.flaggedUnreviewed) {
        entity.flaggedUnreviewed = false;
        const row = body.closest(".mutation-row");
        row?.classList.remove("flagged");
        row?.querySelector(".flag-dot")?.remove();
      }
    } catch { /* best-effort; not fatal if it fails */ }
  }
  renderRowBody(entity, body);
}

function renderRowBody(entity, body) {
  body.innerHTML = "";

  if (entity.flaggedUnreviewed) {
    const note = document.createElement("div");
    note.className = "accum-note";
    note.textContent = "Never reviewed — accumulated changes without a genuine look.";
    body.appendChild(note);
  }

  const rationale = document.createElement("div");
  rationale.className = "rationale-card";
  rationale.innerHTML = `<div class="rationale-label">Why:</div><div class="rationale-text">${escapeHtml(entity.rationale)}</div>`;
  body.appendChild(rationale);

  body.appendChild(buildDiffTable(entity));

  const actionArea = document.createElement("div");
  actionArea.className = "row-action-area";
  body.appendChild(actionArea);

  renderRowActionArea(entity, actionArea);
}

/** Two-column field:before->after diff table, reused verbatim by the Deferred Debt resolve view (task 6.4). */
function buildDiffTable(entity) {
  if (Array.isArray(entity.diff) && entity.diff.length) {
    const table = document.createElement("table");
    table.className = "diff-table";
    for (const change of entity.diff) {
      const tr = document.createElement("tr");
      const tdField = document.createElement("td");
      tdField.className = "field-name";
      const tdValue = document.createElement("td");
      tdValue.className = "field-value";
      if (change.field === "(created)") {
        tdField.textContent = "";
        tdValue.innerHTML = `<span class="created-badge">created</span>`;
      } else {
        tdField.textContent = change.field;
        tdValue.innerHTML =
          `${formatDiffValue(change.from)}<span class="arrow">&rarr;</span><span class="changed">${formatDiffValue(change.to)}</span>`;
      }
      tr.append(tdField, tdValue);
      table.appendChild(tr);
    }
    return table;
  }
  if (entity.data && Object.keys(entity.data).length) {
    const table = document.createElement("table");
    table.className = "diff-table";
    for (const [field, value] of Object.entries(entity.data)) {
      const tr = document.createElement("tr");
      const tdField = document.createElement("td");
      tdField.className = "field-name";
      tdField.textContent = field;
      const tdValue = document.createElement("td");
      tdValue.className = "field-value";
      tdValue.innerHTML = `<span class="changed">${formatDiffValue(value)}</span>`;
      tr.append(tdField, tdValue);
      table.appendChild(tr);
    }
    return table;
  }
  const note = document.createElement("div");
  note.className = "no-diff-note";
  note.textContent = "(no field-level detail recorded)";
  return note;
}

function formatDiffValue(v) {
  if (v === undefined) return "<em>(none)</em>";
  return escapeHtml(typeof v === "string" ? v : JSON.stringify(v));
}

function renderRowActionArea(entity, actionArea) {
  actionArea.innerHTML = "";

  if (entity.status === "pending") {
    const regenBox = document.createElement("div");
    regenBox.className = "regenerate-box";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Steering note for regenerate…";
    const regenBtn = document.createElement("button");
    regenBtn.className = "btn";
    regenBtn.textContent = "Regenerate";
    regenBtn.addEventListener("click", () => regenerateRow(entity, input.value));
    regenBox.append(input, regenBtn);
    actionArea.appendChild(regenBox);

    const actions = document.createElement("div");
    actions.className = "row-actions";
    const acceptBtn = document.createElement("button");
    acceptBtn.className = "btn btn--accept";
    acceptBtn.textContent = "Accept";
    acceptBtn.addEventListener("click", () => acceptSingle(entity.mutationId));
    const rejectBtn = document.createElement("button");
    rejectBtn.className = "btn btn--reject";
    rejectBtn.textContent = "Reject";
    rejectBtn.addEventListener("click", () => rejectSingle(entity.mutationId));
    actions.append(acceptBtn, rejectBtn);
    actionArea.appendChild(actions);
    return;
  }

  if (entity.status === "rejected") {
    const note = document.createElement("div");
    note.className = "row-status-note";
    note.textContent = "Rejected.";
    actionArea.appendChild(note);
    return;
  }

  // status === 'accepted'
  if (!entity.entityId) {
    // A create not yet synced has no resolved target id -- entity-narration.mjs
    // has nothing to key its store by (see mutation-engine/narrate.mjs's
    // narrateEntity, which fails fast on exactly this case rather than
    // wasting an API call on an unpersistable result).
    const note = document.createElement("div");
    note.className = "row-status-note";
    note.textContent = "Accepted — sync this batch before narrating (a newly-created entity needs a resolved id first).";
    actionArea.appendChild(note);
    return;
  }

  renderEntityNarrationArea(entity, actionArea);
}

/**
 * PHASE 10 (plans/phase-10-review.md / phase-10-tasks.md task 10.5):
 * replaces the old whole-BATCH narration (a single client-side
 * reviewState.narrationCache, the actual root cause of "narration is the
 * same across every row," "regenerate recycles one generic statement," and
 * "leaving and coming back loses it" -- narrate.mjs only ever narrated an
 * entire batch in one call, and the result never touched disk). Per-entity
 * narration is now the default: each accepted row fetches (and persists,
 * server-side, via mutation-engine/entity-narration.mjs) ITS OWN narration,
 * gated at ENTITY grain (this row's own mutation must be accepted -- no
 * dependency on `reviewState.detail.narratable`/the rest of the batch at
 * all anymore, the actual grain fix).
 *
 * Fetches this entity's current narration fresh every time a row is
 * (re)rendered -- deliberately not client-cached, so a fresh page load (or
 * simply reopening this row later) always reflects the real, durable,
 * server-side state instead of a stale in-memory guess. A GM leaving and
 * returning to this exact batch will see whatever was last generated,
 * because the fetch below reads it back from disk every time.
 */
async function renderEntityNarrationArea(entity, actionArea) {
  const loading = document.createElement("div");
  loading.className = "hint";
  loading.textContent = "Loading narration…";
  actionArea.appendChild(loading);

  let current = null;
  try {
    const result = await api(`/api/entities/${encodeURIComponent(entity.entityId)}/narration${withWorld()}`);
    current = result.narration;
  } catch {
    // A fetch failure here shouldn't block offering the Narrate button --
    // fall through and treat it the same as "never narrated yet".
  }
  if (!actionArea.isConnected) return; // the row was re-rendered while this fetch was in flight -- don't stomp a newer render

  actionArea.innerHTML = "";
  if (current) {
    appendEntityNarrationCard(entity, actionArea, current);
  } else {
    appendNarrateEntityButton(entity, actionArea);
  }
}

function appendNarrateEntityButton(entity, actionArea) {
  const btn = document.createElement("button");
  btn.className = "btn btn--accept";
  btn.textContent = "Narrate This";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Narrating…";
    try {
      const result = await api(`/api/batches/${reviewState.batchId}/narrate-entity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: CURRENT_WORLD, mutationId: entity.mutationId })
      });
      appendEntityNarrationCard(entity, actionArea, { prose: result.prose });
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Narrate This";
      showToast(`Narration failed: ${err.message}`);
    }
  });
  actionArea.appendChild(btn);
}

/** Same visual card Phase 6 established (serif/parchment, distinct from the sans-serif rationale card above it) -- just fed by this ONE entity's own narration now, not a whole-batch cache. */
function appendEntityNarrationCard(entity, actionArea, narration) {
  actionArea.innerHTML = "";
  const card = document.createElement("div");
  card.className = "narration-card";
  for (const para of narration.prose.split(/\n+/).filter(Boolean)) {
    const p = document.createElement("p");
    p.style.margin = "0 0 0.75rem";
    p.textContent = para;
    card.appendChild(p);
  }
  actionArea.appendChild(card);

  const regen = document.createElement("div");
  regen.className = "narration-regenerate";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Regenerate narration with a note…";
  const btn = document.createElement("button");
  btn.className = "btn";
  btn.textContent = "Regenerate";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      // Regenerate creates a NEW history entry server-side (entity-narration.mjs's
      // saveEntityNarration marks the prior one 'superseded', never overwrites
      // it in place) -- the prior text stays recallable via "View history" below.
      const result = await api(`/api/batches/${reviewState.batchId}/narrate-entity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: CURRENT_WORLD, mutationId: entity.mutationId, note: input.value })
      });
      appendEntityNarrationCard(entity, actionArea, { prose: result.prose });
    } catch (err) {
      showToast(`Narration failed: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });
  regen.append(input, btn);
  actionArea.appendChild(regen);

  appendNarrationHistoryToggle(entity, actionArea);
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

async function acceptSingle(mutationId) {
  await api(`/api/batches/${reviewState.batchId}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: CURRENT_WORLD, scope: "entity", id: mutationId })
  });
  showToast("Accepted.", () => rollbackCurrentBatch());
  await refreshReviewDetail();
}

async function rejectSingle(mutationId) {
  await api(`/api/batches/${reviewState.batchId}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: CURRENT_WORLD, scope: "entity", id: mutationId })
  });
  showToast("Rejected.");
  await refreshReviewDetail();
}

async function regenerateRow(entity, note) {
  try {
    await api(`/api/batches/${reviewState.batchId}/regenerate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: CURRENT_WORLD, scope: "entity", id: entity.mutationId, note })
    });
    // The regenerated mutation gets a brand-new mutationId (the old one is
    // removed) -- pass the target entity's own entityId through so the row
    // that replaces this one reopens automatically, matching the design
    // doc's "regenerating swaps only that row's diff ... collapsing back to
    // the same expanded state" (not literally the same DOM row, but the
    // same visible position/content, expanded).
    await refreshReviewDetail(entity.entityId);
  } catch (err) {
    showToast(`Regenerate failed: ${err.message}`);
  }
}

// A real gap found via hands-on use: accepting every mutation in a batch
// only changes their review-state status -- it does NOT write anything to
// the actual World Fabric graph. That requires a separate explicit "sync"
// step, and this frontend never called that route at all (the server route
// existed since Phase 6, but nothing here triggered it), so an accepted
// batch was, from the GM's perspective, a dead end: no further edits
// possible, nothing visibly happening, and no way to actually commit the
// changes without going around the UI entirely via chat.
function renderSyncBar(detail) {
  const bar = document.getElementById("review-sync-bar");
  const statusEl = document.getElementById("review-sync-status");
  const acceptedCount = detail.regions
    .flatMap((r) => r.entities)
    .filter((e) => e.status === "accepted").length;

  if (detail.batch.status !== "open") {
    bar.hidden = true;
    return;
  }
  if (acceptedCount === 0) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  statusEl.textContent = `${acceptedCount} accepted mutation${acceptedCount === 1 ? "" : "s"} not yet written to the graph.`;
}

document.getElementById("btn-sync-now").addEventListener("click", async () => {
  const btn = document.getElementById("btn-sync-now");
  const statusEl = document.getElementById("review-sync-status");
  btn.disabled = true;
  btn.textContent = "Syncing…";
  // The dual-path apply checks for a live Foundry client before falling back
  // to headless -- confirmed (via a real timed test) that this genuinely
  // takes ~7 seconds, not an instant round trip. Set that expectation
  // explicitly partway through so a several-second silent wait doesn't read
  // as the button being stuck.
  const slowNotice = setTimeout(() => {
    statusEl.textContent = "Still working — checking whether a live Foundry client is open for this world…";
  }, 1500);
  try {
    const result = await api(`/api/batches/${reviewState.batchId}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: CURRENT_WORLD })
    });
    recordSyncPath(result.path);
    showToast(`Synced ${result.syncedCount ?? 0} mutation${result.syncedCount === 1 ? "" : "s"} to the graph (${result.path}).`);
    await refreshReviewDetail();
  } catch (err) {
    statusEl.textContent = `Sync failed: ${err.message}`;
  } finally {
    clearTimeout(slowNotice);
    btn.disabled = false;
    btn.textContent = "Sync to Foundry";
  }
});

async function rollbackCurrentBatch() {
  try {
    const result = await api(`/api/batches/${reviewState.batchId}/rollback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: CURRENT_WORLD })
    });
    recordSyncPath(result.path);
    await refreshReviewDetail();
  } catch (err) {
    showToast(`Undo failed: ${err.message}`);
  }
}

function checkedMutationIds() {
  return [...document.querySelectorAll(".row-check:checked")].map((c) => c.closest(".mutation-row").dataset.mutationId);
}

document.getElementById("btn-select-all").addEventListener("click", () => {
  for (const row of document.querySelectorAll(".mutation-row")) {
    const cb = row.querySelector(".row-check");
    if (!cb.disabled) cb.checked = true;
  }
});

document.getElementById("btn-select-none").addEventListener("click", () => {
  for (const cb of document.querySelectorAll(".row-check")) cb.checked = false;
});

document.getElementById("btn-select-boring").addEventListener("click", () => {
  for (const row of document.querySelectorAll(".mutation-row.boring")) {
    const cb = row.querySelector(".row-check");
    if (!cb.disabled) cb.checked = true;
  }
});

document.getElementById("btn-accept-selected").addEventListener("click", async () => {
  const mutationIds = checkedMutationIds();
  if (!mutationIds.length) return;
  const reviewedMutationIds = mutationIds.filter((id) => reviewState.expanded.has(id));
  await api(`/api/batches/${reviewState.batchId}/bulk-accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: CURRENT_WORLD, mutationIds, reviewedMutationIds })
  });
  showToast(`Accepted ${mutationIds.length} mutation${mutationIds.length === 1 ? "" : "s"}.`, () => rollbackCurrentBatch());
  await refreshReviewDetail();
});

document.getElementById("btn-reject-selected").addEventListener("click", async () => {
  const mutationIds = checkedMutationIds();
  if (!mutationIds.length) return;
  const reviewedMutationIds = mutationIds.filter((id) => reviewState.expanded.has(id));
  await api(`/api/batches/${reviewState.batchId}/bulk-reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: CURRENT_WORLD, mutationIds, reviewedMutationIds })
  });
  showToast(`Rejected ${mutationIds.length} mutation${mutationIds.length === 1 ? "" : "s"}.`);
  await refreshReviewDetail();
});

// --- keyboard shortcuts (task 6.6): j/k move focus row, space toggles checkbox, enter expands ---
document.addEventListener("keydown", (e) => {
  if (!document.getElementById("view-review").classList.contains("active")) return;
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea") return;

  const rows = [...document.querySelectorAll(".mutation-row")];
  if (!rows.length) return;

  if (e.key === "j" || e.key === "k") {
    e.preventDefault();
    const delta = e.key === "j" ? 1 : -1;
    reviewState.focusIndex = Math.min(rows.length - 1, Math.max(0, reviewState.focusIndex + delta));
    for (const r of rows) r.classList.remove("focused");
    const row = rows[reviewState.focusIndex];
    row.classList.add("focused");
    row.scrollIntoView({ block: "nearest" });
  } else if (e.key === " ") {
    if (reviewState.focusIndex < 0) return;
    e.preventDefault();
    const cb = rows[reviewState.focusIndex].querySelector(".row-check");
    if (!cb.disabled) cb.checked = !cb.checked;
  } else if (e.key === "Enter") {
    if (reviewState.focusIndex < 0) return;
    e.preventDefault();
    const details = rows[reviewState.focusIndex].querySelector("details");
    details.open = !details.open;
  }
});

// ---------------------------------------------------------------------------
// Phase 7 task 7.3 — Review screen's List/Graph toggle.
//
// The single most important correctness point in this phase: Graph mode is
// a second RENDERING of reviewState.detail, never a second source of truth.
// It shares the exact same checkbox elements List mode builds (in
// #review-list, which stays in the DOM -- just hidden -- while Graph mode
// is showing) and the exact same acceptSingle/rejectSingle functions List's
// own per-row buttons call. Multi-select in the graph works by flipping
// those SAME checkboxes, so the existing #btn-accept-selected/
// #btn-reject-selected bar (which reads checkedMutationIds() from the
// whole document, not scoped to whichever view is visible) needs no
// changes at all to also work from Graph mode.
// ---------------------------------------------------------------------------

function setReviewModeToggle(mode) {
  for (const btn of document.querySelectorAll("#review-mode-toggle button")) {
    btn.classList.toggle("active", btn.dataset.reviewMode === mode);
  }
  document.getElementById("review-list-wrap").hidden = mode !== "list";
  document.getElementById("review-graph-wrap").hidden = mode !== "graph";
}

document.getElementById("review-mode-toggle").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-review-mode]");
  if (!btn) return;
  reviewState.mode = btn.dataset.reviewMode;
  setReviewModeToggle(reviewState.mode);
  if (reviewState.mode === "graph") renderReviewGraph();
});

document.getElementById("btn-graph-expand-context").addEventListener("click", () => {
  reviewState.graphDepth += 1;
  renderReviewGraph();
});

/**
 * Fetch this batch's graph payload (task 7.1's batch-scoped route) and
 * cross-reference it with reviewState.detail's own per-entity status/
 * rationale/mutationId -- keyed the SAME way the server keys a
 * not-yet-persisted create (`new:<mutationId>`), so a graph node maps to
 * EXACTLY the mutationId the list's checkbox/Accept/Reject buttons use.
 */
async function renderReviewGraph() {
  const container = document.getElementById("review-graph");
  const countEl = document.getElementById("review-graph-count");
  let graph;
  try {
    graph = await api(`/api/graph${withWorld({ batchId: reviewState.batchId, depth: reviewState.graphDepth })}`);
  } catch (err) {
    container.innerHTML = `<p class="hint">Could not load graph: ${escapeHtml(err.message)}</p>`;
    return;
  }

  const byNodeKey = new Map();
  for (const region of reviewState.detail.regions) {
    for (const entity of region.entities) {
      const key = entity.entityId ?? `new:${entity.mutationId}`;
      byNodeKey.set(key, entity);
    }
  }

  const nodes = graph.nodes.map((n) => {
    const entity = byNodeKey.get(n.id);
    return { ...n, status: entity?.status, mutationId: entity?.mutationId, rationale: entity?.rationale };
  });

  countEl.textContent = `${nodes.length} node${nodes.length === 1 ? "" : "s"} (context depth ${reviewState.graphDepth})`;

  renderGraph(container, { nodes, edges: graph.edges }, {
    mode: "batch",
    cacheKey: `batch:${reviewState.batchId}`,
    isSelected: (nodeId) => {
      const entity = byNodeKey.get(nodeId);
      if (!entity) return false;
      return !!document.querySelector(`.mutation-row[data-mutation-id="${cssEscapeId(entity.mutationId)}"] .row-check`)?.checked;
    },
    onToggleSelect: (nodeId, selected) => {
      const entity = byNodeKey.get(nodeId);
      if (!entity) return;
      const cb = document.querySelector(`.mutation-row[data-mutation-id="${cssEscapeId(entity.mutationId)}"] .row-check`);
      if (cb && !cb.disabled) cb.checked = selected;
    },
    onAccept: (mutationId) => acceptSingle(mutationId),
    onReject: (mutationId) => rejectSingle(mutationId),
    onShowInList: (nodeId) => {
      const entity = byNodeKey.get(nodeId);
      reviewState.mode = "list";
      setReviewModeToggle("list");
      if (!entity) return;
      const row = document.querySelector(`.mutation-row[data-mutation-id="${cssEscapeId(entity.mutationId)}"]`);
      const details = row?.querySelector("details");
      if (details && !details.open) details.open = true;
      row?.scrollIntoView({ block: "center" });
    }
  });
}

// ---------------------------------------------------------------------------
// DEFERRED DEBT
// ---------------------------------------------------------------------------

let debtEntities = [];

async function renderDebt() {
  const list = document.getElementById("debt-list");
  const emptyEl = document.getElementById("debt-empty");
  const search = document.getElementById("debt-search");
  list.innerHTML = "";
  emptyEl.hidden = true;
  if (!CURRENT_WORLD) return;
  try {
    ({ entities: debtEntities } = await api(`/api/pending-entities${withWorld()}`));
  } catch {
    debtEntities = [];
  }
  if (!debtEntities.length) { emptyEl.hidden = false; return; }
  renderDebtList(debtEntities);
  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    const filtered = q ? debtEntities.filter((e) => e.name.toLowerCase().includes(q) || e.entityId.toLowerCase().includes(q)) : debtEntities;
    renderDebtList(filtered);
  };
}

function renderDebtList(entities) {
  const list = document.getElementById("debt-list");
  list.innerHTML = "";
  for (const entity of entities) {
    const li = document.createElement("li");
    const row = document.createElement("details");
    row.className = "debt-row";
    const summary = document.createElement("summary");
    const name = document.createElement("span");
    name.className = "debt-name";
    name.textContent = `${entity.name} (${entity.entries.length} pending)`;
    summary.appendChild(name);
    row.appendChild(summary);

    const body = document.createElement("div");
    body.className = "debt-body";
    row.appendChild(body);
    renderDebtBody(entity, body);

    li.appendChild(row);
    list.appendChild(li);
  }
}

function renderDebtBody(entity, body) {
  body.innerHTML = "";
  const tags = document.createElement("ul");
  tags.className = "debt-tags";
  for (const entry of entity.entries) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="cycle-label">${escapeHtml(entry.cycleDescriptor)}:</span>${escapeHtml(entry.causeTag)}`;
    tags.appendChild(li);
  }
  body.appendChild(tags);

  const resolveBtn = document.createElement("button");
  resolveBtn.className = "btn btn--accept";
  resolveBtn.textContent = "Resolve Now";
  resolveBtn.addEventListener("click", async () => {
    resolveBtn.disabled = true;
    resolveBtn.textContent = "Resolving…";
    try {
      const result = await api(`/api/pending-entities/${encodeURIComponent(entity.entityId)}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: CURRENT_WORLD })
      });
      const detail = await api(`/api/batches/${result.batchId}${withWorld()}`);
      renderDebtResolvedDiff(body, detail);
    } catch (err) {
      resolveBtn.disabled = false;
      resolveBtn.textContent = "Resolve Now";
      showToast(`Resolve failed: ${err.message}`);
    }
  });
  body.appendChild(resolveBtn);
}

/** Swaps the tag list for a normal diff view, in place -- reuses buildDiffTable/renderRowActionArea's diff renderer, not a second one (task 6.4). */
function renderDebtResolvedDiff(body, detail) {
  body.innerHTML = "";
  const note = document.createElement("p");
  note.className = "hint";
  note.textContent = detail.headline;
  body.appendChild(note);
  for (const region of detail.regions) {
    for (const entity of region.entities) {
      const rationale = document.createElement("div");
      rationale.className = "rationale-card";
      rationale.innerHTML = `<div class="rationale-label">Why:</div><div class="rationale-text">${escapeHtml(entity.rationale)}</div>`;
      body.appendChild(rationale);
      body.appendChild(buildDiffTable(entity));
    }
  }
  const link = document.createElement("button");
  link.className = "link-btn";
  link.textContent = "Open in Batch Review →";
  link.addEventListener("click", () => navigate("review", detail.batch.id));
  body.appendChild(link);
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
    cacheKey: "standalone",
    findOpenBatchForNode: (nodeId) => (entityToBatch.has(nodeId) ? { batchId: entityToBatch.get(nodeId) } : null),
    onShowInList: (nodeId) => {
      const batchId = entityToBatch.get(nodeId);
      if (!batchId) return;
      pendingScrollToEntityId = nodeId;
      navigate("review", batchId);
    },
    // Phase 11 task 11.5: the entry point into "develop this node" -- only
    // ever wired here, on the STANDALONE graph's popover. Batch Review's own
    // List/Graph toggle (renderReviewGraph, mode:'batch') never passes this
    // callback at all, so the button structurally cannot appear there.
    onDevelopNode: (nodeId) => navigate("entity", nodeId)
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
    navigate("review", result.batchId);
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
    navigate("review", result.batchId);
  } catch (err) {
    statusEl.textContent = `Failed: ${err.message}`;
    btn.disabled = false;
  }
});

// --- reject-loop quick-pick panel (Review screen) ----------------------------

const QUICK_PICK_LABELS = {
  "wrong-emphasis": "Wrong emphasis",
  "wrong-scope": "Wrong scope",
  "missing-something": "Missing something",
  "not-feeling-it-yet": "Not feeling it yet"
};

/**
 * Renders (or hides) the rubber-duck reject panel on the Review screen.
 * Only ever shows anything for a batch whose OWN stamped
 * batch.scope.rubberDuck.enabled is true -- a normal-mode batch (or a
 * rubber-duck-mode batch reviewed after the setting was later flipped off)
 * shows nothing here at all, matching the read-once-snapshot invariant: the
 * frontend defers entirely to what the BATCH says, never the live setting.
 */
function renderRubberDuckRejectPanel(detail) {
  const panel = document.getElementById("rubber-duck-reject-panel");
  panel.innerHTML = "";
  const rubberDuck = detail.batch.scope?.rubberDuck;
  if (!rubberDuck?.enabled || detail.batch.mutationCount === 0) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const startBtn = document.createElement("button");
  startBtn.className = "btn btn--reject";
  startBtn.textContent = "Reject This Extraction";
  startBtn.addEventListener("click", () => renderRubberDuckRejectExpanded(detail, panel));
  panel.appendChild(startBtn);
}

function renderRubberDuckRejectExpanded(detail, panel, opts = {}) {
  panel.innerHTML = "";
  const { noteOnly, message } = opts;

  if (message) {
    const msg = document.createElement("div");
    msg.className = "hint rubber-duck-message";
    msg.textContent = message;
    panel.appendChild(msg);
  }

  if (!noteOnly) {
    const quickPicks = document.createElement("div");
    quickPicks.className = "quick-pick-row";
    for (const [code, label] of Object.entries(QUICK_PICK_LABELS)) {
      const btn = document.createElement("button");
      btn.className = "btn";
      btn.textContent = label;
      btn.addEventListener("click", () => submitRubberDuckReject(detail, { quickPickReason: code }, panel));
      quickPicks.appendChild(btn);
    }
    panel.appendChild(quickPicks);
  }

  const noteRow = document.createElement("div");
  noteRow.className = "regenerate-box";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = noteOnly ? "An explicit reason (required now)…" : "Or reject with an explicit reason…";
  const noteBtn = document.createElement("button");
  noteBtn.className = "btn btn--reject";
  noteBtn.textContent = "Reject with Note";
  noteBtn.addEventListener("click", () => {
    if (!input.value.trim()) return;
    submitRubberDuckReject(detail, { note: input.value.trim() }, panel);
  });
  noteRow.append(input, noteBtn);
  panel.appendChild(noteRow);

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "link-btn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => renderRubberDuckRejectPanel(detail));
  panel.appendChild(cancelBtn);
}

async function submitRubberDuckReject(detail, { note, quickPickReason }, panel) {
  try {
    const result = await api(`/api/batches/${detail.batch.id}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: CURRENT_WORLD, scope: "batch", note, quickPickReason })
    });
    if (result.rubberDuckLoop?.kind === "reframe") {
      importFlowState = { kind: "reframe", batchId: detail.batch.id, framings: result.rubberDuckLoop.framings };
      navigate("framing");
      return;
    }
    showToast(result.rubberDuckLoop?.kind === "regenerate" ? "Rejected — re-extracted with your note." : "Rejected.");
    await refreshReviewDetail();
  } catch (err) {
    if (err.status === 409 && err.body?.name === "FramingRoundLimitError") {
      renderRubberDuckRejectExpanded(detail, panel, {
        noteOnly: true,
        message: "The one bounded re-framing round is already used — provide an explicit note instead."
      });
      return;
    }
    renderRubberDuckRejectExpanded(detail, panel, { message: `Failed: ${err.message}` });
  }
}

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

  await renderPrepContentSection(entity, bodyEl);
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
  renderCurrentView();
})();
