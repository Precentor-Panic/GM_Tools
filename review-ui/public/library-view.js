// GM Review — Phase 35 task 35.2: the Library surface, ported from
// `design/session-planner/Library.dc.html` (the pixel/DOM authority). Replaces
// Phase 34's generic `renderScaffoldSurface("library")` placeholder with the
// real four-tab Library: Bestiary (habitat tree + creature cards + full stat
// rail + rating stepper + source pills + GM note), Hero's Hall (Cards / Side by
// side, one-click always-visible conditions, resources, ✦ expertise markers),
// and Reliquary + Stagecraft through ONE shared tagged-shelf renderer. The
// shared scene tray (scene-tray.js) mounts in every tab's rail.
//
// Real backend data replaces the prototype's seed arrays; every mutation is a
// thin fetch() to the §8 routes 35.1 already built (front-ends are thin
// wrappers — gm-tools-conventions). Two prototype affordances shipped as
// STUBS in Phase 35 (flagged in their own on-screen copy, since no bestiary
// entry could carry a graph-write path yet) are wired for real as of Phase
// 37.6b: the reskin-suggester ("Wear it as something else", a real LLM call
// via combat-planning/reskin-suggest.mjs) and "Promote to a named world
// figure" (bestiary-store.mjs's promoteBestiaryEntryToGraph, mirroring the
// Reliquary's own item-promote affordance).
//
// Faithful-port notes / deliberate deviations from the prototype markup:
//  - The scene tray is mounted in a CONSISTENT rail on all four tabs (the
//    prototype varied its position: bestiary/​shelf left rail, hall right rail).
//    The contract requires "the SAME DOM subtree/testids regardless of which
//    tab is active", so one placement convention wins over the prototype's
//    per-tab variation. testids/behaviour are identical to the prototype's.
//  - Bestiary rawFields from a Foundry pull carry no ability-score block, so
//    the stat rail's 6-ability grid is omitted for pulled creatures (the
//    prototype's seed data had it); defenses + action sections render from the
//    real rawFields (ac/hp/cr/attacks/multiattack/legendary/recharge).
//  - Hero "resources" pips in the prototype were seed-only (spell slots, rages);
//    real pulled members carry no resource tracker, so that block shows the
//    member's real combat readouts (attack bonus, saves, notable feats) instead.
"use strict";
import { mountSceneTray, setTrayDragPayload } from "./scene-tray.js";
// "Aureus to the Table" task G6 -- the Reliquary's own "Available via
// Plutonium" shelf reuses the shell's ONE shared toast (app-shell.js/
// world-view.js/session-planner-view.js's own precedent), rather than the
// Bestiary shelf's older inline-button-text-only feedback convention.
import { showUndoToast } from "./plans-view.js";

// ---------------------------------------------------------------------------
// Palette / kind tables — copied from Library.dc.html's own SOURCES/KINDS.
// ---------------------------------------------------------------------------
const TEAL = "oklch(0.55 0.075 185)";
const SOURCE_PILL = {
  srd: { label: "5e SRD", bg: "oklch(0.90 0.030 185)", fg: "oklch(0.36 0.060 185)" },
  foundry: { label: "Foundry world", bg: "oklch(0.90 0.035 260)", fg: "oklch(0.36 0.07 260)" },
  mine: { label: "Mine", bg: "oklch(0.90 0.045 65)", fg: "oklch(0.38 0.09 65)" },
  // Phase 37.6b -- "Wear it as something else." Colors verbatim from
  // Library.dc.html's own RESKIN-tier `sourceChips` seed (the pixel
  // authority's pre-existing "reskin" pill, line 611) -- matched, not
  // invented, same as every other SOURCE_PILL entry here.
  reskin: { label: "Reskinned", bg: "oklch(0.90 0.045 300)", fg: "oklch(0.36 0.08 300)" },
  // Friction Wave 1 W4b/W4c -- the Plutonium source layer's own DISTINCT
  // pill (rust, a hue no other pill uses): on the read-only "Available via
  // Plutonium" shelf rows, and (via deriveSourcePill's new branch) on
  // curated entries added FROM that shelf.
  plutonium: { label: "Plutonium", bg: "oklch(0.92 0.045 25)", fg: "oklch(0.40 0.10 25)" }
};
const KINDS = {
  item: { label: "Item", glyph: "◈", accent: "oklch(0.55 0.075 185)" },
  map: { label: "Map", glyph: "▦", accent: "oklch(0.50 0.09 145)" },
  splash: { label: "Splash", glyph: "◐", accent: "oklch(0.58 0.10 65)" },
  music: { label: "Music", glyph: "♪", accent: "oklch(0.52 0.09 300)" }
};
const CR_LADDER = ["0", "1/8", "1/4", "1/2", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "30"];
function bumpCr(value, dir) {
  const key = crKey(value);
  const i = CR_LADDER.indexOf(String(key));
  if (i < 0) return String(key);
  return CR_LADDER[Math.min(CR_LADDER.length - 1, Math.max(0, i + dir))];
}
function crKey(v) {
  if (v === 0.125) return "1/8";
  if (v === 0.25) return "1/4";
  if (v === 0.5) return "1/2";
  return String(v);
}

const SKILL_LABELS = {
  acr: "Acrobatics", ani: "Animal Handling", arc: "Arcana", ath: "Athletics", dec: "Deception",
  his: "History", ins: "Insight", itm: "Intimidation", inv: "Investigation", med: "Medicine",
  nat: "Nature", prc: "Perception", prf: "Performance", per: "Persuasion", rel: "Religion",
  slt: "Sleight of Hand", ste: "Stealth", sur: "Survival"
};

// Phase 37.6 task 1 ✦-HONESTY COMMENT CONVENTION: the Bestiary tab's glyph
// below is DECORATIVE-ONLY (one icon of a plain four-icon nav set, ✦/◉/◈/▦ --
// no AI/LLM meaning at all, just this tab's chosen icon). Flagged explicitly
// so a grep for "✦" across review-ui/public doesn't mistake it for an
// unwired AI affordance -- the post-wave invariant is every ✦ that reads as
// an AI indicator reaches a real LLM route; a glyph reused as plain iconography
// is out of scope for that invariant by design, not an oversight.
const TABS = [
  { id: "bestiary", label: "Bestiary", glyph: "✦" },
  { id: "hall", label: "Hero's Hall", glyph: "◉" },
  { id: "reliquary", label: "Reliquary", glyph: "◈" },
  { id: "stagecraft", label: "Stagecraft", glyph: "▦" },
  // Rules oracle (Aureus table wave B4/G11). The ✦-honesty convention holds:
  // the ASK panel inside this tab reaches a real LLM route; the tab glyph
  // itself is plain iconography (§ = the statute mark).
  { id: "rules", label: "Rules", glyph: "§" }
];

// ---------------------------------------------------------------------------
// DOM + fetch helpers (standalone, same convention as app-shell.js).
// ---------------------------------------------------------------------------
function el(tag, { style, testid, text, html, ...attrs } = {}, children = []) {
  const node = document.createElement(tag);
  if (style) node.setAttribute("style", style);
  if (testid) node.setAttribute("data-testid", testid);
  if (text != null) node.textContent = text;
  if (html != null) node.innerHTML = html;
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.appendChild(c);
  return node;
}
function currentWorld() { return localStorage.getItem("gmReview.world") || null; }
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
function setMain(node) {
  const main = document.getElementById("shell-main");
  if (!main) return;
  main.innerHTML = "";
  main.appendChild(node);
}
function sourcePill(pill, testid) {
  const s = SOURCE_PILL[pill] || SOURCE_PILL.mine;
  return el("span", {
    testid,
    text: s.label,
    style: `padding: 1px 6px; border-radius: 20px; background: ${s.bg}; font-family: 'IBM Plex Mono', monospace; font-size: 8.5px; letter-spacing: 0.05em; text-transform: uppercase; color: ${s.fg};`
  });
}

// A scene tray rail column, mounted identically on every tab.
function trayRail(world, width) {
  const rail = el("div", {
    style: `width: ${width}px; flex: none; border-left: 1px solid oklch(0.87 0.010 80); background: oklch(0.938 0.009 85); display: flex; flex-direction: column; min-height: 0; justify-content: flex-end;`
  });
  const host = el("div", {});
  rail.appendChild(host);
  mountSceneTray(host, { world });
  return rail;
}

// ---------------------------------------------------------------------------
// Entry point. `arg` is the tab hash segment (undefined/"" => bestiary).
// Called by app-shell.js's renderShell for the #library surface.
// ---------------------------------------------------------------------------
const NORMALIZE = { bestiary: "bestiary", hall: "hall", reliquary: "reliquary", stagecraft: "stagecraft", rules: "rules" };
let renderToken = 0;
let activeTab = "bestiary";

export async function renderLibrarySurface(arg) {
  const tab = NORMALIZE[arg] || "bestiary";
  activeTab = tab;
  const world = currentWorld();
  const token = ++renderToken;

  // Skeleton first so `library-surface-root` is present immediately (the
  // Phase-34 deep-link e2e waits on it); real counts/body fill after fetch.
  const root = el("div", {
    testid: "library-surface-root",
    style: "display: flex; flex-direction: column; flex: 1; min-height: 0; background: oklch(0.955 0.008 85); color: oklch(0.27 0.015 60); font-size: 14px;"
  });
  const subbar = el("div", {
    style: "display: flex; align-items: center; gap: 12px; padding: 0 16px; height: 42px; flex: none; border-bottom: 1px solid oklch(0.88 0.010 80); background: oklch(0.945 0.009 85);"
  });
  const bodyRow = el("div", { style: "display: flex; flex: 1; min-height: 0;" });
  root.append(subbar, bodyRow);
  setMain(root);

  // Fetch everything the tab bar + body need.
  const data = await fetchLibraryData(world);
  if (token !== renderToken) return; // a newer render superseded this one

  const counts = {
    bestiary: data.bestiary.filter((e) => e.status !== "discarded").length,
    hall: data.party.filter((m) => m.status !== "discarded").length,
    reliquary: data.items.filter((i) => i.status !== "discarded").length,
    stagecraft: data.stagecraft.filter((a) => a.status !== "discarded").length,
    rules: "§" // not a shelf — no count; the glyph repeats as a quiet non-number
  };

  // Tab bar (left) + per-tab filter controls (right).
  const tabsWrap = el("div", { style: "display: flex; gap: 3px; padding: 2px; border: 1px solid oklch(0.86 0.010 80); border-radius: 6px; background: oklch(0.965 0.006 85);" });
  const tabsRoot = el("div", { testid: "library-tabs", style: "display: contents;" });
  for (const t of TABS) {
    const active = t.id === tab;
    const btn = el("div", {
      testid: "library-tab",
      "data-tab": t.id,
      "data-active": String(active),
      style: `display: flex; align-items: center; gap: 7px; padding: 4px 12px; border-radius: 4px; font-size: 12.5px; cursor: pointer; background: ${active ? TEAL : "transparent"}; color: ${active ? "oklch(0.99 0.005 185)" : "oklch(0.48 0.014 65)"};`
    }, [
      el("span", { text: t.glyph, style: "font-family: 'IBM Plex Mono', monospace; font-size: 10px;" }),
      el("span", { text: t.label }),
      el("span", { testid: "library-tab-count", text: String(counts[t.id]), style: "font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; opacity: 0.75;" })
    ]);
    btn.addEventListener("click", () => { location.hash = t.id === "bestiary" ? "#library" : `#library/${t.id}`; });
    tabsRoot.appendChild(btn);
  }
  tabsWrap.appendChild(tabsRoot);
  subbar.appendChild(tabsWrap);
  subbar.appendChild(el("div", { style: "flex: 1;" }));

  const ctx = { world, data, subbar, bodyRow };
  if (tab === "bestiary") buildBestiary(ctx);
  else if (tab === "hall") buildHall(ctx);
  else if (tab === "rules") buildRulesTab(ctx);
  else buildShelf(ctx, tab);
}

