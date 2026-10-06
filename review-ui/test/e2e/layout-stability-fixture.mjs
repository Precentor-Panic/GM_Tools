// WS-G measurement kit (table round 2026-09-09, feedback 7). Shared by the
// probe (`layout-stability.probe.mjs`, prints a diff table) and the guard
// (`layout-stability.e2e.mjs`, asserts). Not a test itself.
import { writeFileSync } from "node:fs";
import { createSceneViaRoute } from "./phase30-fixture.mjs";
import { foundryIndexPath } from "../../../wf-mcp-server/lib/snapshot.mjs";
import { createSceneElementViaRoute, saveNarrationViaRoute } from "./phase29-fixture.mjs";

// The selectors the plan names, each with a stable key so the same DOM node
// can be matched across steps (rows/fields by element id + field; run boxes
// and band rows by class + index).
export const TRACKED = [
  { sel: ".scene-subbar, .scene-subbar-controls, .sp-segmented, .scene-rail-toggle-btn, .scene-party-toggle-btn, .scene-wrap-toggle-btn", key: (el) => `bar:${el.className.split(" ").filter((c) => c !== "btn")[0]}` },
  { sel: ".scene-place-header", key: (el) => "head-band" },
  { sel: ".scene-band-titlerow, .scene-band-intentrow, .scene-band-chiprow", key: (el) => el.className },
  { sel: ".scene-read-aloud-section", key: () => "read-aloud-section" },
  { sel: '[data-testid="scene-narration"]', key: () => "field:read-aloud" },
  { sel: '[data-testid="scene-element-row"]', key: (el) => `row:${el.getAttribute("data-element-id")}` },
  { sel: '[data-testid="scene-element-field"]', key: (el) => `field:${el.closest('[data-element-id]')?.getAttribute("data-element-id")}:${el.getAttribute("data-field")}` },
  { sel: '[data-testid="scene-element-name"]', key: (el) => `name:${el.closest('[data-element-id]')?.getAttribute("data-element-id")}` },
  { sel: ".rs-box", key: (el, i) => `rs-box#${i}:${el.querySelector(".rs-box-l")?.textContent?.trim() ?? ""}` },
  { sel: ".scene-run-spread", key: () => "run-spread" },
  { sel: ".scene-elements-list, .scene-layout-board", key: (el) => el.className.split(" ")[0] }
];

// {key: {top, left, height, width}} for every tracked node that is laid out,
// plus `page:scroll` for the scene surface (the scroller is
// `#app-shell .planner-scene-surface`, not the document -- measure ITS gutter).
export async function snapshot(page) {
  return page.evaluate((tracked) => {
    const out = {};
    for (const t of tracked) {
      const keyFn = new Function("el", "i", `return (${t.key})(el, i)`);
      document.querySelectorAll(t.sel).forEach((el, i) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return; // display:none -- not on this view
        out[keyFn(el, i)] = { top: Math.round((r.top + window.scrollY) * 10) / 10, left: Math.round(r.left * 10) / 10, height: Math.round(r.height * 10) / 10, width: Math.round(r.width * 10) / 10 };
      });
    }
    const sc = document.querySelector(".planner-scene-surface") || document.documentElement;
    out["page:scroll"] = { top: 0, left: 0, height: sc.scrollHeight, width: sc.clientWidth, scrollbar: sc.offsetWidth - sc.clientWidth };
    return out;
  }, TRACKED.map((t) => ({ sel: t.sel, key: t.key.toString() })));
}

export function diff(before, after) {
  const rows = [];
  for (const k of Object.keys(after)) {
    const a = after[k], b = before[k];
    if (!b) { rows.push({ key: k, note: "appeared", dh: null, dtop: null, dw: null, dleft: null }); continue; }
    rows.push({ key: k, dh: +(a.height - b.height).toFixed(1), dtop: +(a.top - b.top).toFixed(1), dw: +(a.width - b.width).toFixed(1), dleft: +(a.left - b.left).toFixed(1), note: "" });
  }
  for (const k of Object.keys(before)) if (!after[k]) rows.push({ key: k, note: "vanished", dh: null, dtop: null, dw: null, dleft: null });
  return rows;
}

export const moved = (r, px = 0.5) => Boolean(r.note) || Math.abs(r.dh) >= px || Math.abs(r.dtop) >= px || Math.abs(r.dw) >= px || Math.abs(r.dleft) >= px;

export async function settle(page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(80);
}

