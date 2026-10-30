/**
 * MCP tools over the Atlas library (plans/atlas-plan.md). Thin: every tool calls atlas/*.mjs and holds no logic.
 *
 * The atlas is a sidecar store, not the World Fabric graph, so the no-silent-auto-write invariant doesn't govern it.
 * Its own rule stands in: everything Claude ADDS through wf_atlas_edit is a draft (pencil on the GM's plan, kept out
 * of the survey and briefs) until the GM accepts it. Moves and corrections apply directly and go to the undo slot.
 */
import { z } from "zod";
import { resolveWorld } from "./resolve.mjs";
import { listAtlases, loadAtlas, loadKnown, markKnown } from "../../atlas/store.mjs";
import { applyAtlasOps, undoAtlasOps } from "../../atlas/ops.mjs";
import { lintAtlas, CHECKS } from "../../atlas/lint.mjs";
import { summary, neighbourhood, route, inArea, inSection, search } from "../../atlas/query.mjs";
import { sectionBrief } from "../../atlas/section-brief.mjs";

const OP = z.object({ op: z.string() }).passthrough();

export function registerAtlasTools(server, { text, errorText, worldParam }) {
  const atlasParam = z.string().describe("Atlas id, e.g. 'under-aureus'. wf_atlas_summary with no atlas lists them.");
  const wrap = (fn) => async (args) => { try { return text(await fn(args)); } catch (err) { return errorText(err); } };

  server.registerTool("wf_atlas_summary", {
    title: "READ: an atlas at a glance (or list the world's atlases)",
    description: "Counts by depth band and system, sections, drafts waiting for the GM, how much the table knows, and the " +
      "check results by severity. Small enough to read first; use wf_atlas_query for detail.",
    inputSchema: { world: worldParam, atlas: atlasParam.optional() },
  }, wrap(({ world, atlas }) => {
    const w = resolveWorld(world);
    if (!atlas) return { atlases: listAtlases(w) };
    return summary(loadAtlas(w, atlas), loadKnown(w, atlas));
  }));

  server.registerTool("wf_atlas_query", {
    title: "READ: ask an atlas a question",
    description: "kind: 'neighbourhood' {id, hops} — places and passages around one place, with travel minutes; " +
      "'route' {from, to, avoid?} — quickest way by minutes, sealed and locked gates avoided unless avoid=[]; " +
      "'area' {id} — places inside an area; 'section' {id} — places inside a battle-map section; 'search' {text}; " +
      "'known' — what the table knows.",
    inputSchema: {
      world: worldParam, atlas: atlasParam,
      kind: z.enum(["neighbourhood", "route", "area", "section", "search", "known"]),
      id: z.string().optional(), hops: z.number().int().min(1).max(4).optional(),
      from: z.string().optional(), to: z.string().optional(), avoid: z.array(z.string()).optional(), text: z.string().optional(),
    },
  }, wrap(({ world, atlas, kind, id, hops, from, to, avoid, text: t }) => {
    const w = resolveWorld(world), a = loadAtlas(w, atlas);
    switch (kind) {
      case "neighbourhood": return neighbourhood(a, id, hops ?? 1);
      case "route": return route(a, from, to, avoid ? { avoid } : {}) ?? { from, to, route: null, note: "no way through (gates?)" };
      case "area": return inArea(a, id);
      case "section": return inSection(a, id);
      case "search": return search(a, t ?? "");
      case "known": return loadKnown(w, atlas);
    }
  }));

  server.registerTool("wf_atlas_edit", {
    title: "WRITE: change an atlas (additions are drafts until the GM accepts them)",
    description: "ops: [{op, ...}]. add-node/add-edge/add-area {data}; update-node/-edge/-area/-section {id, patch} " +
      "(null deletes a field); move-node {id, x, y | r, th, depth?}; remove-node (cascades its passages) / remove-edge / " +
      "remove-area / remove-section {id}; add-section {data}; radial-remap {bands:[{from:[r0,r1], to:[r0,r1]}]}. " +
      "Everything ADDED here is marked draft. Only the GM accepts drafts (the review page or the GM_Tools UI), so " +
      "this tool refuses the 'accept' op. The previous version goes to the one undo slot (wf_atlas_undo).",
    inputSchema: { world: worldParam, atlas: atlasParam, ops: z.array(OP).min(1) },
  }, wrap(({ world, atlas, ops }) => {
    if (ops.some((o) => o.op === "accept")) throw new Error("accepting drafts is the GM's call; use the review page or the GM_Tools UI");
    const { atlas: a, results } = applyAtlasOps(resolveWorld(world), atlas, ops, { draftNew: true });
    return { revision: a.revision, results, findings: lintAtlas(a).filter((f) => f.severity !== "info") };
  }));

  server.registerTool("wf_atlas_undo", {
    title: "WRITE: undo the last atlas edit",
    description: "Puts back the version before the last edit, if nothing has been written since.",
    inputSchema: { world: worldParam, atlas: atlasParam },
  }, wrap(({ world, atlas }) => ({ revision: undoAtlasOps(resolveWorld(world), atlas).revision })));

  server.registerTool("wf_atlas_lint", {
    title: "READ: run an atlas's checks",
    description: "Findings with a check id, severity (error | warn | info) and the ids concerned. Checks: " +
      Object.entries(CHECKS).map(([k, v]) => `${k} (${v})`).join("; ") + ".",
    inputSchema: { world: worldParam, atlas: atlasParam },
  }, wrap(({ world, atlas }) => {
    const w = resolveWorld(world);
    return lintAtlas(loadAtlas(w, atlas), loadKnown(w, atlas));
  }));

  server.registerTool("wf_atlas_brief", {
    title: "READ: a section's build brief (what its battle map must hold, and where its exits go)",
    description: "Places inside the section in its own squares, and every passage leaving it with the side and position " +
      "where it crosses the map's edge, what it leads to, water, gate and tells. Drafts are left out.",
    inputSchema: { world: worldParam, atlas: atlasParam, section: z.string() },
  }, wrap(({ world, atlas, section }) => sectionBrief(loadAtlas(resolveWorld(world), atlas), section)));

  server.registerTool("wf_atlas_mark_known", {
    title: "WRITE: record what the table now knows",
    description: "marks: [{id, level: heard|seen|walked|forgotten, note?}] for places or passages. Levels only rise unless " +
      "force; 'forgotten' removes. Appended to the known log. Feeds the players' survey; pushing the survey to Foundry " +
      "is a separate, confirmed step.",
    inputSchema: {
      world: worldParam, atlas: atlasParam,
      marks: z.array(z.object({ id: z.string(), level: z.enum(["heard", "seen", "walked", "forgotten"]), note: z.string().optional() })).min(1),
      force: z.boolean().optional(),
    },
  }, wrap(({ world, atlas, marks, force }) => {
    const w = resolveWorld(world);
    const a = loadAtlas(w, atlas), ids = new Set([...a.nodes, ...a.edges].map((x) => x.id));
    const bad = marks.filter((m) => !ids.has(m.id)).map((m) => m.id);
    if (bad.length) throw new Error(`not in the atlas: ${bad.join(", ")}`);
    return markKnown(w, atlas, marks, { by: "claude", force: !!force }).applied;
  }));
}
