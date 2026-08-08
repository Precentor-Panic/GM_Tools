// GM Review — Phase 34 task 34.2: the Connection Menu component.
//
// A single chip in the shell topbar's right slot (#shell-conn-slot) that
// carries the Foundry connection STATE (live / stale / off + a distinct
// sync-error badge), and a 560px right-anchored panel that carries the WHY:
// the Foundry block (world-switch + counts + Sync now, or the "No Foundry
// yet" card with Create-World when disconnected), lore intake (paste / World
// Anvil, with a rollup + "Review batch" handoff), the "Read so far" history
// (GET /api/batches), and the "Campaign & keys" disclosure (GET/POST
// /api/settings). "Chip carries state, panel carries why."
//
// Standalone in the exact same way plans-view.js / app-shell.js are (own
// currentWorld()/api helpers over the shared localStorage["gmReview.world"]
// key) so there is no import cycle with app-shell.js (which imports THIS to
// mount the chip). World switching reuses the shell's own world-select
// change wiring rather than duplicating the re-render path: we set the
// select's value and dispatch its native 'change' event, which app-shell.js
// already listens to.
//
// Design source: design/session-planner/Connection Menu.dc.html (chip states,
// 560px panel sections). Route contract: plans/phase-34-tasks.md §"Pre-
// specified route/store contract" (all routes live as of 34.1).
"use strict";

// ---------------------------------------------------------------------------
// local helpers (same standalone convention as the sibling view modules)
// ---------------------------------------------------------------------------
function currentWorld() {
  return localStorage.getItem("gmReview.world") || null;
}

async function cmApi(path, opts) {
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

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  if (text != null) node.textContent = text;
  return node;
}

// ---------------------------------------------------------------------------
// module state
// ---------------------------------------------------------------------------
let chipBuilt = false;
let panelOpen = false;
let lastConn = null; // last GET /api/foundry/connection response
let pendingRequest = null; // a queued open request from a #settings/#import redirect

// panel-local UI state (survives a re-render while open)
const panelState = {
  source: "paste", // "paste" | "worldanvil"
  pasteText: "",
  url: "",
  result: null, // last lore-intake rollup {batchId, mutationCount, headline, importSummary}
  reading: false,
  settingsOpen: false,
  worldsOpen: false,
  syncing: false,
  syncMessage: ""
};

// ---------------------------------------------------------------------------
// public API (imported by app-shell.js + app.js)
// ---------------------------------------------------------------------------

/** Ensure the chip exists in the topbar and refresh its state. Idempotent —
 *  safe to call on every renderShell. Honors any queued redirect request. */
export function mountConnectionChip() {
  buildChip();
  refreshConnectionChip();
  if (panelOpen) renderPanel();
  if (pendingRequest) {
    const req = pendingRequest;
    pendingRequest = null;
    openConnectionPanel(req);
  }
}

/** Queue a panel open to be honored the next time the shell (and thus the
 *  chip) mounts — used by the #settings / #import hash redirects, which fire
 *  before the shell surface is rendered. */
export function requestConnectionPanel(opts) {
  pendingRequest = opts || {};
}

export function openConnectionPanel(opts = {}) {
  if (opts.section === "settings") panelState.settingsOpen = true;
  if (opts.section === "lore") { panelState.source = "paste"; }
  buildChip();
  panelOpen = true;
  renderPanel();
  // Attach dismiss listeners synchronously. The opening interaction can't
  // self-close: openConnectionPanel runs on 'click' (after that interaction's
  // own mousedown already fired), and onOutsideDown ignores mousedowns on the
  // chip or inside the panel anyway. Attaching on a later tick instead left a
  // window where a fast Escape landed before the keydown handler was wired.
  document.removeEventListener("mousedown", onOutsideDown, true);
  document.removeEventListener("keydown", onEscKey, true);
  document.addEventListener("mousedown", onOutsideDown, true);
  document.addEventListener("keydown", onEscKey, true);
}

