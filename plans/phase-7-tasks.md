# GM_Tools — Phase 7 Task Plan: Visual Graph View (Rescoped)

**Status:** ready to execute — queued behind Phase 10 (per-entity narration), which is concurrently editing overlapping files (`review-ui/public/app.js`, `wf-mcp-server/index.mjs`/`lib/`). Do not start until Phase 10 is committed and the working tree is clean. **Prerequisite reading:** `CLAUDE.md` → `PLAN.md` → this file → `plans/phase-7-review.md` (the design reasoning — settled, not a starting point to redesign) → `.claude/skills/gm-tools-conventions/SKILL.md`.

**What this is:** a real graph-rendering view, in two contexts — a List/Graph toggle on the existing Batch Review screen (context-scoped: this batch plus its immediate persisted neighbors), and a new standalone "Graph" nav entry (whole-graph, filtered to flagged nodes by default). Vanilla SVG, no charting/graph-visualization library — matches this project's zero-build-step, minimal-dependency convention.

**Already built and reusable — confirmed by reading the code, not assumed:**
- `wf-mcp-server/lib/graph.mjs`'s `neighborhood(entities, edges, entityId, depth)` — the exact one-hop (or N-hop) BFS helper needed for "this batch's proposed nodes plus their immediate persisted neighbors." Reuse it; don't write a second graph-walk.
- `mutation-engine/human-review.mjs`/`pending-ledger.mjs` — the existing per-entity flagged-status data (`findUnreviewedEntities`, pending-ledger entries) this view needs to color-code against. Query them the same way `review-ui/server.mjs`'s existing routes already do.
- `review-ui/public/graph.html` — currently a deliberate stub ("Not yet built... a 'maybe once a month' tool"). This phase replaces its content; the file/route already exists, just needs real content.
- Whatever entity-type color mapping already exists in `review-ui/public/style.css`/`app.js` for the Batch Review list — reuse it for node fill, don't invent a second palette.

---

## Task list

### 7.1 — Graph data route
**Files:** `review-ui/server.mjs` (extend)

- A new route returning `{nodes, edges}` for a given scope: either `batchId` (this batch's proposed entities + `neighborhood()`-expanded one-hop persisted neighbors) or a standalone whole-graph query with an optional status filter (`unreviewed`, `deferred-debt`, or both — matching `findUnreviewedEntities`/pending-ledger's existing status vocabulary). Each returned node carries: id, name, type, degree (edge count, for size scaling), `unreviewedUnflagged`/`hasDeferredDebt` booleans, and (batch-scope only) whether it's `proposed` (this batch, undecided) vs `persisted`.
- Keep this a thin query layer over existing library functions — no new business logic, this route composes `neighborhood()` + `findUnreviewedEntities()` + pending-ledger reads.

**Acceptance criteria:** route-level tests matching `review-ui/test/routes.test.mjs`'s established style: batch-scoped query returns the batch's own entities plus real one-hop neighbors (not the whole graph); standalone query with `filter=unreviewed` returns only flagged entities; degree/status fields are correct against a real fixture.

---

### 7.2 — Graph rendering (shared component)
**Files:** `review-ui/public/graph-view.js` (new, shared by both contexts), `review-ui/public/style.css` (extend)

