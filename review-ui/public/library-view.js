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
  reskin: { label: "Reskinned", bg: "oklch(0.90 0.045 300)", fg: "oklch(0.36 0.08 300)" }
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
  { id: "stagecraft", label: "Stagecraft", glyph: "▦" }
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
const NORMALIZE = { bestiary: "bestiary", hall: "hall", reliquary: "reliquary", stagecraft: "stagecraft" };
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
    stagecraft: data.stagecraft.filter((a) => a.status !== "discarded").length
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
  else buildShelf(ctx, tab);
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
  centerScroll.append(header, grid, importRow);
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
          el("span", { testid: "library-creature-card-name", text: e.rawFields?.name || "Unnamed", style: "flex: 1; min-width: 0; font-family: Spectral, serif; font-size: 16.5px; font-weight: 500; line-height: 1.2;" }),
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

    // header
    statRail.appendChild(el("div", { style: "padding: 12px 15px; border-bottom: 1px solid oklch(0.88 0.010 80); display: flex; align-items: center; gap: 9px;" }, [
      sourcePill(e.sourcePill, "library-source-pill"),
      el("span", { text: rf.name || "Unnamed", style: "flex: 1; min-width: 0; font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" })
    ]));

    const scroll = el("div", { style: "flex: 1; overflow-y: auto; padding: 14px 15px 20px;" });
    scroll.append(
      el("div", { text: rf.name || "Unnamed", style: "font-family: Spectral, serif; font-size: 23px; font-weight: 500; line-height: 1.15;" }),
      el("div", { text: rf.type || "", style: "font-style: italic; font-family: Spectral, serif; font-size: 13px; color: oklch(0.50 0.014 65); margin-top: 3px;" })
    );

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
          worldItem: !!r.foundryItemRef && !r.ownerPartyMemberId && !r.ownerFoundryActorUuid
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
