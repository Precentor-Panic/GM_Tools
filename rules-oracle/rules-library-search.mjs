/**
 * Rules Oracle — G9b "book-shelf backend".
 *
 * Full-text search over the extracted rulebook shelves at
 * rules-library/<shelf>/<slug>.txt (see rules-library/INDEX.md, and the
 * `rules-lookup` skill for the grep-cite-read workflow this generalizes).
 * Each book's .txt carries `[[<slug> p.N]]` page markers on their own line,
 * one per PDF page (N is the PDF page, never the printed folio) — this
 * module splits on that marker to answer "which page(s) mention X".
 *
 * CITATION CONTRACT: cite a hit as `(LABEL p.N)` — N is the PDF page. For
 * the full page (tables, stat blocks, art), read the actual PDF at that
 * page; this module deliberately never returns more than a capped snippet
 * (see the IP rule below).
 *
 * IP RULE (rules-library/ is gitignored, never committed, never bulk-
 * quoted — Russell's owned archives only): this module enforces the caps
 * itself (SNIPPET_MAX_CHARS, MAX_SNIPPETS) so every surface built on top —
 * the structured/books composition in index.mjs, the review-ui route, the
 * MCP tool — inherits them for free rather than each having to remember to
 * re-implement a cap. The rule EXTENDS to this file's own tests: they use
 * short, synthetic, invented fixture text, never real book content.
 *
 * Graceful degrade: a missing library root (most machines won't have
 * rules-library/ populated — it's gitignored) or a root with no shelf
 * subdirectories returns `{ installed: false, matches: [] }` — never a
 * throw.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Snippet window size and the max number of snippets returned per call — both PINNED BY TEST (the IP rule, enforced once here for every caller). */
export const SNIPPET_MAX_CHARS = 600;
export const MAX_SNIPPETS = 8;

/** Root of the rules library. Read fresh on every call (not cached at import time) so tests can flip GM_TOOLS_RULES_DIR between cases. */
export function rulesLibraryRoot() {
  return process.env.GM_TOOLS_RULES_DIR || join(__dirname, "..", "rules-library");
}

const LABEL_OVERRIDES = {
  "basic-rules-2018": "Basic Rules"
};

function titleCaseWord(w) {
  return w.length ? w[0].toUpperCase() + w.slice(1) : w;
}

