import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — wf-mcp-server/lib/worldanvil-intake.mjs (Phase 34
 * task 34.1). Per gm-tools-conventions' LLM-code testing rule ("a unit test
 * with the API call mocked, verifying orchestration/validation/retry
 * logic"): BOTH the outbound `fetch` (opts.fetchImpl) and the LLM client
 * (opts.llmOpts.client, same mockClient shape test/writeup-import.test.mjs
 * already established) are injected/mocked here — no real network call, no
 * real Anthropic call. A documented manual smoke line covers the real,
 * live-network case (see this file's own bottom comment).
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-worldanvil-intake-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");

const {
  validateWorldAnvilUrl,
  stripHtmlToText,
  fetchAndStripUrl,
  importFromWorldAnvil,
  WorldAnvilFetchError,
  DEFAULT_FETCH_TIMEOUT_MS
} = await import("../lib/worldanvil-intake.mjs");
const { MAX_WRITEUP_CHARS } = await import("../../graph-import/writeup-import.mjs");
const { loadBatch } = await import("../../mutation-engine/review-state.mjs");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

// Same mockClient shape as test/writeup-import.test.mjs's own helper, kept
// local to this file (a small, self-contained duplicate is preferable to a
// cross-directory import into mutation-engine's own test conventions).
function mockClient(responses) {
  let call = 0;
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        const resp = responses[Math.min(call, responses.length - 1)];
        call++;
        return { content: [{ type: "text", text: typeof resp === "function" ? resp(params) : resp }], stop_reason: "end_turn" };
      }
    }
  };
}

function fakeFetch(responses) {
  let call = 0;
  const calls = [];
  return {
    calls,
    impl: async (url, init) => {
      calls.push({ url, init });
      const r = responses[Math.min(call, responses.length - 1)];
      call++;
      if (typeof r === "function") return r(url, init);
      return r;
    }
  };
}

function fakeResponse({ ok = true, status = 200, statusText = "OK", text = "" } = {}) {
  return { ok, status, statusText, text: async () => text };
}

const EXISTING_ENTITY_TYPES = [
  { id: "person", label: "Person", attributeDefs: [] },
  { id: "place", label: "Place", attributeDefs: [] }
];

// ---------------------------------------------------------------- validateWorldAnvilUrl

await test("validateWorldAnvilUrl: accepts http/https, normalizes via URL#toString()", () => {
  assert.equal(validateWorldAnvilUrl("https://www.worldanvil.com/w/some-world/a/some-article"), "https://www.worldanvil.com/w/some-world/a/some-article");
  assert.equal(validateWorldAnvilUrl("http://example.com/page"), "http://example.com/page");
});

await test("validateWorldAnvilUrl: rejects a non-http(s) scheme", () => {
  assert.throws(() => validateWorldAnvilUrl("file:///etc/passwd"), /http/i);
  assert.throws(() => validateWorldAnvilUrl("javascript:alert(1)"), /http/i);
});

await test("validateWorldAnvilUrl: rejects an empty/missing url and an unparseable string", () => {
  assert.throws(() => validateWorldAnvilUrl(""));
  assert.throws(() => validateWorldAnvilUrl(undefined));
  assert.throws(() => validateWorldAnvilUrl("not a url at all"));
});

// ---------------------------------------------------------------- stripHtmlToText

await test("stripHtmlToText: strips tags, drops script/style content, decodes entities, collapses whitespace", () => {
  const html = `
    <html><head><style>.x{color:red}</style><script>alert(1)</script></head>
    <body>
      <h1>Riverwood</h1>
      <p>A small village &amp; trading post &mdash; home to Gerdur &lt;the miller&gt;.</p>
      <p>Second paragraph.</p>
    </body></html>
  `;
  const text = stripHtmlToText(html);
  assert.ok(!text.includes("alert(1)"), "script content must be dropped entirely");
  assert.ok(!text.includes("color:red"), "style content must be dropped entirely");
  assert.ok(text.includes("Riverwood"));
  assert.ok(text.includes("A small village & trading post"), "&amp; must decode to &");
  assert.ok(text.includes("<the miller>"), "&lt;/&gt; must decode");
  assert.ok(text.includes("Second paragraph"));
  assert.ok(!/<(h1|p|body|html|head|style|script)\b/i.test(text), "no raw HTML tags should remain (decoded entities like '<the miller>' are expected and fine)");
});