- A single, reusable rendering module (imported by both the Review screen's toggle and the standalone Graph view — one graph-rendering system, not two): SVG-based, circles sized by degree (clamped min/max), filled by entity type (reuse existing color mapping), bordered gray/amber for reviewed/unreviewed, a small corner badge/dot for deferred-debt (independent of the border — a node can be both), dashed border for `proposed`-status nodes in batch-context mode, solid for `persisted`. Edges as thin lines, dashed for batch-only edges, arrowhead if directional (check the relationship-type data for directionality rather than assuming).
- A compact, hand-rolled force-directed layout (no D3 or similar — a basic force simulation is well within plain JS), run once per open, with computed positions **cached** (localStorage, keyed by batch id or a standalone-view key) so reopening the same view doesn't re-jitter.
- Hover tooltip (name/type/status as text). Click → anchored popover with a one-line summary, status badges, and (batch-scope only) Accept/Reject buttons plus a "Show in list" link.

**Acceptance criteria:** manually verified in a real browser (same standard as every prior UI phase — `run` skill + `claude-in-chrome` or, if unavailable in this environment as it has been in every prior UI phase, real headless Chromium via Playwright, with actual screenshots inspected): a batch with a mix of flagged/unflagged/debt-bearing entities renders with visually distinct, correctly-composited status treatment (confirm both channels can show on one node); reopening the same batch's graph view does not visibly rearrange positions.

---

### 7.3 — Review screen List/Graph toggle
**Files:** `review-ui/public/index.html`/`app.js` (extend)

- A `[ List | Graph ]` toggle at the top of the Review screen, List selected by default (matches the project owner's own confirmed default). Graph mode renders via 7.2's shared component, scoped to `batchId` (7.1's batch-scoped route), with an "Expand context" control that requests a deeper `neighborhood()` radius.
- **Shared selection state, not two sources of truth**: clicking Accept/Reject in the graph's popover must update the exact same underlying accept/reject mechanism the list already uses (`acceptOp`/`rejectOp` via the existing routes) — the node visually resolves (checkmark/X, fades to a muted decided state) and the corresponding list row updates in lockstep when the GM switches back to List.
- Multi-select (shift-click or a simple rubber-band drag) on graph nodes, feeding the *existing* bulk accept/reject action bar (task 6.3's `btn-accept-selected`/`btn-reject-selected`) — this is the actual mechanism that realizes "accept a whole cluster at once," not just a way to see one; don't build a second bulk-action bar for the graph.
- "Show in list" / double-click switches to List mode with that row scrolled into view and expanded (reuse the existing open-row-preservation mechanism from Phase 6, don't rebuild it).

**Acceptance criteria:** manually verified: toggling to Graph and back to List preserves accept/reject state made in either mode; multi-select-then-bulk-accept in Graph mode produces the identical result (confirmed via the API) as the same action taken in List mode; "Show in list" correctly scrolls to and expands the right row.

---

### 7.4 — Standalone Graph nav view
**Files:** `review-ui/public/index.html` (extend nav + new `<section>`), `review-ui/public/app.js` (extend), `review-ui/public/graph.html` (replace stub content — or fold into the main SPA shell as a new hash-routed view; your call once in the code, but note the existing stub `graph.html` was a deliberate Phase-6-era placeholder specifically because this feature didn't exist yet, not a page to preserve as-is)

- A new nav entry ("Graph," alongside Queue/Review/Deferred Debt) reaching a whole-graph view via 7.2's shared component and 7.1's standalone-query route, **defaulting to a filter of `unreviewed OR deferred-debt`** (confirmed default, not "show everything") with a search/filter bar (by type, by name, by status) and an explicit "show everything" control for the unfiltered case.
- No scale fallback/interactivity throttling for large unfiltered graphs in this task — explicitly deferred per the design doc's own recommendation (build the filtered path first; only add a fallback once real campaign graph sizes make it necessary). Do not over-build this speculatively.

**Acceptance criteria:** manually verified against a fixture with a realistic mix of flagged/unflagged entities: default view shows only flagged nodes; "show everything" reveals the full set; search/filter narrows correctly; clicking a node's popover correctly has no Accept/Reject (this is a standalone status view, not a batch review — accept/reject only makes sense in 7.3's batch-scoped context) but does support "Show in list" if the entity belongs to an open batch, or a graceful absence of that link if it doesn't.

---

## How to work

- **Actually look at what you build** — this phase is explicitly visual/interaction-heavy, same standard as Phase 6/8.
- Route-level tests in the project's existing style (`node --test`, no framework); manual/screenshot-verified checks for the rendering/interaction itself.
- Commit after each completed task.
- Self-review remediation pass at the end: specifically re-check (a) that graph and list truly share one selection/accept-reject state rather than drifting independently, (b) that the standalone view's default filter genuinely reduces rendered node count on a large fixture rather than rendering everything and hiding it with CSS, and (c) that layout position caching actually survives a page reload, not just an in-session re-render.

## Definition of done for Phase 7

- [ ] Graph data route built and tested, reusing `neighborhood()` rather than a second BFS implementation.
- [ ] Shared SVG rendering component built, used by both the in-Review toggle and the standalone view — one visual system, not two.
- [ ] Unreviewed and deferred-debt render as independent, co-occurring visual channels (confirmed by looking at a node with both).
- [ ] Review screen's List/Graph toggle shares accept/reject state with the list — verified, not assumed.
- [ ] Multi-select in Graph mode drives the existing bulk accept/reject bar.
- [ ] Standalone Graph nav view built, defaulting to a flagged-only filter, with search/filter and an explicit "show everything" escape hatch.
- [ ] Layout positions are cached and stable across a real page reload.
- [ ] Full test suite (root + wf-mcp-server + review-ui) still passes.
- [ ] Self-review remediation pass run and reported.
