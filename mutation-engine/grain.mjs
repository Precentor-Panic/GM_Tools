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

function isCollapsed(entry) {
  if (isPinned(entry)) return false;
  return importanceOf(entry) < HEADLINE_IMPORTANCE_THRESHOLD;
}

/**
 * Summarize a batch into headline + per-region groupings.
 * @param {object} batch  a review-state.mjs Batch object
 * @returns {{headline:string, regions: Array<{regionId:string, entities:Array, headline:string}>}}
 */
export function summarizeBatch(batch) {
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
      collapsed: isCollapsed(m),
      data: m.data ?? null,
      diff: m.diff ?? null // populated by a caller that ran diff.mjs against a live snapshot, if any
    }));
    return { regionId, entities, headline: renderRegionHeadline(regionId, entities) };
  });

  const totalMutations = batch.mutations.length;
  const pinnedNames = regions
    .flatMap((r) => r.entities)
    .filter((e) => e.pinned)
    .map((e) => e.name);

  const headlineParts = [
    `Batch ${batch.id}: ${regions.length} region${regions.length === 1 ? "" : "s"}, ` +
      `${totalMutations} mutation${totalMutations === 1 ? "" : "s"}.`
  ];
  if (pinnedNames.length) {
    headlineParts.push(`Full review flagged for: ${pinnedNames.join(", ")}.`);
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
