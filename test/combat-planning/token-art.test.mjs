import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST -- combat-planning/token-art.mjs (table round
 * 2026-09-09, WS-F): one Gemini image call from a bestiary row's `looks`
 * line -> a CANDIDATE file + `tokenImgCandidate`; accept moves the file to
 * the convention path and flips `tokenImg`; reject deletes it. The Gemini
 * call and the crop/encode step are injected, so this runs offline.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-token-art-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_BESTIARY_DIR = join(scratchDir, "bestiary");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
process.env.GM_TOOLS_SCENE_ELEMENTS_DIR = join(scratchDir, "scene-elements");
const dataDir = join(scratchDir, "foundrydata");

const {
  tokenSlug, tokenArtPath, buildTokenArtPrompt, findLooksForEntry,
  generateTokenArt, acceptTokenArt, rejectTokenArt, resolveUnderDataDir, tokenImgMime
} = await import("../../combat-planning/token-art.mjs");
const { saveBestiaryEntry, getBestiaryEntry, setBestiaryTokenImg } = await import("../../combat-planning/bestiary-store.mjs");
const { createScene } = await import("../../session-planner/scenes.mjs");
const { createElement } = await import("../../session-planner/scene-elements.mjs");

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

// A 1x1 PNG, enough for the fake Gemini to hand back.
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const fakeGemini = (calls, { mime = "image/png", data = PNG_1x1, text = null, status = 200 } = {}) => async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body), key: init.headers["x-goog-api-key"] });
  const parts = text != null ? [{ text }] : [{ inline_data: { mime_type: mime, data } }];
  return { ok: status === 200, status, json: async () => (status === 200 ? { candidates: [{ content: { parts } }] } : { error: { message: "quota" } }) };
};

await test("tokenSlug / tokenArtPath / tokenImgMime: pure helpers", () => {
  assert.equal(tokenSlug("The Ledger-Man"), "the-ledger-man");
  assert.equal(tokenSlug("Ünder Vane!!"), "under-vane");
  assert.equal(tokenSlug(""), "token");
  assert.equal(tokenArtPath("aureus", "tariq"), "gm-tools/tokens/aureus/tariq.webp");
  assert.equal(tokenArtPath("aureus", "tariq", { candidate: true, ext: "png" }), "gm-tools/tokens/aureus/tariq.candidate.png");
  assert.equal(tokenImgMime("a/b.WEBP"), "image/webp");
  assert.equal(tokenImgMime("a/b.txt"), null);
  assert.equal(resolveUnderDataDir(dataDir, "gm-tools/x.webp"), join(dataDir, "gm-tools/x.webp"));
  assert.throws(() => resolveUnderDataDir(dataDir, "../x.webp"), /escapes/);
});

await test("buildTokenArtPrompt: keeps the physical line, drops Mannerism/Voice, asks for a square face with no text", () => {
  const p = buildTokenArtPrompt({ name: "Tariq", looks: "Human, forties, wiry; burn scar down the left jaw\nMannerism: taps the table\nVoice: low, patient" });
  assert.match(p, /Subject: Tariq\. Human, forties, wiry; burn scar down the left jaw$/);
  assert.ok(!/Mannerism|Voice|taps the table/.test(p));
  assert.match(p, /Square character portrait/);
  assert.match(p, /no text, no watermark/);
});

await test("findLooksForEntry: the first non-empty looks on a scene element pointing at the entry, across the world's scenes", () => {
  const WORLD = "looks-world";
  const entry = saveBestiaryEntry({ rawFields: { name: "Marek" } });
  const s1 = createScene(WORLD, { name: "Sermon" });
  const s2 = createScene(WORLD, { name: "Suq" });
  createElement(WORLD, s1.id, { name: "Marek", kind: "local", fields: { bestiaryEntryId: entry.id, looks: "   " } });
  createElement(WORLD, s2.id, { name: "Marek", kind: "local", fields: { bestiaryEntryId: entry.id, looks: "Tall, sun-dark, shaved head" } });
  createElement(WORLD, s2.id, { name: "Other", kind: "local", fields: { bestiaryEntryId: "bst-other", looks: "not him" } });
  const hit = findLooksForEntry(WORLD, entry.id);
  assert.equal(hit.looks, "Tall, sun-dark, shaved head");
  assert.equal(hit.sceneId, s2.id);
  assert.equal(findLooksForEntry(WORLD, "bst-nobody"), null);
});

await test("generateTokenArt: looks from the scene element -> one Gemini call -> squared webp candidate + tokenImgCandidate; tokenImg untouched", async () => {
  const WORLD = "gen-world";
  const entry = saveBestiaryEntry({ rawFields: { name: "The Ledger-Man" } });
  const scene = createScene(WORLD, { name: "Fight Night" });
  createElement(WORLD, scene.id, { name: "Ledger-Man", kind: "local", fields: { bestiaryEntryId: entry.id, looks: "Thin, grey, ink on every finger\nVoice: dry" } });
  setBestiaryTokenImg(entry.id, "hand/placed/old-face.webp");

  const calls = [];
  const post = [];
  const postprocess = (inAbs, outAbs) => { post.push({ inAbs, outAbs }); writeFileSync(outAbs, "WEBP-BYTES"); };
  const r = await generateTokenArt({ dataDir, world: WORLD, entryId: entry.id, apiKey: "k-test", model: "fake-image-model" }, { fetchImpl: fakeGemini(calls), postprocess });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /models\/fake-image-model:generateContent$/);
  assert.equal(calls[0].key, "k-test");
  assert.match(calls[0].body.contents[0].parts[0].text, /Subject: The Ledger-Man\. Thin, grey, ink on every finger$/);
  assert.equal(r.candidate, "gm-tools/tokens/gen-world/the-ledger-man.candidate.webp");
  assert.equal(r.squared, true);
  assert.equal(r.looksSource.sceneId, scene.id);
  assert.equal(post.length, 1);
  assert.equal(post[0].inAbs, join(dataDir, "gm-tools/tokens/gen-world/the-ledger-man.candidate.png"));
  assert.ok(!existsSync(post[0].inAbs), "raw png removed after the webp encode");
  assert.equal(readFileSync(join(dataDir, r.candidate), "utf8"), "WEBP-BYTES");
  const after = getBestiaryEntry(entry.id);
  assert.equal(after.tokenImgCandidate, r.candidate);
  assert.equal(after.tokenImg, "hand/placed/old-face.webp", "generation never touches the accepted face");
});

