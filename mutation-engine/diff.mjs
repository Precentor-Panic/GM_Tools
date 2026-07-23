/**
 * Diff engine — pure, Foundry-free, unit-testable.
 *
 * Computes field-level diffs between a "before" and "after" entity/edge
 * state, for conversational review rendering (grain.mjs) and for anyone
 * assembling an entity-level drill-down from a live snapshot + a proposed
 * mutation's `data`.
 */

// Entity fields diffEntity compares. Deliberately excludes id/createdAt/
// updatedAt (identity + bookkeeping, not reviewable "changes"), and other
// derived/positional fields (x, y, lastSession, sessionSeen, rulesVerified,
// source) that aren't part of the mutation-engine's review surface.
const ENTITY_DIFF_FIELDS = [
  "name",
  "type",
  "description",
  "summary",
  "importance",
  "imageUrl",
  "tags",
  "attributes",
  "foundryRef",
  "namespace"
];

// Edge fields diffEdge compares.
const EDGE_DIFF_FIELDS = ["relationshipType", "label", "strength", "valence", "notes"];

/**
 * Diff an entity's before/after state field-by-field.
 *
 * `after` must be the fully-merged next state, not a sparse patch — callers
 * holding a partial mutation payload (e.g. a proposed `Mutation.data`) should
 * merge it onto `before` first (`{ ...before, ...mutation.data }`), matching
 * the merge semantics `interchange.mjs`'s `importGraph` already applies.
 * Passing a sparse object here will read as spurious "cleared to null" diffs
 * for every field the patch omitted.
 *
 * @param {object|null} before  null means "new entity" (created)
 * @param {object} after
 * @returns {{field:string, from:*, to:*}[]}
 */
export function diffEntity(before, after) {
  return diffFields(before, after, ENTITY_DIFF_FIELDS);
}

/**
 * Diff an edge's before/after state field-by-field.
 * @param {object|null} before  null means "new edge" (created)
 * @param {object} after
 * @returns {{field:string, from:*, to:*}[]}
 */
export function diffEdge(before, after) {
  return diffFields(before, after, EDGE_DIFF_FIELDS);
}

function diffFields(before, after, fields) {
  if (before === null || before === undefined) {
    return [{ field: "(created)", from: null, to: after }];
  }

  const changes = [];
  for (const field of fields) {
    const from = before[field];
    const to = after[field];
    if (!deepEqual(from, to)) {
      changes.push({ field, from: from ?? null, to: to ?? null });
    }
  }
  return changes;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!deepEqual(a[key], b[key])) return false;
  }
  return true;
}
