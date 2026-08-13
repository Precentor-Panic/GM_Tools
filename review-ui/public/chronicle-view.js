// GM Review — Phase 37 task 37.2: the Chronicle surface, ported from
// `design/session-planner/Chronicle.dc.html` (the pixel/DOM authority).
// Replaces Phase 34's placeholder scaffold with the real page: a deferred
// lane over the EXISTING pending-ledger, a Composer (the ONE span control +
// scope + fortune + nudge tags), a Timeline mode over the same shared span
// state, a Run that drives the resumable time-skip orchestrator (POST
// /api/chronicle/run), the "What changed" panel built from the SHARED
// proposal-card component, and the history rail over GET /api/chronicle/log.
//
// Faithful-port notes / deliberate deviations from the prototype markup, all
// flagged (the prototype seeded data the real backend can't always fill):
//  - THE SPAN CONTROL IS SHARED INTO BOTH MODES. The prototype only showed a
//    duration picker inside Timeline; the contract (phase37-fixture.mjs §2/§8)
//    elevates the single-source-of-duration rule above that placement, so the
//    span chip row (`chronicle-span-control` wrapping `chronicle-span-chip`s)
//    renders in Composer too, backed by ONE `state.spanId`. Switching modes
//    preserves the pick -- there is exactly one duration input in the surface.
//  - The world-clock line is `{calendar · }Day N · session N` (the pinned v1
//    floor). The prototype's richer relative phrasing ("wrapped 2 days ago")
//    has no real backing store and is intentionally not faked.
//  - Deferred-lane rows come from the real pending-ledger; `carried` is purely
//    client-side transient UI state (nothing persists until Run), per §5.
//  - History meta ("N changes applied · M reverted") uses the real batch
//    counts; span/fortune come from the chronicle-run sidecar and render as a
//    plain "—" for any batch not composed here (span:null), never a guess.
"use strict";
import { renderProposalCard, RISK_BUCKETS } from "./proposal-card.js";

// ---------------------------------------------------------------------------
// Palette / seed tables -- copied from Chronicle.dc.html's own logic class.
// ---------------------------------------------------------------------------
const TEAL = "oklch(0.55 0.075 185)";
const TYPES = {
  place: { glyph: "▢", accent: "oklch(0.55 0.075 185)" },
  person: { glyph: "◉", accent: "oklch(0.60 0.10 65)" },
  object: { glyph: "◆", accent: "oklch(0.52 0.08 300)" },
  faction: { glyph: "⬗", accent: "oklch(0.50 0.09 145)" },
  event: { glyph: "✧", accent: "oklch(0.55 0.11 40)" },
  concept: { glyph: "◌", accent: "oklch(0.55 0.03 260)" }
};
const SPANS = [
  { id: "week", label: "A week", head: "One week on" },
  { id: "month", label: "A month", head: "One month on" },
  { id: "season", label: "Three months", head: "Three months on" },
  { id: "year", label: "A year", head: "A year on" },
  { id: "long", label: "A generation", head: "Twenty-two years on" }
];
const FORTUNES = [
  { id: "bountiful", label: "Bountiful", blurb: "a fat year — harvests hold, coin moves, old wounds close" },
  { id: "fair", label: "Fair", blurb: "kind on balance, with the usual small griefs" },
  { id: "middling", label: "Middling", blurb: "the world neither favours nor punishes; things simply drift" },
  { id: "lean", label: "Lean", blurb: "belts tighten, tempers shorten, favours get called in" },
  { id: "ruinous", label: "Ruinous", blurb: "a season that takes things and does not give them back" }
];
const FORTUNE_HUES = { bountiful: 150, fair: 130, middling: 80, lean: 45, ruinous: 25 };
const SCOPE_KINDS = [
  { id: "queued-intents", label: "Only what's queued at left" },
  { id: "branches", label: "Somewhere in particular…" },
  { id: "whole-world", label: "The whole world" }
];
const TAG_GROUPS = [
  { id: "boons", label: "Boons", items: [
    { id: "plenty", label: "Harvest & plenty", glyph: "❋" },
    { id: "arrivals", label: "New arrivals", glyph: "◈" },
    { id: "accord", label: "Accords struck", glyph: "⌁" },
    { id: "returns", label: "Something lost returns", glyph: "↺" }
  ] },
  { id: "neutral", label: "Turns of fate", items: [
    { id: "factions", label: "Factions move", glyph: "⬗" },
    { id: "hands", label: "Things change hands", glyph: "◆" },
    { id: "rumour", label: "Rumour spreads", glyph: "≈" }
  ] },
  { id: "banes", label: "Banes", items: [
    { id: "scarcity", label: "Scarcity", glyph: "◇" },
    { id: "decay", label: "Decay & rot", glyph: "◌" },
    { id: "feud", label: "Old grudges surface", glyph: "✧" },
    { id: "death", label: "Someone doesn't make it", glyph: "✕" }
  ] }
];

// ---------------------------------------------------------------------------
// DOM + fetch helpers (standalone, same convention as library-view.js).
// ---------------------------------------------------------------------------
function el(tag, { style, testid, text, ...attrs } = {}, children = []) {
  const node = document.createElement(tag);
  if (style) node.setAttribute("style", style);
  if (testid) node.setAttribute("data-testid", testid);
  if (text != null) node.textContent = text;
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.appendChild(c);
  return node;
}
function currentWorld() {
  return localStorage.getItem("gmReview.world") || null;
}
function withWorld(params) {
  const p = new URLSearchParams(params || {});
  const w = currentWorld();
  if (w) p.set("world", w);
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}
async function api(path, opts) {
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
async function apiPost(path, payload) {
  return api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ world: currentWorld(), ...payload }) });
}
function setMain(node) {
  const main = document.getElementById("shell-main");
  if (!main) return;
  main.innerHTML = "";
  main.appendChild(node);
}
function mono(text, size = 9.5, color = "oklch(0.53 0.012 70)") {
  return el("div", { text, style: `font-family: 'IBM Plex Mono', monospace; font-size: ${size}px; letter-spacing: 0.09em; text-transform: uppercase; color: ${color};` });
}

// Segmented-control button (adv/review mode toggles).
function segBtn(label, active, onClick, testid, extra = {}) {
  const btn = el("div", {
    testid,
    text: label,
    style: `padding: 3px 10px; border-radius: 4px; font-size: 11.5px; cursor: pointer; background: ${active ? TEAL : "transparent"}; color: ${active ? "oklch(0.99 0.005 185)" : "oklch(0.48 0.014 65)"};`,
    ...extra
  });
  btn.addEventListener("click", onClick);
  return btn;
}