// A Prep page tall enough to scroll at 900px: one graph person with every
// field kind, an object, dressing, GM side boxes, a side card, six filler rows.
// The party rail (2026-10-06) needs seats to lay out, or its geometry is
// untested. Written into the world's data dir, same idiom the party-rail e2e
// uses. Two claimed sheets plus a MULE that must not appear.
export function seedFoundryIndex(dataDir, world) {
  const save = (v) => ({ roll: { min: null, max: null, mode: 0 }, value: v });
  const sk = (value, proficient, passive) => ({ value, proficient, passive });
  const abil = (score, mod, s) => ({ value: score, mod, save: save(s) });
  const index = {
    version: 1, worldId: world, exportedAt: new Date().toISOString(),
    scenes: [], tokens: [], playlists: [], worldItems: [], compendia: [], journals: [],
    users: [
      { id: "u1", name: "Ada", characterUuid: "Actor.ls1" },
      { id: "u2", name: "Bo", characterUuid: "Actor.ls2" }
    ],
    actors: [
      { uuid: "Actor.ls1", name: "Keeneye Vance", type: "character",
        items: [{ type: "class", name: "Rogue" }],
        system: { level: 3, ac: 15, hp: { value: 14, max: 22 },
          abilities: { str: abil(10, 0, 0), dex: abil(18, 4, 6), con: abil(12, 1, 1), int: abil(14, 2, 2), wis: abil(14, 2, 4), cha: abil(12, 1, 1) },
          skills: { prc: sk(6, 2, 19), ste: sk(6, 2, 16), ins: sk(2, 1, 12) } } },
      { uuid: "Actor.ls2", name: "Brawn Olafsson & Dog", type: "character",
        items: [{ type: "class", name: "Fighter" }],
        system: { level: 3, ac: 17, hp: { value: 24, max: 30 },
          abilities: { str: abil(17, 3, 5), dex: abil(11, 0, 0), con: abil(16, 3, 5), int: abil(8, -1, -1), wis: abil(10, 0, 0), cha: abil(9, -1, -1) },
          skills: { prc: sk(0, 0, 10), ath: sk(5, 1, 15) } } },
      { uuid: "Actor.mule", name: "Ada's Mule", type: "character", items: [], system: { level: 0 } }
    ]
  };
  writeFileSync(foundryIndexPath(dataDir, world), JSON.stringify(index), "utf8");
}

export async function seedScene(base, world) {
  const scene = await createSceneViaRoute(base, world, { locationEntityId: "lp-pit", name: "The Pit — call" });
  await saveNarrationViaRoute(base, world, scene.id, "The pit is a bowl of sand under three tiers of benches. Torches gutter in iron cages; the crowd is already loud, and someone is selling dates from a tray.");
  const mk = async (payload) => {
    const r = await createSceneElementViaRoute(base, world, scene.id, payload);
    if (r.status !== 200) throw new Error(`element create failed: ${JSON.stringify(r.body)}`);
    return r.body.element;
  };
  const marek = await mk({
    name: "Marek", kind: "graph", graphEntityId: "lp-marek",
    fields: {
      looks: "Human, forties, heavy through the shoulders, a boxer's flattened nose.\nMannerism: counts on his fingers while he talks.\nVoice: low, unhurried, never raises it.",
      means: "Runs the book on every bout; two door-men answer to him and nobody else.",
      checks: [{ skill: "Insight", dc: 14, purpose: "notice he already knows the party's names" }],
      wants: "The headliner alive until the purse is paid."
    },
    run: { column: "main", role: "person" }
  });
  await mk({ name: "The purse", fields: { looks: "A canvas sack, oil-stained, heavier than it should be.", function: "Two hundred in mixed coin; a wax seal nobody at the pit uses.", secret: "The seal is the Ledger-Man's." }, run: { column: "main", role: "object" } });
  await mk({ name: "Bench chatter", fields: { looks: "Names shouted, odds changing hands; a boy runs slips between the tiers." }, run: { column: "main", role: "dressing" } });
  await mk({ name: "Torch smoke", fields: { looks: "Low and greasy; it catches the throat on the upper tier." }, run: { column: "main", role: "dressing" } });
  await mk({ name: "GM — the odds", fields: { gives: "Marek's book is honest tonight; the fix is in the crowd, not the bout." }, run: { column: "side", role: "gm" } });
  await mk({ name: "GM — exits", fields: { gives: "Two gates; the north one is watched." }, run: { column: "side", role: "gm" } });
  await mk({ name: "Bout card", fields: { trigger: "When the bell rings.", gives: "Initiative; the crowd surges at round two." }, run: { column: "side", role: "card" } });
  for (let i = 0; i < 6; i++) {
    await mk({ name: `Bench ${i + 1}`, fields: { looks: `Tier ${i + 1}: a knot of bettors, one of them counting on a slate.` }, run: { column: "main", role: "dressing" } });
  }
  return { scene, marek };
}

export const SEED_ENTITIES = [
  { op: "upsert_entity", data: { id: "lp-pit", name: "The Pit", type: "place", importance: 0.6, description: "A sand-floored fighting pit ringed by tiered benches; the smell of oil and old blood." } },
  { op: "upsert_entity", data: { id: "lp-marek", name: "Marek", type: "person", importance: 0.7, description: "A pit boss." } }
];

// Open the scene in Prep, fonts loaded, layout settled.
export async function openScenePrep(page, base, sceneId) {
  await page.goto(`${base}/#planner/scene/${sceneId}`);
  await page.locator(`[data-testid="planner-scene-view"][data-scene-id="${sceneId}"]`).waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-testid="mode-prep-btn"]').click();
  await page.locator('[data-testid="scene-element-row"]').first().waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts?.ready);
  await settle(page);
}