/** PURE. slug -> display label (special-cased for basic-rules-2018 and the ds- Draw Steel prefix, else the uppercased slug). */
export function bookLabel(slug) {
  if (LABEL_OVERRIDES[slug]) return LABEL_OVERRIDES[slug];
  if (slug.startsWith("ds-")) {
    const rest = slug.slice(3).split("-").filter(Boolean).map(titleCaseWord).join(" ");
    return `Draw Steel: ${rest}`;
  }
  return slug.toUpperCase();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** shelf subdirs of root, or [] if root doesn't exist / isn't a dir. */
function listShelves(root) {
  if (!existsSync(root)) return [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

/** [{shelf, book (slug), path}] across every shelf under root. */
function listBooks(root) {
  const books = [];
  for (const shelf of listShelves(root)) {
    const shelfDir = join(root, shelf);
    let files;
    try {
      files = readdirSync(shelfDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".txt")) continue;
      books.push({ shelf, book: f.slice(0, -4), path: join(shelfDir, f) });
    }
  }
  return books;
}

/**
 * PURE. Split a book's raw text on its own `[[<slug> p.N]]` markers into
 * page chunks. A file with no markers at all (e.g. a txt-only book with no
 * extracted page numbers) comes back as one page with `page: null`.
 * @returns {{page:number|null, text:string}[]}
 */
export function splitIntoPages(content, slug) {
  const marker = new RegExp(`^\\[\\[${escapeRegExp(slug)} p\\.(\\d+)\\]\\]$`, "gm");
  const matches = [...content.matchAll(marker)];
  if (!matches.length) return [{ page: null, text: content }];
  const pages = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : content.length;
    pages.push({ page: Number(matches[i][1]), text: content.slice(start, end) });
  }
  return pages;
}

// absolute file path -> { mtimeMs, pages } — lazy per-book cache.
const bookPageCache = new Map();

function loadBookPages(filePath, slug) {
  let mtimeMs;
  try {
    mtimeMs = statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
  const cached = bookPageCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.pages;
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const pages = splitIntoPages(content, slug);
  bookPageCache.set(filePath, { mtimeMs, pages });
  return pages;
}

/** Test seam: drop every cached book's page split (mtime-driven otherwise). */
export function clearBookPageCache() {
  bookPageCache.clear();
}

/**
 * PURE. A snippet window around `matchIndex`, capped at SNIPPET_MAX_CHARS
 * total (ellipses included) — the hard cap the whole IP rule leans on.
 * @param {string} text
 * @param {number} matchIndex
 * @returns {string}
 */
export function buildSnippet(text, matchIndex) {
  const idx = Math.max(0, matchIndex);
  const half = Math.floor(SNIPPET_MAX_CHARS / 2);
  let start = Math.max(0, idx - half);
  let end = Math.min(text.length, start + SNIPPET_MAX_CHARS);
  start = Math.max(0, end - SNIPPET_MAX_CHARS);
  const truncatedStart = start > 0;
  const truncatedEnd = end < text.length;
  let snippet = text.slice(start, end).trim();
  if (truncatedStart) snippet = `…${snippet}`;
  if (truncatedEnd) snippet = `${snippet}…`;
  if (snippet.length > SNIPPET_MAX_CHARS) snippet = `${snippet.slice(0, SNIPPET_MAX_CHARS - 1)}…`;
  return snippet;
}

/**
 * Case-insensitive ALL-terms search over every page of every book on the
 * shelf (optionally narrowed to one `book` slug).
 * @param {{query?:string, book?:string, limit?:number}} [opts]
 * @returns {{installed:boolean, matches:{shelf:string, book:string, label:string, page:number|null, snippet:string}[]}}
 */
export function searchBooks(opts = {}) {
  const root = rulesLibraryRoot();
  const books = listBooks(root);
  if (!books.length) return { installed: false, matches: [] };

  const query = typeof opts.query === "string" ? opts.query.trim() : "";
  const bookFilter = typeof opts.book === "string" && opts.book.trim() ? opts.book.trim() : null;
  const limit = Math.min(Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : MAX_SNIPPETS, MAX_SNIPPETS);
  if (!query) return { installed: true, matches: [] };
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { installed: true, matches: [] };

  // Collect per-book, then interleave round-robin up to the cap — filling
  // the cap from the first books in directory order silently starved
  // late-alphabet books (a "grappl" search returned eight Fizban's monster
  // pages and never reached the PHB's actual grappling rule; caught by the
  // first live smoke). Round-robin keeps every matching book represented.
  const perBook = [];
  for (const b of books) {
    if (bookFilter && b.book !== bookFilter) continue;
    const pages = loadBookPages(b.path, b.book);
    if (!pages) continue;
    const bookMatches = [];
    for (const pg of pages) {
      const lower = pg.text.toLowerCase();
      if (!terms.every((t) => lower.includes(t))) continue;
      const matchIndex = lower.indexOf(terms[0]);
      bookMatches.push({
        shelf: b.shelf,
        book: b.book,
        label: bookLabel(b.book),
        page: pg.page,
        snippet: buildSnippet(pg.text, matchIndex)
      });
      if (bookMatches.length >= limit) break; // one book can never need more than the cap
    }
    if (bookMatches.length) perBook.push(bookMatches);
  }
  const matches = [];
  for (let round = 0; matches.length < limit; round++) {
    let took = false;
    for (const bookMatches of perBook) {
      if (round < bookMatches.length && matches.length < limit) {
        matches.push(bookMatches[round]);
        took = true;
      }
    }
    if (!took) break;
  }
  return { installed: true, matches };
}