// ---------------------------------------------------------------------------
// Rules oracle tab (Aureus table wave B4/G11): free deterministic search over
// the structured 5etools rules families + the GM's own page-marked
// rules-library (cited, snippet-capped), and the GM-ONLY "Ask a ruling"
// panel — ONE LLM call composing a cited ruling strictly from the retrieved
// excerpts, with "Post ruling to table" pushing it into live Foundry chat
// (public, per adjudication). No player-facing surface exists on purpose.
// ---------------------------------------------------------------------------
function buildRulesTab(ctx) {
  const { bodyRow } = ctx;
  const col = el("div", { style: "display: flex; flex-direction: column; gap: 14px; flex: 1; min-width: 0; padding: 14px; overflow-y: auto;" });
  bodyRow.appendChild(col);

  const citeOf = (m) => {
    const label = m.family ? m.source : m.label;
    return m.page != null ? `(${label} p.${m.page})` : `(${label})`;
  };
  const citePill = (m) => el("span", {
    text: citeOf(m),
    style: "font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: .04em; border: 1px solid oklch(0.80 0.040 185); border-radius: 999px; padding: 1px 8px; color: oklch(0.38 0.060 185); background: oklch(0.965 0.014 185); white-space: nowrap;"
  });

  // ── free search ──────────────────────────────────────────────────────────
  const searchRow = el("div", { style: "display: flex; gap: 8px; align-items: center; flex-wrap: wrap;" });
  const input = el("input", { testid: "rules-search-input", placeholder: "Search the rules… (all terms must match)", style: "flex: 1; min-width: 220px; padding: 7px 10px; border: 1px solid oklch(0.86 0.010 80); border-radius: 5px; font-size: 13px;" });
  const familySel = el("select", { testid: "rules-family-filter", style: "padding: 6px 8px; border: 1px solid oklch(0.86 0.010 80); border-radius: 5px; font-size: 12px;" });
  for (const [v, t] of [["", "all families"], ["variantrules", "variant rules"], ["actions", "actions"], ["conditionsdiseases", "conditions"], ["skills", "skills"], ["senses", "senses"], ["tables", "tables"]]) {
    familySel.appendChild(el("option", { value: v, text: t }));
  }
  const bookInput = el("input", { testid: "rules-book-filter", placeholder: "book (e.g. phb)", style: "width: 110px; padding: 7px 10px; border: 1px solid oklch(0.86 0.010 80); border-radius: 5px; font-size: 12px;" });
  const searchBtn = el("div", { testid: "rules-search-btn", text: "Search", style: "padding: 7px 14px; border-radius: 5px; cursor: pointer; background: oklch(0.50 0.075 185); color: oklch(0.99 0.005 185); font-size: 12.5px;" });
  searchRow.append(input, familySel, bookInput, searchBtn);
  col.appendChild(searchRow);

  const resultsHost = el("div", { testid: "rules-results", style: "display: flex; flex-direction: column; gap: 8px;" });
  col.appendChild(resultsHost);

  async function runSearch() {
    const query = input.value.trim();
    if (!query) return;
    resultsHost.textContent = "Searching…";
    try {
      const p = new URLSearchParams({ query });
      if (familySel.value) p.set("family", familySel.value);
      if (bookInput.value.trim()) p.set("book", bookInput.value.trim());
      const r = await api(`/api/rules?${p}`);
      resultsHost.innerHTML = "";
      const cards = [];
      for (const m of r.structured.matches) {
        cards.push(el("div", { testid: "rules-result", style: "border: 1px solid oklch(0.86 0.010 80); border-left: 3px solid oklch(0.50 0.075 185); border-radius: 5px; padding: 9px 12px; background: oklch(0.985 0.005 85);" }, [
          el("div", { style: "display: flex; gap: 8px; align-items: center; margin-bottom: 4px;" }, [
            el("strong", { text: m.name, style: "font-size: 13px;" }), citePill(m),
            ...(m.ruleType ? [el("span", { text: m.ruleType, style: "font-size: 10px; color: oklch(0.48 0.014 65);" })] : [])
          ]),
          el("div", { text: m.text, style: "font-size: 12.5px; line-height: 1.5; white-space: pre-wrap;" })
        ]));
      }
      for (const m of r.books.matches) {
        cards.push(el("div", { testid: "rules-result", style: "border: 1px solid oklch(0.86 0.010 80); border-left: 3px solid oklch(0.62 0.10 65); border-radius: 5px; padding: 9px 12px; background: oklch(0.985 0.005 85);" }, [
          el("div", { style: "margin-bottom: 4px;" }, [citePill(m)]),
          el("div", { text: `…${m.snippet}…`, style: "font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; font-style: italic;" })
        ]));
      }
      if (!cards.length) {
        const notes = [];
        if (!r.structured.installed) notes.push("Plutonium data not found on this machine");
        if (!r.books.installed) notes.push("the rules-library shelf is not on this machine");
        resultsHost.appendChild(el("div", { text: notes.length ? `No matches — and ${notes.join("; ")}.` : "No matches. Snippets need EVERY term — try fewer, more specific words.", style: "font-size: 12.5px; color: oklch(0.48 0.014 65);" }));
      } else {
        for (const c of cards) resultsHost.appendChild(c);
        resultsHost.appendChild(el("div", { text: "Page numbers are PDF pages (the rules-lookup convention); snippets are deliberately capped — open the cited PDF page for full tables.", style: "font-size: 11px; color: oklch(0.55 0.012 70);" }));
      }
    } catch (err) {
      resultsHost.textContent = `Search failed: ${err.message}`;
    }
  }
  searchBtn.addEventListener("click", runSearch);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });

  // ── ask a ruling (GM-only; ✦ = a real LLM call) ─────────────────────────
  col.appendChild(el("div", { style: "border-top: 1px dashed oklch(0.80 0.010 80); margin: 4px 0;" }));
  const askHead = el("div", { text: "✦ Ask a ruling (GM-only — one model call over the retrieved excerpts; the ruling can be posted publicly to Foundry chat)", style: "font-size: 12px; font-weight: 600; color: oklch(0.48 0.014 65);" });
  const askRow = el("div", { style: "display: flex; gap: 8px; align-items: center;" });
  const askInput = el("input", { testid: "rules-ask-input", placeholder: "e.g. Does grappling reduce my speed when I drag the target?", style: "flex: 1; padding: 7px 10px; border: 1px solid oklch(0.86 0.010 80); border-radius: 5px; font-size: 13px;" });
  const askBtn = el("div", { testid: "rules-ask-btn", text: "✦ Ask", style: "padding: 7px 14px; border-radius: 5px; cursor: pointer; background: oklch(0.55 0.11 40); color: oklch(0.99 0.005 40); font-size: 12.5px;" });
  askRow.append(askInput, askBtn);
  const answerHost = el("div", { testid: "rules-answer-host", style: "display: none; flex-direction: column; gap: 8px;" });
  col.append(askHead, askRow, answerHost);

  let lastAsk = null;
  askBtn.addEventListener("click", async () => {
    const question = askInput.value.trim();
    if (!question) return;
    askBtn.textContent = "Consulting the library…";
    answerHost.style.display = "none";
    try {
      const r = await api(`/api/rules/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }) });
      answerHost.innerHTML = "";
      answerHost.style.display = "flex";
      if (r.noSources) {
        answerHost.appendChild(el("div", { testid: "rules-answer-none", text: "Not found in the library — no excerpt matched the question's terms. Try the search above with different words.", style: "font-size: 12.5px; color: oklch(0.48 0.014 65);" }));
      } else {
        lastAsk = { question, answer: r.answer };
        answerHost.appendChild(el("div", { testid: "rules-answer", text: r.answer, style: "border: 1px solid oklch(0.80 0.06 40); border-radius: 5px; padding: 11px 14px; background: oklch(0.975 0.012 60); font-size: 13px; line-height: 1.55; white-space: pre-wrap;" }));
        const cites = [...r.hits.structured.matches, ...r.hits.books.matches];
        answerHost.appendChild(el("div", { style: "display: flex; gap: 6px; flex-wrap: wrap;" }, cites.map(citePill)));
        if (r.offline) {
          answerHost.appendChild(el("div", { text: "Offline — no API key configured; the citations above are the retrieval hits.", style: "font-size: 11px; color: oklch(0.55 0.012 70);" }));
        } else {
          const postBtn = el("div", { testid: "rules-post-ruling-btn", text: "Post ruling to table", style: "align-self: flex-start; padding: 6px 12px; border: 1px solid oklch(0.80 0.040 185); border-radius: 5px; cursor: pointer; background: oklch(0.965 0.014 185); color: oklch(0.38 0.060 185); font-size: 12px;" });
          const postStatus = el("span", { style: "font-size: 11px; color: oklch(0.55 0.012 70); margin-left: 8px;" });
          postBtn.addEventListener("click", async () => {
            if (!lastAsk) return;
            postBtn.textContent = "Posting… (logs into Foundry, takes a few seconds)";
            try {
              await api(`/api/rules/post-ruling`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(lastAsk) });
              postBtn.textContent = "Posted to Foundry chat.";
            } catch (err) {
              postBtn.textContent = "Post ruling to table";
              postStatus.textContent = `Post failed: ${err.message} (is a Foundry client running?)`;
            }
          });
          answerHost.appendChild(el("div", {}, [postBtn, postStatus]));
        }
      }
    } catch (err) {
      answerHost.style.display = "flex";
      answerHost.textContent = `Ask failed: ${err.message}`;
    } finally {
      askBtn.textContent = "✦ Ask";
    }
  });
}

async function fetchLibraryData(world) {
  const w = world ? encodeURIComponent(world) : "";
  const [bestiary, party, items, stagecraft, graph] = await Promise.all([
    api(`/api/combat-planning/bestiary`).then((r) => r.entries || []).catch(() => []),
    world ? api(`/api/combat-planning/party-roster?world=${w}`).then((r) => r.members || []).catch(() => []) : Promise.resolve([]),
    world ? api(`/api/combat-planning/items?world=${w}`).then((r) => r.items || []).catch(() => []) : Promise.resolve([]),
    world ? api(`/api/session-planner/stagecraft?world=${w}`).then((r) => r.assets || []).catch(() => []) : Promise.resolve([]),
    world ? api(`/api/graph?world=${w}&filter=all`).then((r) => r.nodes || []).catch(() => []) : Promise.resolve([])
  ]);
  return { bestiary, party, items, stagecraft, places: graph.filter((n) => n.type === "place") };
}

async function doPull() {
  const world = currentWorld();
  if (!world) return;
  try { await api(`/api/foundry/pull-actors`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ world }) }); }
  catch { /* no index / offline — leave the library as-is */ }
  renderLibrarySurface(activeTab);
}

// The "↧ Pull … from Foundry" affordance — identical across all three tabs
// that offer it, wired to the one real sync-IN action (POST pull-actors).
function pullButton(label) {
  const b = el("div", {
    style: "display: inline-flex; align-items: center; gap: 8px; padding: 8px 13px; border: 1px solid oklch(0.80 0.040 185); border-radius: 5px; cursor: pointer; background: oklch(0.965 0.014 185); color: oklch(0.38 0.060 185); font-size: 12.5px;"
  }, [
    el("span", { text: "↧", style: "font-family: 'IBM Plex Mono', monospace; font-size: 10px;" }),
    el("span", { text: label })
  ]);
  b.addEventListener("click", doPull);
  return b;
}

// QA W2 fix (Group D #19): a shared, quiet inline "write one by hand" form --
// a toggle link that reveals a minimal labeled-input panel -- used by all
// four Library tabs (Bestiary/Hero's Hall/Reliquary/Stagecraft), each with
// its own field list and submit handler. No modal, no redesign: matches the
// shelf idiom's existing "or write one by hand" text (now a real
// affordance) sitting beside pullButton's own inline-panel precedent above.
function buildHandAddForm({ fields, onSubmit, toggleLabel = "or write one by hand", rootTestid }) {
  const wrap = el("div", { testid: rootTestid, style: "display: flex; flex-direction: column; align-items: flex-start;" });
  const toggle = el("span", {
    testid: "library-hand-add-toggle",
    text: toggleLabel,
    style: "font-size: 12px; color: oklch(0.44 0.070 185); cursor: pointer; text-decoration: underline dotted; text-underline-offset: 3px;"
  });
  const panelHost = el("div", {});
  wrap.append(toggle, panelHost);

  let open = false;
  toggle.addEventListener("click", () => {
    open = !open;
    panelHost.innerHTML = "";
    if (open) panelHost.appendChild(buildPanel());
  });

  function buildPanel() {
    const panel = el("div", {
      testid: "library-hand-add-form",
      style: "display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px; margin-top: 10px; padding: 12px 14px; border: 1px solid oklch(0.80 0.040 185); border-radius: 5px; background: oklch(0.965 0.014 185); max-width: 640px;"
    });
    const inputs = {};
    for (const f of fields) {
      const box = el("div", { style: "display: flex; flex-direction: column; gap: 3px;" });
      box.appendChild(el("label", {
        text: f.label,
        style: "font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: 0.05em; text-transform: uppercase; color: oklch(0.53 0.012 70);"
      }));
      let input;
      const boxStyle = `padding: 5px 7px; border: 1px solid oklch(0.84 0.010 80); border-radius: 4px; font: inherit; font-size: 12px; background: oklch(1 0 0); color: inherit; width: ${f.width || "120px"};`;
      if (f.type === "select") {
        input = el("select", { testid: `library-hand-add-${f.key}`, style: boxStyle });
        for (const opt of f.options) input.appendChild(el("option", { value: opt.value, text: opt.label }));
      } else {
        input = el("input", { testid: `library-hand-add-${f.key}`, type: f.type || "text", placeholder: f.placeholder || "", style: boxStyle });
      }
      inputs[f.key] = input;
      box.appendChild(input);
      panel.appendChild(box);
    }
    const submitBtn = el("button", {
      type: "button", testid: "library-hand-add-submit-btn", text: "Add",
      style: "padding: 6px 14px; border: none; border-radius: 4px; cursor: pointer; font: inherit; font-size: 12px; background: oklch(0.55 0.075 185); color: oklch(0.99 0.005 185);"
    });
    const status = el("div", { testid: "library-hand-add-status", style: "font-size: 11.5px; color: oklch(0.55 0.012 70); min-height: 14px; flex-basis: 100%;" });
    submitBtn.addEventListener("click", async () => {
      const values = {};
      for (const k in inputs) values[k] = inputs[k].value;
      if (!String(values.name || "").trim()) { status.textContent = "Name is required."; return; }
      submitBtn.disabled = true;
      status.textContent = "Adding…";
      try {
        await onSubmit(values);
        status.textContent = "";
        open = false;
        panelHost.innerHTML = "";
      } catch (err) {
        status.textContent = `Could not add: ${err.message}`;
        submitBtn.disabled = false;
      }
    });
    panel.append(submitBtn, status);
    return panel;
  }
  return wrap;
}

// ===========================================================================
// BESTIARY
// ===========================================================================
function buildBestiary(ctx) {
  const { world, data, subbar, bodyRow } = ctx;
  const st = {
    entries: data.bestiary.filter((e) => e.status !== "discarded"),
    places: data.places,
    habitat: "all",
    query: "",
    sources: {},
    selId: null
  };

  // --- filter controls (right side of the sub-bar) ---
  const controls = el("div", { style: "display: flex; align-items: center; gap: 10px;" });
  const search = el("input", {
    placeholder: "Find a creature…",
    style: "width: 220px; padding: 5px 10px; border: 1px solid oklch(0.84 0.010 80); border-radius: 6px; font-family: inherit; font-size: 12.5px; background: oklch(1 0 0); color: inherit;"
  });
  search.addEventListener("input", () => { st.query = search.value; paintGrid(); });
  const chips = el("div", { style: "display: flex; gap: 5px;" });
  for (const id of ["srd", "foundry", "mine", "reskin"]) {
    const chip = el("div", {
      text: SOURCE_PILL[id].label,
      style: "padding: 4px 10px; border: 1px solid oklch(0.86 0.010 80); border-radius: 20px; cursor: pointer; font-size: 11.5px; background: oklch(0.975 0.006 85); color: oklch(0.50 0.014 65);"
    });
    chip.addEventListener("click", () => {
      st.sources[id] = !st.sources[id];
      const on = st.sources[id];
      chip.setAttribute("style", `padding: 4px 10px; border: 1px solid ${on ? "oklch(0.72 0.055 185)" : "oklch(0.86 0.010 80)"}; border-radius: 20px; cursor: pointer; font-size: 11.5px; background: ${on ? "oklch(0.90 0.030 185)" : "oklch(0.975 0.006 85)"}; color: ${on ? "oklch(0.33 0.060 185)" : "oklch(0.50 0.014 65)"};`);
      paintGrid();
    });
    chips.appendChild(chip);
  }
  controls.append(search, chips);
  subbar.appendChild(controls);

  // --- body: habitat rail (296) | creature main | stat rail (396) ---
  const root = el("div", { testid: "library-bestiary-root", style: "display: flex; flex: 1; min-height: 0;" });

  const leftRail = el("div", { style: "width: 296px; flex: none; border-right: 1px solid oklch(0.87 0.010 80); background: oklch(0.938 0.009 85); display: flex; flex-direction: column; min-height: 0;" });
  const habIntro = el("div", { style: "padding: 13px 14px 8px;" }, [
    el("div", { text: "What belongs where", style: "font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: oklch(0.53 0.012 70);" }),
    el("div", { text: "Habitats come from the world graph. A creature can belong to several, or to none and just sit in the catalogue.", style: "font-size: 11.5px; color: oklch(0.56 0.012 70); line-height: 1.45; margin-top: 6px;" })
  ]);
  const habTree = el("div", { testid: "library-habitat-tree", style: "flex: 1; overflow-y: auto; padding: 0 8px 14px; min-height: 0;" });
  const trayHost = el("div", { style: "border-top: 1px solid oklch(0.88 0.010 80); flex: none;" });
  leftRail.append(habIntro, habTree, trayHost);
  mountSceneTray(trayHost, { world });

  const centerCol = el("div", { style: "flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden;" });
  const centerScroll = el("div", { style: "flex: 1; overflow-y: auto; padding: 22px 26px 40px;" });
  const header = el("div", {});
  const grid = el("div", { testid: "library-creature-grid", style: "display: grid; grid-template-columns: repeat(auto-fill, minmax(268px, 1fr)); gap: 10px;" });
  // QA W2 fix (Group D #19): "or write one by hand" used to be a dead label
  // with nothing behind it -- now a real minimal form (name/CR/AC/HP/notes)
  // -> POST .../bestiary/hand-add, lands immediately with the "mine" pill.
  const handAddForm = buildHandAddForm({
    rootTestid: "library-bestiary-hand-add",
    fields: [
      { key: "name", label: "Name", width: "180px" },
      { key: "challengeRating", label: "CR", width: "60px", placeholder: "e.g. 1/2" },
      { key: "ac", label: "AC", width: "56px", type: "number" },
      { key: "hp", label: "HP", width: "56px", type: "number" },
      { key: "notes", label: "Notes", width: "220px" }
    ],
    onSubmit: async (v) => {
      await api("/api/combat-planning/bestiary/hand-add", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: v.name, challengeRating: v.challengeRating || undefined,
          ac: v.ac || undefined, hp: v.hp || undefined, notes: v.notes || undefined
        })
      });
      await renderLibrarySurface("bestiary"); // a NEW catalogue entry now exists -- full reload picks it up
    }
  });
  const importRow = el("div", { style: "display: flex; align-items: center; gap: 12px; margin-top: 16px;" }, [
    pullButton("Import from Foundry compendium"),
    handAddForm
  ]);
  // Friction Wave 1 W4b -- the read-only "Available via Plutonium" shelf,
  // BELOW the curated grid and never mixed into it (a separate source
  // LAYER, the friction note's own hard rule). Self-contained builder; its
  // add-to-shelf action (W4c) refreshes the whole surface so the new
  // curated entry appears above.
  const plutoniumShelf = buildPlutoniumShelf(ctx);
  centerScroll.append(header, grid, importRow, plutoniumShelf);
  centerCol.appendChild(centerScroll);

  const statRail = el("div", { style: "width: 396px; flex: none; border-left: 1px solid oklch(0.87 0.010 80); background: oklch(0.938 0.009 85); display: flex; flex-direction: column; min-height: 0; overflow-y: auto;" });

  root.append(leftRail, centerCol, statRail);
  bodyRow.appendChild(root);

  // --- helpers ---
  // Phase 37.6b wired promote-to-graph (a bestiary entry CAN carry a graph
  // link now, e.graphEntityId), but deriving "which places/habitats" from
  // that link (e.g. walking the promoted node's own containment edges) is
  // NOT this task's scope -- flagged, not built. Habitat placement stays
  // whatever it already was (nothing -- "belongs nowhere yet" is still every
  // entry's real state) until a future pass wires it.
  const habitatsOf = () => [];
  function filtered() {
    const q = st.query.trim().toLowerCase();
    const anySource = Object.keys(st.sources).some((k) => st.sources[k]);
    return st.entries.filter((e) => {
      const habs = habitatsOf(e);
      if (st.habitat === "unplaced" && habs.length > 0) return false;
      if (st.habitat !== "all" && st.habitat !== "unplaced" && habs.indexOf(st.habitat) < 0) return false;
      if (anySource && !st.sources[e.sourcePill]) return false;
      if (q) {
        const name = (e.rawFields?.name || "").toLowerCase();
        if (name.indexOf(q) < 0) return false;
      }
      return true;
    });
  }
  const ratingOf = (e) => (e.rating != null ? e.rating : e.rawFields?.challengeRating);

  function paintHabitatTree() {
    habTree.innerHTML = "";
    const rows = [
      { id: "all", label: "Everything", glyph: "◈", depth: 0 },
      ...st.places.map((p) => ({ id: p.id, label: p.name || p.id, glyph: "▢", depth: 0 })),
      { id: "unplaced", label: "Belongs nowhere yet", glyph: "◌", depth: 0 }
    ];
    for (const h of rows) {
      const active = st.habitat === h.id;
      const count = h.id === "all"
        ? st.entries.length
        : h.id === "unplaced"
          ? st.entries.filter((e) => habitatsOf(e).length === 0).length
          : st.entries.filter((e) => habitatsOf(e).indexOf(h.id) >= 0).length;
      const row = el("div", {
        testid: "library-habitat-row",
        "data-habitat-id": h.id,
        style: `display: flex; align-items: center; gap: 8px; padding: 6px 9px; padding-left: ${9 + h.depth * 16}px; border-radius: 5px; cursor: pointer; background: ${active ? "oklch(0.90 0.020 185)" : "transparent"};`
      }, [
        el("span", { text: h.glyph, style: `font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; color: ${h.id === "unplaced" ? "oklch(0.60 0.03 260)" : TEAL};` }),
        el("span", { text: h.label, style: `flex: 1; min-width: 0; font-size: 12.5px; color: ${active ? "oklch(0.24 0.020 185)" : "oklch(0.40 0.014 65)"}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;` }),
        el("span", { testid: "library-habitat-row-count", text: String(count), style: "font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; color: oklch(0.64 0.012 70);" })
      ]);
      row.addEventListener("click", () => { st.habitat = h.id; paintHabitatTree(); paintHeader(); paintGrid(); });
      habTree.appendChild(row);
    }
  }

  function paintHeader() {
    const rowNames = [{ id: "all", label: "Everything", blurb: "The whole catalogue — everything read out of Foundry, plus what you've written here." }, { id: "unplaced", label: "Belongs nowhere yet", blurb: "Catalogue entries with no habitat. Drag one onto a place to say where it lives." }];
    const place = st.places.find((p) => p.id === st.habitat);
    const meta = rowNames.find((r) => r.id === st.habitat);
    const title = place ? (place.name || place.id) : (meta ? meta.label : "Everything");
    const blurb = place ? "Creatures that live here." : (meta ? meta.blurb : "");
    const n = filtered().length;
    header.innerHTML = "";
    header.append(
      el("div", { style: "display: flex; align-items: baseline; gap: 11px; margin-bottom: 4px;" }, [
        el("div", { text: title, style: "font-family: Spectral, serif; font-size: 25px; font-weight: 500;" }),
        el("div", { text: `${n} ${n === 1 ? "creature" : "creatures"}`, style: "font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: oklch(0.60 0.012 70);" })
      ]),
      el("div", { text: blurb, style: "font-size: 12.5px; color: oklch(0.52 0.014 65); margin-bottom: 16px; max-width: 66ch; line-height: 1.5;" })
    );
  }

  function paintGrid() {
    paintHeader();
    grid.innerHTML = "";
    const list = filtered();
    if (!list.length) {
      grid.appendChild(el("div", { text: "No creatures here yet. Pull from Foundry, or loosen the filter.", style: "font-size: 12.5px; color: oklch(0.56 0.012 70); grid-column: 1 / -1;" }));
      return;
    }
    for (const e of list) {
      const selected = e.id === st.selId;
      const accent = selected ? TEAL : "oklch(0.88 0.010 80)";
      const rating = ratingOf(e);
      const card = el("div", {
        testid: "library-creature-card",
        "data-entry-id": e.id,
        draggable: "true",
        title: "Drag onto a scene at lower left to add it to that encounter",
        style: `border: 1px solid ${selected ? "oklch(0.72 0.055 185)" : "oklch(0.88 0.010 80)"}; border-top: 3px solid ${accent}; border-radius: 4px; background: ${selected ? "oklch(0.975 0.012 185)" : "oklch(0.985 0.005 85)"}; padding: 11px 12px 10px; cursor: pointer;`
      }, [
        el("div", { style: "display: flex; align-items: baseline; gap: 8px;" }, [
          el("span", { testid: "library-creature-card-name", text: e.flavorName || e.rawFields?.name || "Unnamed", style: "flex: 1; min-width: 0; font-family: Spectral, serif; font-size: 16.5px; font-weight: 500; line-height: 1.2;" }),
          el("span", { testid: "library-creature-card-rating", text: `CR ${rating ?? "—"}`, style: "font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; color: oklch(0.42 0.014 65); flex: none;" })
        ]),
        el("div", { style: "display: flex; align-items: center; gap: 7px; margin-top: 5px;" }, [
          sourcePill(e.sourcePill, "library-creature-card-source"),
          el("span", { text: e.rawFields?.type || "", style: "font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; color: oklch(0.60 0.012 70);" })
        ]),
        el("div", { text: `AC ${e.rawFields?.ac ?? "—"} · HP ${e.rawFields?.hp ?? "—"}`, style: "font-size: 12px; color: oklch(0.48 0.014 65); line-height: 1.45; margin-top: 8px;" }),
        e.note ? el("div", { style: "display: flex; gap: 7px; margin-top: 8px; padding: 5px 8px; border-radius: 3px; background: oklch(0.96 0.030 65);" }, [
          el("span", { text: "✎", style: "font-family: 'IBM Plex Mono', monospace; font-size: 9px; color: oklch(0.52 0.10 65);" }),
          el("span", { text: e.note, style: "font-size: 11.5px; line-height: 1.4; color: oklch(0.42 0.06 65);" })
        ]) : null
      ]);
      card.addEventListener("click", () => selectEntry(e.id));
      card.addEventListener("dragstart", (ev) => {
        if (ev.dataTransfer) { ev.dataTransfer.effectAllowed = "copy"; ev.dataTransfer.setData("text/plain", e.id); }
        setTrayDragPayload({ kind: "creature", id: e.id });
      });
      card.addEventListener("dragend", () => setTrayDragPayload(null));
      grid.appendChild(card);
    }
  }

  function selectEntry(id) {
    st.selId = id;
    paintGrid();
    paintStatRail();
  }

  function statSections(rf) {
    const sections = [];
    const actions = [];
    if (rf.multiattack) {
      const names = rf.multiattack.attackNames?.length ? ` (${rf.multiattack.attackNames.join(", ")})` : "";
      actions.push({ name: "Multiattack.", text: `Makes ${rf.multiattack.count} attacks${names}.` });
    }
    for (const a of rf.attacks || []) {
      const hit = a.toHitBonus != null ? `+${a.toHitBonus} to hit, ` : "";
      const dmg = a.damageDice ? `${a.damageDice}${a.damageType ? " " + a.damageType : ""} damage.` : "";
      actions.push({ name: `${a.name}.`, text: `${hit}${dmg}`.trim() });
    }
    if (actions.length) sections.push({ label: "Actions", items: actions });
    if (Array.isArray(rf.rechargeAbilities) && rf.rechargeAbilities.length) {
      sections.push({ label: "Recharge", items: rf.rechargeAbilities.map((r) => ({ name: `${r.name} (Recharge ${r.rechargeOn}).`, text: r.damageDice ? `${r.damageDice} damage.` : "" })) });
    }
    if (rf.legendaryActions) {
      sections.push({ label: "Legendary Actions", items: [{ name: `${rf.legendaryActions.count} legendary actions.`, text: `${rf.legendaryActions.costPerAction ? rf.legendaryActions.costPerAction + " per action. " : ""}Regains spent actions at the start of its turn.` }] });
    }
    return sections;
  }

  function paintStatRail() {
    statRail.innerHTML = "";
    const e = st.entries.find((x) => x.id === st.selId);
    if (!e) {
      statRail.setAttribute("style", "width: 396px; flex: none; border-left: 1px solid oklch(0.87 0.010 80); background: oklch(0.938 0.009 85); display: flex; align-items: center; justify-content: center; padding: 24px; min-height: 0;");
      statRail.appendChild(el("div", { text: "Select a creature to see its stat block.", style: "font-size: 12.5px; color: oklch(0.58 0.012 70); text-align: center;" }));
      return;
    }
    statRail.setAttribute("style", "width: 396px; flex: none; border-left: 1px solid oklch(0.87 0.010 80); background: oklch(0.938 0.009 85); display: flex; flex-direction: column; min-height: 0; overflow-y: auto;");
    statRail.setAttribute("data-testid", "library-stat-rail");
    statRail.setAttribute("data-entry-id", e.id);

    const rf = e.rawFields || {};
    const rating = ratingOf(e);

    // header. "Aureus to the Table" task G8: a Plutonium-provenance entry
    // (sourcePill === "plutonium") gets an "Import to Foundry" action here.
    // Deliberately NO separate "in Foundry" pill invented: the moment a push
    // confirms, foundryActorRef is set and deriveSourcePill's OWN existing
    // "foundry" branch takes over on the next read -- the button's own
    // condition (sourcePill === "plutonium") then simply stops matching, and
    // the header's existing sourcePill badge already reads "Foundry world"
    // (gm-tools-conventions: reuse an existing primitive over inventing a
    // second one that would say the same thing).
    const headerChildren = [
      sourcePill(e.sourcePill, "library-source-pill"),
      el("span", { text: rf.name || "Unnamed", style: "flex: 1; min-width: 0; font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" })
    ];
    if (e.sourcePill === "plutonium") {
      headerChildren.push(foundryPushButton({
        testid: "library-bestiary-import-btn",
        label: "Import to Foundry",
        title: "Imports this creature straight from here — stat fidelity is Plutonium's own conversion; needs a live Foundry client with Plutonium enabled.",
        onPush: async () => {
          const result = await api("/api/foundry/push-bestiary-entry", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ world, entryId: e.id })
          });
          if (result.status === "queued") {
            showUndoToast(`"${rf.name}" is queued — no live Foundry client picked it up yet.`, () => {});
            return;
          }
          if (!result.ok) {
            showUndoToast(`Foundry reported a failure: ${result.error}`, () => {});
            return;
          }
          showUndoToast(`"${rf.name}" imported into Foundry.`, () => {});
          await renderLibrarySurface("bestiary");
        }
      }));
    }
    statRail.appendChild(el("div", { style: "padding: 12px 15px; border-bottom: 1px solid oklch(0.88 0.010 80); display: flex; align-items: center; gap: 9px;" }, headerChildren));

    const scroll = el("div", { style: "flex: 1; overflow-y: auto; padding: 14px 15px 20px;" });
    scroll.append(
      el("div", { testid: "library-detail-name", text: e.flavorName || rf.name || "Unnamed", style: "font-family: Spectral, serif; font-size: 23px; font-weight: 500; line-height: 1.15;" }),
      el("div", { text: rf.type || "", style: "font-style: italic; font-family: Spectral, serif; font-size: 13px; color: oklch(0.50 0.014 65); margin-top: 3px;" })
    );
    // GM-only chassis line — what the statblock actually IS. Never shown to
    // players, never pushed to Foundry (only the stats are). Styled like the
    // muted-mono GM labels elsewhere in the rail.
    if (e.chassis) {
      scroll.append(el("div", {
        testid: "library-detail-chassis",
        style: "margin-top: 6px; padding: 4px 8px; border-radius: 3px; background: oklch(0.95 0.012 300); font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; color: oklch(0.44 0.06 300);"
      }, [
        el("span", { text: "GM · chassis: ", style: "opacity: 0.75;" }),
        el("span", { text: e.chassis }),
        el("span", { text: "  — players see the flavor name; the stats below are the chassis", style: "opacity: 0.6;" })
      ]));
    }
    // GM-only reflavor notes: per-ability delivery reskin, mechanics unchanged.
    if ((e.reflavorNotes || []).length) {
      scroll.append(el("div", {
        testid: "library-detail-reflavor",
        style: "margin-top: 8px; padding: 6px 9px; border-radius: 3px; background: oklch(0.96 0.020 300); border-left: 3px solid oklch(0.70 0.09 300);"
      }, [
        el("div", { text: "Reflavor — delivery only, mechanics unchanged", style: "font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase; color: oklch(0.50 0.09 300); margin-bottom: 4px;" }),
        ...e.reflavorNotes.map((n) => el("div", { text: `• ${n}`, style: "font-size: 12px; line-height: 1.45; color: oklch(0.40 0.05 300);" }))
      ]));
    }

    // rating box + stepper
    const valueSpan = el("span", { testid: "library-rating-stepper-value", text: String(crKey(rating)), style: `font-family: 'IBM Plex Mono', monospace; font-size: 13px; color: oklch(0.42 0.014 65); min-width: 26px; text-align: center;` });
    const stepper = el("div", { testid: "library-rating-stepper", style: "display: flex; align-items: center; gap: 7px; padding: 2px; border: 1px solid oklch(0.84 0.030 185); border-radius: 4px; background: oklch(1 0 0);" }, [
      el("span", { testid: "library-rating-stepper-down", text: "−", style: "padding: 0 7px; font-family: 'IBM Plex Mono', monospace; font-size: 13px; color: oklch(0.50 0.014 65); cursor: pointer;" }),
      valueSpan,
      el("span", { testid: "library-rating-stepper-up", text: "+", style: "padding: 0 7px; font-family: 'IBM Plex Mono', monospace; font-size: 13px; color: oklch(0.50 0.014 65); cursor: pointer;" })
    ]);
    const step = async (dir) => {
      const next = bumpCr(ratingOf(e), dir);
      valueSpan.textContent = String(next);
      e.rating = next;
      try { await api(`/api/combat-planning/bestiary/${encodeURIComponent(e.id)}/rating`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rating: next }) }); }
      catch { /* keep the optimistic value */ }
    };
    stepper.children[0].addEventListener("click", () => step(-1));
    stepper.children[2].addEventListener("click", () => step(1));
    scroll.appendChild(el("div", { style: "display: flex; align-items: center; gap: 10px; margin: 12px 0 12px; padding: 9px 11px; border: 1px solid oklch(0.86 0.030 185); border-radius: 4px; background: oklch(0.968 0.012 185);" }, [
      el("div", { text: "challenge", style: "font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; letter-spacing: 0.07em; text-transform: uppercase; color: oklch(0.44 0.050 185);" }),
      el("div", { text: `CR ${crKey(rf.challengeRating)}`, style: "font-family: 'IBM Plex Mono', monospace; font-size: 15px; color: oklch(0.32 0.060 185);" }),
      el("div", { style: "flex: 1;" }),
      el("div", { text: "at my table", style: "font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; color: oklch(0.50 0.014 65);" }),
      stepper
    ]));

    // defenses
    const defenses = [];
    if (rf.ac != null) defenses.push(["AC", rf.ac]);
    if (rf.hp != null) defenses.push(["HP", rf.hp]);
    if (rating != null) defenses.push(["CR", crKey(rating)]);
    if (defenses.length) {
      const dgrid = el("div", { style: `display: grid; grid-template-columns: repeat(${defenses.length}, 1fr); gap: 6px; margin-bottom: 12px;` });
      for (const [k, v] of defenses) {
        dgrid.appendChild(el("div", { style: "padding: 7px 8px; border: 1px solid oklch(0.88 0.010 80); border-radius: 3px; background: oklch(1 0 0); text-align: center;" }, [
          el("div", { text: k, style: "font-family: 'IBM Plex Mono', monospace; font-size: 8.5px; letter-spacing: 0.07em; text-transform: uppercase; color: oklch(0.60 0.012 70);" }),
          el("div", { text: String(v), style: "font-family: 'IBM Plex Mono', monospace; font-size: 14px; color: oklch(0.30 0.015 60); margin-top: 3px;" })
        ]));
      }
      scroll.appendChild(dgrid);
    }

    // action sections
    for (const sec of statSections(rf)) {
      const block = el("div", { style: "margin-bottom: 13px;" }, [
        el("div", { text: sec.label, style: "font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; letter-spacing: 0.09em; text-transform: uppercase; color: oklch(0.50 0.09 40); border-bottom: 1px solid oklch(0.80 0.060 40); padding-bottom: 3px; margin-bottom: 8px;" })
      ]);
      const items = el("div", { style: "display: flex; flex-direction: column; gap: 7px;" });
      for (const it of sec.items) {
        items.appendChild(el("div", { style: "font-size: 12.5px; line-height: 1.5; color: oklch(0.36 0.014 65);" }, [
          el("span", { text: it.name, style: "font-family: Spectral, serif; font-weight: 600; font-style: italic;" }),
          el("span", { text: " " + it.text })
        ]));
      }
      block.appendChild(items);
      scroll.appendChild(block);
    }

    // GM note
    const noteWrap = el("div", { style: "margin-top: 16px; border-top: 1px solid oklch(0.88 0.010 80); padding-top: 12px;" }, [
      el("div", { style: "display: flex; align-items: center; gap: 8px; margin-bottom: 7px;" }, [
        el("div", { text: "My note", style: "font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; letter-spacing: 0.09em; text-transform: uppercase; color: oklch(0.53 0.012 70);" }),
        el("div", { text: "stays here — never pushed to Foundry", style: "font-family: 'IBM Plex Mono', monospace; font-size: 9px; color: oklch(0.64 0.012 70);" })
      ])
    ]);
    const note = el("div", {
      testid: "library-gm-note",
      contenteditable: "true",
      text: e.note || "",
      style: "min-height: 34px; padding: 8px 10px; border: 1px solid oklch(0.88 0.010 80); border-radius: 4px; background: oklch(0.975 0.006 85); font-size: 12.5px; line-height: 1.5; color: oklch(0.40 0.014 65);"
    });
    note.addEventListener("blur", async () => {
      const v = note.textContent.trim();
      e.note = v;
      try { await api(`/api/combat-planning/bestiary/${encodeURIComponent(e.id)}/note`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note: v }) }); }
      catch { /* keep local */ }
    });
    noteWrap.appendChild(note);
    scroll.appendChild(noteWrap);

    // reskin-suggester — Phase 37.6b: wired to a real LLM call
    // (combat-planning/reskin-suggest.mjs via POST .../reskin-suggest).
    // "Same numbers, different creature": accepting a suggestion creates a
    // NEW bestiary entry (POST .../reskin-accept) with the byte-identical
    // rawFields, this entry's stat rail is untouched. Ephemeral per-render
    // state (reset whenever paintStatRail reruns, e.g. selecting a
    // different creature) -- suggestions are a one-shot review surface, not
    // persisted anywhere until accepted.
    const reskinState = { loading: false, suggestions: null, vision: "" };
    const reskinBox = el("div", { testid: "library-reskin-box", "data-entry-id": e.id, style: "margin-top: 14px; border: 1px solid oklch(0.88 0.010 80); border-radius: 4px; background: oklch(0.965 0.006 85); padding: 11px 12px;" });
    scroll.appendChild(reskinBox);

    async function runReskinSuggest() {
      reskinState.loading = true;
      renderReskinBox();
      try {
        const result = await api(`/api/combat-planning/bestiary/${encodeURIComponent(e.id)}/reskin-suggest`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ world, vision: reskinState.vision })
        });
        reskinState.suggestions = result.suggestions || [];
      } catch {
        reskinState.suggestions = []; // one-shot failure -- "no suggestions came back", never a silent hang
      }
      reskinState.loading = false;
      renderReskinBox();
    }

    function renderReskinBox() {
      reskinBox.innerHTML = "";
      const header = el("div", { style: "display: flex; align-items: center; gap: 8px;" }, [
        el("span", { text: "✦", style: "font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: oklch(0.50 0.08 300);" }),
        el("span", { text: "Wear it as something else", style: "font-size: 12.5px; font-weight: 500; color: oklch(0.34 0.06 300);" }),
        el("span", { style: "flex: 1;" })
      ]);
      reskinBox.appendChild(header);

      if (!reskinState.suggestions) {
        reskinBox.appendChild(el("div", { text: "Same numbers, different creature — the model never sees or changes the stat block.", style: "font-size: 11.5px; line-height: 1.45; color: oklch(0.50 0.014 65); margin-top: 6px;" }));
        const visionInput = el("input", {
          testid: "library-reskin-vision-input",
          placeholder: "an absolute chad of a city patrolman (optional)",
          value: reskinState.vision,
          style: "width: 100%; margin-top: 9px; padding: 6px 10px; border: 1px solid oklch(0.85 0.010 80); border-radius: 4px; font-family: inherit; font-size: 12.5px; background: oklch(1 0 0); color: inherit;"
        });
        visionInput.addEventListener("input", () => { reskinState.vision = visionInput.value; });
        reskinBox.appendChild(visionInput);
        const suggestBtn = el("div", {
          testid: "library-reskin-suggest-btn",
          text: reskinState.loading ? "Thinking…" : "Suggest a skin",
          style: `display: inline-block; margin-top: 9px; padding: 5px 12px; border-radius: 4px; cursor: ${reskinState.loading ? "default" : "pointer"}; font-size: 12px; background: ${reskinState.loading ? "oklch(0.72 0.040 300)" : "oklch(0.52 0.10 300)"}; color: oklch(0.99 0.005 300);`
        });
        if (!reskinState.loading) suggestBtn.addEventListener("click", runReskinSuggest);
        reskinBox.appendChild(suggestBtn);
        return;
      }

      if (!reskinState.suggestions.length) {
        reskinBox.appendChild(el("div", { testid: "library-reskin-empty", text: "No suggestions came back — try again.", style: "font-size: 11.5px; color: oklch(0.58 0.012 70); margin-top: 6px;" }));
        const retryBtn = el("span", { testid: "library-reskin-retry-btn", text: "Again", style: "display: inline-block; margin-top: 7px; padding: 4px 11px; border: 1px solid oklch(0.86 0.010 80); border-radius: 4px; cursor: pointer; font-size: 11.5px; color: oklch(0.50 0.014 65); background: oklch(1 0 0);" });
        retryBtn.addEventListener("click", () => { reskinState.suggestions = null; renderReskinBox(); });
        reskinBox.appendChild(retryBtn);
        return;
      }

      for (const s of reskinState.suggestions) {
        const card = el("div", {
          testid: "library-reskin-suggestion-card",
          "data-suggestion-name": s.name,
          style: "margin-top: 9px; padding: 9px 10px; border: 1px solid oklch(0.80 0.050 300); border-radius: 4px; background: oklch(0.975 0.012 300);"
        }, [
          el("div", { text: s.name, style: "font-family: Spectral, serif; font-size: 15px; font-weight: 500;" }),
          el("div", { text: s.description, style: "font-size: 12px; line-height: 1.5; color: oklch(0.44 0.014 65); margin-top: 5px;" }),
          el("div", { text: s.habitatHint, style: "font-size: 11px; font-style: italic; color: oklch(0.56 0.012 70); margin-top: 5px;" })
        ]);
        const actions = el("div", { style: "display: flex; gap: 8px; margin-top: 9px;" });
        const acceptBtn = el("span", {
          testid: "library-reskin-accept-btn",
          text: "Keep it",
          style: "padding: 4px 11px; border: 1px solid oklch(0.76 0.060 300); border-radius: 4px; cursor: pointer; font-size: 11.5px; color: oklch(0.36 0.08 300); background: oklch(0.96 0.020 300);"
        });
        acceptBtn.addEventListener("click", async () => {
          acceptBtn.textContent = "Creating…";
          try {
            await api(`/api/combat-planning/bestiary/${encodeURIComponent(e.id)}/reskin-accept`, {
              method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ suggestion: s })
            });
            await renderLibrarySurface("bestiary"); // a NEW catalogue entry now exists -- full reload picks it up
          } catch { acceptBtn.textContent = "Keep it"; }
        });
        const dismissBtn = el("span", {
          testid: "library-reskin-dismiss-btn",
          text: "Dismiss",
          style: "padding: 4px 11px; border: 1px solid oklch(0.86 0.010 80); border-radius: 4px; cursor: pointer; font-size: 11.5px; color: oklch(0.50 0.014 65); background: oklch(1 0 0);"
        });
        dismissBtn.addEventListener("click", () => {
          reskinState.suggestions = reskinState.suggestions.filter((x) => x !== s);
          renderReskinBox();
        });
        actions.append(acceptBtn, dismissBtn);
        card.appendChild(actions);
        reskinBox.appendChild(card);
      }
    }
    renderReskinBox();

    // "Where it's been" + promote — Phase 37.6b: promote wired for real,
    // mirroring the Reliquary's item-promote affordance (graphPromoteAffordance,
    // SAME function, SAME "⛓ in the graph" convention once linked).
    // Scene-appearance tracking itself stays out of scope (a catalogue entry,
    // not a character -- that's still fine; nothing here claims otherwise).
    const promoteWrap = el("div", { style: "margin-top: 14px; border-top: 1px solid oklch(0.88 0.010 80); padding-top: 12px;" }, [
      el("div", { text: "Where it's been", style: "font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; letter-spacing: 0.09em; text-transform: uppercase; color: oklch(0.53 0.012 70); margin-bottom: 7px;" }),
      el("div", { text: "Scene-appearance tracking isn't wired yet — a catalogue entry, not a character. That's fine.", style: "font-size: 12px; color: oklch(0.58 0.012 70); line-height: 1.45;" })
    ]);
    const promoteRow = el("div", { style: "display: flex; align-items: center; gap: 8px; margin-top: 9px; padding: 8px 11px; border: 1px dashed oklch(0.82 0.010 80); border-radius: 4px;" }, [
      el("span", { text: "◉", style: "font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: oklch(0.50 0.075 185);" }),
      el("div", { style: "flex: 1;" }, [
        el("div", { text: "Promote to a named world figure", style: "font-size: 12.5px; color: oklch(0.38 0.030 185);" }),
        el("div", { text: "Creates a graph node that keeps this stat block.", style: "font-size: 11px; color: oklch(0.58 0.012 70); margin-top: 2px;" })
      ])
    ]);
    promoteRow.appendChild(graphPromoteAffordance(e, async (btn) => {
      btn.style.opacity = "0.6";
      try {
        const result = await api(`/api/combat-planning/bestiary/${encodeURIComponent(e.id)}/promote-to-graph`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ world })
        });
        e.graphEntityId = result.entityId; // update in place -- keeps this creature selected, no full reload needed
      } catch { /* leave the affordance clickable to retry */ }
      paintStatRail();
    }, {
      testidPrefix: "library-bestiary",
      badgeTitle: "This creature is linked to a graph node",
      btnTitle: "Promote this creature to a named world figure"
    }));
    promoteWrap.appendChild(promoteRow);
    scroll.appendChild(promoteWrap);

    statRail.appendChild(scroll);
  }

  paintHabitatTree();
  paintGrid();
  paintStatRail();
}

// ===========================================================================
// AVAILABLE VIA PLUTONIUM — Friction Wave 1 W4b: the read-only source-layer
// shelf under the Bestiary tab's curated grid. Backed entirely by the W4a
// route (GET /api/combat-planning/plutonium): search + CR range + type +
// source filters run SERVER-side, and rendering is windowed (50-row pages +
// "Show more") so the ~4k-row index never tanks the page. Distinct
// "Plutonium" source pill; rows NEVER mix into the curated grid's data.
// ===========================================================================
const PLU_PAGE_SIZE = 50;

function crLadderToNum(v) {
  if (!v || v === "any") return null;
  if (v === "1/8") return 0.125;
  if (v === "1/4") return 0.25;
  if (v === "1/2") return 0.5;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function buildPlutoniumShelf(ctx) {
  const st = { query: "", crMin: "any", crMax: "any", type: "", source: "", offset: 0, rows: [], matched: 0, installed: null, facets: null, loading: false };

  const section = el("div", { testid: "plutonium-shelf", style: "margin-top: 34px; border-top: 1px solid oklch(0.86 0.010 80); padding-top: 18px;" });
  const headRow = el("div", { style: "display: flex; align-items: baseline; gap: 11px; flex-wrap: wrap;" }, [
    el("div", { text: "Available via Plutonium", style: "font-family: Spectral, serif; font-size: 20px; font-weight: 500;" }),
    sourcePill("plutonium", "plutonium-shelf-pill"),
    el("span", { testid: "plutonium-shelf-count", style: "font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: oklch(0.60 0.012 70);" })
  ]);
  const blurb = el("div", {
    // "Aureus to the Table" task G8 -- honest copy: browsing here is
    // read-only, but adding a creature to the curated shelf below now makes
    // it directly importable (no more "manual Plutonium act" framing).
    text: "Everything Plutonium's bundled 5etools data says exists — browsable here so the library isn't blind to unimported creatures. Read-only for browsing; a creature added to the curated shelf below is importable straight from here — stat fidelity is Plutonium's own conversion; needs a live Foundry client with Plutonium enabled.",
    style: "font-size: 12px; color: oklch(0.52 0.014 65); margin: 5px 0 12px; max-width: 78ch; line-height: 1.5;"
  });
  section.append(headRow, blurb);

  // --- filter controls ---
  const controls = el("div", { style: "display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px;" });
  const inputStyle = "padding: 5px 9px; border: 1px solid oklch(0.84 0.010 80); border-radius: 5px; font-family: inherit; font-size: 12px; background: oklch(1 0 0); color: inherit;";
  const search = el("input", { testid: "plutonium-search-input", placeholder: "Find a creature…", style: `${inputStyle} width: 200px;` });
  let debounce = null;
  search.addEventListener("input", () => {
    st.query = search.value;
    clearTimeout(debounce);
    debounce = setTimeout(() => fetchPage(true), 200);
  });

  const mkSelect = (testid, first, options, onChange) => {
    const sel = el("select", { testid, style: inputStyle });
    sel.appendChild(el("option", { value: first.value, text: first.label }));
    for (const o of options) sel.appendChild(el("option", { value: o.value, text: o.label }));
    sel.addEventListener("change", () => { onChange(sel.value); fetchPage(true); });
    return sel;
  };
  const crOpts = CR_LADDER.map((c) => ({ value: c, label: c }));
  const crMinSel = mkSelect("plutonium-cr-min", { value: "any", label: "CR min" }, crOpts, (v) => { st.crMin = v; });
  const crMaxSel = mkSelect("plutonium-cr-max", { value: "any", label: "CR max" }, crOpts, (v) => { st.crMax = v; });
  const typeSelHost = el("span", {});
  const sourceSelHost = el("span", {});
  controls.append(search, crMinSel, crMaxSel, typeSelHost, sourceSelHost);
  section.appendChild(controls);

  const rowsHost = el("div", { testid: "plutonium-rows", style: "display: flex; flex-direction: column; gap: 4px;" });
  const footerHost = el("div", { style: "margin-top: 10px;" });
  section.append(rowsHost, footerHost);

  // Facet dropdowns are built ONCE from the first response (whole-index
  // facets), then left stable while filtering.
  let facetsBuilt = false;
  function buildFacetSelects() {
    if (facetsBuilt || !st.facets) return;
    facetsBuilt = true;
    typeSelHost.appendChild(mkSelect(
      "plutonium-type-filter", { value: "", label: "Any type" },
      st.facets.types.map((t) => ({ value: t.id, label: `${t.id} (${t.count})` })),
      (v) => { st.type = v; }
    ));
    sourceSelHost.appendChild(mkSelect(
      "plutonium-source-filter", { value: "", label: "Any source" },
      st.facets.sources.map((s) => ({ value: s.id, label: `${s.id} (${s.count})` })),
      (v) => { st.source = v; }
    ));
  }

  async function fetchPage(reset) {
    if (reset) { st.offset = 0; st.rows = []; }
    st.loading = true;
    paintFooter();
    const params = new URLSearchParams();
    if (st.query.trim()) params.set("query", st.query.trim());
    const crMin = crLadderToNum(st.crMin);
    const crMax = crLadderToNum(st.crMax);
    if (crMin !== null) params.set("crMin", String(crMin));
    if (crMax !== null) params.set("crMax", String(crMax));
    if (st.type) params.set("type", st.type);
    if (st.source) params.set("source", st.source);
    params.set("offset", String(st.offset));
    params.set("limit", String(PLU_PAGE_SIZE));
    try {
      const r = await api(`/api/combat-planning/plutonium?${params}`);
      st.installed = r.installed;
      st.matched = r.matched;
      st.facets = st.facets || r.facets;
      st.rows = st.rows.concat(r.creatures || []);
      st.offset = st.rows.length;
      buildFacetSelects();
    } catch { st.installed = st.installed ?? false; }
    st.loading = false;
    paintRows();
    paintFooter();
  }

  function paintRows() {
    rowsHost.innerHTML = "";
    const countEl = headRow.querySelector('[data-testid="plutonium-shelf-count"]');
    if (st.installed === false) {
      countEl.textContent = "";
      rowsHost.appendChild(el("div", {
        testid: "plutonium-not-installed",
        text: "Plutonium isn't installed in this Foundry data directory — nothing to browse. Install the Plutonium module and its bundled 5etools data appears here automatically.",
        style: "padding: 16px; border: 1px dashed oklch(0.86 0.010 80); border-radius: 4px; font-size: 12px; color: oklch(0.56 0.012 70);"
      }));
      return;
    }
    countEl.textContent = `${st.matched} matching`;
    if (!st.rows.length) {
      rowsHost.appendChild(el("div", { text: "Nothing matches that. Loosen the search or a filter.", style: "font-size: 12px; color: oklch(0.56 0.012 70); padding: 8px 0;" }));
      return;
    }
    for (const c of st.rows) rowsHost.appendChild(plutoniumRow(c, ctx));
  }

  function paintFooter() {
    footerHost.innerHTML = "";
    if (st.installed === false) return;
    if (st.loading) {
      footerHost.appendChild(el("div", { text: "Loading…", style: "font-size: 11.5px; color: oklch(0.58 0.012 70);" }));
      return;
    }
    if (st.rows.length < st.matched) {
      const more = el("div", {
        testid: "plutonium-show-more-btn",
        text: `Show more (${st.rows.length} of ${st.matched})`,
        style: "display: inline-block; padding: 6px 14px; border: 1px solid oklch(0.84 0.010 80); border-radius: 5px; cursor: pointer; font-size: 12px; color: oklch(0.44 0.050 25); background: oklch(0.975 0.006 85);"
      });
      more.addEventListener("click", () => fetchPage(false));
      footerHost.appendChild(more);
    }
  }

  function plutoniumRow(c, rowCtx) {
    const statBits = [
      c.cr != null ? `CR ${c.cr}` : null,
      c.type ? (c.tags?.length ? `${c.type} (${c.tags.join(", ")})` : c.type) : null,
      c.ac != null ? `AC ${c.ac}` : null,
      c.hp != null ? `HP ${c.hp}` : null,
      c.legendary ? "legendary" : null
    ].filter(Boolean).join(" · ");
    const row = el("div", {
      testid: "plutonium-row",
      "data-name": c.name,
      "data-source": c.source ?? "",
      style: "display: flex; align-items: baseline; gap: 10px; padding: 6px 10px; border: 1px solid oklch(0.90 0.010 80); border-left: 3px solid oklch(0.78 0.070 25); border-radius: 4px; background: oklch(0.985 0.005 85);"
    }, [
      el("span", { testid: "plutonium-row-name", text: c.name, style: "font-family: Spectral, serif; font-size: 14.5px; font-weight: 500; flex: none;" }),
      el("span", { text: statBits, style: "font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; color: oklch(0.52 0.014 65); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" }),
      el("span", {
        testid: "plutonium-row-source",
        text: `${c.source ?? "?"}${c.page != null ? ` p${c.page}` : ""}`,
        style: "font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; color: oklch(0.40 0.10 25); flex: none;"
      })
    ]);
    const action = buildPlutoniumRowAction?.(c, rowCtx);
    if (action) row.appendChild(action);
    return row;
  }

  fetchPage(true);
  return section;
}

// W4c -- the per-row "Add to shelf" action: THE one explicit bridge from the
// read-only source layer onto the curated shelf (POST .../bestiary/
// add-from-plutonium; server-side dedupe guard -> 409 reads back as
// "already on shelf"). An already-added creature renders the quiet "on
// shelf" marker instead of the button (matched against the curated entries'
// own provenance line). Success refreshes the whole Bestiary surface so the
// new curated entry appears in the grid above with its Plutonium pill.
// "Aureus to the Table" task G8 -- once on the curated shelf, the entry's
// own "Import to Foundry" affordance (buildBestiary's paintStatRail) takes
// over; this button's own title says so honestly now.
function buildPlutoniumRowAction(c, ctx) {
  const provenance = `${c.source ?? "?"}${c.page != null ? ` p${c.page}` : ""} via Plutonium`;
  const alreadyOnShelf = (ctx?.data?.bestiary || []).some(
    (e) => e.status !== "discarded" && e.rawFields?.name === c.name && e.sourceText === provenance
  );
  if (alreadyOnShelf) {
    return el("span", {
      testid: "plutonium-row-on-shelf",
      text: "✓ on shelf",
      title: "Already on the curated shelf",
      style: "flex: none; font-family: 'IBM Plex Mono', monospace; font-size: 9px; color: oklch(0.48 0.09 150); padding: 2px 8px; border: 1px solid oklch(0.80 0.070 150); border-radius: 20px; background: oklch(0.96 0.020 150);"
    });
  }
  const btn = el("span", {
    testid: "plutonium-row-add-btn",
    text: "+ shelf",
    title: "Add this creature's stats to the curated shelf. From there it's importable straight into Foundry — stat fidelity is Plutonium's own conversion; needs a live Foundry client with Plutonium enabled.",
    style: "flex: none; font-family: 'IBM Plex Mono', monospace; font-size: 9px; color: oklch(0.40 0.10 25); padding: 2px 8px; border: 1px dashed oklch(0.78 0.070 25); border-radius: 20px; cursor: pointer; white-space: nowrap;"
  });
  btn.addEventListener("click", async () => {
    btn.textContent = "adding…";
    try {
      await api("/api/combat-planning/bestiary/add-from-plutonium", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: c.name, source: c.source })
      });
      await renderLibrarySurface("bestiary"); // a NEW curated entry exists -- full reload, same as hand-add/reskin-accept
    } catch (err) {
      // The server's dedupe guard (409) or any other failure -- say so
      // inline, leave the row usable.
      btn.textContent = err.status === 409 ? "already on shelf" : "+ shelf";
      if (err.status !== 409) btn.title = `Could not add: ${err.message}`;
    }
  });
  return btn;
}

// ===========================================================================
// HERO'S HALL
// ===========================================================================
function buildHall(ctx) {
  const { world, data, subbar, bodyRow } = ctx;
  const st = { members: data.party.filter((m) => m.status !== "discarded"), layout: "cards" };

  // layout toggle (right of sub-bar)
  const controls = el("div", { style: "display: flex; align-items: center; gap: 10px;" });
  controls.appendChild(el("div", { text: "Layout", style: "font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase; color: oklch(0.58 0.012 70);" }));
  const toggle = el("div", { style: "display: flex; gap: 3px; padding: 2px; border: 1px solid oklch(0.86 0.010 80); border-radius: 6px; background: oklch(0.965 0.006 85);" });
  for (const l of [{ id: "cards", label: "Cards" }, { id: "table", label: "Side by side" }]) {
    const b = el("div", { text: l.label, style: layoutBtnStyle(st.layout === l.id) });
    b.addEventListener("click", () => { st.layout = l.id; for (const c of toggle.children) c.setAttribute("style", layoutBtnStyle(false)); b.setAttribute("style", layoutBtnStyle(true)); paintBody(); });
    toggle.appendChild(b);
  }
  controls.appendChild(toggle);
  subbar.appendChild(controls);

  const root = el("div", { testid: "library-hall-root", style: "display: flex; flex: 1; min-height: 0;" });
  const main = el("div", { style: "flex: 1; min-width: 0; overflow-y: auto; padding: 22px 28px 44px;" });
  const header = el("div", {}, [
    el("div", { style: "display: flex; align-items: baseline; gap: 12px; margin-bottom: 4px;" }, [
      el("div", { text: "The Hero's Hall", style: "font-family: Spectral, serif; font-size: 25px; font-weight: 500;" }),
      el("div", { text: `${st.members.length} ${st.members.length === 1 ? "character" : "characters"}`, style: "font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: oklch(0.60 0.012 70);" })
    ]),
    el("div", { text: "What's spent, what they'll save against, and the few skills good enough to matter. Conditions are one click away, always visible.", style: "font-size: 12.5px; color: oklch(0.52 0.014 65); margin-bottom: 18px; max-width: 72ch; line-height: 1.5;" })
  ]);
  const bodyHost = el("div", {});
  // QA W2 fix (Group D #19): Hero's Hall previously had NO hand-authoring
  // path at all (unlike Bestiary/Reliquary/Stagecraft, which at least had a
  // dead "write one by hand" label) -- a real, always-visible (not just in
  // the empty state, matching the other three tabs' own importRow/footer
  // idiom) minimal form -> POST .../party-roster/hand-add.
  const handAddRow = el("div", { style: "display: flex; align-items: center; gap: 12px; margin-top: 16px;" }, [
    buildHandAddForm({
      rootTestid: "library-hall-hand-add",
      toggleLabel: "or add a character by hand",
      fields: [
        { key: "name", label: "Name", width: "170px" },
        { key: "class", label: "Class", width: "120px" },
        { key: "level", label: "Level", width: "56px", type: "number" },
        { key: "ac", label: "AC", width: "56px", type: "number" },
        { key: "hp", label: "HP", width: "56px", type: "number" }
      ],
      onSubmit: async (v) => {
        await api("/api/combat-planning/party-roster/hand-add", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            world, name: v.name, class: v.class || undefined,
            level: v.level || undefined, ac: v.ac || undefined, hp: v.hp || undefined
          })
        });
        await renderLibrarySurface("hall"); // a NEW party member now exists -- full reload picks it up
      }
    })
  ]);
  main.append(header, bodyHost, handAddRow);
  root.append(main, trayRail(world, 306));
  bodyRow.appendChild(root);

  function paintBody() {
    bodyHost.innerHTML = "";
    if (st.layout === "table") bodyHost.appendChild(heroTable());
    else bodyHost.appendChild(heroCards());
  }

  function heroCards() {
    const grid = el("div", { style: "display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px;" });
    if (!st.members.length) {
      const empty = el("div", { style: "display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 9px; min-height: 130px; border: 1px dashed oklch(0.80 0.010 80); border-radius: 4px; padding: 14px;" });
      empty.appendChild(pullButton("Pull characters from Foundry"));
      grid.appendChild(empty);
      return grid;
    }
    for (const m of st.members) grid.appendChild(heroCard(m));
    return grid;
  }

  function heroCard(m) {
    const cr = m.combatRelevant || {};
    const br = m.buildRelevant || {};
    const pill = m.foundryActorRef ? "foundry" : "mine";
    const build = [cr.class, cr.level].filter((x) => x != null).join(" ");

    const card = el("div", {
      testid: "library-hero-card",
      "data-member-id": m.id,
      draggable: "true",
      title: "Drag onto a scene at right to place this hero",
      style: "border: 1px solid oklch(0.88 0.010 80); border-top: 3px solid oklch(0.60 0.10 65); border-radius: 4px; background: oklch(0.985 0.005 85); padding: 13px 14px 12px;"
    });
    card.addEventListener("dragstart", (ev) => {
      if (ev.dataTransfer) { ev.dataTransfer.effectAllowed = "copy"; ev.dataTransfer.setData("text/plain", m.id); }
      setTrayDragPayload({ kind: "hero", id: m.id });
    });
    card.addEventListener("dragend", () => setTrayDragPayload(null));

    // header
    card.appendChild(el("div", { style: "display: flex; align-items: baseline; gap: 9px;" }, [
      el("span", { text: m.name, style: "font-family: Spectral, serif; font-size: 19px; font-weight: 500;" }),
      el("span", { text: build, style: "flex: 1; min-width: 0; font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; color: oklch(0.60 0.012 70); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" }),
      sourcePill(pill)
    ]));

    // hp / ac / passive
    card.appendChild(el("div", { style: "display: flex; align-items: center; gap: 14px; margin-top: 11px;" }, [
      defenseCell("HP", cr.hp ?? "—"),
      defenseCell("AC", cr.ac ?? "—"),
      defenseCell("Passive", m.passive ?? "—")
    ]));

    // resources (real combat readouts — see file header note)
    const resChips = el("div", { style: "display: flex; flex-wrap: wrap; gap: 4px;" });
    if (cr.attackBonus != null) resChips.appendChild(miniChip(`Atk +${cr.attackBonus}`));
    for (const [k, v] of Object.entries(cr.saveDCs || {})) {
      // saveDCs is an opaque pass-through of dnd5e `system.saves` (mapper's
      // documented tolerance) -- real 5.3.3 data wraps each save as
      // `{roll, value}` where `value` is the modifier, older/fixture shapes
      // are bare numbers. Unwrap; skip entries with no numeric to show.
      const mod = (v && typeof v === "object") ? v.value : v;
      if (typeof mod !== "number") continue;
      resChips.appendChild(miniChip(`${k.toUpperCase()} ${mod >= 0 ? "+" : ""}${mod}`));
    }
    for (const feat of cr.notableAbilities || []) resChips.appendChild(miniChip(feat));
    if (!resChips.children.length) resChips.appendChild(el("span", { text: "No tracked resources", style: "font-size: 11px; color: oklch(0.60 0.012 70);" }));
    card.appendChild(el("div", { testid: "library-hero-resources", style: "margin-top: 12px;" }, [
      el("div", { text: "Resources", style: "font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; color: oklch(0.60 0.012 70); margin-bottom: 4px;" }),
      resChips
    ]));

    // skills + expertise markers. Phase 37.6 task 1 ✦-HONESTY COMMENT
    // CONVENTION: `library-hero-expertise-marker` below is DECORATIVE-ONLY --
    // a plain "this skill has expertise" indicator (D&D 5e rules concept,
    // sourced straight from br.expertise), not an AI affordance and not
    // wired to any LLM route. The addendum names this exact marker as the
    // canonical decorative-✦ example; kept unchanged.
    const skills = br.skills || [];
    const expertise = new Set(br.expertise || []);
    if (skills.length) {
      const skillRow = el("div", { style: "display: flex; flex-wrap: wrap; gap: 4px;" });
      for (const s of skills) {
        const isExp = expertise.has(s);
        const chip = el("span", { style: `display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border: 1px solid ${isExp ? "oklch(0.80 0.045 185)" : "oklch(0.88 0.010 80)"}; border-radius: 20px; font-size: 11.5px; background: ${isExp ? "oklch(0.94 0.030 185)" : "oklch(0.975 0.006 85)"}; color: ${isExp ? "oklch(0.34 0.060 185)" : "oklch(0.40 0.014 65)"};` }, [
          el("span", { text: SKILL_LABELS[s] || s })
        ]);
        if (isExp) chip.appendChild(el("span", { testid: "library-hero-expertise-marker", text: "✦", style: "font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: oklch(0.50 0.075 185);" }));
        skillRow.appendChild(chip);
      }
      card.appendChild(el("div", { style: "margin-top: 12px;" }, [
        el("div", { text: "Notable", style: "font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; color: oklch(0.60 0.012 70); margin-bottom: 4px;" }),
        skillRow
      ]));
    }

    // conditions — ONE-CLICK, ALWAYS VISIBLE (locked decision), editable in place
    const condWrap = el("div", { style: "margin-top: 12px;" });
    condWrap.appendChild(el("div", { text: "Conditions", style: "font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; color: oklch(0.60 0.012 70); margin-bottom: 4px;" }));
    const cond = el("div", {
      testid: "library-hero-conditions-toggle",
      contenteditable: "true",
      text: m.conditions || "",
      style: "min-height: 26px; padding: 5px 9px; border: 1px solid oklch(0.89 0.010 80); border-radius: 3px; background: oklch(0.975 0.006 85); font-size: 11.5px; line-height: 1.45; color: oklch(0.42 0.014 65); cursor: text;"
    });
    if (!m.conditions) cond.setAttribute("data-placeholder", "—");
    cond.addEventListener("blur", async () => {
      const v = cond.textContent.trim();
      m.conditions = v;
      try { await api(`/api/combat-planning/party-roster/${encodeURIComponent(m.id)}/conditions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ world, conditions: v }) }); }
      catch { /* keep local */ }
    });
    condWrap.appendChild(cond);
    card.appendChild(condWrap);

    return card;
  }

  function heroTable() {
    const wrap = el("div", { style: "border: 1px solid oklch(0.88 0.010 80); border-radius: 4px; background: oklch(0.985 0.005 85); overflow: hidden;" });
    const cols = "184px 88px 64px 80px 1.2fr 1fr";
    const head = el("div", { style: `display: grid; grid-template-columns: ${cols}; background: oklch(0.928 0.009 85); border-bottom: 1px solid oklch(0.88 0.010 80);` });
    for (const h of ["Character", "HP", "AC", "Passive", "Notable", "Conditions"]) head.appendChild(el("div", { text: h, style: "padding: 8px 11px; font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase; color: oklch(0.53 0.012 70);" }));
    wrap.appendChild(head);
    for (const m of st.members) {
      const cr = m.combatRelevant || {};
      const br = m.buildRelevant || {};
      const expertise = new Set(br.expertise || []);
      const row = el("div", { style: `display: grid; grid-template-columns: ${cols}; border-bottom: 1px solid oklch(0.91 0.010 80);` });
      const nameCell = el("div", { draggable: "true", title: "Drag onto a scene at right", style: "padding: 11px; border-left: 3px solid oklch(0.60 0.10 65); cursor: grab;" }, [
        el("div", { text: m.name, style: "font-family: Spectral, serif; font-size: 15.5px; font-weight: 500;" }),
        el("div", { text: [cr.class, cr.level].filter((x) => x != null).join(" "), style: "font-family: 'IBM Plex Mono', monospace; font-size: 9px; color: oklch(0.60 0.012 70); margin-top: 2px;" })
      ]);
      nameCell.addEventListener("dragstart", (ev) => { if (ev.dataTransfer) ev.dataTransfer.setData("text/plain", m.id); setTrayDragPayload({ kind: "hero", id: m.id }); });
      nameCell.addEventListener("dragend", () => setTrayDragPayload(null));
      // Same decorative expertise-marker convention as heroCard's own ✦ above
      // -- not an AI affordance, see that site's comment.
      const notable = el("div", { style: "padding: 11px; display: flex; flex-wrap: wrap; gap: 4px;" });
      for (const s of br.skills || []) notable.appendChild(miniChip((SKILL_LABELS[s] || s) + (expertise.has(s) ? " ✦" : "")));
      row.append(
        nameCell,
        el("div", { text: String(cr.hp ?? "—"), style: "padding: 11px; font-family: 'IBM Plex Mono', monospace; font-size: 12.5px; color: oklch(0.31 0.015 60);" }),
        el("div", { text: String(cr.ac ?? "—"), style: "padding: 11px; font-family: 'IBM Plex Mono', monospace; font-size: 12.5px; color: oklch(0.31 0.015 60);" }),
        el("div", { text: String(m.passive ?? "—"), style: "padding: 11px; font-family: 'IBM Plex Mono', monospace; font-size: 12.5px; color: oklch(0.31 0.015 60);" }),
        notable,
        el("div", { text: m.conditions || "—", style: "padding: 11px; font-size: 11.5px; color: oklch(0.42 0.014 65);" })
      );
      wrap.appendChild(row);
    }
    return wrap;
  }

  paintBody();
}