await test("stripHtmlToText: non-string input degrades to empty string, never throws", () => {
  assert.equal(stripHtmlToText(null), "");
  assert.equal(stripHtmlToText(undefined), "");
});

// ---------------------------------------------------------------- fetchAndStripUrl (fetch mocked)

await test("fetchAndStripUrl: happy path -- fetches, strips, passes plain text through unmodified when under the char cap", async () => {
  const fetcher = fakeFetch([fakeResponse({ text: "<p>Hello <b>World</b> Anvil.</p>" })]);
  const text = await fetchAndStripUrl("https://www.worldanvil.com/some-article", { fetchImpl: fetcher.impl });
  assert.equal(text, "Hello World Anvil.");
  assert.equal(fetcher.calls.length, 1);
  assert.equal(fetcher.calls[0].url, "https://www.worldanvil.com/some-article");
});

await test("fetchAndStripUrl: non-2xx response -- clean WorldAnvilFetchError, not a raw fetch exception", async () => {
  const fetcher = fakeFetch([fakeResponse({ ok: false, status: 404, statusText: "Not Found" })]);
  await assert.rejects(
    () => fetchAndStripUrl("https://example.com/missing", { fetchImpl: fetcher.impl }),
    (err) => {
      assert.ok(err instanceof WorldAnvilFetchError);
      assert.match(err.message, /404/);
      return true;
    }
  );
});

await test("fetchAndStripUrl: a rejected/thrown fetch (network failure) -- wrapped as a clean WorldAnvilFetchError", async () => {
  const fetcher = fakeFetch([
    async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }
  ]);
  await assert.rejects(
    () => fetchAndStripUrl("https://unreachable.example", { fetchImpl: fetcher.impl }),
    (err) => {
      assert.ok(err instanceof WorldAnvilFetchError);
      assert.match(err.message, /Could not reach/);
      return true;
    }
  );
});

await test("fetchAndStripUrl: a page that strips to nothing readable -- clean WorldAnvilFetchError", async () => {
  const fetcher = fakeFetch([fakeResponse({ text: "<script>only script content here</script>" })]);
  await assert.rejects(() => fetchAndStripUrl("https://example.com/empty", { fetchImpl: fetcher.impl }), WorldAnvilFetchError);
});

await test("fetchAndStripUrl: a bad url is rejected BEFORE fetch is ever called", async () => {
  const fetcher = fakeFetch([fakeResponse({ text: "irrelevant" })]);
  await assert.rejects(() => fetchAndStripUrl("ftp://example.com/x", { fetchImpl: fetcher.impl }));
  assert.equal(fetcher.calls.length, 0, "fetch must never be invoked for a rejected-before-fetch url");
});

await test("fetchAndStripUrl: TRUNCATE, don't reject -- a fetched page over MAX_WRITEUP_CHARS is truncated with a trailing note, not thrown", async () => {
  const hugeText = "x".repeat(MAX_WRITEUP_CHARS + 5000);
  const fetcher = fakeFetch([fakeResponse({ text: `<p>${hugeText}</p>` })]);
  const text = await fetchAndStripUrl("https://example.com/huge-article", { fetchImpl: fetcher.impl });
  assert.ok(text.length <= MAX_WRITEUP_CHARS, "truncated result must fit within the same limit importWriteup enforces");
  assert.match(text, /truncated/i, "a visible truncation note must be present, not a silent cut");
});