export function closeConnectionPanel() {
  panelOpen = false;
  panelState.worldsOpen = false;
  document.removeEventListener("mousedown", onOutsideDown, true);
  document.removeEventListener("keydown", onEscKey, true);
  const panel = document.getElementById("conn-panel");
  if (panel) panel.remove();
  const chip = document.querySelector('[data-testid="conn-chip"]');
  chip?.setAttribute("aria-expanded", "false");
}

// ---------------------------------------------------------------------------
// dismiss handlers
// ---------------------------------------------------------------------------
function onEscKey(e) {
  if (e.key === "Escape") { closeConnectionPanel(); }
}

function onOutsideDown(e) {
  const panel = document.getElementById("conn-panel");
  const chip = document.querySelector('[data-testid="conn-chip"]');
  const t = e.target;
  if (panel && panel.contains(t)) return;
  if (chip && chip.contains(t)) return;
  closeConnectionPanel();
}

// ---------------------------------------------------------------------------
// the chip
// ---------------------------------------------------------------------------
function buildChip() {
  const slot = document.getElementById("shell-conn-slot");
  if (!slot) return;
  if (chipBuilt && slot.querySelector('[data-testid="conn-chip"]')) return;
  slot.innerHTML = "";

  const chip = el("button", {
    type: "button",
    class: "conn-chip",
    "data-testid": "conn-chip",
    "data-state": "off",
    "aria-haspopup": "dialog",
    "aria-expanded": "false",
    title: "Connection, intake and campaign settings"
  });
  const gear = el("span", { class: "conn-chip-gear" }, "⚙");
  const text = el("span", { class: "conn-chip-text" }, "Not connected");
  const badge = el("span", { class: "conn-chip-error", hidden: "" }, "!");
  const chevron = el("span", { class: "conn-chip-chev" }, "▾");
  chip.append(gear, text, badge, chevron);
  chip.addEventListener("click", () => {
    if (panelOpen) closeConnectionPanel();
    else openConnectionPanel();
  });
  slot.appendChild(chip);
  chipBuilt = true;
}

/** Fetch the connection + pending-review count and paint the chip. */
export async function refreshConnectionChip() {
  const chip = document.querySelector('[data-testid="conn-chip"]');
  if (!chip) return;
  const w = currentWorld();
  let conn = { state: "off", counts: null, lastSync: null };
  if (w) {
    try { conn = await cmApi(`/api/foundry/connection?world=${encodeURIComponent(w)}`); }
    catch { /* keep off */ }
  }
  lastConn = conn;
  paintChip(conn);

  // Pending-review count (cheap, best-effort — never blocks the chip).
  if (w) {
    try {
      const { batches } = await cmApi(`/api/batches?world=${encodeURIComponent(w)}`);
      const pending = (batches || []).reduce((n, b) => n + (b.pendingCount || 0), 0);
      const textEl = chip.querySelector(".conn-chip-text");
      if (textEl && pending > 0) textEl.textContent += ` · ${pending} to review`;
    } catch { /* ignore */ }
  }
}

function paintChip(conn) {
  const chip = document.querySelector('[data-testid="conn-chip"]');
  if (!chip) return;
  const state = conn.state === "live" || conn.state === "stale" ? conn.state : "off";
  chip.setAttribute("data-state", state);
  const textEl = chip.querySelector(".conn-chip-text");
  const actors = conn.counts && typeof conn.counts.actors === "number" ? conn.counts.actors : null;
  if (textEl) {
    if (state === "off") textEl.textContent = "Not connected";
    else textEl.textContent = `Foundry · ${state}${actors != null ? ` · ${actors} actors` : ""}`;
  }
  // Distinct sync-error badge — the chip's own signal that the last sync failed,
  // independent of the live/stale/off index state.
  const badge = chip.querySelector(".conn-chip-error");
  const syncFailed = !!(conn.lastSync && conn.lastSync.ok === false);
  if (badge) badge.hidden = !syncFailed;
  chip.classList.toggle("conn-chip--error", syncFailed);
}

