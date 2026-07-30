# GM_Tools — Phase 17 Design Record: Session Planner UI

**Status:** design complete, not yet built. Builds directly on Phase 16 (`plans/phase-16-review.md`, `plans/phase-16-tasks.md`), which shipped the engine and API (`session-planner/*.mjs`, `/api/session-planner/*` routes) with zero UI. This record captures a UX review and a webdev performance/testability review run against a concrete draft plan, both grounded in the actual shipped Phase 16 code (not speculative API shapes).

---

## 1. What's being built

A new "Plan Session" view in `review-ui/public/`, reachable from the existing hash-router nav (same pattern as Queue/New Import/Deferred Debt/Graph), that renders a `GET /api/session-planner/brief` response as a live, annotatable surface — plus the interactions needed to create/fork scenes and capture notes against entities.

## 2. Ground truth: the actual `brief` response shape (confirmed from shipped code, `session-planner/brief.mjs`)

```js
{
  sceneId, path,   // path: the location entity id(s) the corridor was built from
  locations: [
    {
      entityId, distance,                       // 0 = on the path itself
      digest: { name, roleTag, hook } | null,    // null = no established fact/hook yet
      contentFlag: { flagged, reason? },         // independent of structuralFlag
      structuralFlag: { flagged },               // independent of contentFlag
      notes: [ { id, text, timestamp, consumed } ]
    }, ...
  ],
  beyondCorridor: { contentReadinessCount, structuralUnderConnectionCount }
}
```

`locations` is deliberately unordered data (Phase 16 §7) — no chapter/sequence field anywhere. This is a hard constraint carried forward into the UI, not just the data: **render order must not encode a reading sequence either**, even without explicit numbers (see §3).

## 3. Layout: anchor + satellites, not a uniform grid

A uniform grid, rendered the same way every session, becomes an implicit reading order through repetition even with the numbers stripped off — this was the single sharpest UX finding. Two concrete rules:

- **Never sort `locations` by `distance` (or anything else monotonic) for render order.** Distance-sorted rendering is chapter numbering with the digits filed off. Randomize or hash-order instead.
- **Path locations (`distance: 0`) get a visually distinct anchor treatment** — pinned, larger, or differently bordered. Everything else renders as loose satellite cards around it, not in the same rank-and-file grid cell shape. This encodes the real data relationship (proximity to the path) instead of a scan order.

## 4. The digest and flags — always visible, never merged

- `digest` renders inline, unconditionally, no click required — this is the whole point of the ambient/improv mode from Phase 16 §3.
- `digest: null` needs its own **conspicuous** "no established fact yet" state, not blank space — blank space reads as a loading glitch, not a real signal.
- `contentFlag` and `structuralFlag` render as two visually distinct badges, never merged into one combined indicator (Phase 16 §5's independence requirement, carried into the visual spec explicitly so it can't be lost in implementation).
- Flag encoding must not be color-only — icon/shape too. This is explicitly an ambient/improv-use surface, plausibly read at a table in low light.

## 5. Notes: inline-expand, not a popover — a bug avoided before it was built

The original draft proposed reusing `graph-view.js`'s existing popover (`positionPopoverAt`/`clampPopoverIntoView`) with a new slim template for note capture. The UX review caught a real bug in that plan before any code existed: the existing dismiss helper those functions pair with (`wireFormDismiss`) is documented as "Esc/click-outside cancels with nothing written." Reused unmodified, clicking outside the notes popover — the single most likely dismissal action during play — would silently discard the note, directly violating the "must never lose text" requirement.

**Resolution, adopted as the actual design:** notes on a card's own listed entities use **inline-expand within the row** — click an entity's name, a textarea unfolds in place beneath it, existing notes render the same way. No positioning/clamping logic, nothing to accidentally dismiss, survives scroll/resize for free. The entity name is **not** the click target for this — give notes their own small affordance (a pencil/note icon per row), since the name doubling as both "read the digest" and "start editing a note" invites accidental edits while just browsing a dense card.

