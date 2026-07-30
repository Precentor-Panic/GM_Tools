/**
 * Small, pure, DOM-free debounce/flush helper for autosaving typed text.
 * See test/session-planner/debounced-save.test.mjs for the full contract
 * this module implements — that file's header comment is the spec.
 *
 * Used by review-ui/public/session-planner-view.js to drive inline note
 * autosave: debounce on `input`, flush immediately on `blur`, and a
 * guaranteed flush hooked into app.js's hashchange listener.
 */

export function createFlushableDebounce(saveFn, { debounceMs = 500 } = {}) {
  let timer = null;
  let latestValue;
  let dirty = false;

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function save() {
    clearTimer();
    if (!dirty) return;
    dirty = false;
    saveFn(latestValue);
  }

  function onInput(value) {
    latestValue = value;
    dirty = true;
    clearTimer();
    timer = setTimeout(save, debounceMs);
  }

  function onBlur(value) {
    latestValue = value;
    dirty = true;
    save();
  }

  function flush() {
    save();
  }

  return { onInput, onBlur, flush };
}
