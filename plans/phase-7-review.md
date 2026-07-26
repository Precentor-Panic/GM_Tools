# Phase 7 — Visual Graph View Design (Rescoped)

**Why this document exists:** Phase 7 was originally scoped, months ago, as a low-priority "explore the graph, maybe once a month" utility — deliberately minimal, a single external link from Settings, no real interaction design invested. First hands-on use of the Batch Review list on a genuinely large writeup-import batch ("the extraction frontpage is very overwhelming") prompted the project owner to connect that problem directly to Phase 7, and to significantly elevate its scope. This document records the resulting DM + interaction-design review; `plans/phase-7-tasks.md` is the build plan.

---

## The DM's stated needs (gathered directly)

1. **The job is triage, not reading.** The list makes every proposed change look equally weighty regardless of order. A graph should let the GM spot, at a glance: **clusters** (a tight group of changes belonging to one story thread — accept the whole thing in one motion), **hub nodes** (a heavily-connected node is high-stakes because changes there ripple; a leaf node is low-stakes), **orphans** (a proposed node with no edges is almost always an extraction mistake), and **conflicts** (contradictory edges converging on one existing node — invisible in a scrolled list, obvious as crossing lines in a graph).
2. **Status needs two independent visual channels.** Unreviewed and deferred-debt are not mutually exclusive — a node can be both — so they can't share one combined signal. Entity-type color (already used elsewhere) occupies the fill; status rides on the frame (border + a separate badge/dot), not on fill, so it doesn't fight with type.
3. **Scope depends on where you opened it from.** From inside a batch review: the batch's proposed nodes **plus their immediate existing neighbors** (not the whole campaign graph — that's noise for a 20-node decision), with an explicit way to expand further. As a standalone, persistent thing: the **whole graph**, but filtered to flagged (unreviewed/deferred-debt) nodes by default — scanning hundreds of quiet nodes for the few that need attention is the same overwhelming-list problem moved into a new widget.
4. **Click-through must not rebuild the diff reader.** A node click gets a small popover (name, one-line change summary, status, Accept/Reject) for the easy calls. Anything uncertain jumps into the list, scrolled to and expanded — the existing detail/diff UI, reused verbatim, never duplicated.
5. **Stability matters now that it's a daily surface.** Positions should not rearrange between sessions — if the GM has mentally mapped where the faction web sits, it should stay there.

## The interaction-design synthesis

### Two surfaces, one visual language
1. **A List/Graph toggle on the Review screen itself** (`[ List | Graph ]`, List default) — batch-scoped-with-context: the batch's proposed nodes plus their one-hop persisted neighbors, with an "expand context" control to widen it.
2. **A standalone "Graph" nav entry** (alongside Queue/Review/Deferred Debt/Settings) — whole-graph, batch-independent, defaulting to a filter of `unreviewed OR deferred-debt`, with search/filter and an explicit "show everything" control. **Confirmed via direct question**: build this as a real nav-level view, not just the in-Review toggle with the old Settings link pointed at a nicer version of the same thing.

Both surfaces share one node/status visual vocabulary — this is one graph-rendering system used in two contexts, not two separate ones.

### Node visual spec (vanilla SVG, no charting library — matches this project's zero-build-step convention)
- **Shape**: circle, every node. **Size**: scaled modestly by degree (edge count), clamped min/max, so hubs read as bigger without dominating.
- **Fill**: entity type — reuse whatever categorical color mapping already exists elsewhere in the app.
- **Border (channel 1 — unreviewed)**: neutral gray normally; amber when unreviewed, directly reusing the existing list-view convention.
- **Badge/dot (channel 2 — deferred debt)**: a small corner dot, present only when the entity has unresolved deferred debt — independent of the border, so both can show at once.
- **Dashed vs. solid border**: in batch-with-context mode, proposed-but-undecided batch nodes render dashed; persisted/committed nodes render solid.
- **Label**: entity name below the node, truncated with a full-name hover tooltip. **Edges**: thin gray lines, arrowhead if the relationship is directional; dashed for batch-only edges.

### Interaction
- **Hover**: tooltip with name/type/status as text.
- **Click**: anchored popover — one-line change summary, status badges, Accept/Reject right there, plus a "Show in list" link.
- **Show in list / double-click**: switches to List mode with that row scrolled into view and expanded.
- **Accept/Reject from the popover**: updates the SAME shared batch-selection state the list uses — list and graph are two views over one selection, never two sources of truth. The node visually resolves (checkmark/X, fades to a muted "decided" state) and the list row updates in lockstep.
- **Multi-select** (shift-click or rubber-band drag): selects a cluster of nodes, then applies the existing bulk accept/reject bar to the graph selection — the actual mechanism that realizes "accept a whole cluster at once," not just a way to see one.

### Layout & performance
- **Batch-scoped view** (tens of nodes): a compact, hand-rolled force-directed layout run once on open, positions cached (per batch or session) so reopening doesn't re-jitter.
- **Standalone dashboard** (potentially hundreds of nodes over a long campaign): the default flagged-only filter is the main scaling lever, not clever rendering — keep the actually-rendered node count small by default regardless of total graph size. A scale fallback (interactivity throttling past a node-count threshold) is explicitly **deferred** — build the filtered SVG path first; only add a fallback once real campaign graph sizes make it necessary.

### Flagged additions (the interaction-design persona's own judgment, confirmed or noted)
- The standalone nav-level Graph dashboard — **confirmed** via direct question, not just inferred.
- Splitting unreviewed/deferred-debt into two independent visual channels rather than the list's combined signal — necessary since the graph must represent both statuses co-occurring.
- Dashed-vs-solid border for proposed-vs-persisted nodes in context mode.
- Multi-select feeding the existing bulk accept/reject bar.
- Cached/frozen layout positions between sessions.
- A deferred, NOT-yet-built scale fallback for the standalone dashboard — explicitly recommended as later work, not a v1 requirement.