function defenseCell(label, value) {
  return el("div", { style: "text-align: center; min-width: 48px;" }, [
    el("div", { text: label, style: "font-family: 'IBM Plex Mono', monospace; font-size: 8.5px; letter-spacing: 0.06em; text-transform: uppercase; color: oklch(0.60 0.012 70);" }),
    el("div", { text: String(value), style: "font-family: 'IBM Plex Mono', monospace; font-size: 15px; color: oklch(0.31 0.015 60); margin-top: 2px;" })
  ]);
}
function miniChip(text) {
  return el("span", { text, style: "padding: 2px 8px; border: 1px solid oklch(0.88 0.010 80); border-radius: 20px; font-family: 'IBM Plex Mono', monospace; font-size: 10px; background: oklch(0.975 0.006 85); color: oklch(0.42 0.014 65);" });
}
function layoutBtnStyle(active) {
  return `padding: 3px 10px; border-radius: 4px; font-size: 11.5px; cursor: pointer; background: ${active ? TEAL : "transparent"}; color: ${active ? "oklch(0.99 0.005 185)" : "oklch(0.48 0.014 65)"};`;
}

// ---------------------------------------------------------------------------
// "Aureus to the Table" task G6 -- the Reliquary's own "Available via
// Plutonium" shelf, over the generalized family core's `items` family
// (combat-planning/plutonium-source.mjs task G4 / review-ui route task G5).
// Deliberately mirrors buildPlutoniumShelf's (the Bestiary tab's own shelf)
// structure/testids/styling convention one-for-one -- search + facet
// selects built once from the first response, windowed "show more" paging,
// a not-installed empty state, a per-row dedupe marker -- rather than
// force-generalizing the two into one shared builder (the Bestiary shelf is
// CR-range-filtered creature stats; this one is type/rarity/source-filtered
// items -- different enough fields that sharing the builder would mean
// threading a pile of creature-vs-item conditionals through one function
// for no real reuse win). Only `sourcePill` (a tiny, already-generic
// helper) and the toast import above are actually shared.
// ---------------------------------------------------------------------------
function buildPlutoniumItemsShelf(ctx) {
  const { world, data } = ctx;
  const st = { query: "", type: "", rarity: "", source: "", offset: 0, rows: [], total: 0, installed: null, facets: null, loading: false };
  const PAGE_SIZE = 25;

  const section = el("div", { testid: "plutonium-items-shelf", style: "margin-top: 34px; border-top: 1px solid oklch(0.86 0.010 80); padding-top: 18px;" });
  const headRow = el("div", { style: "display: flex; align-items: baseline; gap: 11px; flex-wrap: wrap;" }, [
    el("div", { text: "Available via Plutonium", style: "font-family: Spectral, serif; font-size: 20px; font-weight: 500;" }),
    sourcePill("plutonium", "plutonium-items-shelf-pill"),
    el("span", { testid: "plutonium-items-shelf-count", style: "font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: oklch(0.60 0.012 70);" })
  ]);
  const blurb = el("div", {
    // Honest framing, stated up front where the shelf starts -- same rule
    // W4c's bestiary blurb states, worded for what THIS bridge actually does.
    text: "Everything Plutonium's bundled 5etools item data says exists — browsable here so the Reliquary isn't blind to unimported gear. Read-only: adding a row here adds it to the Reliquary; pushing an actual Foundry item is separate.",
    style: "font-size: 12px; color: oklch(0.52 0.014 65); margin: 5px 0 12px; max-width: 78ch; line-height: 1.5;"
  });
  section.append(headRow, blurb);

  // --- filter controls ---
  const controls = el("div", { style: "display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px;" });
  const inputStyle = "padding: 5px 9px; border: 1px solid oklch(0.84 0.010 80); border-radius: 5px; font-family: inherit; font-size: 12px; background: oklch(1 0 0); color: inherit;";
  const search = el("input", { testid: "plutonium-items-search-input", placeholder: "Find an item…", style: `${inputStyle} width: 200px;` });
  let debounce = null;
  search.addEventListener("input", () => {
    st.query = search.value;
    clearTimeout(debounce);
    debounce = setTimeout(() => fetchPage(true), 200);
  });

  const mkSelect = (testid, first, options, onChange) => {
    const sel = el("select", { testid, style: inputStyle });
    sel.appendChild(el("option", { value: first.value, text: first.label }));
    for (const o of options) sel.appendChild(el("option", { value: o.value, text: o.label }));
    sel.addEventListener("change", () => { onChange(sel.value); fetchPage(true); });
    return sel;
  };
  const typeSelHost = el("span", {});
  const raritySelHost = el("span", {});
  const sourceSelHost = el("span", {});
  controls.append(search, typeSelHost, raritySelHost, sourceSelHost);
  section.appendChild(controls);

  const rowsHost = el("div", { testid: "plutonium-items-rows", style: "display: flex; flex-direction: column; gap: 4px;" });
  const footerHost = el("div", { style: "margin-top: 10px;" });
  section.append(rowsHost, footerHost);

  // Facet dropdowns built ONCE from the first response (whole-family
  // facets), then left stable while filtering -- same convention as the
  // Bestiary shelf's own buildFacetSelects.
  let facetsBuilt = false;
  function buildFacetSelects() {
    if (facetsBuilt || !st.facets) return;
    facetsBuilt = true;
    typeSelHost.appendChild(mkSelect(
      "plutonium-items-type-filter", { value: "", label: "Any type" },
      st.facets.types.map((t) => ({ value: t.id, label: `${t.id} (${t.count})` })),
      (v) => { st.type = v; }
    ));
    raritySelHost.appendChild(mkSelect(
      "plutonium-items-rarity-filter", { value: "", label: "Any rarity" },
      st.facets.rarities.map((r) => ({ value: r.id, label: `${r.id} (${r.count})` })),
      (v) => { st.rarity = v; }
    ));
    sourceSelHost.appendChild(mkSelect(
      "plutonium-items-source-filter", { value: "", label: "Any source" },
      st.facets.sources.map((s) => ({ value: s.id, label: `${s.id} (${s.count})` })),
      (v) => { st.source = v; }
    ));
  }

  async function fetchPage(reset) {
    if (reset) { st.offset = 0; st.rows = []; }
    st.loading = true;
    paintFooter();
    const params = new URLSearchParams();
    if (st.query.trim()) params.set("query", st.query.trim());
    if (st.type) params.set("type", st.type);
    if (st.rarity) params.set("rarity", st.rarity);
    if (st.source) params.set("source", st.source);
    params.set("offset", String(st.offset));
    params.set("limit", String(PAGE_SIZE));
    try {
      const r = await api(`/api/combat-planning/plutonium-items?${params}`);
      st.installed = r.installed;
      st.total = r.total;
      st.facets = st.facets || r.facets;
      st.rows = st.rows.concat(r.rows || []);
      st.offset = st.rows.length;
      buildFacetSelects();
    } catch { st.installed = st.installed ?? false; }
    st.loading = false;
    paintRows();
    paintFooter();
  }

  function paintRows() {
    rowsHost.innerHTML = "";
    const countEl = headRow.querySelector('[data-testid="plutonium-items-shelf-count"]');
    if (st.installed === false) {
      countEl.textContent = "";
      rowsHost.appendChild(el("div", {
        testid: "plutonium-items-not-installed",
        text: "Plutonium isn't installed in this Foundry data directory — nothing to browse. Install the Plutonium module and its bundled 5etools item data appears here automatically.",
        style: "padding: 16px; border: 1px dashed oklch(0.86 0.010 80); border-radius: 4px; font-size: 12px; color: oklch(0.56 0.012 70);"
      }));
      return;
    }
    countEl.textContent = `${st.total} matching`;
    if (!st.rows.length) {
      rowsHost.appendChild(el("div", { text: "Nothing matches that. Loosen the search or a filter.", style: "font-size: 12px; color: oklch(0.56 0.012 70); padding: 8px 0;" }));
      return;
    }
    for (const r of st.rows) rowsHost.appendChild(plutoniumItemRow(r));
  }

  function paintFooter() {
    footerHost.innerHTML = "";
    if (st.installed === false) return;
    if (st.loading) {
      footerHost.appendChild(el("div", { text: "Loading…", style: "font-size: 11.5px; color: oklch(0.58 0.012 70);" }));
      return;
    }
    if (st.rows.length < st.total) {
      const more = el("div", {
        testid: "plutonium-items-show-more-btn",
        text: `Show more (${st.rows.length} of ${st.total})`,
        style: "display: inline-block; padding: 6px 14px; border: 1px solid oklch(0.84 0.010 80); border-radius: 5px; cursor: pointer; font-size: 12px; color: oklch(0.44 0.050 25); background: oklch(0.975 0.006 85);"
      });
      more.addEventListener("click", () => fetchPage(false));
      footerHost.appendChild(more);
    }
  }

  function plutoniumItemRow(r) {
    const statBits = [
      r.type ? r.type : null,
      r.rarity && r.rarity !== "none" ? r.rarity : null,
      r.reqAttune ? "attunement" : null,
      r.isBase ? "mundane" : null
    ].filter(Boolean).join(" · ");
    const row = el("div", {
      testid: "plutonium-item-row",
      "data-name": r.name,
      "data-source": r.source ?? "",
      style: "display: flex; align-items: baseline; gap: 10px; padding: 6px 10px; border: 1px solid oklch(0.90 0.010 80); border-left: 3px solid oklch(0.78 0.070 25); border-radius: 4px; background: oklch(0.985 0.005 85);"
    }, [
      el("span", { testid: "plutonium-item-row-name", text: r.name, style: "font-family: Spectral, serif; font-size: 14.5px; font-weight: 500; flex: none;" }),
      el("span", { text: statBits, style: "font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; color: oklch(0.52 0.014 65); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" }),
      el("span", {
        testid: "plutonium-item-row-source",
        text: `${r.source ?? "?"}${r.page != null ? ` p${r.page}` : ""}`,
        style: "font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; color: oklch(0.40 0.10 25); flex: none;"
      })
    ]);
    row.appendChild(buildPlutoniumItemRowAction(r));
    return row;
  }

  // THE one explicit bridge from the read-only Plutonium `items` family onto
  // the curated Reliquary (POST .../items/add-from-plutonium; server-side
  // dedupe guard -> 409 reads back as "already on the shelf"). An
  // already-added item renders the quiet "on shelf" marker instead of the
  // button (matched against the CURATED items this ctx was built with --
  // a fresh Reliquary render after adding recomputes this from scratch, same
  // as the Bestiary shelf's own dedupe-marker convention).
  function buildPlutoniumItemRowAction(r) {
    const provenance = `${r.source ?? "?"}${r.page != null ? ` p${r.page}` : ""} via Plutonium`;
    const alreadyOnShelf = (data.items || []).some(
      (i) => i.status !== "discarded" && i.name === r.name && i.sourceText === provenance
    );
    if (alreadyOnShelf) {
      return el("span", {
        testid: "plutonium-item-row-on-shelf",
        text: "✓ on shelf",
        title: "Already on the Reliquary shelf",
        style: "flex: none; font-family: 'IBM Plex Mono', monospace; font-size: 9px; color: oklch(0.48 0.09 150); padding: 2px 8px; border: 1px solid oklch(0.80 0.070 150); border-radius: 20px; background: oklch(0.96 0.020 150);"
      });
    }
    const btn = el("span", {
      testid: "plutonium-item-row-add-btn",
      text: "+ shelf",
      title: "Adds this item to the Reliquary. Pushing an actual Foundry item stays a separate act.",
      style: "flex: none; font-family: 'IBM Plex Mono', monospace; font-size: 9px; color: oklch(0.40 0.10 25); padding: 2px 8px; border: 1px dashed oklch(0.78 0.070 25); border-radius: 20px; cursor: pointer; white-space: nowrap;"
    });
    btn.addEventListener("click", async () => {
      btn.textContent = "adding…";
      try {
        await api("/api/combat-planning/items/add-from-plutonium", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ world, name: r.name, source: r.source })
        });
        showUndoToast(`"${r.name}" added to the Reliquary.`, () => {});
        await renderLibrarySurface("reliquary"); // a NEW curated item exists -- full reload, same as the Bestiary shelf's own convention
      } catch (err) {
        if (err.status === 409) {
          showUndoToast(`"${r.name}" is already on the shelf.`, () => {});
          btn.textContent = "already on shelf";
        } else {
          btn.textContent = "+ shelf";
          btn.title = `Could not add: ${err.message}`;
        }
      }
    });
    return btn;
  }

  fetchPage(true);
  return section;
}

