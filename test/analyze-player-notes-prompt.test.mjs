import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * PINNED PROMPT CONTENT — prompts/analyze-player-notes.md.
 * This is a GM-SIDE prompt handed the full GM-only truth; the header MUST
 * assert player-safety does not apply and that its output must never reach a
 * player-facing surface (the same pinning discipline session-wrap's
 * player-safety split relies on). Also pins the JSON-only response contract.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT = readFileSync(join(__dirname, "..", "prompts", "analyze-player-notes.md"), "utf8");

test("carries the GM-SIDE / player-safety-does-not-apply header", () => {
  assert.match(PROMPT, /GM-SIDE PROMPT/);
  assert.match(PROMPT, /PLAYER-SAFETY DOES NOT APPLY/i);
  assert.match(PROMPT, /never surfaced to\s+players|never be shown to players|any player-facing surface/i);
  assert.match(PROMPT, /GM-only truth/i);
});

test("defines exactly the three flag kinds and forbids inventing entityIds", () => {
  assert.match(PROMPT, /`confusion`/);
  assert.match(PROMPT, /`close-to-truth`/);
  assert.match(PROMPT, /`thread`/);
  assert.ok(!/wrong-assumption/.test(PROMPT), "the deliberately-omitted kind is absent");
  assert.match(PROMPT, /never invent one|copied EXACTLY|copied exactly/i);
});

test("asks for JSON-only, no prose/fences, and carries both template slots", () => {
  assert.match(PROMPT, /ONLY a single JSON object/);
  assert.match(PROMPT, /\{\{entityRoster\}\}/);
  assert.match(PROMPT, /\{\{playerNotes\}\}/);
});