// ---------------------------------------------------------------------------
// the panel
// ---------------------------------------------------------------------------
function renderPanel() {
  const slot = document.getElementById("shell-conn-slot");
  if (!slot) return;
  let panel = document.getElementById("conn-panel");
  if (!panel) {
    panel = el("div", { id: "conn-panel", class: "conn-panel", "data-testid": "conn-panel", role: "dialog", "aria-label": "Connection menu" });
    slot.appendChild(panel);
  }
  panel.innerHTML = "";
  const chip = document.querySelector('[data-testid="conn-chip"]');
  chip?.setAttribute("aria-expanded", "true");

  // header
  const header = el("div", { class: "conn-panel-header" });
  header.append(
    el("span", { class: "conn-panel-kicker" }, "Where the world comes from"),
    el("span", { class: "conn-panel-header-spacer" })
  );
  const close = el("span", { class: "conn-panel-close", title: "Close" }, "✕");
  close.addEventListener("click", closeConnectionPanel);
  header.appendChild(close);
  panel.appendChild(header);

  panel.appendChild(renderFoundrySection());
  panel.appendChild(renderLoreSection());
  panel.appendChild(renderHistorySection());
  panel.appendChild(renderSettingsSection());
}

// --- (1) Foundry -----------------------------------------------------------
function renderFoundrySection() {
  const sec = el("div", { class: "conn-section", "data-testid": "conn-panel-foundry-section" });
  sec.appendChild(el("div", { class: "conn-section-label" }, "Foundry"));

  const conn = lastConn || { state: "off" };
  const connected = conn.state === "live" || conn.state === "stale";

  if (connected) {
    const card = el("div", { class: "conn-foundry-card" });
    const head = el("div", { class: "conn-foundry-head" });
    const dot = el("span", { class: `conn-foundry-dot conn-foundry-dot--${conn.state}` });
    const name = el("span", { class: "conn-foundry-world" }, currentWorld() || "");
    const switchLink = el("span", { class: "conn-link", "data-testid": "conn-switch-world" }, "switch world");
    switchLink.addEventListener("click", () => { panelState.worldsOpen = !panelState.worldsOpen; renderPanel(); });
    const spacer = el("span", { class: "conn-foundry-head-spacer" });
    const live = el("span", { class: "conn-foundry-livetext" },
      conn.state === "stale" ? "stale · reindex in Foundry" : "live · changes in Foundry land here");
    head.append(dot, name, switchLink, spacer, live);
    card.appendChild(head);

    if (panelState.worldsOpen) card.appendChild(renderWorldSwitchList());

    // counts grid
    const counts = conn.counts || {};
    const grid = el("div", { class: "conn-counts-grid" });
    for (const [label, key] of [["Actors", "actors"], ["Items", "items"], ["Scenes", "scenes"], ["Journals", "journals"]]) {
      const cell = el("div", { class: "conn-count-cell" });
      cell.append(
        el("div", { class: "conn-count-label" }, label),
        el("div", { class: "conn-count-value" }, counts[key] != null ? String(counts[key]) : "—")
      );
      grid.appendChild(cell);
    }
    card.appendChild(grid);

    // Sync now
    const syncRow = el("div", { class: "conn-sync-row" });
    const syncBtn = el("button", { type: "button", class: "conn-sync-btn", "data-testid": "conn-sync-now" },
      panelState.syncing ? "Syncing…" : "Sync now");
    if (panelState.syncing) syncBtn.setAttribute("disabled", "");
    syncBtn.addEventListener("click", doSyncNow);
    const syncNote = el("div", { class: "conn-sync-note" },
      panelState.syncMessage || "reads the current Foundry index — new actors arrive as proposals");
    syncRow.append(syncBtn, syncNote);
    card.appendChild(syncRow);

    sec.appendChild(card);
  } else {
    // disconnected / off
    const card = el("div", { class: "conn-noconn-card", "data-testid": "conn-foundry-disconnected" });
    card.appendChild(el("div", { class: "conn-noconn-title" }, "No Foundry yet"));
    card.appendChild(el("div", { class: "conn-noconn-body" },
      "The World Fabric module in Foundry writes the bridge files this reads — open a world there and a sync brings its bestiary and party in as proposals. You can also start from lore alone; stat blocks can come later."));

    // Create-World (moved here from the retired #settings view — the launcher's
    // first-run lands on #settings, which now redirects to this panel).
    const cw = el("div", { class: "conn-create-world" });
    cw.appendChild(el("div", { class: "conn-create-world-label" }, "Start a fresh world"));
    const row = el("div", { class: "conn-create-world-row" });
    const input = el("input", { type: "text", class: "conn-create-world-input", "data-testid": "conn-create-world-input", placeholder: "world id, e.g. my-campaign" });
    const btn = el("button", { type: "button", class: "conn-create-world-btn", "data-testid": "conn-create-world-btn" }, "Create world");
    const status = el("div", { class: "conn-create-world-status" });
    btn.addEventListener("click", async () => {
      const id = input.value.trim();
      if (!id) { status.textContent = "Enter a world id first."; return; }
      status.textContent = "Creating…";
      try {
        const result = await cmApi("/api/worlds", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ world: id })
        });
        selectWorld(result.world);
        status.textContent = `Created "${result.world}" and selected it.`;
        renderPanel();
      } catch (err) { status.textContent = `Create failed: ${err.message}`; }
    });
    row.append(input, btn);
    cw.append(row, status);
    card.appendChild(cw);
    sec.appendChild(card);
  }
  return sec;
}

