import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";

import {
  SNIPPET_MAX_CHARS,
  MAX_SNIPPETS,
  bookLabel,
  splitIntoPages,
  buildSnippet,
  searchBooks,
  clearBookPageCache
} from "../rules-oracle/rules-library-search.mjs";

/**
 * G9b — rules-oracle/rules-library-search.mjs, the book-shelf backend.
 *
 * SYNTHETIC FIXTURE TEXT ONLY (the IP rule extends to test fixtures, per
 * this module's own header comment): every book below is short, invented
 * prose written for this test, never copied from a real rulebook.
 */

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-rules-library-search-test-"));
const libraryRoot = join(scratchDir, "rules-library");
const shelf5e = join(libraryRoot, "5e");
const shelfDs = join(libraryRoot, "draw-steel");
mkdirSync(shelf5e, { recursive: true });
mkdirSync(shelfDs, { recursive: true });

const longFillerLine = "The invented grapple rule keeps going with more filler text so this page runs well past the snippet cap. ".repeat(10);

writeFileSync(
  join(shelf5e, "testbook.txt"),
  [
    "[[testbook p.1]]",
    "Front matter with no useful content.",
    "",
    "[[testbook p.2]]",
    "To make a Grappling attempt, use the Attack action. A grappled creature's speed becomes 0.",
    "Shoving a creature works the same way as grappling.",
    "",
    "[[testbook p.3]]",
    `Long page about grappling in extended detail. ${longFillerLine} The word grappling appears again near the very end of this long page.`
  ].join("\n")
);

writeFileSync(
  join(shelfDs, "ds-testbook.txt"),
  ["[[ds-testbook p.1]]", "Draw Steel test content mentioning a grapple-like maneuver called a Grab."].join("\n")
);

writeFileSync(join(shelf5e, "basic-rules-2018.txt"), "No page markers in this txt-only fixture book. Mentions grappling once.");

function withRoot(root, fn) {
  const prev = process.env.GM_TOOLS_RULES_DIR;
  process.env.GM_TOOLS_RULES_DIR = root;
  clearBookPageCache();
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.GM_TOOLS_RULES_DIR;
    else process.env.GM_TOOLS_RULES_DIR = prev;
    clearBookPageCache();
  }
}

await test("splitIntoPages: splits on the book's own [[slug p.N]] markers", () => {
  const content = "[[foo p.1]]\nAAA\n[[foo p.2]]\nBBB\n[[foo p.3]]\nCCC";
  const pages = splitIntoPages(content, "foo");
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map((p) => p.page), [1, 2, 3]);
  assert.match(pages[0].text, /AAA/);
  assert.match(pages[1].text, /BBB/);
  assert.match(pages[2].text, /CCC/);
});

await test("splitIntoPages: no markers at all -> one page with page:null", () => {
  const pages = splitIntoPages("just plain text, no markers", "foo");
  assert.equal(pages.length, 1);
  assert.equal(pages[0].page, null);
  assert.match(pages[0].text, /plain text/);
});

await test("bookLabel: special-cases basic-rules-2018 and ds- prefixes, else uppercases the slug", () => {
  assert.equal(bookLabel("basic-rules-2018"), "Basic Rules");
  assert.equal(bookLabel("ds-heroes"), "Draw Steel: Heroes");
  assert.equal(bookLabel("ds-rules-reference"), "Draw Steel: Rules Reference");
  assert.equal(bookLabel("phb"), "PHB");
});

await test("buildSnippet: window around the match, capped at SNIPPET_MAX_CHARS total", () => {
  const text = `${"a".repeat(1000)}TARGET${"b".repeat(1000)}`;
  const idx = text.indexOf("TARGET");
  const snippet = buildSnippet(text, idx);
  assert.ok(snippet.length <= SNIPPET_MAX_CHARS);
  assert.match(snippet, /TARGET/);
  assert.ok(snippet.startsWith("…"));
  assert.ok(snippet.endsWith("…"));
});

await test("searchBooks: missing library root degrades to installed:false, not a throw", () => {
  withRoot(join(scratchDir, "no-such-root"), () => {
    const result = searchBooks({ query: "grappling" });
    assert.equal(result.installed, false);
    assert.deepEqual(result.matches, []);
  });
});

await test("searchBooks: a root with no shelf subdirectories also degrades to installed:false", () => {
  const emptyRoot = join(scratchDir, "empty-root");
  mkdirSync(emptyRoot, { recursive: true });
  withRoot(emptyRoot, () => {
    const result = searchBooks({ query: "grappling" });
    assert.equal(result.installed, false);
  });
});

await test("searchBooks: case-insensitive ALL-terms matching, correct page + label, across shelves", () => {
  withRoot(libraryRoot, () => {
    const result = searchBooks({ query: "GRAPPLING attack" });
    assert.equal(result.installed, true);
    const hit = result.matches.find((m) => m.book === "testbook" && m.page === 2);
    assert.ok(hit, "expected a page-2 hit combining both terms");
    assert.equal(hit.shelf, "5e");
    assert.equal(hit.label, "TESTBOOK");
    assert.match(hit.snippet, /[Gg]rappl/);
  });
});

await test("searchBooks: a fixture page longer than SNIPPET_MAX_CHARS comes back cut", () => {
  withRoot(libraryRoot, () => {
    const result = searchBooks({ query: "grappling", book: "testbook" });
    const longHit = result.matches.find((m) => m.page === 3);
    assert.ok(longHit, "expected the long page-3 hit");
    assert.ok(longHit.snippet.length <= SNIPPET_MAX_CHARS);
  });
});

await test("searchBooks: book filter narrows to exactly that book's slug", () => {
  withRoot(libraryRoot, () => {
    const result = searchBooks({ query: "grapple", book: "ds-testbook" });
    assert.ok(result.matches.length >= 1);
    assert.ok(result.matches.every((m) => m.book === "ds-testbook"));
    assert.equal(result.matches[0].label, "Draw Steel: Testbook");
  });
});

await test("searchBooks: MAX_SNIPPETS caps the response even when limit is passed higher", () => {
  withRoot(libraryRoot, () => {
    const result = searchBooks({ query: "grappling", limit: 500 });
    assert.ok(result.matches.length <= MAX_SNIPPETS);
  });
});

await test("searchBooks: a book with no page markers still matches, page:null", () => {
  withRoot(libraryRoot, () => {
    const result = searchBooks({ query: "grappling", book: "basic-rules-2018" });
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].page, null);
    assert.equal(result.matches[0].label, "Basic Rules");
  });
});

await test("searchBooks: empty query returns installed:true, matches:[]", () => {
  withRoot(libraryRoot, () => {
    const result = searchBooks({ query: "" });
    assert.equal(result.installed, true);
    assert.deepEqual(result.matches, []);
  });
});

after(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});