// ===========================================================================
// RELIQUARY + STAGECRAFT — ONE shared tagged-shelf renderer
// ===========================================================================
function buildShelf(ctx, which) {
  const { world, data, subbar, bodyRow } = ctx;
  const isReliquary = which === "reliquary";
  const st = {
    rows: normalizeShelf(isReliquary ? data.items : data.stagecraft, isReliquary),
    query: "",
    tagFilter: [],
    kind: "all",
    tagFor: null
  };

  // filter controls: search (+ stagecraft kind filter)
  const controls = el("div", { style: "display: flex; align-items: center; gap: 10px;" });
  const search = el("input", {
    testid: "tagged-shelf-search-input",
    placeholder: isReliquary ? "Find an item…" : "Find a map, image, or track…",
    style: "width: 240px; padding: 5px 10px; border: 1px solid oklch(0.84 0.010 80); border-radius: 6px; font-family: inherit; font-size: 12.5px; background: oklch(1 0 0); color: inherit;"
  });
  search.addEventListener("input", () => { st.query = search.value; paintRows(); });
  controls.appendChild(search);
  if (!isReliquary) {
    const kindFilter = el("div", { testid: "library-stagecraft-kind-filter", style: "display: flex; gap: 3px; padding: 2px; border: 1px solid oklch(0.86 0.010 80); border-radius: 6px; background: oklch(0.965 0.006 85);" });
    for (const k of [{ id: "all", label: "All" }, { id: "map", label: "Maps" }, { id: "splash", label: "Splash art" }, { id: "music", label: "Music" }]) {
      const chip = el("div", { testid: "library-stagecraft-kind-chip", "data-kind": k.id, text: k.label, style: kindChipStyle(st.kind === k.id) });
      chip.addEventListener("click", () => {
        st.kind = k.id;
        for (const c of kindFilter.children) c.setAttribute("style", kindChipStyle(false));
        chip.setAttribute("style", kindChipStyle(true));
        paintTagRail(); paintRows();
      });
      kindFilter.appendChild(chip);
    }
    controls.appendChild(kindFilter);
  }
  subbar.appendChild(controls);

  // body: tag rail (268) | rows main
  const root = el("div", { testid: isReliquary ? "library-reliquary-root" : "library-stagecraft-root", style: "display: flex; flex: 1; min-height: 0;" });

  const leftRail = el("div", { style: "width: 268px; flex: none; border-right: 1px solid oklch(0.87 0.010 80); background: oklch(0.938 0.009 85); display: flex; flex-direction: column; min-height: 0;" });
  leftRail.appendChild(el("div", { style: "padding: 13px 14px 8px;" }, [
    el("div", { text: "Tags", style: "font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: oklch(0.53 0.012 70);" }),
    el("div", { text: isReliquary ? "Filter by tag. Add your own on any row — they stick and they search." : "Filter by tag. Stack two to narrow (e.g. vault + combat).", style: "font-size: 11.5px; color: oklch(0.56 0.012 70); line-height: 1.45; margin-top: 6px;" })
  ]));
  const tagRail = el("div", { testid: "tagged-shelf-tag-rail", style: "flex: 1; overflow-y: auto; padding: 0 10px 14px; min-height: 0; display: flex; flex-wrap: wrap; gap: 5px; align-content: flex-start;" });
  const clearHost = el("div", {});
  const trayHost = el("div", { style: "border-top: 1px solid oklch(0.88 0.010 80); flex: none;" });
  leftRail.append(tagRail, clearHost, trayHost);
  mountSceneTray(trayHost, { world });

  const main = el("div", { style: "flex: 1; min-width: 0; overflow-y: auto; padding: 22px 28px 44px;" });
  const header = el("div", {});
  const rowsHost = el("div", { style: "display: flex; flex-direction: column; gap: 6px;" });
  const emptyHost = el("div", {});
  // QA W2 fix (Group D #19): "write one by hand" for both shelves sharing
  // this renderer -- Reliquary (name/type/description -> item-store,
  // accepted, no Foundry refs) and Stagecraft (name/kind/desc -> the store's
  // own pre-existing hand-added convention, see saveStagecraftAsset's
  // default status:'accepted'/source:'local'). `reload()` (below) is the
  // SAME refresh this shelf already uses after a tag add/remove -- no new
  // refresh mechanism.
  const handAddForm = isReliquary
    ? buildHandAddForm({
        rootTestid: "library-reliquary-hand-add",
        fields: [
          { key: "name", label: "Name", width: "170px" },
          { key: "type", label: "Type", width: "120px" },
          { key: "description", label: "Description", width: "240px" }
        ],
        onSubmit: async (v) => {
          await api("/api/combat-planning/items/hand-add", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ world, name: v.name, type: v.type || undefined, description: v.description || undefined })
          });
          await reload();
        }
      })
    : buildHandAddForm({
        rootTestid: "library-stagecraft-hand-add",
        fields: [
          { key: "name", label: "Name", width: "170px" },
          { key: "kind", label: "Kind", width: "110px", type: "select", options: [
            { value: "map", label: "Map" }, { value: "splash", label: "Splash art" }, { value: "music", label: "Music" }
          ] },
          { key: "desc", label: "Description", width: "240px" },
          // W3a: the asset's real file path/URL as Foundry resolves it -- the
          // durable record the Kilmarn exercise had to fake in `desc`.
          { key: "src", label: "File path", width: "240px", placeholder: "worlds/…/maps/x.webp or URL" }
        ],
        onSubmit: async (v) => {
          await api("/api/session-planner/stagecraft/hand-add", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ world, name: v.name, kind: v.kind, desc: v.desc || undefined, src: v.src || undefined })
          });
          await reload();
        }
      });
  const footer = el("div", { style: "display: flex; align-items: center; gap: 12px; margin-top: 16px;" }, [
    pullButton(isReliquary ? "Pull items from Foundry" : "Pull scenes, art, and playlists from Foundry"),
    el("div", { text: isReliquary ? "Descriptions come across from Foundry when the item has one." : "Files stay in Foundry; these are refs.", style: "font-size: 11.5px; color: oklch(0.60 0.012 70);" }),
    handAddForm
  ]);
  main.append(header, rowsHost, emptyHost, footer);
  // "Aureus to the Table" task G6 -- Reliquary-only, BELOW the curated list
  // and never mixed into it (the same separate-source-LAYER rule the
  // Bestiary tab's own Plutonium shelf follows). Stagecraft has no
  // equivalent Plutonium family wired to a route/UI yet -- out of scope here.
  if (isReliquary) main.appendChild(buildPlutoniumItemsShelf(ctx));

  root.append(leftRail, main);
  bodyRow.appendChild(root);

  // --- data helpers ---
  function pool() {
    return st.rows.filter((r) => (isReliquary || st.kind === "all") ? true : r.kind === st.kind);
  }
  function visibleRows() {
    const q = st.query.trim().toLowerCase();
    return pool().filter((r) => {
      if (st.tagFilter.some((t) => r.tags.indexOf(t) < 0)) return false;
      if (!q) return true;
      return (r.name + " " + (r.desc || "") + " " + r.tags.join(" ")).toLowerCase().includes(q);
    });
  }
  function tagCounts() {
    const counts = {};
    for (const r of pool()) for (const t of r.tags) counts[t] = (counts[t] || 0) + 1;
    return counts;
  }

  async function reload() {
    // Re-fetch the mutated list so a tag add/remove reflects real persisted state.
    try {
      if (isReliquary) {
        const r = await api(`/api/combat-planning/items?world=${encodeURIComponent(world)}`);
        st.rows = normalizeShelf(r.items || [], true);
      } else {
        const r = await api(`/api/session-planner/stagecraft?world=${encodeURIComponent(world)}`);
        st.rows = normalizeShelf(r.assets || [], false);
      }
    } catch { /* keep current */ }
    paintTagRail(); paintRows();
  }

  async function addTag(id, tag) {
    const v = tag.trim().toLowerCase();
    if (!v) return;
    const path = isReliquary
      ? `/api/combat-planning/items/${encodeURIComponent(id)}/tags`
      : `/api/session-planner/stagecraft/${encodeURIComponent(id)}/tags`;
    try { await api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ world, tag: v }) }); }
    catch { /* ignore */ }
    await reload();
  }
  async function removeTag(id, tag) {
    const path = isReliquary
      ? `/api/combat-planning/items/${encodeURIComponent(id)}/tags/${encodeURIComponent(tag)}`
      : `/api/session-planner/stagecraft/${encodeURIComponent(id)}/tags/${encodeURIComponent(tag)}`;
    try { await api(path, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ world }) }); }
    catch { /* ignore */ }
    st.tagFilter = st.tagFilter.filter((t) => t !== tag);
    await reload();
  }

  // --- paint ---
  function paintTagRail() {
    tagRail.innerHTML = "";
    const counts = tagCounts();
    for (const t of Object.keys(counts).sort()) {
      const on = st.tagFilter.indexOf(t) >= 0;
      const chip = el("div", {
        testid: "tagged-shelf-tag-chip",
        "data-tag": t,
        style: `display: flex; align-items: center; gap: 6px; padding: 3px 9px; border: 1px solid ${on ? TEAL : "oklch(0.86 0.010 80)"}; border-radius: 20px; cursor: pointer; font-size: 11.5px; background: ${on ? "oklch(0.93 0.030 185)" : "oklch(0.965 0.006 85)"}; color: ${on ? "oklch(0.30 0.060 185)" : "oklch(0.50 0.014 65)"};`
      }, [
        el("span", { text: t }),
        el("span", { testid: "tagged-shelf-tag-chip-count", text: String(counts[t]), style: "font-family: 'IBM Plex Mono', monospace; font-size: 9px; opacity: 0.7;" })
      ]);
      chip.addEventListener("click", () => {
        st.tagFilter = on ? st.tagFilter.filter((x) => x !== t) : st.tagFilter.concat([t]);
        paintTagRail(); paintRows();
      });
      tagRail.appendChild(chip);
    }
    // clear button
    clearHost.innerHTML = "";
    if (st.tagFilter.length) {
      const clear = el("div", { testid: "tagged-shelf-clear-tags-btn", text: "Clear tag filter", style: "padding: 8px 14px; font-size: 11.5px; color: oklch(0.50 0.075 185); cursor: pointer; border-top: 1px solid oklch(0.90 0.010 80);" });
      clear.addEventListener("click", () => { st.tagFilter = []; paintTagRail(); paintRows(); });
      clearHost.appendChild(clear);
    }
  }

  function paintHeader() {
    const rows = visibleRows();
    header.innerHTML = "";
    header.append(
      el("div", { style: "display: flex; align-items: baseline; gap: 11px; margin-bottom: 4px;" }, [
        el("div", { text: isReliquary ? "The Reliquary" : "Stagecraft", style: "font-family: Spectral, serif; font-size: 25px; font-weight: 500;" }),
        el("div", { text: `${rows.length} of ${pool().length} ${isReliquary ? "items" : "pieces"}`, style: "font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: oklch(0.60 0.012 70);" })
      ]),
      el("div", { text: isReliquary ? "Things the party can hold, read, or steal. Tag it, find it, hand it to a scene." : "Maps, splash art, and music — kept as references; the files stay in Foundry. This is how you find the right one mid-session.", style: "font-size: 12.5px; color: oklch(0.52 0.014 65); margin-bottom: 16px; max-width: 68ch; line-height: 1.5;" })
    );
  }

  function paintRows() {
    paintHeader();
    rowsHost.innerHTML = "";
    emptyHost.innerHTML = "";
    const rows = visibleRows();
    if (!rows.length) {
      emptyHost.appendChild(el("div", { text: "Nothing matches that. Loosen the search or clear a tag.", style: "padding: 26px; border: 1px dashed oklch(0.86 0.010 80); border-radius: 4px; font-size: 12.5px; color: oklch(0.56 0.012 70); text-align: center;" }));
      return;
    }
    for (const r of rows) rowsHost.appendChild(shelfRow(r));
  }

  function shelfRow(r) {
    const k = KINDS[r.kind] || KINDS.item;
    const row = el("div", {
      testid: "tagged-shelf-row",
      "data-item-id": r.id,
      "data-kind": r.kind,
      draggable: "true",
      title: "Drag onto a scene at left to hand it to that scene",
      style: `display: flex; align-items: flex-start; gap: 12px; padding: 10px 13px; border: 1px solid oklch(0.88 0.010 80); border-left: 3px solid ${k.accent}; border-radius: 4px; background: oklch(0.985 0.005 85); cursor: grab;`
    });
    row.addEventListener("dragstart", (ev) => {
      if (ev.dataTransfer) { ev.dataTransfer.effectAllowed = "copy"; ev.dataTransfer.setData("text/plain", r.id); }
      setTrayDragPayload({ kind: "asset", id: r.id });
    });
    row.addEventListener("dragend", () => setTrayDragPayload(null));

    // Phase 38 task 38.2, §3 -- a compendium browse row's thumb (when the
    // pack entry carried one) renders in place of the plain kind glyph, a
    // quiet visual "this one has a real preview" cue; every other row (no
    // thumb) keeps the existing glyph unchanged.
    if (r.thumb) {
      row.appendChild(el("img", {
        testid: "tagged-shelf-row-thumb",
        src: r.thumb,
        alt: "",
        style: "width: 30px; height: 30px; object-fit: cover; border-radius: 3px; flex: none; border: 1px solid oklch(0.85 0.010 80);"
      }));
    } else {
      row.appendChild(el("span", { text: k.glyph, style: `font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: ${k.accent}; padding-top: 2px; flex: none;` }));
    }

    const bodyCol = el("div", { style: "flex: 1; min-width: 0;" });
    const topRowChildren = [
      el("span", { text: r.name, style: "font-family: Spectral, serif; font-size: 16px; font-weight: 500;" }),
      el("span", { text: k.label + (r.meta ? " · " + r.meta : ""), style: "font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; color: oklch(0.60 0.012 70);" }),
      el("span", { style: "flex: 1;" }),
      sourcePill(r.source)
    ];
    // Phase 38 task 38.2, §2 -- a loose world item (no owning actor/party
    // member) gets a quiet provenance marker instead of an owner link line
    // (this view has never rendered one -- "unowned renders cleanly" is
    // structural, this is purely the added quiet-text).
    if (r.worldItem) {
      topRowChildren.push(el("span", {
        testid: "tagged-shelf-row-world-item-badge",
        text: "world item",
        title: "Pulled from Foundry's loose world items -- not carried by any actor",
        style: "font-family: 'IBM Plex Mono', monospace; font-size: 8.5px; letter-spacing: 0.04em; color: oklch(0.55 0.012 70); font-style: italic;"
      }));
    }
    // Phase 38 task 38.4 -- Russell's catalog tier: an external-catalog map
    // pack that isn't installed in Foundry yet. Visible/searchable so the
    // whole catalog is suggestible; badged so it can't be mistaken for a
    // stageable map ("load them in later if they become useful" -- his call).
    if (r.catalogOnly) {
      topRowChildren.push(el("span", {
        testid: "tagged-shelf-row-catalog-badge",
        text: "in catalog — not installed",
        title: "Known from the map catalog but not installed in Foundry yet — ask to install this pack to make its scenes importable",
        style: "font-family: 'IBM Plex Mono', monospace; font-size: 8.5px; letter-spacing: 0.04em; color: oklch(0.55 0.10 65); font-style: italic;"
      }));
    }
    // Phase 35.5a: Reliquary-only (Stagecraft rows never carry graphEntityId).
    if (r.kind === "item") {
      topRowChildren.push(graphPromoteAffordance(r, async (btn) => {
        btn.style.opacity = "0.6";
        try {
          await api(`/api/combat-planning/items/${encodeURIComponent(r.id)}/promote-to-graph`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ world })
          });
        } catch { /* leave the affordance clickable to retry */ }
        await reload();
      }));
      // "Aureus to the Table" task G8 -- Push to Foundry / "in Foundry" pill,
      // plus the "-> into <owner>'s inventory" secondary option.
      topRowChildren.push(reliquaryFoundryPushElement(r, world, data, reload));
    }
    bodyCol.appendChild(el("div", { style: "display: flex; align-items: baseline; gap: 9px; flex-wrap: wrap;" }, topRowChildren));
    if (r.desc) bodyCol.appendChild(el("div", { text: r.desc, style: "font-size: 12px; color: oklch(0.48 0.014 65); line-height: 1.45; margin-top: 5px; max-width: 78ch;" }));
    else bodyCol.appendChild(el("div", { text: "No description came across from Foundry.", style: "font-size: 11.5px; color: oklch(0.64 0.012 70); font-style: italic; margin-top: 5px;" }));

    // W3a: Stagecraft-only src line -- the asset's real file path/URL,
    // click-to-edit (POST .../stagecraft/:id/src). A Foundry-pulled asset
    // that carries no explicit `src` still shows its foundryRef.imagePath as
    // a read-only hint (that path IS where its file lives) -- only the `src`
    // field itself is editable.
    if (!isReliquary) {
      const srcLine = el("div", { style: "display: flex; align-items: center; gap: 7px; margin-top: 5px;" });
      const paintSrc = () => {
        srcLine.innerHTML = "";
        const shown = r.src || r.foundryImagePath || null;
        srcLine.appendChild(el("span", {
          testid: "tagged-shelf-row-src",
          "data-item-id": r.id,
          text: shown ? `⛁ ${shown}` : "⛁ no file path recorded",
          title: r.src ? "This asset's file path/URL (as Foundry resolves it)" : (shown ? "Path from the Foundry pull (foundryRef.imagePath)" : "No file path recorded for this asset yet"),
          style: `font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: ${shown ? "oklch(0.46 0.014 65)" : "oklch(0.64 0.012 70)"}; ${shown ? "" : "font-style: italic;"} overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60ch;`
        }));
        const editBtn = el("span", {
          testid: "tagged-shelf-row-src-edit-btn",
          text: r.src ? "✎ edit path" : "✎ set path",
          style: "font-size: 10.5px; color: oklch(0.50 0.075 185); cursor: pointer; white-space: nowrap;"
        });
        editBtn.addEventListener("click", () => {
          const input = el("input", {
            testid: "tagged-shelf-row-src-input",
            value: r.src || "",
            placeholder: "worlds/…/maps/x.webp or URL",
            style: "width: 320px; padding: 2px 8px; border: 1px solid oklch(0.72 0.045 185); border-radius: 4px; font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; background: oklch(1 0 0); color: inherit;"
          });
          const commit = async () => {
            const v = input.value.trim();
            try {
              const { asset } = await api(`/api/session-planner/stagecraft/${encodeURIComponent(r.id)}/src`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ world, src: v || null })
              });
              r.src = asset.src ?? null;
            } catch { /* keep the old value */ }
            paintSrc();
          };
          input.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") commit();
            else if (ev.key === "Escape") paintSrc();
          });
          srcLine.innerHTML = "";
          srcLine.appendChild(input);
          input.focus();
        });
        srcLine.appendChild(editBtn);
      };
      paintSrc();
      bodyCol.appendChild(srcLine);
    }

    const tagsRow = el("div", { style: "display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; align-items: center;" });
    for (const t of r.tags) {
      const on = st.tagFilter.indexOf(t) >= 0;
      const tag = el("span", {
        testid: "tagged-shelf-row-tag",
        "data-tag": t,
        style: `display: flex; align-items: center; gap: 5px; padding: 2px 8px; border: 1px solid ${on ? TEAL : "oklch(0.88 0.010 80)"}; border-radius: 20px; background: ${on ? "oklch(0.93 0.030 185)" : "oklch(0.955 0.006 85)"}; font-size: 11px; color: ${on ? "oklch(0.30 0.060 185)" : "oklch(0.48 0.014 65)"};`
      });
      const label = el("span", { text: t, style: "cursor: pointer;" });
      label.addEventListener("click", () => {
        st.tagFilter = on ? st.tagFilter.filter((x) => x !== t) : st.tagFilter.concat([t]);
        paintTagRail(); paintRows();
      });
      const rm = el("span", { testid: "tagged-shelf-row-tag-remove", text: "✕", style: "font-size: 9px; cursor: pointer; color: oklch(0.62 0.012 70);" });
      rm.addEventListener("click", (ev) => { ev.stopPropagation(); removeTag(r.id, t); });
      tag.append(label, rm);
      tagsRow.appendChild(tag);
    }
    // + tag inline add
    const addBtn = el("span", { testid: "tagged-shelf-row-add-tag-btn", text: "+ tag", style: "padding: 2px 8px; border: 1px dashed oklch(0.83 0.010 80); border-radius: 20px; font-size: 11px; color: oklch(0.58 0.012 70); cursor: pointer;" });
    addBtn.addEventListener("click", () => {
      const input = el("input", { testid: "tagged-shelf-row-tag-input", placeholder: "tag…", style: "width: 120px; padding: 2px 9px; border: 1px solid oklch(0.72 0.045 185); border-radius: 20px; font-family: inherit; font-size: 11px; background: oklch(1 0 0); color: inherit;" });
      let committed = false;
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { committed = true; addTag(r.id, input.value); }
        else if (ev.key === "Escape") { input.replaceWith(addBtn); }
      });
      input.addEventListener("blur", () => { if (!committed && input.isConnected) input.replaceWith(addBtn); });
      addBtn.replaceWith(input);
      input.focus();
    });
    tagsRow.appendChild(addBtn);
    bodyCol.appendChild(tagsRow);

    // "Aureus to the Table" task G8 -- the "lostech…" local-overrides editor,
    // Reliquary-items only, behind its own per-row toggle (never opened by default).
    if (isReliquary && r.kind === "item") {
      bodyCol.appendChild(reliquaryLostechEditor(r, world));
    }

    row.appendChild(bodyCol);
    return row;
  }

  paintTagRail();
  paintRows();
}