await test("generateTokenArt: postprocess failure keeps the raw bytes under their own extension (squared:false); explicit looks wins over the element; no looks -> clear error; Gemini text-only / HTTP error surface", async () => {
  const WORLD = "gen-fallback-world";
  const entry = saveBestiaryEntry({ rawFields: { name: "Vane" } });
  const calls = [];
  const boom = () => { throw new Error("no PIL"); };
  const r = await generateTokenArt({ dataDir, world: WORLD, entryId: entry.id, looks: "Broad, red-bearded", apiKey: "k" }, { fetchImpl: fakeGemini(calls, { mime: "image/jpeg" }), postprocess: boom });
  assert.equal(r.squared, false);
  assert.equal(r.candidate, "gm-tools/tokens/gen-fallback-world/vane.candidate.jpg");
  assert.ok(existsSync(join(dataDir, r.candidate)));
  assert.equal(r.looksSource, null);
  assert.match(calls[0].body.contents[0].parts[0].text, /Broad, red-bearded/);

  const noLooks = saveBestiaryEntry({ rawFields: { name: "Nobody" } });
  await assert.rejects(() => generateTokenArt({ dataDir, world: WORLD, entryId: noLooks.id, apiKey: "k" }, { fetchImpl: fakeGemini([]), postprocess: null }), /No "looks" line found/);
  await assert.rejects(() => generateTokenArt({ dataDir, world: WORLD, entryId: entry.id, looks: "x", apiKey: "k" }, { fetchImpl: fakeGemini([], { text: "I cannot draw that" }), postprocess: null }), /no image -- it said: I cannot draw that/);
  await assert.rejects(() => generateTokenArt({ dataDir, world: WORLD, entryId: entry.id, looks: "x", apiKey: "k" }, { fetchImpl: fakeGemini([], { status: 429 }), postprocess: null }), /Gemini 429: quota/);
  await assert.rejects(() => generateTokenArt({ dataDir, entryId: entry.id, looks: "x", apiKey: "k" }, { fetchImpl: fakeGemini([]), postprocess: null }), /world is required/);
  const savedKey = process.env.GEMINI_API_KEY; const savedGoogle = process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY; delete process.env.GOOGLE_API_KEY;
  try {
    await assert.rejects(() => generateTokenArt({ dataDir, world: WORLD, entryId: entry.id, looks: "x" }, { fetchImpl: fakeGemini([]), postprocess: null }), /No GEMINI_API_KEY/);
  } finally {
    if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
    if (savedGoogle !== undefined) process.env.GOOGLE_API_KEY = savedGoogle;
  }
});

await test("acceptTokenArt: candidate file -> convention path (overwriting an older face), tokenImg set, candidate cleared; rejectTokenArt deletes the file and clears the slot", async () => {
  const WORLD = "accept-world";
  const entry = saveBestiaryEntry({ rawFields: { name: "Marek" } });
  const postprocess = (inAbs, outAbs) => writeFileSync(outAbs, "NEW-FACE");
  const gen = await generateTokenArt({ dataDir, world: WORLD, entryId: entry.id, looks: "Tall", apiKey: "k" }, { fetchImpl: fakeGemini([]), postprocess });
  const finalAbs = join(dataDir, "gm-tools/tokens/accept-world/marek.webp");
  writeFileSync(finalAbs, "OLD-FACE");

  const accepted = acceptTokenArt({ dataDir, entryId: entry.id });
  assert.equal(accepted.tokenImg, "gm-tools/tokens/accept-world/marek.webp");
  assert.equal(accepted.tokenImgCandidate, null);
  assert.equal(readFileSync(finalAbs, "utf8"), "NEW-FACE");
  assert.ok(!existsSync(join(dataDir, gen.candidate)), "candidate file moved, not copied");
  assert.throws(() => acceptTokenArt({ dataDir, entryId: entry.id }), /no token-art candidate/);

  // reject path
  const gen2 = await generateTokenArt({ dataDir, world: WORLD, entryId: entry.id, looks: "Tall", apiKey: "k" }, { fetchImpl: fakeGemini([]), postprocess });
  assert.ok(existsSync(join(dataDir, gen2.candidate)));
  const rejected = rejectTokenArt({ dataDir, entryId: entry.id });
  assert.equal(rejected.tokenImgCandidate, null);
  assert.equal(rejected.tokenImg, "gm-tools/tokens/accept-world/marek.webp", "reject leaves the accepted face alone");
  assert.ok(!existsSync(join(dataDir, gen2.candidate)));
  assert.equal(rejectTokenArt({ dataDir, entryId: entry.id }).tokenImgCandidate, null, "idempotent");
});

console.log(`\n${passed} test(s) passed.`);
process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
