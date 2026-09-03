/**
 * Headline/grain logic — pure, Foundry-free, unit-testable.
 *
 * Turns a stored Batch (review-state.mjs's shape) into a three-level
 * conversational review surface: headline (whole batch) -> region -> entity.
 * Region grouping reuses the `regionId` field texture.mjs already stamped
 * onto each mutation during its own BFS/connectivity-based clustering
 * (propagate.mjs's seed propagation -> texture.mjs's groupByRegion) — grain.mjs
 * does not recompute BFS distance itself, per the "reuse, don't duplicate
 * traversal logic" convention. Mutations without a regionId (e.g. hand-authored
 * 'manual' mutations that skipped texturing) each become their own singleton
 * region, keyed by mutationId.
 *
 * Design choice (documented per task 1.6's instruction to pick the less
 * invasive option and note it): the "always show full" override is sourced
 * from World Fabric's existing `tags` field via a `"pin-review"` tag convention
 * on entityContext.tags (populated by texture.mjs from the live entity at
 * texturing time) — not a new per-world config file. This reuses an existing
 * WF primitive (tags) instead of introducing new state to keep in sync.
 *
 * Phase 4 task 4.2 adds a SECOND, independent "always show full" override:
 * an entity flagged by mutation-engine/human-review.mjs's
 * findUnreviewedEntities() (applied-but-unreviewed history that's gone on
 * too long) is forced out of collapse regardless of its `importance` score —
 * an entity accumulating silent, unreviewed AI-authored history shouldn't
 * stay hideable just because it's individually low-importance. Unlike the
 * pin-review tag (an in-batch signal baked into entityContext at texturing
 * time), the flagged-entity set is genuinely cross-batch, external state —
 * so this module stays pure/Foundry-free (no file I/O of its own) and
 * accepts it as an optional `flaggedEntityIds` Set the caller supplies
 * (queried from human-review.mjs beforehand), rather than importing and
 * reading human-review.mjs's on-disk state directly from inside here.
 */

// Below this importance, an entity's mutation collapses into its region's
// headline by default (name + one-line rationale only) rather than earning
// full-diff visibility. Distinct from propagate.mjs's IMPORTANCE_FLOOR
// (which gates texturing eligibility) — this is a separate, later-stage
// bar for how much review-surface space a change earns once it *has* been
// textured.
export const HEADLINE_IMPORTANCE_THRESHOLD = 0.5;

const PIN_REVIEW_TAG = "pin-review";

function isPinned(entry) {
  return Array.isArray(entry.entityContext?.tags) && entry.entityContext.tags.includes(PIN_REVIEW_TAG);
}

function importanceOf(entry) {
  const imp = entry.entityContext?.importance;
  return typeof imp === "number" ? imp : 0.3;
}

function displayName(entry) {
  return entry.entityContext?.name ?? entry.id ?? entry.mutationId;
}

function isFlaggedUnreviewed(entry, flaggedEntityIds) {
  return !!entry.id && flaggedEntityIds.has(entry.id);
}

function isCollapsed(entry, flaggedEntityIds) {
  if (isPinned(entry)) return false;
  if (isFlaggedUnreviewed(entry, flaggedEntityIds)) return false;
  return importanceOf(entry) < HEADLINE_IMPORTANCE_THRESHOLD;
}

/**
 * Summarize a batch into headline + per-region groupings.
 * @param {object} batch  a review-state.mjs Batch object
 * @param {object} [opts]
 * @param {Set<string>} [opts.flaggedEntityIds]  entity ids to force out of
 *   collapse regardless of importance (Phase 4 task 4.2) — typically the
 *   result of human-review.mjs's findUnreviewedEntities(), mapped to a Set
 *   of entityId by the caller. Defaults to an empty Set (no forcing), so
 *   every existing caller that doesn't pass this is unaffected.
 * @returns {{headline:string, regions: Array<{regionId:string, entities:Array, headline:string}>}}
 */