// ---------------------------------------------------------------------------
// Entry point. Owns #shell-main (single root child, per the phase34 e2e).
// ---------------------------------------------------------------------------
export async function renderChronicleSurface(arg) {
  const world = currentWorld();

  const root = el("div", {
    testid: "chronicle-surface-root",
    style: "display: flex; flex-direction: column; height: 100%; min-height: 0; background: oklch(0.955 0.008 85); font-size: 14px; color: oklch(0.27 0.015 60);"
  });
  setMain(root);

  // Loading placeholder while the four reads resolve.
  const loading = el("div", { style: "padding: 40px; font-size: 13px; color: oklch(0.55 0.012 70);", text: "Reading the chronicle…" });
  root.appendChild(loading);

  if (!world) {
    loading.textContent = "Select a world to compose an advance.";
    return;
  }

  // The component's own reactive state (mirrors the prototype's state object).
  const state = {
    advMode: "composer",
    reviewMode: "list",
    spanId: "season",
    scopeKind: "queued-intents",
    fortuneStopId: "middling",
    prompt: "",
    carried: new Set(),        // entryIds currently carried (default: all)
    branchIds: [],             // picked branch entityIds
    branchNames: {},           // entityId -> name (for chips)
    tags: new Set(),           // selected nudge-tag ids
    pickerOpen: false,
    running: false,
    proposals: [],             // region entities from the last run's batch detail
    batchId: null
  };

  // Repaint registries (elements refreshed on state change without a full
  // teardown -- keeps text-input focus/scroll stable, unlike a re-render).
  const spanChipEls = [];
  const fortuneStopEls = [];
  const scopeChipEls = [];
  const tagChipEls = [];
  const promptEls = [];
  const fortuneBlurbEls = [];
  const spanHeadlineEls = [];
  const branchChipsHost = el("div", { style: "display: flex; flex-wrap: wrap; gap: 6px;" });
  const branchPickerHost = el("div", {});
  const runMetaEl = el("div", { testid: "chronicle-run-meta", style: "font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: oklch(0.58 0.012 70);" });
  let runBtnEl = null; // set by buildRunRow; refreshRunMeta dims it when a run can't succeed
  let historyListHost = null;

  // ---- initial data ------------------------------------------------------
  let clock, fortune, pending, log;
  try {
    [clock, fortune, pending, log] = await Promise.all([
      api(`/api/chronicle/world-clock${withWorld()}`),
      api(`/api/chronicle/fortune${withWorld()}`),
      api(`/api/pending-entities${withWorld()}`),
      api(`/api/chronicle/log${withWorld()}`)
    ]);
  } catch (err) {
    loading.textContent = `Could not load the Chronicle: ${err.message}`;
    return;
  }
  state.fortuneStopId = fortune?.stopId ?? "middling";

  // Flatten pending entities -> intent rows, default every entry to carried.
  const intents = [];
  for (const ent of pending.entities || []) {
    for (const entry of ent.entries || []) {
      intents.push({
        entityId: ent.entityId,
        entryId: entry.entryId,
        name: ent.name,
        type: ent.type || "concept",
        note: entry.causeTag || "",
        source: entry.cycleDescriptor || "Deferred",
        tags: Array.isArray(entry.tags) ? entry.tags : []
      });
      state.carried.add(entry.entryId);
    }
  }

  root.removeChild(loading);

  // ---- sub-bar -----------------------------------------------------------
  const worldClockLine = el("div", {
    testid: "chronicle-worldclock-line",
    text: formatWorldClock(clock),
    style: "font-size: 12.5px; color: oklch(0.47 0.014 65);"
  });
  const advToggle = el("div", { testid: "chronicle-adv-mode-toggle", style: segWrapStyle() });
  const reviewToggle = el("div", { testid: "chronicle-review-mode-toggle", style: segWrapStyle() });

  function paintAdvToggle() {
    advToggle.innerHTML = "";
    for (const m of [["composer", "Composer"], ["timeline", "Timeline"]]) {
      advToggle.appendChild(segBtn(m[1], state.advMode === m[0], () => setAdvMode(m[0]), "chronicle-adv-mode-btn", { "data-mode": m[0] }));
    }
  }
  function paintReviewToggle() {
    reviewToggle.innerHTML = "";
    for (const m of [["list", "Every change"], ["triage", "Triaged"]]) {
      reviewToggle.appendChild(segBtn(m[1], state.reviewMode === m[0], () => { state.reviewMode = m[0]; paintReviewToggle(); paintProposals(); }, "chronicle-review-mode-btn", { "data-mode": m[0] }));
    }
  }
  paintAdvToggle();
  paintReviewToggle();

  const subbar = el("div", {
    style: "display: flex; align-items: center; gap: 12px; padding: 0 16px; height: 40px; flex: none; border-bottom: 1px solid oklch(0.88 0.010 80); background: oklch(0.945 0.009 85);"
  }, [
    mono("Chronicle", 10),
    worldClockLine,
    el("div", { style: "flex: 1;" }),
    mono("Advance", 9.5, "oklch(0.58 0.012 70)"),
    advToggle,
    mono("Review", 9.5, "oklch(0.58 0.012 70)"),
    reviewToggle
  ]);
  root.appendChild(subbar);

  // ---- three-column body -------------------------------------------------
  const body = el("div", { style: "display: flex; flex: 1; min-height: 0;" });
  root.appendChild(body);

  // ==== LEFT: deferred lane ==============================================
  const lane = buildDeferredLane();
  body.appendChild(lane);

  // ==== MIDDLE: composer / timeline / proposals ==========================
  const midScroll = el("div", { style: "flex: 1; overflow-y: auto; padding: 24px 30px 40px;" });
  const midInner = el("div", { style: "max-width: 840px;" });
  midScroll.appendChild(midInner);
  body.appendChild(el("div", { style: "flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden;" }, [midScroll]));

  // The active advance mode is the SOLE mode in the DOM at a time (composer
  // XOR timeline) -- not two display:none copies -- so exactly one span
  // control / fortune track ever matches a selector, honoring §2's single-
  // source rule at the DOM level and satisfying Playwright strict mode.
  const modeHost = el("div", {});
  const runRow = buildRunRow();
  const spinner = el("div", { testid: "chronicle-run-spinner", style: "display: none; margin-top: 26px; padding: 16px 18px; border: 1px dashed oklch(0.82 0.040 185); border-radius: 5px; background: oklch(0.97 0.010 185);" }, [
    el("div", { style: "display: flex; align-items: center; gap: 10px;" }, [
      el("span", { text: "◍", style: "font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: oklch(0.48 0.075 185); animation: chpulse 1.1s ease-in-out infinite;" }),
      el("span", { testid: "chronicle-run-spinner-text", text: "Reading intents and nodes into one mutation pass…", style: "font-size: 13px; color: oklch(0.42 0.050 185);" })
    ])
  ]);
  const proposalsWrap = el("div", { style: "display: none;" });
  midInner.append(modeHost, runRow, spinner, proposalsWrap);

  // ==== RIGHT: the chronicle (history) ===================================
  const history = buildHistory(log);
  body.appendChild(history);

  paintAdvMode();

  // -----------------------------------------------------------------------
  // Phase 37 task 37.3: deep-link + Wrap-up handoff routing (the SAME
  // surface, entered from three retired places).
  //  - `#chronicle/batch/<batchId>` -> load that batch's detail straight
  //    into the "What changed" panel (the SHARED proposal-card). This is
  //    the new home for the retired `#review/<batchId>` screen and the
  //    Connection-Menu lore-intake + Wrap-rail "Review" handoffs -- one
  //    review surface, not three local card renderers.
  //  - `#chronicle/compose` -> the Wrap-up "N threads waiting -- pass time
  //    now?" entry point: Composer mode with the queued-intents scope
  //    pre-selected (the deferred lane is always visible at left).
  const route = parseChronicleArg(arg);
  if (route.kind === "compose") {
    state.advMode = "composer";
    state.scopeKind = "queued-intents";
    paintAdvMode();
    paintScopeChips();
    refreshRunMeta();
  } else if (route.kind === "batch" && route.batchId) {
    await loadBatchDetail(route.batchId);
  }

  // -----------------------------------------------------------------------
  // Builders
  // -----------------------------------------------------------------------
  function buildDeferredLane() {
    const laneRoot = el("div", {
      testid: "chronicle-deferred-lane",
      style: "width: 336px; flex: none; border-right: 1px solid oklch(0.87 0.010 80); background: oklch(0.938 0.009 85); display: flex; flex-direction: column; min-height: 0;"
    });
    const head = el("div", { style: "padding: 13px 14px 6px;" }, [
      el("div", { style: "display: flex; align-items: center; gap: 8px;" }, [
        mono("Deferred", 10),
        el("div", { style: "flex: 1;" }),
        el("div", { testid: "chronicle-intent-meta", text: `${state.carried.size} of ${intents.length} carried`, style: "font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; color: oklch(0.60 0.012 70);" })
      ]),
      el("div", { style: "font-size: 11.5px; color: oklch(0.56 0.012 70); line-height: 1.45; margin-top: 6px;", text: "Tagged during wrap-up and held here. Nothing has been sent anywhere — they ride along on the next advance, batched into one call." })
    ]);
    const metaEl = head.querySelector('[data-testid="chronicle-intent-meta"]');

    const rows = el("div", { style: "flex: 1; overflow-y: auto; padding: 8px 10px 14px;" });
    const rowsHost = el("div", { style: "display: flex; flex-direction: column; gap: 6px;" });
    rows.appendChild(rowsHost);
    for (const it of intents) rowsHost.appendChild(intentRow(it, metaEl));
    if (!intents.length) {
      rowsHost.appendChild(el("div", { style: "padding: 10px 6px; font-size: 12px; color: oklch(0.58 0.012 70); line-height: 1.45;", text: "Nothing queued yet. Add an intent by hand below, or defer threads from a wrap-up." }));
    }

    const foot = el("div", { style: "border-top: 1px solid oklch(0.88 0.010 80); background: oklch(0.925 0.009 85); padding: 11px 14px 13px;" }, [
      mono("Add an intent by hand", 9.5),
      (() => {
        const input = el("input", {
          testid: "chronicle-intent-add-input",
          placeholder: "e.g. Sella's brother's ring — who has it now?",
          style: "width: 100%; margin-top: 8px; padding: 6px 9px; border: 1px solid oklch(0.85 0.010 80); border-radius: 4px; font-family: inherit; font-size: 12px; background: oklch(1 0 0); color: inherit;"
        });
        input.addEventListener("keydown", async (e) => {
          if (e.key !== "Enter" || !input.value.trim()) return;
          const name = input.value.trim();
          input.value = "";
          input.disabled = true;
          try {
            const created = await apiPost("/api/chronicle/intents", { name });
            const entry = (created.entries || [])[created.entries.length - 1] || {};
            const it = { entityId: created.entityId, entryId: entry.entryId, name: created.name, type: created.type || "concept", note: entry.causeTag || "Added by hand.", source: "Manual", tags: Array.isArray(entry.tags) ? entry.tags : [] };
            intents.push(it);
            if (it.entryId) state.carried.add(it.entryId);
            const empty = rowsHost.querySelector("div"); // remove empty-state note if present
            rowsHost.appendChild(intentRow(it, metaEl));
            refreshIntentMeta(metaEl);
          } catch (err) {
            console.error("add intent failed:", err);
          } finally {
            input.disabled = false;
            input.focus();
          }
        });
        return input;
      })()
    ]);

    laneRoot.append(head, rows, foot);
    return laneRoot;
  }

  function intentRow(it, metaEl) {
    const t = TYPES[it.type] || TYPES.concept;
    const carried = it.entryId ? state.carried.has(it.entryId) : false;
    const row = el("div", {
      testid: "chronicle-intent-row",
      "data-entity-id": it.entityId,
      "data-entry-id": it.entryId || "",
      "data-carried": carried ? "true" : "false",
      style: intentRowStyle(carried, t.accent)
    });
    const cb = el("input", { type: "checkbox" });
    cb.checked = carried;
    const nameEl = el("span", { text: it.name, style: `flex: 1; min-width: 0; font-size: 12.5px; color: ${carried ? "oklch(0.28 0.015 60)" : "oklch(0.62 0.012 70)"}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;` });
    const stateEl = el("span", { text: carried ? "carried" : "held back", style: `font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; color: ${carried ? "oklch(0.45 0.060 185)" : "oklch(0.66 0.012 70)"};` });
    const topLine = el("div", { style: "display: flex; align-items: center; gap: 7px;" }, [
      cb,
      el("span", { text: t.glyph, style: `font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; color: ${carried ? t.accent : "oklch(0.82 0.010 80)"};` }),
      nameEl,
      stateEl
    ]);
    const noteEl = el("div", { text: it.note, style: "font-size: 11.5px; color: oklch(0.50 0.014 65); line-height: 1.45; margin-top: 5px;" });
    const tagsRow = el("div", { style: "display: flex; flex-wrap: wrap; gap: 4px; margin-top: 7px;" });
    for (const tg of it.tags) tagsRow.appendChild(el("span", { text: tg, style: "padding: 2px 7px; border-radius: 20px; background: oklch(0.90 0.030 185); font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: 0.04em; color: oklch(0.40 0.060 185);" }));

    function toggle() {
      if (!it.entryId) return;
      const now = !state.carried.has(it.entryId);
      if (now) state.carried.add(it.entryId); else state.carried.delete(it.entryId);
      cb.checked = now;
      row.setAttribute("data-carried", now ? "true" : "false");
      row.setAttribute("style", intentRowStyle(now, t.accent));
      nameEl.setAttribute("style", `flex: 1; min-width: 0; font-size: 12.5px; color: ${now ? "oklch(0.28 0.015 60)" : "oklch(0.62 0.012 70)"}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`);
      stateEl.textContent = now ? "carried" : "held back";
      stateEl.setAttribute("style", `font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; color: ${now ? "oklch(0.45 0.060 185)" : "oklch(0.66 0.012 70)"};`);
      refreshIntentMeta(metaEl);
    }
    cb.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
    row.addEventListener("click", (e) => { if (e.target !== cb) toggle(); });

    row.append(topLine, noteEl, tagsRow);
    return row;
  }

  function refreshIntentMeta(metaEl) {
    metaEl.textContent = `${state.carried.size} of ${intents.length} carried`;
    refreshRunMeta();
  }

  // ---- Composer ---------------------------------------------------------
  function buildComposer() {
    const c = el("div", { testid: "chronicle-composer" });
    c.append(
      el("div", { style: "font-family: Spectral, serif; font-size: 27px; font-weight: 500; margin-bottom: 6px;", text: "Let time pass" }),
      el("div", { style: "font-size: 13.5px; line-height: 1.5; color: oklch(0.48 0.014 65); max-width: 62ch; margin-bottom: 18px;", text: "Say what happens in the world's own words. Everything checked at left rides along, so the graph moves once instead of eleven times." }),
      promptTextarea("Three months pass. The Compact's blockade of the causeway holds, barely — and the vault has been dry for six weeks."),
      labelRow("How far it reaches"),
      buildScopeRow(),
      buildBranchPicker(),
      labelRow("How far ahead"),
      buildSpanControl(),
      labelRow("How the age treats them"),
      buildFortuneTrack(),
      buildNudgeTags()
    );
    return c;
  }

  function promptTextarea(placeholder) {
    const ta = el("textarea", {
      testid: "chronicle-prompt-input",
      placeholder,
      style: "width: 100%; min-height: 96px; padding: 13px 14px; border: 1px solid oklch(0.84 0.010 80); border-radius: 5px; font-size: 15px; line-height: 1.5; background: oklch(1 0 0); color: inherit; resize: vertical; font-family: inherit;"
    });
    ta.value = state.prompt;
    ta.addEventListener("input", () => { state.prompt = ta.value; refreshRunMeta(); });
    return ta;
  }
  function promptValue() { return state.prompt; }

  function labelRow(text) {
    return el("div", { style: "display: flex; align-items: baseline; gap: 10px; margin: 16px 0 7px;" }, [mono(text, 9.5, "oklch(0.55 0.012 70)")]);
  }

  function buildScopeRow() {
    const row = el("div", { style: "display: flex; flex-wrap: wrap; gap: 6px; align-items: center;" });
    // Cleanup (Russell's Phase-37 pass, 2026-08-11): the row previously
    // rendered TWO "Somewhere in particular…" controls -- the scope chip AND
    // a separate picker toggle -- both flipping scopeKind to "branches"
    // immediately, so a run before any branch was picked hit the server's
    // (correct) 400 "requires a non-empty branchIds[]". ONE chip now serves
    // both roles: selecting "branches" opens the picker; the Run button
    // separately refuses the empty state with a quiet hint (see runDisabledReason).
    for (const sk of SCOPE_KINDS) {
      const chip = el("div", {
        testid: "chronicle-scope-chip",
        "data-scope-kind": sk.id,
        role: "button",
        "aria-pressed": state.scopeKind === sk.id ? "true" : "false",
        text: sk.label,
        style: chipStyle(state.scopeKind === sk.id)
      });
      chip.addEventListener("click", () => {
        state.scopeKind = sk.id;
        state.pickerOpen = sk.id === "branches"; // picking the branches scope IS opening the picker
        paintScopeChips(); paintBranchPicker(); refreshRunMeta();
      });
      scopeChipEls.push(chip);
      row.appendChild(chip);
    }
    // picked-branch chips live in the same row (the picker itself renders below)
    row.appendChild(branchChipsHost);
    return row;
  }

  function paintScopeChips() {
    for (const chip of scopeChipEls) {
      const on = chip.getAttribute("data-scope-kind") === state.scopeKind;
      chip.setAttribute("aria-pressed", on ? "true" : "false");
      chip.setAttribute("style", chipStyle(on));
    }
  }

  function buildBranchPicker() { paintBranchPicker(); return branchPickerHost; }
  function paintBranchChips() {
    branchChipsHost.innerHTML = "";
    for (const id of state.branchIds) {
      const chip = el("div", {
        testid: "chronicle-branch-chip",
        "data-entity-id": id,
        style: "display: flex; align-items: center; gap: 7px; padding: 5px 9px 5px 11px; border: 1px solid oklch(0.72 0.055 185); border-radius: 20px; font-size: 12px; background: oklch(0.90 0.030 185); color: oklch(0.33 0.060 185);"
      }, [
        el("span", { text: state.branchNames[id] || id }),
        (() => { const x = el("span", { text: "✕", style: "font-size: 10px; cursor: pointer; color: oklch(0.45 0.050 185);" }); x.addEventListener("click", () => { state.branchIds = state.branchIds.filter((b) => b !== id); paintBranchChips(); refreshRunMeta(); }); return x; })()
      ]);
      branchChipsHost.appendChild(chip);
    }
  }
  function paintBranchPicker() {
    branchPickerHost.innerHTML = "";
    if (!state.pickerOpen) return;
    const box = el("div", { style: "margin-top: 9px; border: 1px solid oklch(0.86 0.010 80); border-radius: 5px; background: oklch(0.985 0.005 85); overflow: hidden;" });
    const input = el("input", { placeholder: "Find a place, faction, event, or object…", style: "width: 100%; padding: 9px 12px; border: none; border-bottom: 1px solid oklch(0.90 0.010 80); font-family: inherit; font-size: 13px; background: oklch(1 0 0); color: inherit; outline: none;" });
    const results = el("div", { style: "max-height: 208px; overflow-y: auto; padding: 6px;" });
    box.append(input, results);
    branchPickerHost.appendChild(box);

    async function search(qstr) {
      results.innerHTML = "";
      let nodes = [];
      try { ({ nodes } = await api(`/api/graph${withWorld({ filter: "all" })}`)); } catch { nodes = []; }
      const ql = (qstr || "").trim().toLowerCase();
      const rows = nodes
        .filter((n) => state.branchIds.indexOf(n.id) < 0)
        .filter((n) => !ql || (n.name || "").toLowerCase().includes(ql))
        .slice(0, 40);
      if (!rows.length) { results.appendChild(el("div", { style: "padding: 10px 9px; font-size: 12px; color: oklch(0.58 0.012 70);", text: "Nothing by that name in the graph." })); return; }
      for (const n of rows) {
        const t = TYPES[n.type] || TYPES.concept;
        const r = el("div", { style: "display: flex; align-items: baseline; gap: 9px; padding: 6px 9px; border-radius: 4px; cursor: pointer;" }, [
          el("span", { text: t.glyph, style: `font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; color: ${t.accent};` }),
          el("span", { text: n.name || n.id, style: "font-size: 12.5px; color: oklch(0.28 0.015 60);" })
        ]);
        r.addEventListener("click", () => { state.branchIds.push(n.id); state.branchNames[n.id] = n.name || n.id; state.pickerOpen = false; state.scopeKind = "branches"; paintScopeChips(); paintBranchChips(); paintBranchPicker(); refreshRunMeta(); });
        results.appendChild(r);
      }
    }
    input.addEventListener("input", () => search(input.value));
    search("");
    setTimeout(() => input.focus(), 0);
  }

  // ---- THE shared span control (rendered in BOTH modes) -----------------
  function buildSpanControl() {
    const wrap = el("div", { testid: "chronicle-span-control", style: "display: flex; flex-wrap: wrap; gap: 6px; align-items: center;" });
    for (const sp of SPANS) {
      const chip = el("div", {
        testid: "chronicle-span-chip",
        "data-span-id": sp.id,
        role: "button",
        "aria-pressed": state.spanId === sp.id ? "true" : "false",
        text: sp.label,
        style: chipStyle(state.spanId === sp.id)
      });
      chip.addEventListener("click", () => { state.spanId = sp.id; paintSpanChips(); refreshRunMeta(); paintSpanHeadline(); });
      spanChipEls.push(chip);
      wrap.appendChild(chip);
    }
    return wrap;
  }
  function paintSpanChips() {
    for (const chip of spanChipEls) {
      const on = chip.getAttribute("data-span-id") === state.spanId;
      chip.setAttribute("aria-pressed", on ? "true" : "false");
      chip.setAttribute("style", chipStyle(on));
    }
  }

  // ---- fortune track (rendered in BOTH modes) ---------------------------
  function buildFortuneTrack() {
    const outer = el("div", { style: "border: 1px solid oklch(0.87 0.010 80); border-radius: 5px; background: oklch(0.985 0.005 85); padding: 4px 4px 0;" });
    const track = el("div", { testid: "chronicle-fortune-track", style: "display: flex;" });
    for (const f of FORTUNES) {
      const on = state.fortuneStopId === f.id;
      const hue = FORTUNE_HUES[f.id];
      const stop = el("div", {
        testid: "chronicle-fortune-stop",
        "data-stop-id": f.id,
        role: "button",
        "aria-pressed": on ? "true" : "false",
        style: fortuneStopStyle(on, hue)
      }, [
        el("span", { style: `width: 7px; height: 7px; border-radius: 50%; background: ${on ? `oklch(0.52 0.11 ${hue})` : "oklch(0.84 0.010 80)"};` }),
        el("span", { text: f.label, style: `font-family: Spectral, serif; font-size: 14.5px; font-weight: ${on ? "600" : "400"}; color: ${on ? `oklch(0.32 0.09 ${hue})` : "oklch(0.52 0.014 65)"};` })
      ]);
      stop.addEventListener("click", () => pickFortune(f.id));
      fortuneStopEls.push(stop);
      track.appendChild(stop);
    }
    const blurb = el("div", { testid: "chronicle-fortune-blurb", style: "padding: 8px 11px 9px; border-top: 1px solid oklch(0.91 0.010 80); font-size: 12.5px; color: oklch(0.50 0.014 65);", text: fortuneBlurb(state.fortuneStopId) });
    fortuneBlurbEls.push(blurb);
    outer.append(track, blurb);
    return outer;
  }
  async function pickFortune(stopId) {
    const prev = state.fortuneStopId;
    state.fortuneStopId = stopId;
    paintFortuneStops();
    refreshRunMeta();
    try { await apiPost("/api/chronicle/fortune", { stopId }); }
    catch (err) { state.fortuneStopId = prev; paintFortuneStops(); console.error("set fortune failed:", err); }
  }
  function paintFortuneStops() {
    for (const stop of fortuneStopEls) {
      const id = stop.getAttribute("data-stop-id");
      const on = id === state.fortuneStopId;
      stop.setAttribute("aria-pressed", on ? "true" : "false");
      stop.setAttribute("style", fortuneStopStyle(on, FORTUNE_HUES[id]));
      const dot = stop.children[0];
      const lbl = stop.children[1];
      dot.setAttribute("style", `width: 7px; height: 7px; border-radius: 50%; background: ${on ? `oklch(0.52 0.11 ${FORTUNE_HUES[id]})` : "oklch(0.84 0.010 80)"};`);
      lbl.setAttribute("style", `font-family: Spectral, serif; font-size: 14.5px; font-weight: ${on ? "600" : "400"}; color: ${on ? `oklch(0.32 0.09 ${FORTUNE_HUES[id]})` : "oklch(0.52 0.014 65)"};`);
    }
    for (const b of fortuneBlurbEls) b.textContent = fortuneBlurb(state.fortuneStopId);
  }

  // ---- nudge tags -------------------------------------------------------
  function buildNudgeTags() {
    const wrap = el("div", {});
    wrap.append(
      el("div", { style: "display: flex; align-items: baseline; gap: 10px; margin: 18px 0 8px;" }, [
        mono("Nudge it further", 9.5, "oklch(0.55 0.012 70)"),
        el("div", { style: "font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; color: oklch(0.64 0.012 70);", text: "optional — these become tags on the graph, not prose" })
      ])
    );
    const groups = el("div", { style: "display: flex; flex-direction: column; gap: 8px;" });
    for (const g of TAG_GROUPS) {
      const gRow = el("div", { style: "display: flex; align-items: center; gap: 10px;" }, [
        el("div", { style: "width: 84px; flex: none; font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; letter-spacing: 0.06em; text-transform: uppercase; color: oklch(0.60 0.012 70); text-align: right;", text: g.label })
      ]);
      const items = el("div", { style: "display: flex; flex-wrap: wrap; gap: 6px;" });
      for (const t of g.items) {
        const chip = el("div", {
          testid: "chronicle-nudge-tag",
          "data-tag-id": t.id,
          role: "button",
          "aria-pressed": state.tags.has(t.id) ? "true" : "false",
          style: chipStyle(state.tags.has(t.id))
        }, [el("span", { text: t.glyph, style: "font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; margin-right: 6px;" }), el("span", { text: t.label })]);
        chip.addEventListener("click", () => {
          if (state.tags.has(t.id)) state.tags.delete(t.id); else state.tags.add(t.id);
          for (const c of tagChipEls) { const on = state.tags.has(c.getAttribute("data-tag-id")); c.setAttribute("aria-pressed", on ? "true" : "false"); c.setAttribute("style", chipStyle(on)); }
        });
        tagChipEls.push(chip);
        items.appendChild(chip);
      }
      gRow.appendChild(items);
      groups.appendChild(gRow);
    }
    wrap.appendChild(groups);
    return wrap;
  }

  // ---- Timeline ---------------------------------------------------------
  function buildTimeline() {
    const t = el("div", { testid: "chronicle-timeline" });
    t.append(
      el("div", { style: "font-family: Spectral, serif; font-size: 27px; font-weight: 500; margin-bottom: 6px;", text: "Drag the world forward" }),
      el("div", { style: "font-size: 13.5px; line-height: 1.5; color: oklch(0.48 0.014 65); max-width: 62ch; margin-bottom: 22px;", text: "Pick how far ahead you're jumping. Deferred intents ride along with the jump — everything checked at left is carried in." }),
      buildSpanControl(),
      spanHeadlineCard(),
      el("div", { style: "margin-top: 14px;" }, [mono("What colours the jump", 9.5, "oklch(0.55 0.012 70)")]),
      promptTextarea("Optional. The blockade holds, barely — and the vault has been dry for six weeks."),
      el("div", { style: "margin-top: 14px;" }, [buildFortuneTrack()]),
      el("div", { style: "margin-top: 12px;" }, [buildNudgeTags()])
    );
    return t;
  }
  function spanHeadlineCard() {
    const card = el("div", { style: "display: flex; align-items: baseline; gap: 12px; padding: 12px 14px; border: 1px solid oklch(0.86 0.030 185); border-radius: 5px; background: oklch(0.965 0.014 185); margin-top: 16px;" });
    const head = el("div", { testid: "chronicle-span-headline", style: "font-family: Spectral, serif; font-size: 19px; font-weight: 500; color: oklch(0.36 0.060 185);", text: spanHead() });
    spanHeadlineEls.push(head);
    card.append(head, el("div", { style: "flex: 1;" }), el("div", { testid: "chronicle-span-meta", style: "font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: oklch(0.44 0.050 185);", text: `${state.carried.size} intents carried` }));
    return card;
  }
  function paintSpanHeadline() { for (const h of spanHeadlineEls) h.textContent = spanHead(); }
  function spanHead() { return (SPANS.find((s) => s.id === state.spanId) || SPANS[2]).head; }

  // ---- Run row ----------------------------------------------------------
  // Cleanup (Russell's pass): a run that CANNOT succeed (branches scope with
  // nothing picked) must never reach the server's 400 -- the button deflects
  // with a quiet hint instead. The server-side validation stays as backstop.
  function runDisabledReason() {
    if (state.scopeKind === "branches" && state.branchIds.length === 0) {
      return "pick at least one place or faction first";
    }
    // Cleanup (Russell's pass, task 37.5): a queued-intents run with NO
    // typed event AND nothing carried is structurally empty -- it can never
    // produce a reviewable proposal (the server-side fix makes a typed
    // prompt a real seed, but an empty prompt with zero carried intents is
    // still a true no-op). Deflect client-side, same pattern as the
    // branches guard above; the empty-carried case with a REAL prompt is a
    // valid, intentional run and must NOT be blocked here.
    if (state.scopeKind === "queued-intents" && !promptValue().trim() && state.carried.size === 0) {
      return "describe an event or carry a thread first";
    }
    return null;
  }
  function buildRunRow() {
    runBtnEl = el("div", {
      testid: "chronicle-run-btn",
      role: "button",
      style: `display: flex; align-items: center; gap: 9px; padding: 9px 18px; border-radius: 5px; cursor: pointer; background: ${TEAL}; color: oklch(0.99 0.005 185); font-size: 13px; font-weight: 500;`
    }, [el("span", { text: "✦", style: "font-family: 'IBM Plex Mono', monospace; font-size: 11px;" }), el("span", { testid: "chronicle-run-btn-label", text: "Let time pass" })]);
    runBtnEl.addEventListener("click", () => {
      if (runDisabledReason()) { refreshRunMeta(); return; }
      runAdvance();
    });
    refreshRunMeta();
    return el("div", { style: "display: flex; align-items: center; gap: 14px; margin-top: 20px; padding-top: 16px; border-top: 1px solid oklch(0.89 0.010 80);" }, [runBtnEl, runMetaEl]);
  }
  function refreshRunMeta() {
    const reason = runDisabledReason();
    runMetaEl.textContent = reason ?? runMetaText();
    runMetaEl.setAttribute("data-run-blocked", reason ? "true" : "false");
    if (runBtnEl) {
      runBtnEl.setAttribute("aria-disabled", reason ? "true" : "false");
      runBtnEl.style.opacity = reason ? "0.55" : "1";
      runBtnEl.style.cursor = reason ? "default" : "pointer";
    }
  }
  function runMetaText() {
    const fLabel = (FORTUNES.find((f) => f.id === state.fortuneStopId) || FORTUNES[2]).label.toLowerCase();
    const scopeSummary = state.scopeKind === "queued-intents" ? `${state.carried.size} intents` : state.scopeKind === "branches" ? `${state.branchIds.length} branch${state.branchIds.length === 1 ? "" : "es"}` : "whole world";
    return `1 call · ${scopeSummary} · ${fLabel} · ${spanHead().toLowerCase()}`;
  }

  // ---- history ----------------------------------------------------------
  function buildHistory(logData) {
    const h = el("div", {
      testid: "chronicle-history",
      style: "width: 306px; flex: none; border-left: 1px solid oklch(0.87 0.010 80); background: oklch(0.938 0.009 85); display: flex; flex-direction: column; min-height: 0;"
    });
    h.appendChild(el("div", { style: "padding: 13px 14px 8px; display: flex; align-items: center; gap: 8px;" }, [
      mono("The chronicle", 10),
      el("div", { style: "flex: 1;" }),
      el("div", { style: "font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; color: oklch(0.60 0.012 70);", text: "newest first" })
    ]));
    const scroll = el("div", { testid: "chronicle-history-list", style: "flex: 1; overflow-y: auto; padding: 0 12px 16px;" });
    const list = el("div", { style: "display: flex; flex-direction: column; gap: 8px;" });
    scroll.appendChild(list);
    h.appendChild(scroll);
    fillHistory(list, logData);
    historyListHost = list;
    return h;
  }
  // Cleanup (Russell's pass, task 37.5): the chronicle = what actually
  // happened, so the MAIN list shows only batches with >=1 ACCEPTED
  // mutation. Batches with pending-but-unaccepted mutations group under a
  // quiet "awaiting review" section at the TOP (deep-linking to
  // #chronicle/batch/<id> -- fix A prevents new ZERO-mutation batches on the
  // queued-intents path going forward). Zero-mutation batches are HIDDEN
  // from the rail entirely (they remain reachable via batch routes; here
  // they're pure noise). This gating applies to the RAIL only -- the
  // just-run flow's "What changed" panel (paintProposals/state.batchId)
  // shows its own proposals immediately, unaffected.
  function fillHistory(list, logData) {
    list.innerHTML = "";
    const entries = (logData && logData.entries) || [];
    const awaiting = entries.filter((e) => (e.mutationCount ?? 0) > 0 && (e.acceptedCount ?? 0) === 0);
    const accepted = entries.filter((e) => (e.acceptedCount ?? 0) > 0);
    if (!awaiting.length && !accepted.length) {
      list.appendChild(el("div", { style: "padding: 10px 4px; font-size: 11.5px; color: oklch(0.58 0.012 70); line-height: 1.45;", text: "No passages yet. Compose one at the centre and it lands here." }));
      return;
    }
    if (awaiting.length) {
      list.appendChild(el("div", {
        testid: "chronicle-history-awaiting-header",
        style: "font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; letter-spacing: 0.06em; text-transform: uppercase; color: oklch(0.55 0.070 60); padding: 2px 2px 5px;",
        text: `Awaiting review (${awaiting.length})`
      }));
      const awaitingHost = el("div", { testid: "chronicle-history-awaiting", style: "display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px;" });
      for (const e of awaiting) awaitingHost.appendChild(historyEntry(e));
      list.appendChild(awaitingHost);
    }
    if (accepted.length) {
      const acceptedHost = el("div", { testid: "chronicle-history-accepted", style: "display: flex; flex-direction: column; gap: 8px;" });
      for (const e of accepted) acceptedHost.appendChild(historyEntry(e));
      list.appendChild(acceptedHost);
    }
  }

  // Cleanup (Russell's pass): "batch batch_msqs27sp_ss9e6r or whatever... I
  // can't understand" -- grain.mjs's own renderHeadline embeds the raw
  // batch id ("Batch <id>: N regions, M mutations...") for the MCP/
  // conversational surface; the history rail must never use that text as
  // its title. historyTitle picks the first legible thing: the typed
  // event's own promptSummary, else "N queued threads resolved" (only
  // meaningful for a seed-mode batch with real seeds and no prompt), else a
  // plain scope label -- the batch id is demoted to a small mono sub-line +
  // native tooltip (title attribute) on the row itself.
  function historyTitle(e) {
    if (e.promptSummary) return e.promptSummary;
    const seedCount = e.scope && e.scope.mode === "seed" && Array.isArray(e.scope.seeds) ? e.scope.seeds.length : 0;
    if (seedCount > 0) return `${seedCount} queued thread${seedCount === 1 ? "" : "s"} resolved`;
    return scopeLabel(e.scope);
  }
  function scopeLabel(scope) {
    const mode = scope && scope.mode;
    if (mode === "seed") return "Queued-intents pass";
    if (mode === "branches") return "Branch pass";
    if (mode === "ambient") return "Whole-world pass";
    return "Batch";
  }
  function historyEntry(e) {
    const spanLabel = e.span ? (SPANS.find((s) => s.id === (e.span.spanId || e.span))?.head || spanText(e.span)) : null;
    const applied = e.acceptedCount ?? 0;
    const pendingN = e.pendingCount ?? 0;
    const metaBits = [`${applied} accepted`, `${pendingN} pending`];
    if (e.fortuneAtRun) metaBits.push(e.fortuneAtRun);
    if (spanLabel) metaBits.push(spanLabel);
    const entry = el("div", {
      testid: "chronicle-history-entry",
      "data-batch-id": e.batchRef,
      title: e.batchRef,
      style: "padding: 10px 11px; border: 1px solid oklch(0.89 0.010 80); border-radius: 4px; background: oklch(0.975 0.006 85); cursor: pointer;"
    }, [
      el("div", { style: "font-family: Spectral, serif; font-size: 14.5px; line-height: 1.35;", text: historyTitle(e) }),
      el("div", { style: "font-size: 11.5px; color: oklch(0.55 0.012 70); margin-top: 4px;", text: metaBits.join(" · ") }),
      el("div", { testid: "chronicle-history-batch-id", style: "font-family: 'IBM Plex Mono', monospace; font-size: 8.5px; color: oklch(0.74 0.010 80); margin-top: 4px;", text: e.batchRef })
    ]);
    entry.addEventListener("click", () => { location.hash = `#chronicle/batch/${encodeURIComponent(e.batchRef)}`; });
    return entry;
  }

  // ---- proposals ("What changed") ---------------------------------------
  function paintProposals() {
    proposalsWrap.innerHTML = "";
    if (!state.proposals.length) { proposalsWrap.style.display = "none"; return; }
    proposalsWrap.style.display = "block";
    proposalsWrap.style.marginTop = "30px";

    proposalsWrap.appendChild(el("div", { style: "display: flex; align-items: baseline; gap: 11px; margin-bottom: 4px;" }, [
      el("div", { style: "font-family: Spectral, serif; font-size: 21px; font-weight: 500;", text: "What changed" }),
      el("div", { style: "font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: oklch(0.58 0.012 70);", text: `${state.proposals.length} proposed` })
    ]));
    proposalsWrap.appendChild(el("div", { style: "font-size: 12.5px; color: oklch(0.52 0.014 65); margin-bottom: 16px;", text: "Nothing is written until you accept. The old values stay in the chronicle either way." }));

    const container = el("div", { testid: "chronicle-proposals", style: "display: flex; flex-direction: column; gap: 9px;" });
    proposalsWrap.appendChild(container);

    const opts = { world: currentWorld(), batchId: state.batchId, onDecided: () => refreshHistoryAfterDecision() };
    if (state.reviewMode === "triage") {
      for (const bucket of RISK_BUCKETS) {
        const items = state.proposals.filter((p) => (p.risk || "safe") === bucket.id);
        if (!items.length) continue;
        const group = el("div", { testid: "chronicle-triage-bucket", "data-bucket": bucket.id, style: `border: 1px solid ${bucket.border}; border-radius: 5px; background: ${bucket.bg}; overflow: hidden;` });
        const cardsHost = el("div", { style: "display: flex; flex-direction: column; gap: 8px; padding: 0 13px 13px 34px;" });
        const header = el("div", { style: "display: flex; align-items: center; gap: 10px; padding: 11px 13px; cursor: pointer;" }, [
          el("span", { text: bucket.glyph, style: `font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: ${bucket.accent};` }),
          el("span", { text: bucket.label, style: `font-size: 13.5px; font-weight: 500; color: ${bucket.titleColor};` }),
          el("span", { text: `${items.length} change${items.length === 1 ? "" : "s"}`, style: `font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: ${bucket.accent};` }),
          el("span", { style: "flex: 1; min-width: 0; font-size: 12px; color: oklch(0.52 0.014 65); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;", text: bucket.blurb })
        ]);
        let open = true;
        header.addEventListener("click", () => { open = !open; cardsHost.style.display = open ? "flex" : "none"; });
        for (const p of items) cardsHost.appendChild(renderProposalCard(p, opts));
        group.append(header, cardsHost);
        container.appendChild(group);
      }
    } else {
      for (const p of state.proposals) container.appendChild(renderProposalCard(p, opts));
    }
  }

  async function refreshHistoryAfterDecision() {
    try {
      const fresh = await api(`/api/chronicle/log${withWorld()}`);
      if (historyListHost) fillHistory(historyListHost, fresh);
    } catch { /* leave history as-is */ }
  }

  // ---- run --------------------------------------------------------------
  async function runAdvance() {
    if (state.running) return;
    state.running = true;
    spinner.style.display = "block";
    const carriedCount = state.scopeKind === "queued-intents" ? state.carried.size : 0;
    spinner.querySelector('[data-testid="chronicle-run-spinner-text"]').textContent =
      `Reading ${state.scopeKind === "queued-intents" ? carriedCount + " intents" : "the world"} into one mutation pass…`;
    proposalsWrap.style.display = "none";

    const payload = {
      scopeKind: state.scopeKind,
      span: { spanId: state.spanId },
      prompt: promptValue() || undefined,
      tags: [...state.tags]
    };
    if (state.scopeKind === "queued-intents") payload.carriedEntryIds = [...state.carried];
    if (state.scopeKind === "branches") payload.branchIds = state.branchIds;

    try {
      const run = await apiPost("/api/chronicle/run", payload);
      state.batchId = run.batchId;
      // Fetch the freshly-created batch detail -> its region entities (which now
      // carry type/risk) feed the SHARED proposal-card.
      const detail = await api(`/api/batches/${encodeURIComponent(run.batchId)}${withWorld()}`);
      state.proposals = (detail.regions || []).flatMap((r) => r.entities || []);
      // World clock advanced -> refresh the sub-bar line from the run's own clock.
      if (run.clock) worldClockLine.textContent = formatWorldClock({ ...clock, currentDate: run.clock.currentDate, sessionNumber: run.clock.sessionNumber });
      paintProposals();
      const fresh = await api(`/api/chronicle/log${withWorld()}`);
      if (historyListHost) fillHistory(historyListHost, fresh);
    } catch (err) {
      console.error("chronicle run failed:", err);
      spinner.querySelector('[data-testid="chronicle-run-spinner-text"]').textContent = `The pass could not complete: ${err.message}`;
      state.running = false;
      return;
    }
    spinner.style.display = "none";
    state.running = false;
  }

  // ---- batch deep-link (retired #review/<batchId>'s new home) -----------
  // Fetch a specific batch's detail and render its region entities through
  // the SAME shared proposal-card pipeline a composed run produces -- no
  // second review surface. Used by the `#chronicle/batch/<id>` route.
  async function loadBatchDetail(batchId) {
    try {
      const detail = await api(`/api/batches/${encodeURIComponent(batchId)}${withWorld()}`);
      state.batchId = batchId;
      state.proposals = (detail.regions || []).flatMap((r) => r.entities || []);
      paintProposals();
      proposalsWrap.scrollIntoView?.({ behavior: "smooth", block: "start" });
    } catch (err) {
      console.error("chronicle batch deep-link failed:", err);
    }
  }

  // ---- mode switching ---------------------------------------------------
  function setAdvMode(mode) { state.advMode = mode; paintAdvToggle(); paintAdvMode(); }
  function paintAdvMode() {
    // Reset the repaint registries -- the outgoing mode's chip elements are
    // about to be discarded from the DOM, so nothing must keep pointing at them.
    spanChipEls.length = 0;
    fortuneStopEls.length = 0;
    scopeChipEls.length = 0;
    tagChipEls.length = 0;
    fortuneBlurbEls.length = 0;
    spanHeadlineEls.length = 0;
    modeHost.innerHTML = "";
    modeHost.appendChild(state.advMode === "timeline" ? buildTimeline() : buildComposer());
    const label = runRow.querySelector('[data-testid="chronicle-run-btn-label"]');
    if (label) label.textContent = state.advMode === "timeline" ? "Advance " + spanHead().toLowerCase() : "Let time pass";
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
/** Chronicle's own hash-arg vocabulary (app.js passes `arg` = the hash's rest). */
function parseChronicleArg(arg) {
  if (!arg) return { kind: "default" };
  if (arg === "compose") return { kind: "compose" };
  if (arg.startsWith("batch/")) return { kind: "batch", batchId: arg.slice("batch/".length) };
  return { kind: "default" };
}
function formatWorldClock(clock) {
  if (!clock) return "";
  const cal = clock.calendar ? `${clock.calendar} · ` : "";
  const sess = clock.sessionNumber != null ? ` · session ${clock.sessionNumber}` : "";
  return `${cal}${clock.currentDate || "Day 0"}${sess}`;
}
function fortuneBlurb(stopId) {
  return (FORTUNES.find((f) => f.id === stopId) || FORTUNES[2]).blurb;
}
function spanText(span) {
  if (!span) return "—";
  if (span.days) return `${span.days} days`;
  return String(span.spanId || span);
}
function segWrapStyle() {
  return "display: flex; gap: 3px; padding: 2px; border: 1px solid oklch(0.86 0.010 80); border-radius: 6px; background: oklch(0.965 0.006 85);";
}
function chipStyle(on) {
  return on
    ? "padding: 5px 11px; border: 1px solid oklch(0.72 0.055 185); border-radius: 20px; cursor: pointer; font-size: 12px; background: oklch(0.90 0.030 185); color: oklch(0.33 0.060 185);"
    : "padding: 5px 11px; border: 1px solid oklch(0.86 0.010 80); border-radius: 20px; cursor: pointer; font-size: 12px; background: oklch(0.975 0.006 85); color: oklch(0.50 0.014 65);";
}
function intentRowStyle(carried, accent) {
  return `padding: 9px 10px; border: 1px solid ${carried ? "oklch(0.88 0.010 80)" : "oklch(0.90 0.008 80)"}; border-left: 2px solid ${carried ? accent : "oklch(0.82 0.010 80)"}; border-radius: 4px; background: ${carried ? "oklch(0.985 0.005 85)" : "oklch(0.945 0.006 85)"}; cursor: pointer;`;
}
function fortuneStopStyle(on, hue) {
  return `flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 8px 4px 9px; border-radius: 4px; cursor: pointer; background: ${on ? `oklch(0.90 0.055 ${hue})` : "transparent"};`;
}