await test("fetchAndStripUrl: default timeout constant is documented/exported", () => {
  assert.equal(typeof DEFAULT_FETCH_TIMEOUT_MS, "number");
  assert.ok(DEFAULT_FETCH_TIMEOUT_MS > 0);
});

// ---------------------------------------------------------------- importFromWorldAnvil (fetch AND LLM client mocked)

await test("importFromWorldAnvil: full orchestration -- fetch -> strip -> importWriteup, same shape as /api/writeup-propose", async () => {
  const fetcher = fakeFetch([fakeResponse({ text: "<h1>Riverwood</h1><p>Gerdur runs the mill.</p>" })]);
  const llmResponse = JSON.stringify({
    entities: [{ name: "Gerdur", type: "person", description: "Runs the mill.", rationale: "Article says so." }],
    edges: []
  });
  const client = mockClient([llmResponse]);
  const existingSnapshot = { entities: [], edges: [], entityTypes: EXISTING_ENTITY_TYPES };

  const result = await importFromWorldAnvil("wa-world", "https://www.worldanvil.com/w/x/a/riverwood", existingSnapshot, {
    fetchImpl: fetcher.impl,
    llmOpts: { client }
  });

  assert.ok(result.batchId);
  assert.equal(result.mutationCount, 1);
  assert.ok(typeof result.headline === "string" && result.headline.length > 0);
  assert.ok(result.importSummary);

  const batch = loadBatch("wa-world", result.batchId);
  assert.equal(batch.scope.mode, "writeup-import", "reuses the SAME batch machinery a pasted writeup uses -- no second pipeline");
  assert.match(batch.scope.text, /Gerdur runs the mill/, "the fetched-and-stripped text (not the raw HTML) must be what's stored/sent to the model");
  assert.ok(!batch.scope.text.includes("<h1>"), "raw HTML tags must never reach the stored writeup text");

  // The LLM call itself received the stripped text, not raw HTML.
  assert.match(client.calls[0].messages[0].content, /Gerdur runs the mill/);
});

await test("importFromWorldAnvil: an unreachable URL never reaches the LLM client at all", async () => {
  const fetcher = fakeFetch([fakeResponse({ ok: false, status: 500, statusText: "Internal Server Error" })]);
  const client = mockClient(["should never be called"]);
  const existingSnapshot = { entities: [], edges: [], entityTypes: EXISTING_ENTITY_TYPES };

  await assert.rejects(
    () => importFromWorldAnvil("wa-world-2", "https://example.com/down", existingSnapshot, { fetchImpl: fetcher.impl, llmOpts: { client } }),
    WorldAnvilFetchError
  );
  assert.equal(client.calls.length, 0, "the LLM must never be called if the fetch stage itself failed");
});

console.log(`\n${passed} test(s) passed.`);

process.on("exit", () => rmSync(scratchDir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// MANUAL/DOCUMENTED SMOKE TEST (not run by `node --test`, per gm-tools-
// conventions' LLM-code testing rule: "a documented manual or integration
// smoke test that makes a real (small, cheap) API call"):
//
//   ANTHROPIC_API_KEY=... node -e '
//     import("./wf-mcp-server/lib/worldanvil-intake.mjs").then(async (m) => {
//       const result = await m.importFromWorldAnvil(
//         "smoke-test-world",
//         "https://en.wikipedia.org/wiki/Dungeons_%26_Dragons",
//         { entities: [], edges: [], entityTypes: [] }
//       );
//       console.log(JSON.stringify(result, null, 2));
//     });
//   '
//
// Confirms: a real public URL fetches successfully, strips to readable
// text, and produces a genuine review batch (batchId/mutationCount/headline)
// via the real Anthropic API -- not executed here (no ANTHROPIC_API_KEY in
// this build environment, matching every other LLM-touching module's own
// documented-not-executed smoke test in this project, e.g.
// graph-import/writeup-import.mjs's own real-API smoke tests).
