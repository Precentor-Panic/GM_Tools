// GM Review — Phase 35 task 35.2: the SHARED scene tray component, ported from
// `design/session-planner/Library.dc.html`'s own "Drop into a scene" tray
// (the `sceneTargets` renderer + `drop:` handler, read verbatim). ONE tray
// serves all four Library surfaces ("implement once" — README §"Ported once,
// used everywhere"); this module is deliberately self-contained and exports a
// clean `mountSceneTray(host, {world})` so task 35.3 can adopt it on the World
// inspector and elsewhere without a second copy.
//
// It owns NO business logic beyond composing the client-side XP meter: every
// persistence action is a thin fetch() to the §8 tray routes 35.1 built
// (GET/drop/DELETE/budget). The XP total is composed HERE, in the browser,
// from the roster + the bestiary CR→XP arithmetic — per the locked decision
// "tray XP = literal CR→XP arithmetic ... NO verdict language" (phase-35-tasks
// .md). The meter reads the literal `N / budget xp`; no verdict/difficulty word
// (deadly/hard/easy/…) ever appears in this subtree — the Encounter Builder
// stays the difficulty tool.
//
// Drag payload channel: the drag SOURCES (creature cards, hero cards, shelf
// rows) live in library-view.js; the drop TARGETS (scene rows) live here. They
// share one module-level payload set on dragstart (setTrayDragPayload) and read
// on drop — robust across the synthetic DataTransfer the e2e drag helper uses,
// and it carries the `kind` a bare text/plain id could not.
//
// Phase 35 task 35.3: world-view.js adopts this SAME component for the World
// inspector's "Drop into a scene" tray (retiring its own bespoke
// buildSceneTray/srow implementation — one tray, per README's "implement
// once"). A World graph-node drag is NOT one of this store's roster kinds
// (creature/hero/asset) — dropping a node there must keep creating a real
// `kind:'graph'` scene-ELEMENT via the existing, unchanged
// `.../elements/from-graph` route (phase33's pinned behavior), never a roster
// row. `mountSceneTray` therefore accepts a handful of narrow, additive-only
// opts (all optional — every Library call site is unaffected, since none of
// them pass these) so ONE implementation serves both:
//   - `rowTestid`/`hintText`/`hintTestid`/`metaClass` — cosmetic DOM overrides
//     so a caller can match its own pre-existing, e2e-pinned contract instead
//     of this module's own Library-pinned testids.
//   - `computeMeta(scene, roster)` / `computeMetaAsync(scene)` — override the
//     built-in "N creatures · N heroes · N props" meta line (sync initial
//     text + an optional async follow-up patch, mirroring the exact
//     sync-then-async-refine pattern world-view.js's own retired
//     `srow`/`sceneContentCount` already used).
//   - `onExternalDrop(scene, payload)` — first refusal on every drop; a
//     truthy (possibly-async) return means "handled elsewhere," skipping this
//     module's own generic `POST .../tray/drop` entirely. World's own
//     unchanged `addToScene` (the from-graph route + its own undo toast) is
//     wired in through this hook.
"use strict";

// ---------------------------------------------------------------------------
// Shared drag payload channel (library-view.js sets it on a source dragstart).
// ---------------------------------------------------------------------------
let dragPayload = null;
export function setTrayDragPayload(payload) { dragPayload = payload; }
export function getTrayDragPayload() { return dragPayload; }

// ---------------------------------------------------------------------------
// CR→XP arithmetic (Library.dc.html:757-761 `CR_XP` + `evOf`, copied verbatim
// and extended past the prototype's own truncated CR-8 table to the full
// standard 2014 SRD XP-by-CR ladder so a real higher-CR pulled monster —
// e.g. the fixture's CR 12 Frostmaw — computes a real XP value, not 0).
// ---------------------------------------------------------------------------
const CR_XP = {
  "0": 10, "1/8": 25, "1/4": 50, "1/2": 100,
  "1": 200, "2": 450, "3": 700, "4": 1100, "5": 1800, "6": 2300, "7": 2900,
  "8": 3900, "9": 5000, "10": 5900, "11": 7200, "12": 8400, "13": 10000,
  "14": 11500, "15": 13000, "16": 15000, "17": 18000, "18": 20000, "19": 22000,
  "20": 25000, "21": 33000, "22": 41000, "23": 50000, "24": 62000, "25": 75000,
  "26": 90000, "27": 105000, "28": 120000, "29": 135000, "30": 155000
};