function renderWorldSwitchList() {
  const list = el("div", { class: "conn-world-switch", "data-testid": "conn-world-switch-list" });
  cmApi("/api/worlds").then(({ worlds }) => {
    list.innerHTML = "";
    const cur = currentWorld();
    for (const w of worlds || []) {
      const row = el("div", { class: "conn-world-switch-row" + (w === cur ? " conn-world-switch-row--active" : "") }, w);
      row.addEventListener("click", () => { selectWorld(w); panelState.worldsOpen = false; refreshConnectionChip().then(renderPanel); });
      list.appendChild(row);
    }
  }).catch(() => { /* leave empty */ });
  return list;
}

// Reuse the shell world-select's own change wiring rather than a second
// re-render path (avoids importing renderShell -> import cycle).
function selectWorld(w) {
  localStorage.setItem("gmReview.world", w);
  const sel = document.querySelector('[data-testid="shell-world-select"]');
  if (sel) {
    if (![...sel.options].some((o) => o.value === w)) {
      const opt = document.createElement("option");
      opt.value = w; opt.textContent = w; sel.appendChild(opt);
    }
    sel.value = w;
    sel.dispatchEvent(new Event("change"));
  }
}

async function doSyncNow() {
  if (panelState.syncing) return;
  panelState.syncing = true;
  panelState.syncMessage = "";
  renderPanel();
  try {
    const w = currentWorld();
    const result = await cmApi("/api/foundry/sync-now", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: w })
    });
    if (result.state === "off") {
      panelState.syncMessage = result.message || "No Foundry index yet — open the world in Foundry first.";
    } else {
      const p = result.pulled || {};
      panelState.syncMessage = `Pulled — ${p.bestiaryProposed || 0} bestiary · ${p.partyProposed || 0} party · ${p.alreadyLinked || 0} already linked.`;
    }
  } catch (err) {
    panelState.syncMessage = `Sync failed: ${err.message}`;
  } finally {
    panelState.syncing = false;
    await refreshConnectionChip();
    if (panelOpen) renderPanel();
  }
}

