/**
 * Run skeleton — pre-seeds a scene with PLACEHOLDER elements, one per role
 * the runnable spread expects, so a GM opening a fresh scene in Prep sees
 * the shape they are filling in (read-aloud, dressing, beats, exits, GM
 * box, stat block, sketch…) instead of an empty list.
 *
 * World-agnostic: templates are keyed by the scene's `kind`
 * (narrative | combat | transit), falling back to the scene-name prefix
 * ("Combat —", "Transit —") and then to narrative. Every seeded element
 * carries `run.placeholder: true`: Prep renders it dashed with a "fill me"
 * hint, Run hides it while its fields are empty, and scene-elements.mjs's
 * updateElement drops the flag the moment real content lands.
 *
 * Idempotent by ROLE: a role the scene already has (explicit or inferred)
 * is not seeded again, so re-running on a half-built scene only fills the
 * genuine gaps. Never overwrites, never reorders existing elements.
 */
import { createElement, listElementsForScene } from "./scene-elements.mjs";
import { getScene } from "./scenes.mjs";
import { effectiveRun } from "./run-layout.mjs";

export const RUN_SKELETON_VERSION = 1;

const EXIT_TEMPLATE = "ONWARD (plot): what pulls them forward → 'Target scene'";
const EXIT_TEMPLATE_2 = "ONWARD (explore): what rewards curiosity → 'Target scene'";
const EXIT_TEMPLATE_3 = "LINGER: what happens if they stay → 'Target scene'";

const ROWS = {
  read:     { name: "Read aloud", column: "main", role: "read", fields: {} },
  dressing: [
    { name: "Dressing — 1", column: "main", role: "dressing", fields: {} },
    { name: "Dressing — 2", column: "main", role: "dressing", fields: {} },
    { name: "Dressing — 3", column: "main", role: "dressing", fields: {} }
  ],
  beat: [
    { name: "Beat — 1", column: "main", role: "beat", fields: {} },
    { name: "Beat — 2", column: "main", role: "beat", fields: {} }
  ],
  exits:    { name: "→ Where this leads", column: "main", role: "exits", fields: { gives: EXIT_TEMPLATE, means: EXIT_TEMPLATE_2, secret: EXIT_TEMPLATE_3 } },
  gm:       { name: "GM note", column: "side", role: "gm", fields: {} },
  block:    { name: "Enemies", column: "side", role: "block", fields: {} },
  sketch:   { name: "Sketch", column: "side", role: "sketch", fields: {} }
};

export const SKELETON_TEMPLATES = {
  narrative: ["read", "dressing", "beat", "gm", "exits"],
  combat:    ["read", "dressing", "block", "sketch", "beat", "gm", "exits"],
  transit:   ["read", "beat", "exits"]
};

/** Resolve the template kind for a scene: explicit `kind` > name prefix > narrative. */
export function skeletonKindFor(scene, override) {
  if (override && SKELETON_TEMPLATES[override]) return override;
  if (scene?.kind && SKELETON_TEMPLATES[scene.kind]) return scene.kind;
  const name = String(scene?.name || "");
  if (/^combat\b/i.test(name)) return "combat";
  if (/^transit\b/i.test(name)) return "transit";
  return "narrative";
}

/**
 * @param {string} world
 * @param {string} sceneId
 * @param {{kind?: 'narrative'|'combat'|'transit'}} [opts]
 * @returns {{kind:string, seeded:object[], skipped:string[], elements:object[]}}
 */
export function seedRunSkeleton(world, sceneId, opts = {}) {
  const scene = getScene(world, sceneId);
  const kind = skeletonKindFor(scene, opts.kind);
  const existing = listElementsForScene(world, sceneId);
  const present = new Set(existing.map((e) => effectiveRun(e).run.role));
  const seeded = [];
  const skipped = [];
  for (const role of SKELETON_TEMPLATES[kind]) {
    if (present.has(role)) { skipped.push(role); continue; }
    const rows = Array.isArray(ROWS[role]) ? ROWS[role] : [ROWS[role]];
    for (const row of rows) {
      seeded.push(createElement(world, sceneId, {
        name: row.name,
        fields: { ...row.fields },
        run: { column: row.column, role: row.role, placeholder: true }
      }));
    }
  }
  return { kind, seeded, skipped, elements: listElementsForScene(world, sceneId) };
}