const KIND_GLYPH = { item: "◈", map: "▦", splash: "◐", music: "♪" };

/** Normalize a Foundry-numeric fractional CR (0.125/0.25/0.5) to the CR_XP key form. */
function crKey(value) {
  if (value === 0.125) return "1/8";
  if (value === 0.25) return "1/4";
  if (value === 0.5) return "1/2";
  return String(value);
}

/** xp of one bestiary entry (rating-override wins over the book CR). */
function xpOfEntry(entry) {
  if (!entry) return 0;
  const rating = entry.rating != null ? entry.rating : entry?.rawFields?.challengeRating;
  if (rating == null) return 0;
  if (entry.ratingLabel === "EV") return Number(rating) * 40;
  return CR_XP[crKey(rating)] || 0;
}

// ---------------------------------------------------------------------------
// Tiny DOM helper (same standalone convention as app-shell.js's `el`).
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

// ---------------------------------------------------------------------------
// mountSceneTray(host, opts) — builds the tray into `host` and fetches its
// data. Returns a controller with `refresh()`. `opts.world` overrides the
// localStorage world (35.3 may mount it for an explicit world context).
// ---------------------------------------------------------------------------
export function mountSceneTray(host, opts = {}) {
  const world = opts.world || currentWorld();
  const state = { query: "", scenes: [], trays: {}, lookups: null, entityNames: new Map() };

  host.innerHTML = "";
  const root = el("div", {
    testid: "scene-tray",
    style: "border-top: 1px solid oklch(0.88 0.010 80); background: oklch(0.925 0.009 85); padding: 11px 14px 13px; flex: none;"
  });

  const header = el("div", { style: "display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px;" }, [
    el("div", {
      text: "Drop into a scene",
      style: "font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; letter-spacing: 0.09em; text-transform: uppercase; color: oklch(0.53 0.012 70);"
    }),
    el("div", { style: "flex: 1;" }),
    el("div", {
      testid: opts.hintTestid,
      text: opts.hintText || "creatures, heroes, props",
      style: "font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; color: oklch(0.60 0.012 70);"
    })
  ]);

  const search = el("input", {
    testid: "scene-tray-search-input",
    placeholder: "Find a scene…",
    value: state.query,
    style: "width: 100%; padding: 5px 9px; border: 1px solid oklch(0.85 0.010 80); border-radius: 4px; font-family: inherit; font-size: 12px; background: oklch(1 0 0); color: inherit; margin-bottom: 8px;"
  });
  search.addEventListener("input", () => { state.query = search.value; paintScenes(); });

  const list = el("div", { style: "display: flex; flex-direction: column; gap: 5px; max-height: 268px; overflow-y: auto;" });

  root.append(header, search, list);
  host.appendChild(root);

  // -------------------------------------------------------------------------
  function nameFor(kind, id) {
    const lk = state.lookups;
    if (!lk) return "?";
    if (kind === "creature") return lk.bestiary.get(id)?.rawFields?.name ?? "?";
    if (kind === "hero") return lk.party.get(id)?.name ?? "?";
    // asset: item first, then stagecraft (mirrors the tray-drop route's own resolution order)
    return lk.items.get(id)?.name ?? lk.stagecraft.get(id)?.name ?? "?";
  }

  function glyphFor(kind, id) {
    if (kind === "hero") return "◉ ";
    if (kind === "creature") return "";
    // asset
    const asset = state.lookups?.stagecraft.get(id);
    if (asset) return (KIND_GLYPH[asset.kind] || "◈") + " ";
    return "◈ ";
  }

  function chipTheme(kind) {
    if (kind === "hero") return { bg: "oklch(0.955 0.020 65)", fg: "oklch(0.38 0.07 65)", border: "oklch(0.86 0.040 65)" };
    if (kind === "asset") return { bg: "oklch(0.965 0.006 85)", fg: "oklch(0.42 0.014 65)", border: "oklch(0.86 0.010 80)" };
    return { bg: "oklch(0.955 0.014 185)", fg: "oklch(0.36 0.050 185)", border: "oklch(0.86 0.030 185)" };
  }

  function sceneName(scene) {
    // Same resolution as app-shell's resolveSceneDisplayName: an explicit
    // name wins, else the anchor PLACE's graph-node name (scenes are usually
    // unnamed and known by their place -- every real scene rendered as an
    // indistinguishable "Ad-hoc scene" before this, Russell's pass bug).
    if (scene.name) return scene.name;
    if (scene.locationEntityId) {
      const place = state.entityNames.get(scene.locationEntityId);
      if (place) return place;
    }
    return scene.objectiveNote || "Ad-hoc scene";
  }

  function metaFor(roster) {
    const mobs = roster.filter((r) => r.kind === "creature").reduce((n, r) => n + r.n, 0);
    const heroes = roster.filter((r) => r.kind === "hero").length;
    const props = roster.filter((r) => r.kind === "asset").length;
    if (!mobs && !heroes && !props) return "empty";
    return [
      mobs ? `${mobs} ${mobs === 1 ? "creature" : "creatures"}` : "",
      heroes ? `${heroes} ${heroes === 1 ? "hero" : "heroes"}` : "",
      props ? `${props} ${props === 1 ? "prop" : "props"}` : ""
    ].filter(Boolean).join(" · ");
  }

  function xpFor(roster) {
    return roster.reduce(
      (n, r) => n + (r.kind === "creature" ? r.n * xpOfEntry(state.lookups?.bestiary.get(r.id)) : 0),
      0
    );
  }

  function budgetColor(total, budget) {
    if (budget > 0 && total > budget) return "oklch(0.52 0.13 25)";
    if (budget > 0 && total > budget * 0.6) return "oklch(0.55 0.10 65)";
    return "oklch(0.48 0.09 150)";
  }

  async function doDrop(scene, payload) {
    if (opts.onExternalDrop) {
      let handled = false;
      try { handled = await opts.onExternalDrop(scene, payload); } catch { /* fall through to the generic roster drop below */ }
      if (handled) return;
    }
    try {
      await api(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/tray/drop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world, kind: payload.kind, id: payload.id })
      });
      await refreshTray(scene.id);
      paintScenes();
      opts.onChange?.();
    } catch { /* unresolvable id / no scene — leave the tray as-is */ }
  }

  async function doRemove(scene, kind, id) {
    try {
      await api(`/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/tray/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world })
      });
      await refreshTray(scene.id);
      paintScenes();
      opts.onChange?.();
    } catch { /* ignore */ }
  }

  function sceneRow(scene) {
    const tray = state.trays[scene.id] || { roster: [], xpBudget: null };
    const roster = tray.roster || [];
    const budget = tray.xpBudget ?? 0;
    const total = xpFor(roster);

    const row = el("div", {
      testid: opts.rowTestid || "scene-tray-scene-row",
      "data-scene-id": scene.id,
      style: "padding: 8px 10px; border: 1px dashed oklch(0.86 0.010 80); border-radius: 4px; background: oklch(0.965 0.006 85);"
    });

    // A native drop target (setState-free — the drop reads the shared payload).
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      row.setAttribute("style", "padding: 8px 10px; border: 1px dashed oklch(0.60 0.075 185); border-radius: 4px; background: oklch(0.93 0.020 185);");
    });
    row.addEventListener("dragleave", () => {
      row.setAttribute("style", "padding: 8px 10px; border: 1px dashed oklch(0.86 0.010 80); border-radius: 4px; background: oklch(0.965 0.006 85);");
    });
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      const payload = getTrayDragPayload();
      if (payload && payload.id) doDrop(scene, payload);
      setTrayDragPayload(null);
    });

    const head = el("div", { style: "display: flex; align-items: baseline; gap: 8px;" }, [
      el("span", { text: sceneName(scene), style: "font-size: 12.5px; color: oklch(0.28 0.015 60);" }),
      el("span", { style: "flex: 1;" }),
      el("span", {
        testid: "scene-tray-xp-meter",
        text: `${total} / ${budget} xp`,
        style: `font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; color: ${budgetColor(total, budget)};`
      })
    ]);

    const meta = el("div", {
      testid: "scene-tray-scene-row-meta",
      class: opts.metaClass,
      text: opts.computeMeta ? opts.computeMeta(scene, roster) : metaFor(roster),
      style: "font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; color: oklch(0.60 0.012 70); margin-top: 3px;"
    });

    row.append(head, meta);

    if (opts.computeMetaAsync) {
      // Sync-then-async-refine, matching world-view.js's own retired
      // sceneContentCount().then(...) pattern verbatim: `meta` is closed over
      // this specific render's DOM node, so a stale/detached update (the row
      // was already rebuilt by a later paintScenes()) is a harmless no-op —
      // the exact same edge case the retired implementation already had.
      opts.computeMetaAsync(scene).then((text) => { if (text != null) meta.textContent = text; }).catch(() => {});
    }

    if (roster.length) {
      const chips = el("div", { style: "display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px;" });
      for (const r of roster) {
        const theme = chipTheme(r.kind);
        const label = glyphFor(r.kind, r.id) + nameFor(r.kind, r.id) + (r.n > 1 ? " ×" + r.n : "");
        const chip = el("span", {
          testid: "scene-tray-roster-chip",
          "data-kind": r.kind,
          "data-source-id": r.id,
          style: `display: flex; align-items: center; gap: 5px; padding: 2px 7px; border: 1px solid ${theme.border}; border-radius: 20px; background: ${theme.bg}; font-size: 11px; color: ${theme.fg};`
        }, [
          el("span", { text: label })
        ]);
        const rm = el("span", {
          testid: "scene-tray-roster-chip-remove",
          text: "✕",
          style: "font-size: 9px; cursor: pointer; color: oklch(0.50 0.030 185);"
        });
        rm.addEventListener("click", () => doRemove(scene, r.kind, r.id));
        chip.appendChild(rm);
        chips.appendChild(chip);
      }
      row.appendChild(chips);
    }

    return row;
  }

  function paintScenes() {
    const q = state.query.trim().toLowerCase();
    const shown = state.scenes.filter((sc) => !q || sceneName(sc).toLowerCase().includes(q));
    list.innerHTML = "";
    if (!shown.length) {
      list.appendChild(el("div", {
        text: state.scenes.length ? "No scene matches that." : "No scenes yet — build one in the Session planner.",
        style: "font-size: 11.5px; color: oklch(0.60 0.012 70); line-height: 1.45;"
      }));
      return;
    }
    for (const sc of shown) list.appendChild(sceneRow(sc));
  }

  async function refreshTray(sceneId) {
    try {
      state.trays[sceneId] = await api(`/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/tray?world=${encodeURIComponent(world)}`);
    } catch { state.trays[sceneId] = { roster: [], xpBudget: null }; }
  }

  async function loadAll() {
    if (!world) { paintScenes(); return; }
    // Lookups for name/XP resolution. Bestiary is library-wide (no world).
    const [bestiary, party, items, stagecraft, scenesRes, graph] = await Promise.all([
      api(`/api/combat-planning/bestiary`).catch(() => ({ entries: [] })),
      api(`/api/combat-planning/party-roster?world=${encodeURIComponent(world)}`).catch(() => ({ members: [] })),
      api(`/api/combat-planning/items?world=${encodeURIComponent(world)}`).catch(() => ({ items: [] })),
      api(`/api/session-planner/stagecraft?world=${encodeURIComponent(world)}`).catch(() => ({ assets: [] })),
      api(`/api/scene-planning/scenes?world=${encodeURIComponent(world)}&sort=recency`).catch(() => ({ scenes: [] })),
      // Graph node names for sceneName's place resolution (scenes are mostly
      // unnamed; their display name IS their anchor place's name).
      api(`/api/graph?world=${encodeURIComponent(world)}&filter=all`).catch(() => ({ nodes: [] }))
    ]);
    state.entityNames = new Map((graph.nodes || []).map((n) => [n.id, n.name]));
    state.lookups = {
      bestiary: new Map((bestiary.entries || []).map((e) => [e.id, e])),
      party: new Map((party.members || []).map((m) => [m.id, m])),
      items: new Map((items.items || []).map((i) => [i.id, i])),
      stagecraft: new Map((stagecraft.assets || []).map((a) => [a.id, a]))
    };
    state.scenes = scenesRes.scenes || [];
    await Promise.all(state.scenes.map((sc) => refreshTray(sc.id)));
    paintScenes();
  }

  loadAll();

  return { refresh: loadAll };
}