function normalizeShelf(list, isReliquary) {
  return (list || [])
    .filter((r) => r.status !== "discarded")
    .map((r) => isReliquary
      ? {
          id: r.id, kind: "item", name: r.name,
          meta: [r.type, r.quantity > 1 ? `×${r.quantity}` : null].filter(Boolean).join(" · "),
          desc: r.description, tags: r.tags || [],
          source: r.foundryItemRef ? "foundry" : "mine",
          // Phase 35.5a: carried through so shelfRow can render the
          // promote-to-graph affordance / "in the graph" marker. Absent on
          // Stagecraft rows (undefined -- falsy, same as null).
          graphEntityId: r.graphEntityId ?? null,
          // Phase 38 task 38.2, §2 -- a loose Foundry world item (no owning
          // actor/party member -- foundry-pull-ops.mjs's worldItems[] loop)
          // renders a quiet "world item" provenance instead of an owner
          // link line (there IS no owner link line anywhere in this view
          // today -- an actor-owned item's ownerPartyMemberId isn't
          // rendered either -- so "unowned renders cleanly" already holds
          // structurally; this flag is purely the ADDED provenance quiet-text).
          worldItem: !!r.foundryItemRef && !r.ownerPartyMemberId && !r.ownerFoundryActorUuid,
          // "Aureus to the Table" task G8 -- carried through raw (not
          // reshaped) for the Push-to-Foundry affordance + lostech overrides
          // editor in shelfRow below.
          foundryItemRef: r.foundryItemRef ?? null,
          pushOverrides: r.pushOverrides ?? null,
          ownerPartyMemberId: r.ownerPartyMemberId ?? null,
          ownerFoundryActorUuid: r.ownerFoundryActorUuid ?? null,
          sourceText: r.sourceText ?? null
        }
      : {
          id: r.id, kind: r.kind, name: r.name, meta: r.meta,
          desc: r.desc, tags: r.tags || [],
          source: r.source === "foundry" ? "foundry" : "mine",
          // Phase 38 task 38.2, §3 -- a not-yet-imported compendium browse
          // row (compendiumRef set, foundryRef still null) carries a thumb
          // through for the shelf row's own quiet preview, when present.
          compendiumRef: r.compendiumRef ?? null,
          thumb: r.thumb ?? null,
          // Phase 38 task 38.4 (Russell's catalog tier): an external-catalog
          // pack that ISN'T installed in Foundry yet -- browsable so nothing
          // scanning the library is blind to it, badged so nobody mistakes
          // it for a stageable map.
          catalogOnly: !!r.catalogRef && !r.compendiumRef && !r.foundryRef,
          // W3a: the asset's real file path/URL (editable), plus the
          // Foundry pull's own imagePath as a read-only fallback hint.
          src: r.src ?? null,
          foundryImagePath: r.foundryRef?.imagePath ?? null
        });
}