// --- (2) Bring in lore -----------------------------------------------------
function renderLoreSection() {
  const sec = el("div", { class: "conn-section", "data-testid": "conn-panel-lore-section" });
  const head = el("div", { class: "conn-lore-head" });
  head.append(
    el("div", { class: "conn-section-label" }, "Bring in lore"),
    el("div", { class: "conn-lore-subnote" }, "read once, reviewed in the Chronicle")
  );
  sec.appendChild(head);

  // mode tabs
  const tabs = el("div", { class: "conn-lore-tabs" });
  const pasteTab = el("div", { class: "conn-lore-tab" + (panelState.source === "paste" ? " conn-lore-tab--active" : ""), "data-testid": "conn-lore-mode-paste" }, "Paste text");
  const waTab = el("div", { class: "conn-lore-tab" + (panelState.source === "worldanvil" ? " conn-lore-tab--active" : ""), "data-testid": "conn-lore-mode-worldanvil" }, "World Anvil");
  pasteTab.addEventListener("click", () => { panelState.source = "paste"; panelState.result = null; renderPanel(); });
  waTab.addEventListener("click", () => { panelState.source = "worldanvil"; panelState.result = null; renderPanel(); });
  tabs.append(pasteTab, waTab);
  sec.appendChild(tabs);

  // the input for the active mode ONLY (mutually exclusive — the other's
  // testid must be absent from the DOM, not merely hidden)
  if (panelState.source === "paste") {
    const ta = el("textarea", { class: "conn-lore-paste", "data-testid": "conn-lore-paste-input", placeholder: "Paste your framing doc, session-zero notes, or half-finished worldbuilding. It reads names, places and who is inside what." });
    ta.value = panelState.pasteText;
    ta.addEventListener("input", (e) => { panelState.pasteText = e.target.value; });
    sec.appendChild(ta);
  } else {
    const inp = el("input", { type: "url", class: "conn-lore-url", "data-testid": "conn-lore-worldanvil-input", placeholder: "https://www.worldanvil.com/w/…" });
    inp.value = panelState.url;
    inp.addEventListener("input", (e) => { panelState.url = e.target.value; });
    sec.appendChild(inp);
  }

  // read button + status
  const actionRow = el("div", { class: "conn-lore-action-row" });
  const readBtn = el("button", { type: "button", class: "conn-lore-read-btn", "data-testid": "conn-lore-read-btn" },
    panelState.reading ? "Reading…" : "Read it in");
  if (panelState.reading) readBtn.setAttribute("disabled", "");
  readBtn.addEventListener("click", doReadLore);
  const meta = el("div", { class: "conn-lore-action-meta" },
    panelState.source === "paste" ? "one call · names, places, and what sits inside what" : "one call · fetched and stripped to text, merged by title");
  actionRow.append(readBtn, meta);
  sec.appendChild(actionRow);

  const statusHost = el("div", { class: "conn-lore-status", "data-testid": "conn-lore-status" });
  sec.appendChild(statusHost);

  if (panelState.result) sec.appendChild(renderLoreResult(panelState.result));
  return sec;
}

async function doReadLore() {
  if (panelState.reading) return;
  const w = currentWorld();
  const statusText = (msg) => {
    const host = document.querySelector('[data-testid="conn-lore-status"]');
    if (host) host.textContent = msg;
  };
  if (!w) { statusText("Select or create a world first."); return; }

  panelState.reading = true; panelState.result = null;
  renderPanel(); statusText("Reading…");
  try {
    let result;
    if (panelState.source === "paste") {
      if (!panelState.pasteText.trim()) { panelState.reading = false; renderPanel(); statusText("Paste some lore first."); return; }
      result = await cmApi("/api/writeup-propose", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: w, text: panelState.pasteText })
      });
    } else {
      if (!panelState.url.trim()) { panelState.reading = false; renderPanel(); statusText("Enter a World Anvil URL first."); return; }
      result = await cmApi("/api/lore/worldanvil", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: w, url: panelState.url })
      });
    }
    panelState.reading = false;
    if (result && result.phase === "framing") {
      // Rubber-duck mode is on for this world — the interpretive-framing step
      // lives in the full importer, not this compact panel. Stub handoff.
      panelState.result = null;
      renderPanel();
      statusText("Rubber-duck mode is on for this world — pick a framing in the full importer (New Import).");
      return;
    }
    panelState.result = result;
    renderPanel();
  } catch (err) {
    panelState.reading = false;
    renderPanel();
    statusText(`Could not read that in: ${err.message}`);
  }
}

