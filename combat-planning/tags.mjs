/**
 * Tags helper API — Phase 35 task 35.1, §4 of review-ui/test/e2e/
 * phase35-fixture.mjs (THE WRITTEN CONTRACT). ONE shared module, PURE
 * functions only (no I/O) — reused by combat-planning/item-store.mjs and
 * session-planner/stagecraft-store.mjs (a cross-directory import from
 * session-planner/ into combat-planning/ — a NEW but harmless precedent per
 * the contract's own note: grep-confirmed neither directory imported from
 * the other before this task; flagged here and in this task's completion
 * report rather than silently introduced).
 *
 * Every function here operates on a plain array of "taggable records"
 * (objects with at least `id` and `tags: string[]`) and knows nothing about
 * which store called it or how the result gets persisted — the CALLER (each
 * store's own thin persisting wrapper, e.g. item-store.mjs's addItemTag/
 * removeItemTag) is responsible for writing the returned array back to disk.
 * This mirrors every other store's own "pure helper + a thin persisting
 * wrapper" split (bestiary-store.mjs's checkBestiaryOutliers vs
 * saveBestiaryEntry is the established precedent for this same shape).
 */

/**
 * Adds `tag` (trimmed) to the record with this `id`'s `tags[]`.
 * NO-OP (returns `records` unchanged, same reference) when: `id` isn't
 * found, `tag` is empty/whitespace-only after trimming, or the record
 * already carries this exact (trimmed) tag.
 *
 * @param {object[]} records
 * @param {string} id
 * @param {string} tag
 * @returns {object[]}   a NEW array on a real change, `records` itself unchanged
 */
export function addTag(records, id, tag) {
  const trimmed = typeof tag === "string" ? tag.trim() : "";
  if (!trimmed) return records;
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return records;
  const record = records[idx];
  const existingTags = Array.isArray(record.tags) ? record.tags : [];
  if (existingTags.includes(trimmed)) return records;
  const next = [...records];
  next[idx] = { ...record, tags: [...existingTags, trimmed] };
  return next;
}

/**
 * Removes `tag` from the record with this `id`'s `tags[]`. NO-OP if the
 * record or the tag isn't present.
 *
 * @param {object[]} records
 * @param {string} id
 * @param {string} tag
 * @returns {object[]}   a NEW array on a real change, `records` itself unchanged
 */
export function removeTag(records, id, tag) {
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return records;
  const record = records[idx];
  const existingTags = Array.isArray(record.tags) ? record.tags : [];
  if (!existingTags.includes(tag)) return records;
  const next = [...records];
  next[idx] = { ...record, tags: existingTags.filter((t) => t !== tag) };
  return next;
}

/**
 * Every distinct tag across `records` (an untagged record contributes
 * nothing) mapped to the count of records carrying it — the left-rail "N"
 * next to each tag chip.
 *
 * @param {object[]} records
 * @returns {Object<string, number>}
 */
export function tagIndex(records) {
  const index = {};
  for (const record of records) {
    const tags = Array.isArray(record.tags) ? record.tags : [];
    for (const tag of tags) {
      index[tag] = (index[tag] ?? 0) + 1;
    }
  }
  return index;
}

/**
 * AND semantics (README §H: "selected tags AND together") — a record must
 * carry EVERY tag in `tags` to survive. An empty/omitted `tags` filter is
 * vacuously true for every record (no filter applied, the whole set passes
 * through unchanged).
 *
 * @param {object[]} records
 * @param {string[]} [tags]
 * @returns {object[]}
 */
export function filterByTagsAnd(records, tags) {
  if (!Array.isArray(tags) || tags.length === 0) return records;
  return records.filter((r) => {
    const recordTags = Array.isArray(r.tags) ? r.tags : [];
    return tags.every((t) => recordTags.includes(t));
  });
}
