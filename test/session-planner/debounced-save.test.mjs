/**
 * CONTRACT UNDER TEST — Phase 17 task 17.0. Specifies (does not yet
 * implement — this file is expected to fail with "Cannot find module" until
 * task 17.3 lands) a small, pure, DOM-free debounce/flush helper factored
 * OUT of the DOM-coupled session-planner view module, per
 * `plans/phase-17-review.md` §6 and `plans/phase-17-tasks.md` task 17.0's
 * explicit instruction to specify this as its own unit-testable function.
 *
 * ---------------------------------------------------------------------------
 * MODULE LOCATION: review-ui/public/debounced-save.mjs
 * ---------------------------------------------------------------------------
 * Deliberately placed under `review-ui/public/` (a sibling of app.js /
 * graph-view.js), NOT under root `session-planner/` alongside
 * corridor.mjs/digest.mjs/flags.mjs/scenes.mjs/session-notes.mjs, even
 * though the module itself has zero DOM references and is fully importable
 * under plain `node --test` (proven by this very test file, which imports
 * it with no browser). Reasoning: `session-planner/*.mjs` (Phase 16) is the
 * graph/engine layer -- pure functions over {entities, edges}/stores, wholly
 * ignorant of any UI concern. This module's *purpose* is UI-specific (arming
 * a save cycle for an on-screen textarea, flushing on blur/hashchange) even
 * though its *implementation* happens to need no DOM API -- its `saveFn`
 * callback is always going to be a `fetch()`-wrapping closure supplied by
 * review-ui/public/session-planner-view.js (task 17.2-17.3's new view
 * module, the graph-view.js sibling per that task's own file-organization
 * question). Keeping it a separate small file (rather than inlining the
 * timer logic into session-planner-view.js directly) is what makes its
 * timing/flush-ordering behavior verifiable here without a browser at all --
 * matching this project's established "pure logic gets its own
 * `node --test` file; DOM/rendering glue gets Playwright" split (e.g.
 * graph-view.js's own positionPopoverAt/clampPopoverIntoView are NOT
 * separated out this way because their whole job IS DOM measurement; this
 * helper's job is pure timer/state sequencing, so it can and should be).
 *
 * ---------------------------------------------------------------------------
 * EXPORTED CONTRACT
 * ---------------------------------------------------------------------------
 *   export function createFlushableDebounce(saveFn, { debounceMs = 500 } = {})
 *     -> { onInput(value), onBlur(value), flush() }
 *
 *   - `saveFn(value)`: caller-supplied, called with exactly the most recent
 *     value passed to onInput/onBlur at the moment a save actually fires.
 *     This module never inspects `value` -- treated as an opaque payload
 *     (the real caller, session-planner-view.js, passes the note textarea's
 *     current string; this module doesn't care that it's a string).
 *     `saveFn`'s return value (sync or a Promise) is not awaited or
 *     otherwise consumed by this module -- fire-and-forget, matching how
 *     the real call site (a `POST /api/session-planner/notes`) is itself
 *     fire-and-forget from the hashchange listener's perspective (see
 *     review-ui/test/e2e/session-planner-flush-on-navigate.e2e.mjs's header
 *     comment for why that's safe: the value is captured into THIS module's
 *     own closure state on every onInput call, decoupled from whether the
 *     DOM node that produced it still exists by the time the save fires).
 *
 *   - `onInput(value)`: records `value` as the latest pending value, marks
 *     the debounce dirty, and (re)arms a fresh `debounceMs` timer -- any
 *     previously-armed timer from an earlier onInput call is canceled
 *     first, so rapid-fire onInput calls collapse into exactly ONE eventual
 *     save (of the LAST value), not one save per call. This is the
 *     `input`-event-driven ~500ms autosave path from the design record.
 *
 *   - `onBlur(value)`: records `value` (same as onInput), then flushes
 *     IMMEDIATELY -- cancels any pending timer and calls `saveFn(value)`
 *     synchronously within this call, with NO additional debounce delay.
 *     Design record §6: "Debounce and blur are different mechanisms... blur
 *     flushes immediately... it's already a discrete 'done editing' signal,
 *     don't debounce a discrete event."
 *
 *   - `flush()`: the guaranteed-flush-on-hashchange path. Takes NO
 *     argument (deliberately -- see the module-location note above: it must
 *     work correctly even when called from a context, like a hashchange
 *     listener, where re-reading a live DOM element isn't a safe
 *     assumption). Cancels any pending timer and calls `saveFn(latestValue)`
 *     synchronously, using whatever value was most recently captured via
 *     onInput/onBlur -- but ONLY IF there is a genuinely pending (unsaved)
 *     value. If nothing is dirty (no onInput/onBlur since the last actual
 *     save, or flush() called on a brand-new instance that never received
 *     input), flush() is a NO-OP -- it must NOT call saveFn again with
 *     stale/already-saved data. This matters for the real call site: the
 *     app's hashchange listener calls flush() UNCONDITIONALLY on every
 *     single navigation (per the design record, "hung on the same spot
 *     that already closes the mobile drawer"), including the overwhelmingly
 *     common case where no note editor is even open -- a no-op-when-clean
 *     flush() is what makes that safe to do unconditionally rather than
 *     needing an extra "is anything open" guard at the call site.
 *
 *   - Re-arming after a flush: calling onInput again AFTER any save has
 *     fired (via the debounce timer, onBlur, or flush()) must start a
 *     completely fresh debounce cycle -- the "dirty" flag and timer state
 *     are not permanently consumed by one save, this is a reusable,
 *     stateful instance across an arbitrary number of save cycles (the real
 *     call site keeps ONE createFlushableDecoded instance alive per
 *     currently-open note editor for as long as that editor stays open).
 *
 * Real DOM-driving verification of this helper actually wired into the view
 * (blur firing on a real textarea, hashchange firing while typing) belongs
 * in review-ui/test/e2e/session-planner-flush-on-navigate.e2e.mjs, not
 * here -- this file only proves the pure timer/state logic in isolation,
 * deliberately fast (short debounceMs) and deterministic (real setTimeout,
 * no fake-timer library needed, matching review-ui/test/scan-dedupe.test.mjs's
 * own established real-short-timeout convention in this codebase).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFlushableDebounce } from "../../review-ui/public/debounced-save.mjs";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("debounced onInput calls collapse into exactly one save, of the LAST value, after the debounce window", async () => {
  const calls = [];
  const debounced = createFlushableDebounce((v) => calls.push(v), { debounceMs: 30 });

  debounced.onInput("a");
  debounced.onInput("ab");
  debounced.onInput("abc");

  assert.equal(calls.length, 0, "must not save synchronously on input -- it's debounced");
  await wait(60);
  assert.deepEqual(calls, ["abc"], "exactly one save, carrying the LAST value, not one save per keystroke");
});

test("onBlur flushes immediately, canceling any pending timer, with no extra debounce delay", async () => {
  const calls = [];
  const debounced = createFlushableDebounce((v) => calls.push(v), { debounceMs: 30 });

  debounced.onInput("typed while focused");
  debounced.onBlur("typed while focused, then blurred");

  assert.deepEqual(
    calls,
    ["typed while focused, then blurred"],
    "onBlur must save synchronously within its own call, not wait for the debounce window"
  );

  await wait(60);
  assert.equal(
    calls.length,
    1,
    "the timer armed by the earlier onInput must have been canceled by onBlur -- no second, stale save later"
  );
});

test("flush() saves immediately regardless of debounce state, canceling any pending timer", async () => {
  const calls = [];
  const debounced = createFlushableDebounce((v) => calls.push(v), { debounceMs: 30 });

  debounced.onInput("mid-debounce-window text");
  debounced.flush();

  assert.deepEqual(
    calls,
    ["mid-debounce-window text"],
    "flush() must save synchronously within its own call, not wait for the debounce window to elapse"
  );

  await wait(60);
  assert.equal(
    calls.length,
    1,
    "the timer armed by onInput must have been genuinely canceled by flush() -- no later duplicate save"
  );
});

test("flush() with nothing pending is a no-op -- safe to call unconditionally (the real hashchange-listener use case)", async () => {
  const calls = [];
  const debounced = createFlushableDebounce((v) => calls.push(v), { debounceMs: 30 });

  // Never called onInput/onBlur at all -- this instance has nothing dirty.
  debounced.flush();
  assert.equal(calls.length, 0, "flush() on a clean instance must not invent a save call");

  // Also true immediately AFTER a real save already flushed everything.
  debounced.onInput("saved once");
  debounced.flush();
  assert.deepEqual(calls, ["saved once"]);
  debounced.flush();
  assert.deepEqual(
    calls,
    ["saved once"],
    "a second flush() with nothing NEW pending since the last save must not re-save the same value again"
  );
});

test("calling onInput again after a flush correctly re-arms a fresh debounce cycle", async () => {
  const calls = [];
  const debounced = createFlushableDebounce((v) => calls.push(v), { debounceMs: 30 });

  debounced.onInput("first note");
  debounced.flush();
  assert.deepEqual(calls, ["first note"]);

  // Re-arm: a fresh onInput after the flush must start a genuinely new
  // debounce cycle, not be a no-op because the instance thinks it's
  // "already saved" forever.
  debounced.onInput("second note, typed later");
  assert.deepEqual(calls, ["first note"], "must not save synchronously on input");
  await wait(60);
  assert.deepEqual(
    calls,
    ["first note", "second note, typed later"],
    "the re-armed cycle must produce its own, separate save after its own debounce window"
  );
});

test("onBlur re-arms correctly too -- a later onInput after an onBlur-triggered save still produces a new save", async () => {
  const calls = [];
  const debounced = createFlushableDebounce((v) => calls.push(v), { debounceMs: 30 });

  debounced.onInput("typed");
  debounced.onBlur("typed, blurred");
  assert.deepEqual(calls, ["typed, blurred"]);

  debounced.onInput("typed again after refocusing");
  await wait(60);
  assert.deepEqual(calls, ["typed, blurred", "typed again after refocusing"]);
});
