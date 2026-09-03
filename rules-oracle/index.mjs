/**
 * Rules Oracle — G9c composition.
 *
 * A single entry point over the two G9 backends: the structured, mechanics-
 * granular index built off Plutonium's bundled 5etools data
 * (rules-index.mjs, `query`/`family`-filterable) and the full-text book
 * shelf (rules-library-search.mjs, `query`/`book`-filterable). Both arms
 * always run — `family` only narrows the structured arm, `book` only
 * narrows the books arm, so a caller who passes just `family` still gets
 * whatever book hits exist, and vice versa. Either backend degrading to
 * `installed:false` (Plutonium not installed / rules-library/ not
 * populated on this machine) never blocks the other arm from answering.
 *
 * v2 NOTE (not built here): the natural next step is composing an actual
 * LLM answer over these hits — mutation-engine/llm-call.mjs's shared
 * callModel/JSON-response plumbing for the call itself, and PDF-page
 * `document` content blocks (the pattern combat-planning/bestiary-ingest.mjs
 * already established for sending a PDF page straight to the Messages API)
 * for grounding an answer in a cited book page's actual layout/tables
 * rather than just this module's plain-text snippet. Deliberately out of
 * scope for this task — this file only composes the two deterministic,
 * non-LLM retrieval backends.
 */
import { loadRulesIndex, searchRulesIndex } from "./rules-index.mjs";
import { searchBooks } from "./rules-library-search.mjs";

/**
 * @param {string} dataDir                 the resolved Foundry data dir (for the structured/Plutonium arm)
 * @param {{query:string, family?:string, book?:string, limit?:number}} opts
 * @returns {{
 *   structured: {installed:boolean, matches:object[]},
 *   books: {installed:boolean, matches:object[]}
 * }}
 */
export function searchRules(dataDir, opts = {}) {
  const query = typeof opts.query === "string" ? opts.query.trim() : "";
  const limit = opts.limit;

  const rulesIndex = loadRulesIndex(dataDir);
  const structuredMatches = rulesIndex.installed
    ? searchRulesIndex(rulesIndex.rows, { query, family: opts.family, limit })
    : [];

  const booksResult = searchBooks({ query, book: opts.book, limit });

  return {
    structured: { installed: rulesIndex.installed, matches: structuredMatches },
    books: { installed: booksResult.installed, matches: booksResult.matches }
  };
}