// ---------------------------------------------------------------------------
// "Aureus to the Table" task G8 -- the shared direct-Foundry-push button,
// used by both the curated Bestiary's "Import to Foundry" (buildBestiary's
// paintStatRail) and the Reliquary's "Push to Foundry" (shelfRow below).
// Deliberately a THIN, generic button (label/title/onPush caller-supplied)
// rather than graphPromoteAffordance's fixed badge-vs-button toggle: the two
// push actions differ in what "already pushed" looks like on their own row
// (foundryItemRef vs foundryActorRef, plus the Reliquary's overrides editor
// living alongside it) enough that the CALLER decides whether/what to render
// once pushed, instead of this helper owning that state.
// ---------------------------------------------------------------------------
function foundryPushButton({ testid, label, title, onPush }) {
  const btn = el("span", {
    testid,
    text: label,
    title,
    style: "flex: none; font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: 0.04em; color: oklch(0.44 0.050 185); padding: 2px 8px; border: 1px dashed oklch(0.72 0.045 185); border-radius: 20px; cursor: pointer; white-space: nowrap;"
  });
  btn.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    const original = btn.textContent;
    btn.textContent = "pushing…";
    btn.style.opacity = "0.6";
    try {
      await onPush();
    } catch (err) {
      btn.textContent = original;
      btn.style.opacity = "1";
      showUndoToast(err.status === 409 ? "Already in Foundry — remove it there first if you want a re-push." : `Could not push: ${err.message}`, () => {});
    }
  });
  return btn;
}