function renderLoreResult(result) {
  const card = el("div", { class: "conn-lore-result", "data-testid": "conn-lore-result" });
  const head = el("div", { class: "conn-lore-result-head" });
  head.append(
    el("span", { class: "conn-lore-result-headline" }, result.headline || `${result.mutationCount || 0} nodes proposed`),
    el("span", { class: "conn-lore-result-head-spacer" }),
    el("span", { class: "conn-lore-result-meta" }, `${result.mutationCount || 0} proposed`)
  );
  card.appendChild(head);

  // Breakdown chips if the importSummary carries a per-type tally we can read.
  const breakdown = deriveBreakdown(result.importSummary);
  if (breakdown.length) {
    const chips = el("div", { class: "conn-lore-result-chips" });
    for (const b of breakdown) chips.appendChild(el("span", { class: "conn-lore-result-chip" }, b));
    card.appendChild(chips);
  }

  card.appendChild(el("div", { class: "conn-lore-result-note" },
    "Grouped by where things sit inside each other, so you can accept a whole branch at once. Nothing is in your graph yet."));

  const actions = el("div", { class: "conn-lore-result-actions" });
  const review = el("a", { class: "conn-lore-result-review", href: `#review/${result.batchId}`, "data-testid": "conn-lore-review-batch" }, "Review batch");
  review.addEventListener("click", () => closeConnectionPanel());
  actions.appendChild(review);
  // NOTE: "Accept all without reading" is intentionally OMITTED — the propose
  // response carries no mutation-id list, so bulk-accept isn't trivially
  // wireable here (it would need a batch-detail fetch + accept + sync). The
  // safe path is the "Review batch" handoff. Flagged in the completion report.
  card.appendChild(actions);
  return card;
}

// Best-effort per-type tally from importSummary — tolerant of shape, returns
// [] when nothing type-shaped is derivable (the rollup then shows headline +
// count only, never a crash).
function deriveBreakdown(summary) {
  if (!summary || typeof summary !== "object") return [];
  const out = [];
  const byType = summary.byType || summary.entitiesByType || summary.types;
  if (byType && typeof byType === "object") {
    for (const [k, v] of Object.entries(byType)) {
      const n = typeof v === "number" ? v : (v && typeof v.count === "number" ? v.count : null);
      if (n != null) out.push(`${k} ${n}`);
    }
  }
  return out.slice(0, 6);
}

// --- (3) Read so far (history) --------------------------------------------
function renderHistorySection() {
  const sec = el("div", { class: "conn-section", "data-testid": "conn-panel-history-section" });
  sec.appendChild(el("div", { class: "conn-section-label" }, "Read so far"));
  const list = el("div", { class: "conn-history-list" });
  sec.appendChild(list);

  const w = currentWorld();
  if (!w) { list.appendChild(el("div", { class: "conn-history-empty" }, "Select a world to see its intake history.")); return sec; }

  cmApi(`/api/batches?world=${encodeURIComponent(w)}`).then(({ batches }) => {
    list.innerHTML = "";
    if (!batches || !batches.length) {
      list.appendChild(el("div", { class: "conn-history-empty" }, "Nothing read in yet."));
      return;
    }
    for (const b of batches.slice(0, 8)) {
      const row = el("div", { class: "conn-history-row" });
      const kind = (b.scope && b.scope.mode) || (b.elapsedTimeDescriptor ? "time-skip" : "batch");
      row.append(
        el("span", { class: "conn-history-kind" }, kind),
        el("span", { class: "conn-history-name" }, b.id),
        el("span", { class: "conn-history-meta" }, `${b.status} · ${b.mutationCount} · ${b.pendingCount} pending`)
      );
      if (b.pendingCount > 0) {
        const open = el("a", { class: "conn-history-open", href: `#review/${b.id}` }, "review");
        open.addEventListener("click", () => closeConnectionPanel());
        row.appendChild(open);
      }
      list.appendChild(row);
    }
  }).catch(() => {
    list.innerHTML = "";
    list.appendChild(el("div", { class: "conn-history-empty" }, "Could not load history."));
  });
  return sec;
}