**Deferred out of this phase:** the popover pattern is only genuinely needed for a different case — annotating an entity mentioned *inside* another entity's own hook/digest text (prose, not a row to expand into). That's a real, narrower surface with real risk of its own (a new popover template needs its own listener-lifecycle wiring — reusing `positionPopoverAt` buys positioning geometry only, not leak-safety — and its own overflow-clamping test, since Phase 14.5's clamping fix was proven for a different container, the SVG graph canvas, not this card grid). Shipping inline-expand-only for v1 covers the actual common ambient-annotation use case with a smaller, cleaner surface; the in-prose-mention popover is a fast-follow, not part of this phase.

## 6. Autosave mechanics

Debounce and blur are different mechanisms, composed correctly rather than treated as one:

- Debounce the `input` event (~500ms — comfortably under the app's existing ~1.5s `withSlowNotice` threshold so the two never perceptually compete).
- `blur` flushes immediately (calls the save function directly, cancels the pending timer) — it's already a discrete "done editing" signal, don't debounce a discrete event.
- **Guaranteed flush on `hashchange`**, hung on the same spot that already closes the mobile drawer on navigate (`app.js`'s existing `hashchange` listener). This is the real risk the webdev review surfaced: an in-progress, not-yet-saved note must never be silently lost just because the DM navigated away via the hash-router before the debounce timer fired.
- **This case is the opposite of the existing scan-cancellation pattern (`cancelActiveScan`/task 14.8).** A scan is disposable derived output; abandoning it on navigate is correct cleanup. A note is text the DM already typed and expects persisted — flushing it, not aborting it, is the correct behavior on navigate-away. Use the same single-shared-slot convention `activeScanController` established, but for guaranteed flush, not cancellation.
- If the shared save-slot is reused across entities (open a second note before the first's timer fires), the first entity's pending save must flush before arming a timer for the second — otherwise text typed against entity A can post under entity B's id, or drop silently.

## 7. Beyond-corridor summary

- Show `contentReadinessCount` and `structuralUnderConnectionCount` **separately**, not summed into one blended number — merging them here repeats the exact mistake the on-corridor flags were explicitly kept apart to avoid.
- Region-grouping the collapsed counts ("9 beyond the north pass, 5 beyond the old mine") would be more actionable than a flat total, but only if that grouping is already cheap from existing graph data. **Skip it for v1** rather than build new aggregation machinery to get it — a flat, split (not summed) pair of counts is still real, non-noisy signal on its own.

## 8. Staleness: no separate control

Both reviews converged independently: don't add an explicit "where is the party right now" control distinct from re-centering. Re-centering the scene (forking to a new anchor location) already **is** that ground-truth statement; a second, separate concept for the same fact risks the two disagreeing. `checkStaleness` (already built in Phase 16, unused by any UI yet) stays in the codebase but is not wired into this phase's UI — revisit only if a real gap shows up in practice.

## 9. Re-center

- **Type-ahead/search-as-you-select, not a plain `<select>`.** A flat dropdown is real friction at the table the moment a world has more than a couple dozen locations, and "single fast action" doesn't hold if the DM has to scroll a giant list to find where the party actually went.
- **Race guard, reusing the exact `activeScanController` pattern** (a single shared, replaced-on-every-invocation abort slot) — but here abort-on-double-click/navigate is the CORRECT behavior, unlike notes, because re-center's fork+refetch output is derived view state, not typed text the DM is trying to keep. Extend the existing `renderCurrentView()`/`hashchange` cancellation step (which already calls `cancelActiveScan()`) with a parallel `cancelActiveRecenter()`, rather than inventing a second cancellation convention.
- **Disable the re-center control for the duration of the in-flight fork+refetch**, in addition to the abort guard (not instead of it) — cheap defense-in-depth against a double-click issuing two requests in the first place, while the guard still covers navigate-away and out-of-order slow-network responses the disabled-button alone can't catch.

## 10. Rendering discipline

- Full-container rebuild is the right call for **view load and re-center** — matches every other view in this app (`renderQueue`, `renderReview`, etc. all do direct DOM rebuilds), and a few hundred DOM nodes for a normal corridor size is trivially cheap. No virtualization; there's no N here that justifies it.
- **Nothing smaller than a full navigation may trigger that rebuild.** Specifically: a note save (success or error) must only update a small inline indicator, never call the container-level render function — doing so would tear down every card on every blur, including destroying an inline-expanded note the DM has open elsewhere on the grid. State this explicitly in the implementation, don't leave it as an assumption.
- The inline-expand open/close (§5) and the future popover (§5, deferred) are targeted DOM operations on one row/card, never a re-render of the list — matching how `graph-view.js`'s own `showPopover` already never calls a full `renderGraph`.

## 11. Proactive Playwright e2e tests (write before first ship, not after a bug is found)

Per this project's own established bar (a behavior only earns a proactive test when its failure class has already bitten this project once, elsewhere, invisibly):

1. **Flush-on-hashchange-mid-typing.** Type into an inline note, navigate via hash before the debounce fires, assert the save still lands. Direct sibling of Phase 15.3's mobile-drawer-close-on-hashchange fix, already treated as proactive-test-worthy in this project's own history — and the single highest silent-data-loss risk in this phase.
2. **Double-click re-center race.** Click re-center twice fast; assert exactly one fork+refetch wins, no duplicate scene, no stale response overwriting a fresher one. Direct sibling of the already-fixed Phase 14.8 duplicate-batch-from-uncancelled-scan bug — same fetch-then-mutate-then-refetch shape.

**Deferred with the in-prose popover (§5), not written this phase:** listener-leak-on-repeated-open/close for that popover template, and its own overflow-clamping test. These become proactive-test-worthy again the moment that surface actually gets built.

**Left reactive, correctly:** the beyond-corridor expand/collapse toggle — pure client-side state, no persistence, no race, no listener accumulation beyond a single click handler. Matches the class of interaction this project has never needed a proactive test for.

## 12. Explicitly out of scope for this phase

- The in-prose-mention annotation popover (§5) — fast-follow.
- Any UI for `checkStaleness` (§8) — not wired in, revisit only if a real gap shows up.
- Region-grouped beyond-corridor counts (§7) — only if free, otherwise skip.
- Anything from Phase 16 §9's already-deferred items (clue-redundancy, thread-adjacency digest axis, axis-priority config) — unaffected by this UI phase.