/** The quiet, already-pushed marker every foundryPushButton caller swaps to once a ref is confirmed -- mirrors graphPromoteAffordance's own badge styling. */
function foundryPushedBadge(testid, text, title) {
  return el("span", {
    testid,
    text,
    title,
    style: "flex: none; padding: 2px 8px; border-radius: 20px; font-family: 'IBM Plex Mono', monospace; font-size: 8.5px; letter-spacing: 0.04em; color: oklch(0.44 0.050 185); background: oklch(0.94 0.020 185); border: 1px solid oklch(0.80 0.035 185); white-space: nowrap;"
  });
}

/**
 * "Aureus to the Table" task G8 -- Reliquary row Push-to-Foundry. Renders
 * the quiet "in Foundry" pill once `r.foundryItemRef` is set (written only
 * on a confirmed-applied push, per foundry-item-push-ops.mjs's own
 * contract); otherwise a `foundryPushButton` plus, when the item's owning
 * party member (r.ownerPartyMemberId) carries a `foundryActorRef` of its
 * own, a secondary "-> into <name>'s inventory" option that composes the
 * SAME push with an explicit `actorUuid`.
 */
function reliquaryFoundryPushElement(r, world, data, reload) {
  if (r.foundryItemRef) {
    return foundryPushedBadge("tagged-shelf-row-in-foundry-badge", "in Foundry", "This item has a real Foundry document.");
  }
  const wrap = el("span", { style: "display: inline-flex; align-items: center; gap: 7px;" });

  async function doPush(actorUuid, onOk) {
    const result = await api("/api/foundry/push-item", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world, itemId: r.id, ...(actorUuid ? { actorUuid } : {}) })
    });
    if (result.status === "queued") {
      showUndoToast(`"${r.name}" is queued — no live Foundry client picked it up yet.`, () => {});
      return;
    }
    if (!result.ok) {
      showUndoToast(`Foundry reported a failure: ${result.error}`, () => {});
      return;
    }
    showUndoToast(`"${r.name}" pushed to Foundry.`, () => {});
    await onOk();
  }

  wrap.appendChild(foundryPushButton({
    testid: "tagged-shelf-row-push-btn",
    label: "Push to Foundry",
    title: "Pushes this item straight from here — a Plutonium-sourced row imports at Plutonium's own conversion fidelity, a hand-authored row pushes a minimal item. Needs a live Foundry client (with Plutonium enabled for the Plutonium-sourced path).",
    onPush: () => doPush(undefined, reload)
  }));

  const owner = r.ownerPartyMemberId ? (data.party || []).find((m) => m.id === r.ownerPartyMemberId) : null;
  if (owner?.foundryActorRef) {
    const intoBtn = el("span", {
      testid: "tagged-shelf-row-push-into-actor-btn",
      text: `→ into ${owner.name}'s inventory`,
      title: `Pushes this item directly into ${owner.name}'s Foundry actor sheet instead of the world items list.`,
      style: "font-size: 10.5px; color: oklch(0.50 0.075 185); cursor: pointer; white-space: nowrap;"
    });
    intoBtn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const original = intoBtn.textContent;
      intoBtn.textContent = "pushing…";
      try {
        await doPush(owner.foundryActorRef, reload);
      } catch (err) {
        intoBtn.textContent = original;
        showUndoToast(err.status === 409 ? "Already in Foundry — remove it there first if you want a re-push." : `Could not push: ${err.message}`, () => {});
      }
    });
    wrap.appendChild(intoBtn);
  }
  return wrap;
}