// --- (4) Campaign & keys (settings) ---------------------------------------
function renderSettingsSection() {
  const sec = el("div", { class: "conn-section", "data-testid": "conn-panel-settings-section" });
  const head = el("div", { class: "conn-settings-head" });
  head.append(
    el("span", { class: "conn-settings-chev" }, panelState.settingsOpen ? "▾" : "▸"),
    el("span", { class: "conn-section-label" }, "Campaign & keys")
  );
  head.addEventListener("click", () => { panelState.settingsOpen = !panelState.settingsOpen; renderPanel(); });
  sec.appendChild(head);

  if (!panelState.settingsOpen) return sec;

  const body = el("div", { class: "conn-settings-body", "data-testid": "conn-settings-body" });
  sec.appendChild(body);

  const w = currentWorld();
  if (!w) { body.appendChild(el("div", { class: "conn-history-empty" }, "Select a world first.")); return sec; }

  cmApi(`/api/settings?world=${encodeURIComponent(w)}`).then((settings) => {
    body.innerHTML = "";
    const grid = el("div", { class: "conn-settings-grid" });
    // WIRED rows (patch on blur): campaign, system, calendar.
    for (const [label, key, ph] of [
      ["Campaign", "campaignName", "Name this campaign"],
      ["Game system", "gameSystem", "e.g. D&D 5e"],
      ["Calendar", "calendar", "e.g. Harptos"]
    ]) {
      grid.appendChild(makeSettingRow(label, settings[key], (val) => patchSetting(key, val), ph));
    }
    // STORED-NOT-WIRED rows (rendered, labeled — the contract's own note).
    for (const [label, key] of [["Prose model", "proseModel"], ["Image model", "imageModel"]]) {
      grid.appendChild(makeStoredNotWiredRow(label, settings[key]));
    }
    body.appendChild(grid);
    body.appendChild(el("div", { class: "conn-settings-note" },
      "Model rows are stored but not wired to generation yet. Map and splash art stays in Foundry — this side keeps the name, a thumbnail and the scene it belongs to."));
  }).catch(() => {
    body.innerHTML = "";
    body.appendChild(el("div", { class: "conn-history-empty" }, "Could not load settings."));
  });
  return sec;
}

function makeSettingRow(label, value, save, placeholder) {
  const row = el("div", { class: "conn-setting-row" });
  row.appendChild(el("div", { class: "conn-setting-label" }, label));
  const field = el("div", {
    class: "conn-setting-value",
    contenteditable: "true",
    spellcheck: "false",
    "data-setting-label": label
  });
  const paint = () => {
    field.textContent = value || "";
    field.classList.toggle("conn-setting-value--empty", !value);
    if (!value) field.setAttribute("data-placeholder", placeholder || "");
  };
  paint();
  field.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); field.blur(); } });
  field.addEventListener("blur", async () => {
    const next = field.textContent.trim();
    if (next === (value || "")) return;
    value = next;
    await save(next);
    paint();
  });
  row.appendChild(field);
  return row;
}

function makeStoredNotWiredRow(label, value) {
  const row = el("div", { class: "conn-setting-row" });
  row.appendChild(el("div", { class: "conn-setting-label" }, label));
  const val = el("div", { class: "conn-setting-value conn-setting-value--readonly" });
  val.append(
    el("span", {}, value || "—"),
    el("span", { class: "conn-setting-tag" }, "stored, not wired")
  );
  row.appendChild(val);
  return row;
}

async function patchSetting(key, value) {
  const w = currentWorld();
  if (!w) return;
  try {
    await cmApi("/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: w, [key]: value })
    });
  } catch { /* best-effort; the field keeps the typed value */ }
}
