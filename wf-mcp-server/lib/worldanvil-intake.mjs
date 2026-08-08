/**
 * World Anvil (or any http(s) article) lore intake — Phase 34 task 34.1.
 * Server-side fetch of a GM-pasted URL, HTML-stripped to plain text, then
 * delegated to graph-import/writeup-import.mjs's importWriteup — the SAME
 * `{batchId, mutationCount, importSummary, suggestions, headline}` shape
 * POST /api/writeup-propose already returns for a pasted writeup, per
 * plans/phase-34-tasks.md's pre-specified contract (that route is this
 * module's own shape precedent, not reinvented here).
 *
 * Deliberately NOT a World-Anvil-specific API integration — no new
 * dependency, no auth flow, no vendor SDK. Just a plain `fetch()` of
 * whatever URL the GM pastes (World Anvil article pages are public HTML by
 * default), HTML-stripped the same simple way
 * foundry_worldFabric/scripts/data/world-scan.mjs's own journalText()/
 * stripHtml() do it in-Foundry — that implementation is DOM-based
 * (`document.createElement`), which doesn't exist in this Node process, so
 * stripHtmlToText below is a regex-based, Node-safe equivalent following
 * the SAME approach (strip tags, collapse whitespace, no new dependency),
 * not a port of that exact code.
 *
 * TRUNCATE, DON'T REJECT (documented decision — the task explicitly asked
 * this be picked and documented, not left implicit): a fetched page over
 * MAX_WRITEUP_CHARS is truncated to that limit with a trailing note folded
 * into the text itself, NOT a WriteupTooLargeError 4xx the way a pasted
 * writeup over the same limit is rejected. Reasoning: a pasted writeup's
 * length is something the GM directly chose at paste time, so a reject-with-
 * "trim it yourself" is the right, actionable signal there. A fetched
 * article's length is not something the GM controls at the point they paste
 * a URL — a hard reject here would make importing any sufficiently long
 * real World Anvil article impossible from this route with no recourse
 * short of manually copy-pasting a trimmed excerpt through the OTHER
 * (paste) route instead. Truncating loses only the tail of one page; the
 * extraction LLM call tolerates a truncated excerpt fine (the model
 * routinely works from partial context), and nothing about the truncation
 * is hidden — it's folded into `text` before proposeWfiFromWriteup's own
 * retry/validation logic ever sees it, so the resulting importSummary/
 * headline read completely normally, just over a smaller source excerpt.
 */
import { importWriteup, MAX_WRITEUP_CHARS } from "../../graph-import/writeup-import.mjs";

export const DEFAULT_FETCH_TIMEOUT_MS = 10000;

/**
 * Thrown for any fetch-stage failure (unreachable host, timeout, non-2xx
 * response, or successfully-fetched-but-no-readable-text) — a plain Error
 * subclass, so review-ui/server.mjs's existing statusForError default
 * branch (return 400 for anything not explicitly special-cased) already
 * gives this a clean 4xx with a clear message, per the task's own
 * requirement, with no new special-case needed there.
 */
export class WorldAnvilFetchError extends Error {
  constructor(message, { url, cause } = {}) {
    super(message);
    this.name = "WorldAnvilFetchError";
    this.url = url;
    if (cause) this.cause = cause;
  }
}

/**
 * http/https only — rejects file:, javascript:, data:, and any other
 * scheme before ever calling fetch(), matching the task's explicit "http/
 * https only" validation requirement. Also the first line of defense
 * against a malformed string reaching fetch() as a confusing low-level error.
 *
 * @param {string} url
 * @returns {string}  the normalized (URL#toString()) form
 * @throws {Error}  not a string, empty, unparseable, or not http(s)
 */
export function validateWorldAnvilUrl(url) {
  if (typeof url !== "string" || !url.trim()) {
    throw new Error("worldanvil intake requires a non-empty `url`.");
  }
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new Error(`"${url}" is not a valid URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`URL must be http:// or https:// — got "${parsed.protocol}" for "${url}".`);
  }
  return parsed.toString();
}

// Node-safe regex tag-strip, same general shape as world-scan.mjs's
// journalText()/stripHtml() (script/style dropped entirely, block-level
// tags become line breaks, everything else removed, common HTML entities
// decoded, whitespace collapsed) — no DOM, no new dependency.
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };

export function stripHtmlToText(html) {
  if (typeof html !== "string") return "";
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  text = text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (match, code) => {
    if (code[0] === "#") {
      const codePoint = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
  return text.replace(/[ \t]+/g, " ").replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function truncateForImport(text) {
  if (text.length <= MAX_WRITEUP_CHARS) return text;
  const cut = text.slice(0, MAX_WRITEUP_CHARS - 200);
  return (
    `${cut}\n\n[...truncated -- the source page was ${text.length} characters, over the ${MAX_WRITEUP_CHARS}-character ` +
    `import limit; only the first portion was imported...]`
  );
}

/**
 * Server-side fetch + strip, split out from importFromWorldAnvil below so
 * the fetch step can be mocked independently of the LLM step in tests, per
 * gm-tools-conventions' LLM-code testing convention ("a unit test with the
 * API call mocked, verifying orchestration/validation/retry logic").
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]  injectable fetch, for tests
 * @param {number} [opts.timeoutMs]        default DEFAULT_FETCH_TIMEOUT_MS
 * @returns {Promise<string>}  plain text, HTML-stripped, truncated to MAX_WRITEUP_CHARS
 * @throws {Error} invalid/non-http(s) url (validateWorldAnvilUrl)
 * @throws {WorldAnvilFetchError} unreachable, timed out, non-2xx, or no readable text
 */
export async function fetchAndStripUrl(url, opts = {}) {
  const validated = validateWorldAnvilUrl(url);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(validated, { signal: controller.signal, redirect: "follow" });
  } catch (err) {
    throw new WorldAnvilFetchError(`Could not reach "${validated}": ${err.message}`, { url: validated, cause: err });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new WorldAnvilFetchError(
      `Fetching "${validated}" failed with HTTP ${res.status}${res.statusText ? " " + res.statusText : ""}.`,
      { url: validated }
    );
  }

  const html = await res.text();
  const text = stripHtmlToText(html);
  if (!text) {
    throw new WorldAnvilFetchError(
      `Fetched "${validated}" successfully but found no readable text content after stripping HTML.`,
      { url: validated }
    );
  }
  return truncateForImport(text);
}

/**
 * The full route composition: fetch -> strip -> importWriteup. Same
 * `{batchId, mutationCount, importSummary, suggestions, headline}` shape
 * POST /api/writeup-propose returns for a pasted writeup — see this
 * module's own header for why.
 *
 * @param {string} world
 * @param {string} url
 * @param {{entities:object[], edges:object[], entityTypes?:object[]}} existingSnapshot  the live snapshot
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]  injectable fetch, for tests
 * @param {number} [opts.timeoutMs]
 * @param {object} [opts.llmOpts]  forwarded to importWriteup (injectable Anthropic client, etc. — see writeup-import.mjs)
 * @param {() => string} [opts.makeId]  batch id generator, injectable for tests
 * @returns {Promise<{batchId:string, mutationCount:number, importSummary:object, suggestions:Array, headline:string}>}
 */
export async function importFromWorldAnvil(world, url, existingSnapshot, opts = {}) {
  const text = await fetchAndStripUrl(url, opts);
  return importWriteup(world, text, existingSnapshot, opts);
}