/**
 * "Aureus to the Table" task G8 -- the Reliquary row's "lostech…" toggle +
 * inline overrides editor (item-store.mjs's PushOverridesSchema). Closed by
 * default, per row. `recharges` defaults OFF in the UI (unchecked) even when
 * the row carries no overrides yet -- Russell's own design driver ("the
 * lostech default is scarcity"), stated again as a one-line hint in the
 * panel itself. `descriptionNote` is saved but never pushed (see
 * foundry-item-push-ops.mjs's header for why) -- labelled honestly.
 */
function reliquaryLostechEditor(r, world) {
  const wrap = el("div", { style: "margin-top: 8px;" });
  const toggleLabel = () => (r.pushOverrides ? "lostech overrides set…" : "lostech…");
  const toggle = el("span", {
    testid: "tagged-shelf-row-lostech-toggle",
    text: toggleLabel(),
    style: "font-size: 10.5px; color: oklch(0.50 0.075 185); cursor: pointer; text-decoration: underline dotted; text-underline-offset: 2px;"
  });
  const panelHost = el("div", {});
  wrap.append(toggle, panelHost);

  let open = false;
  toggle.addEventListener("click", (ev) => {
    ev.stopPropagation();
    open = !open;
    panelHost.innerHTML = "";
    if (open) panelHost.appendChild(buildPanel());
  });

  function fieldBox(testid, label, input) {
    const box = el("div", { testid, style: "display: flex; flex-direction: column; gap: 3px;" });
    box.append(
      el("label", { text: label, style: "font-family: 'IBM Plex Mono', monospace; font-size: 8.5px; letter-spacing: 0.05em; text-transform: uppercase; color: oklch(0.53 0.012 70);" }),
      input
    );
    return box;
  }

  function buildPanel() {
    const ov = r.pushOverrides || {};
    const inputStyle = "padding: 4px 7px; border: 1px solid oklch(0.84 0.010 80); border-radius: 4px; font: inherit; font-size: 11.5px; background: oklch(1 0 0); color: inherit;";
    const nameInput = el("input", { testid: "tagged-shelf-row-lostech-displayName", type: "text", value: ov.displayName || "", style: `${inputStyle} width: 170px;` });
    const valueInput = el("input", { testid: "tagged-shelf-row-lostech-usesValue", type: "number", min: "0", value: ov.usesValue ?? "", style: `${inputStyle} width: 56px;` });
    const maxInput = el("input", { testid: "tagged-shelf-row-lostech-usesMax", type: "number", min: "1", value: ov.usesMax ?? "", style: `${inputStyle} width: 56px;` });
    const noteInput = el("input", { testid: "tagged-shelf-row-lostech-descriptionNote", type: "text", value: ov.descriptionNote || "", style: `${inputStyle} width: 220px;` });
    const rechargeCheckbox = el("input", { testid: "tagged-shelf-row-lostech-recharges", type: "checkbox" });
    rechargeCheckbox.checked = ov.recharges === true; // default OFF -- scarcity is the lostech default

    const rechargeRow = el("label", { style: "display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: oklch(0.48 0.014 65); padding-bottom: 4px;" }, [
      rechargeCheckbox,
      el("span", { text: "recharges on rest" })
    ]);
    const hint = el("div", {
      text: "Lostech default is scarcity — leave \"recharges on rest\" unchecked unless this is TRUE lostech (it still recharges).",
      style: "font-size: 10.5px; color: oklch(0.58 0.012 70); flex-basis: 100%; line-height: 1.4;"
    });
    const noteHint = el("div", {
      text: "Saved, but not pushed yet — Foundry's own item description isn't read back here to append to.",
      style: "font-size: 10px; color: oklch(0.62 0.012 70); font-style: italic; flex-basis: 100%;"
    });

    const saveBtn = el("span", {
      testid: "tagged-shelf-row-lostech-save-btn",
      text: "Save overrides",
      style: "padding: 5px 12px; border: 1px solid oklch(0.72 0.045 185); border-radius: 5px; font-size: 11.5px; color: oklch(0.30 0.060 185); cursor: pointer; background: oklch(0.90 0.030 185); white-space: nowrap;"
    });
    const clearBtn = el("span", {
      testid: "tagged-shelf-row-lostech-clear-btn",
      text: "Clear",
      style: "font-size: 11px; color: oklch(0.58 0.012 70); cursor: pointer; white-space: nowrap;"
    });

    async function persist(overridesOrNull) {
      try {
        const { item } = await api(`/api/combat-planning/items/${encodeURIComponent(r.id)}/push-overrides`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ world, overrides: overridesOrNull })
        });
        r.pushOverrides = item.pushOverrides;
        showUndoToast(overridesOrNull ? "Lostech overrides saved." : "Lostech overrides cleared.", () => {});
      } catch (err) {
        showUndoToast(`Could not save overrides: ${err.message}`, () => {});
      }
      open = false;
      panelHost.innerHTML = "";
      toggle.textContent = toggleLabel();
    }

    saveBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const overrides = {};
      if (nameInput.value.trim()) overrides.displayName = nameInput.value.trim();
      if (valueInput.value !== "") overrides.usesValue = Number(valueInput.value);
      if (maxInput.value !== "") overrides.usesMax = Number(maxInput.value);
      overrides.recharges = rechargeCheckbox.checked;
      if (noteInput.value.trim()) overrides.descriptionNote = noteInput.value.trim();
      persist(overrides);
    });
    clearBtn.addEventListener("click", (ev) => { ev.stopPropagation(); persist(null); });

    const panel = el("div", {
      testid: "tagged-shelf-row-lostech-panel",
      style: "display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px; margin-top: 6px; padding: 10px 12px; border: 1px dashed oklch(0.72 0.045 185); border-radius: 5px; background: oklch(0.975 0.014 185); max-width: 600px;"
    }, [
      fieldBox("tagged-shelf-row-lostech-displayName-box", "Display name", nameInput),
      fieldBox("tagged-shelf-row-lostech-usesValue-box", "Uses", valueInput),
      fieldBox("tagged-shelf-row-lostech-usesMax-box", "Max", maxInput),
      rechargeRow,
      fieldBox("tagged-shelf-row-lostech-descriptionNote-box", "Description note (not pushed yet)", noteInput),
      hint,
      noteHint,
      saveBtn,
      clearBtn
    ]);
    return panel;
  }

  return wrap;
}

// ---------------------------------------------------------------------------
// Phase 35.5a (task #44) -- "promote items of interest from the reliquary to
// the graph as nodes." Reliquary-only (r.kind === "item"; Stagecraft rows
// never carry this). Quiet, small: a dashed pill next to the source pill
// that swaps to a quiet "in the graph" marker after promotion, reusing the
// SAME "⛓ graph" glyph convention session-planner-view.js's
// scene-element-graph-badge already established for "this thing carries a
// real graph link." Phase 37.6b wires the Bestiary's OWN "Promote to a
// named world figure" affordance through this SAME function (see
// buildBestiary's paintStatRail below) rather than a second copy.
// ---------------------------------------------------------------------------
// Phase 37.6b: gained an optional `opts` param (testidPrefix/badgeText/
// badgeTitle/btnText/btnTitle) so the Bestiary's own "Promote to a named
// world figure" affordance can reuse this SAME function/glyph convention
// (per gm-tools-conventions -- "if you find yourself writing the same...
// logic twice, stop") rather than a second copy. Every default reproduces
// the Reliquary caller's EXACT pre-existing testids/copy byte-for-byte when
// `opts` is omitted -- backward compatible, that caller is unchanged below.
function graphPromoteAffordance(r, onPromote, opts = {}) {
  const testidPrefix = opts.testidPrefix ?? "tagged-shelf-row";
  const badgeText = opts.badgeText ?? "⛓ in the graph";
  const badgeTitle = opts.badgeTitle ?? "This item is linked to a graph node";
  const btnText = opts.btnText ?? "→ graph";
  const btnTitle = opts.btnTitle ?? "Promote this item to a graph node";
  if (r.graphEntityId) {
    return el("span", {
      testid: `${testidPrefix}-graph-badge`,
      "data-item-id": r.id,
      "data-graph-entity-id": r.graphEntityId,
      text: badgeText,
      title: badgeTitle,
      style: "padding: 2px 8px; border-radius: 20px; font-family: 'IBM Plex Mono', monospace; font-size: 8.5px; letter-spacing: 0.04em; color: oklch(0.44 0.050 185); background: oklch(0.94 0.020 185); border: 1px solid oklch(0.80 0.035 185); white-space: nowrap;"
    });
  }
  const btn = el("span", {
    testid: `${testidPrefix}-promote-btn`,
    "data-item-id": r.id,
    text: btnText,
    title: btnTitle,
    style: "padding: 2px 8px; border: 1px dashed oklch(0.72 0.045 185); border-radius: 20px; font-family: 'IBM Plex Mono', monospace; font-size: 8.5px; letter-spacing: 0.04em; color: oklch(0.44 0.050 185); cursor: pointer; white-space: nowrap;"
  });
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onPromote(btn);
  });
  return btn;
}

function kindChipStyle(active) {
  return `padding: 3px 10px; border-radius: 4px; font-size: 11.5px; cursor: pointer; background: ${active ? TEAL : "transparent"}; color: ${active ? "oklch(0.99 0.005 185)" : "oklch(0.48 0.014 65)"};`;
}
