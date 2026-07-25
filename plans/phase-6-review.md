# Phase 6 — Batch Review Interface Design

**Why this document exists:** before building the dedicated web review UI (deferred since Phase 1, specifically for this moment), two independent perspectives were gathered — a working-GM persona on actual day-to-day needs, and an HMI/UI-design persona on concrete interaction design grounded in those needs. This is the design record; `plans/phase-6-tasks.md` is the resulting build plan. Read this when a task's rationale needs more depth than the task file gives.

---

## The GM's stated needs (verbatim reasoning, gathered first)

1. **Landing screen = a pending-work queue, not a dashboard.** "I open this the way I open my email — I want to know what needs me, not admire a system." Sorted: explicitly-requested items first, then auto-flagged unreviewed-accumulation items. No charts, no graph front-and-center. True empty state says so in one line and gets out of the way.
2. **Reviewing one batch**: headline list, one line per entity, plain language, scanned like a commit log. Wants multi-select checkboxes + bulk accept for the boring stuff — explicitly not one-at-a-time clicking through a dozen NPCs. Anything that snags attention expands **inline**, never a separate page. Regenerate-with-note box sits directly under the diff it regenerates. Narration must not appear until after accept, and must be **visually distinct** from the rationale above it — different audiences (GM deciding vs. GM performing), and conflating them causes real confusion.
3. **Deferred/lazy debt**: its own separate, quiet tab, not the front page — "half the point of deferred resolution is that I'm allowed to not think about it." Surfaces only on explicit click-in or a direct search for that entity, and resolves right there, not via a separate queue hunt.
4. **Unreviewed-accumulation flags**: should "interrupt, mildly" — not a popup, forced into the headline view with a small distinct marker. Designed specifically to fight the GM's own tendency to skip review.
5. **Explicitly wants collapsed by default**: the full graph visualization (useful "maybe once a month," not daily); rollback as a single "undo last batch" button, no visible history/log; Foundry sync status/controls in a settings corner, not competing with content decisions.

---

## The interaction design (HMI persona's response)

### Screen structure
Four views, one shell, no router library — a single `index.html` with four `<section>` panels toggled by a plain JS `showView(id)` (sets `display`, updates `location.hash` so back/forward/reload work without a framework):
- **Queue** (`#queue`, default) — pending-work list.
- **Batch Review** (`#review`) — opened from a queue item; full headline list + inline expansion.
- **Deferred Debt** (`#debt`) — separate tab, never auto-opened.
- **Settings/Sync** (`#settings`) — reached by a gear icon, corner-anchored.

Reasoning: Queue and Debt are genuinely separate tasks/mental modes ("what needs me now" vs. "what am I choosing to dig into") — separate views, recognition over recall. *Within* one batch review, expansion stays inline because losing your place in a scan-a-dozen-things-fast list is a real cost. Page-level nav between tasks, zero-navigation disclosure within a task.

### Batch Review screen
One scrolling list, one row per entity mutation: checkbox + plain-language line + disclosure caret. Use native `<details>/<summary>` per row (keyboard-accessible for free) with the checkbox pulled outside `<summary>` so clicking it doesn't toggle expansion. A sticky action bar at the top of *this list* (not the viewport): `[Accept Selected] [Reject Selected] [Select All Boring]` — "boring" pre-checks everything below the batch's importance threshold.

**Diff rendering**: not JSON — a two-column `field : before → after` table, monospace only for values, changed cells subtly bolded/colored, unchanged context fields omitted entirely (data-ink minimization — every pixel represents a change). `(created)` renders as a single badge in the before-cell, a recognizable shape rather than a blank to read.

**Regenerate-with-note**: a plain input + button inside the expanded row's own `<details>`, below its diff — not a modal, not a page-level shared box. Regenerating swaps only that row's diff via `fetch`, collapsing back to the same expanded state.

**Narration vs. rationale, concrete split**: rationale = normal sans-serif body font, plain neutral card, "Why:" label prefix. Narration (only rendered after Accept, replacing that row's action bar) = **serif font, distinct parchment/cream background tint** (`#faf3e6` light / warm dark-brown in dark mode), larger line-height, no label — reads like prose because it's typeset like prose. Font/background differences are visible before reading a word, which matters because these two texts sit near each other on screen in the one moment (right after accept) they could be confused.

### Accumulation-flag "mild interrupt"
A 1px amber left border on the row + a small filled dot before the headline text — not a banner, not a modal, not full-row color. Forced into the headline list itself (not a separate section) — spatial inevitability (can't scroll past it while already reading) instead of urgency signaling (no color screaming). Expanding shows one line: "Never reviewed — accumulated N changes since cycle X."

### Deferred-debt tab
Search box filtering a flat entity list client-side, no browsing hierarchy. Selecting a result inline-expands (same `<details>` pattern) to show accumulated tags as a plain list ("cycle 4: raided", "cycle 6: relocated") with one `[Resolve Now]` button — fires the synthesis call and swaps the tag list for a normal diff, right there.

### Collapsed/secondary elements
- **Graph browser**: one nav link, "Explore Graph," opening a genuinely separate full page — the one place a real page-load is fine, since it's explicitly monthly-not-daily.
- **Rollback**: one "Undo Last Batch" button in Settings, plain `window.confirm`, no history list.
- **Sync status**: small colored dot + text ("Foundry: live" / "Headless") in Settings only, never on Queue/Review.

### Flagged additions (HMI persona's own judgment, not GM-requested)
- **Undo toast** after any accept/reject, inline "Undo" link for ~8 seconds — cheap safety net specifically because fast checkbox bulk-accept is exactly where misclicks happen, and the only other recovery is the one-shot rollback button buried in Settings.
- **Keyboard shortcuts on Review** (`j`/`k` move focus row, `space` toggles checkbox, `enter` expands) — justified by the GM's own email/git-log comparison; both of those tools live and die by keyboard triage.
