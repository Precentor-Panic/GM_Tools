import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

/**
 * Regression guard for the whole BUG CLASS behind "Fix real bugs found in
 * first hands-on use of Phase 8": an HTML entity like &hellip;/&mdash;/&rarr;
 * only decodes when parsed as real HTML (.innerHTML, or literal markup
 * sitting in index.html) -- assigning one to a plain-text DOM property
 * (.textContent/.placeholder/.value/.title) renders the literal, garbled
 * entity text instead of the intended glyph, because those properties never
 * run an HTML parser over their input.
 *
 * That commit fixed 7 instances found by hand. This project's own QA pass
 * (re-grepping specifically for this) found an 8th the first pass missed:
 * renderDebtResolvedDiff's `link.textContent = "Open in Batch Review
 * &rarr;"` on the Deferred Debt tab's resolve flow. Rather than adding one
 * more fixed-instance test (which only guards the instances someone
 * remembered to list), this scans the real source file for the whole
 * pattern, so a future entity-in-textContent slip anywhere in app.js fails
 * this test regardless of which string it's in.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const appJsPath = join(__dirname, "..", "public", "app.js");
const appJs = readFileSync(appJsPath, "utf8");

const PLAIN_TEXT_PROPS = ["textContent", "placeholder", "value", "title"];
const ENTITY_PATTERN = /&[a-zA-Z]+;/;

test("app.js: no HTML entity is assigned to a plain-text DOM property (.textContent/.placeholder/.value/.title) -- entities only decode via .innerHTML", () => {
  const offendingLines = [];
  const lines = appJs.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("innerHTML")) continue; // innerHTML DOES decode entities -- not this bug class
    if (!ENTITY_PATTERN.test(line)) continue;
    const assignsPlainTextProp = PLAIN_TEXT_PROPS.some((prop) => new RegExp(`\\.${prop}\\s*=[^=]`).test(line));
    if (assignsPlainTextProp) {
      offendingLines.push(`line ${i + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(
    offendingLines,
    [],
    `Found HTML entities assigned to plain-text DOM properties (these render as literal garbled text, ` +
      `not the intended glyph):\n${offendingLines.join("\n")}`
  );
});
