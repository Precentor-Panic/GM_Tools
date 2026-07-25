// GM Review — Phase 6 review UI frontend. Plain JS, no framework, no build step.
"use strict";

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
  const openBatches = batches.filter((b) => b.status === "open");

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
  narrationCache: null, // {prose} once fetched for this batch
  focusIndex: -1
};

async function renderReview(batchId) {
  reviewState = { batchId, detail: null, expanded: new Set(), narrationCache: null, focusIndex: -1 };
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

function renderReviewFromState(openMutationIds, openEntityIdHint) {
  const { detail } = reviewState;
  document.getElementById("review-headline").textContent = detail.headline;
  const meta = [];
  if (detail.batch.elapsedTimeDescriptor) meta.push(detail.batch.elapsedTimeDescriptor);
  meta.push(`status: ${detail.batch.status}`);
  document.getElementById("review-meta").textContent = meta.join(" · ");

  const actionBar = document.getElementById("review-actionbar");
  actionBar.style.display = detail.batch.mutationCount === 0 ? "none" : "";

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
    api(`/api/batches/${reviewState.batchId}/view`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: CURRENT_WORLD, grain: "entity", entityId: entity.entityId })
    }).catch(() => { /* best-effort; not fatal if it fails */ });
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
    input.placeholder = "Steering note for regenerate&hellip;";
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
  if (!reviewState.detail.narratable) {
    const note = document.createElement("div");
    note.className = "row-status-note";
    note.textContent = "Accepted — waiting on the rest of this batch before narration is available.";
    actionArea.appendChild(note);
    return;
  }

  renderNarrationArea(actionArea);
}

/**
 * Narration is generated once per BATCH (mutation-engine/narrate.mjs
 * narrates the whole scene's consequences, not one mutation in isolation --
 * see server.mjs's narrateOp), but the design doc (phase-6-review.md)
 * describes it appearing PER ROW, replacing that row's own action area,
 * directly below that row's own rationale, the moment the row's mutation is
 * accepted and the batch has become fully narratable. Reconciled here (a
 * genuinely ambiguous point, noted in the closing report): the same
 * batch-level prose, once fetched, is cached client-side
 * (reviewState.narrationCache) and rendered into every accepted row's own
 * action area -- satisfying the letter of "narration replaces that row's
 * action bar" and "these two texts [rationale, narration] sit near each
 * other on screen in the one moment right after accept" for every row that
 * belongs to this batch, without re-fetching per row.
 */
function renderNarrationArea(actionArea) {
  if (reviewState.narrationCache) {
    appendNarrationCard(actionArea, reviewState.narrationCache.prose);
    return;
  }
  const btn = document.createElement("button");
  btn.className = "btn btn--accept";
  btn.textContent = "Narrate This Scene";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Narrating&hellip;";
    try {
      const result = await api(`/api/batches/${reviewState.batchId}/narrate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: CURRENT_WORLD })
      });
      reviewState.narrationCache = result;
      renderReviewFromState(currentlyOpenMutationIds());
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Narrate This Scene";
      showToast(`Narration failed: ${err.message}`);
    }
  });
  actionArea.appendChild(btn);
}

function appendNarrationCard(actionArea, prose) {
  const card = document.createElement("div");
  card.className = "narration-card";
  for (const para of prose.split(/\n+/).filter(Boolean)) {
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
  input.placeholder = "Regenerate narration with a note&hellip;";
  const btn = document.createElement("button");
  btn.className = "btn";
  btn.textContent = "Regenerate";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const result = await api(`/api/batches/${reviewState.batchId}/narrate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: CURRENT_WORLD, note: input.value })
      });
      reviewState.narrationCache = result;
      renderReviewFromState(currentlyOpenMutationIds());
    } catch (err) {
      showToast(`Narration failed: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });
  regen.append(input, btn);
  actionArea.appendChild(regen);
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
    resolveBtn.textContent = "Resolving&hellip;";
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
  link.textContent = "Open in Batch Review &rarr;";
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
// boot
// ---------------------------------------------------------------------------

(async function boot() {
  await initWorldSelect();
  renderCurrentView();
})();