export function summarizeBatch(batch, opts = {}) {
  const flaggedEntityIds = opts.flaggedEntityIds ?? new Set();

  const byRegion = new Map();
  for (const m of batch.mutations) {
    const key = m.regionId ?? `solo-${m.mutationId}`;
    if (!byRegion.has(key)) byRegion.set(key, []);
    byRegion.get(key).push(m);
  }

  const regions = [...byRegion.entries()].map(([regionId, mutations]) => {
    const entities = mutations.map((m) => ({
      mutationId: m.mutationId,
      entityId: m.id ?? null,
      name: displayName(m),
      op: m.op,
      rationale: m.rationale,
      importance: importanceOf(m),
      pinned: isPinned(m),
      flaggedUnreviewed: isFlaggedUnreviewed(m, flaggedEntityIds),
      collapsed: isCollapsed(m, flaggedEntityIds),
      data: m.data ?? null,
      // Phase 37 task 37.2: the shared proposal-card (review-ui/public/proposal-card.js)
      // reads these off batchDetailPayload's region entities to paint data-type /
      // data-risk. Stamped by attachDiffs (schema.mjs SCHEMA_VERSION 5); null on
      // any pre-Phase-37 batch, a real valid "unclassified" state.
      type: m.type ?? null,
      risk: m.risk ?? null,
      diff: m.diff ?? null, // populated by a caller that ran diff.mjs against a live snapshot, if any
      // Phase 12 task 12.5: graph-import/scan-mentions.mjs's LINK-vs-PROPOSE-NEW
      // discriminator, surfaced so review-ui can render the mandatory badge +
      // border accent -- null for every other mutation producer (writeup-import,
      // texture.mjs, etc.), which never set entityContext.scanResultKind at all.
      scanResultKind: m.entityContext?.scanResultKind ?? null,
      // Friction Wave 1 (W2a/W2b): graph-import/writeup-import.mjs's
      // pre-dry-run normalization record ({kind:'near-miss-rename'|'type-
      // conflict-resolved', ...}) -- surfaced so the review card can show
      // WHY this row targets an existing entity the writeup never named
      // exactly. Null for every other producer, same convention as
      // scanResultKind above.
      writeupNormalization: m.entityContext?.writeupNormalization ?? null,
      // Narrative-state layer (WS4): writeup-import's per-entity GM
      // truth/stance/revealState carrier ({truth?, stance?, revealState?})
      // -- surfaced so the review card can paint the GM-TRUTH block the GM
      // is actually accepting (it lands in the sidecar store on accept,
      // never in the graph). Null for every producer that never sets it,
      // same convention as the two carriers above.
      narrativeState: m.entityContext?.narrativeState ?? null
    }));
    return { regionId, entities, headline: renderRegionHeadline(regionId, entities) };
  });

  const totalMutations = batch.mutations.length;
  const allEntities = regions.flatMap((r) => r.entities);
  const pinnedNames = allEntities.filter((e) => e.pinned).map((e) => e.name);
  const flaggedNames = allEntities.filter((e) => e.flaggedUnreviewed).map((e) => e.name);

  const headlineParts = [
    `Batch ${batch.id}: ${regions.length} region${regions.length === 1 ? "" : "s"}, ` +
      `${totalMutations} mutation${totalMutations === 1 ? "" : "s"}.`
  ];
  if (pinnedNames.length) {
    headlineParts.push(`Full review flagged for: ${pinnedNames.join(", ")}.`);
  }
  if (flaggedNames.length) {
    headlineParts.push(`Unreviewed-accumulation flagged for: ${flaggedNames.join(", ")}.`);
  }

  return { headline: headlineParts.join(" "), regions };
}

function renderRegionHeadline(regionId, entities) {
  const visible = entities.filter((e) => !e.collapsed);
  const collapsedCount = entities.length - visible.length;
  const visibleNames = visible.map((e) => e.name);
  const suffix = collapsedCount > 0 ? ` (+${collapsedCount} minor)` : "";
  const names = visibleNames.length ? visibleNames.join(", ") : `${entities.length} minor change${entities.length === 1 ? "" : "s"}`;
  return `${regionId}: ${names}${suffix}`;
}

/** Render the top-level headline + per-region one-liners as plain text/markdown. */
export function renderHeadline(summary) {
  const lines = [summary.headline, ""];
  for (const region of summary.regions) {
    lines.push(`- ${region.headline}`);
  }
  return lines.join("\n").trimEnd();
}

/**
 * Render one region: full detail for non-collapsed entities, a terse
 * one-liner for collapsed ones.
 */
export function renderRegionDiff(region) {
  const lines = [`## ${region.regionId}`, ""];
  for (const entity of region.entities) {
    if (entity.collapsed) {
      lines.push(`- ${entity.name} (${entity.op}) — ${entity.rationale}`);
    } else {
      lines.push(renderEntityDiff(entity));
      lines.push("");
    }
  }
  return lines.join("\n").trimEnd();
}

/** Render full drill-down detail for a single entity's mutation, regardless of collapse state. */
export function renderEntityDiff(entity) {
  const lines = [`### ${entity.name} (${entity.op})`];
  if (entity.pinned) lines.push("_pinned for full review_");
  lines.push(`Rationale: ${entity.rationale}`);

  if (Array.isArray(entity.diff) && entity.diff.length) {
    lines.push("Changes:");
    for (const change of entity.diff) {
      if (change.field === "(created)") {
        lines.push(`  - created: ${JSON.stringify(change.to)}`);
      } else {
        lines.push(`  - ${change.field}: ${JSON.stringify(change.from)} -> ${JSON.stringify(change.to)}`);
      }
    }
  } else if (entity.data && Object.keys(entity.data).length) {
    lines.push(`Proposed values: ${JSON.stringify(entity.data)}`);
  }

  return lines.join("\n");
}
