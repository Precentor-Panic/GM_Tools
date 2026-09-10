/**
 * combat-planning/token-art.mjs -- token faces for bestiary rows
 * (table round 2026-09-09, WS-F; Russell: "token art use generation from
 * the looks line").
 *
 * Three jobs, all review-gated:
 *
 *   generateTokenArt   -- one Gemini image call from the entry's `looks`
 *                         line (the person's at-a-glance line on a scene
 *                         element), square-cropped to a webp, written as a
 *                         CANDIDATE file and recorded on the entry as
 *                         `tokenImgCandidate`. Nothing else reads a
 *                         candidate: not the scene push, not update_actor.
 *   acceptTokenArt     -- the GM liked it: the file moves to the convention
 *                         path and becomes `tokenImg`.
 *   rejectTokenArt     -- the file is deleted and the slot cleared.
 *
 * File convention (plan WS-F F1): `<FoundryData>/gm-tools/tokens/<world>/
 * <slug>.webp`, candidate = `<slug>.candidate.webp`. Paths are stored
 * Foundry-Data-RELATIVE (that is what Scene/Actor texture fields want).
 * The plan named this module `stagecraft/token-art.mjs`; it lives here
 * because `stagecraft/` is the gitignored per-world DATA root of the
 * stagecraft store, not a code directory, and the record it feeds is a
 * bestiary row.
 *
 * Image path: the same raw REST call bin/gen-splash.mjs makes
 * (`generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`,
 * default model `gemini-2.5-flash-image`, key from GEMINI_API_KEY /
 * GOOGLE_API_KEY, no SDK -- the repo's no-runtime-deps rule). The API takes
 * no size/aspect parameter, so squareness is asked for in the prompt AND
 * enforced afterwards by a centre crop + webp encode through the system
 * python3/PIL (`convertToSquareWebp`). If that tool is missing the raw
 * bytes are kept under their own extension -- a face that is slightly off-
 * square still beats no face; the result says which happened.
 *
 * Both external edges are injectable for tests: `fetchImpl` (the Gemini
 * call) and `postprocess` (the crop/encode; `null` skips it).
 */

import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import {
  getBestiaryEntry,
  setBestiaryTokenImgCandidate,
  acceptBestiaryTokenImgCandidate
} from "./bestiary-store.mjs";
import { listScenesForWorld } from "../session-planner/scenes.mjs";
import { listElementsForScene } from "../session-planner/scene-elements.mjs";

export const DEFAULT_TOKEN_ART_MODEL = "gemini-2.5-flash-image";
export const TOKEN_ART_SIZE = 512;

/** kebab-case file stem from a creature name; never empty. */
export function tokenSlug(name) {
  const slug = String(name ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "token";
}

/** Foundry-Data-relative convention path for a world + slug. */
export function tokenArtPath(world, slug, { candidate = false, ext = "webp" } = {}) {
  return `gm-tools/tokens/${world}/${slug}${candidate ? ".candidate" : ""}.${ext}`;
}

/**
 * The prompt source: the first non-empty `looks` on any scene element in
 * the world that points at this bestiary entry (`fields.bestiaryEntryId`).
 * Returns `{looks, sceneId, elementId}` or null.
 */
export function findLooksForEntry(world, entryId) {
  for (const scene of listScenesForWorld(world)) {
    let elements;
    try {
      elements = listElementsForScene(world, scene.id);
    } catch {
      continue;
    }
    for (const el of elements) {
      if (el.fields?.bestiaryEntryId !== entryId) continue;
      const looks = typeof el.fields?.looks === "string" ? el.fields.looks.trim() : "";
      if (looks) return { looks, sceneId: scene.id, elementId: el.id };
    }
  }
  return null;
}

/**
 * The image prompt. Only the first line of `looks` is the physical
 * description (WS-C shape: `race, build/age, tell` / `Mannerism:` /
 * `Voice:`); mannerism and voice lines are dropped -- they are not
 * paintable and pull the model toward scenes instead of a face.
 *
 * The two hardened clauses come from a real batch (2026-09-09, eleven
 * generations for Aureus). The model ignored the original one-line "no
 * frame, no border, no text" in three of them -- twice painting a picture
 * frame with garbled lettering inside it -- and twice rendered a
 * hand-written prop as a modern device: a character described with "a slate
 * and a chalk stub" came back holding what reads as a tablet computer. Both
 * failures are generic (any world, any creature), so both fixes live here
 * rather than in any campaign's own wording.
 *
 * `avoid` is the re-roll's memory. A plain re-roll re-sends an identical
 * prompt and simply re-rolls the dice, which is why a stuck failure mode
 * (that slate) repeats; a caller that knows what was wrong appends it here
 * so the next attempt is actually a different request.
 */
export function buildTokenArtPrompt({ name, looks, avoid } = {}) {
  const physical = String(looks ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(mannerism|voice)\s*:/i.test(l))
    .join(". ");
  const avoidNote = String(avoid ?? "").trim();
  return (
    `Square character portrait for a tabletop RPG token: head and shoulders, facing the viewer, centred, ` +
    `plain dark neutral background. Fantasy illustration, painterly. ` +
    `The artwork must fill the whole square edge to edge: no frame, no border, no matte, no inset panel, ` +
    `and no lettering of any kind -- no text, caption, signature or watermark. ` +
    `Pre-industrial setting: every object held or worn is hand-made from wood, stone, leather, cloth, horn or ` +
    `hammered metal, and nothing may read as machined, printed, plastic or electronic. ` +
    `Subject: ${name}. ${physical}` +
    (avoidNote ? ` Avoid: ${avoidNote}` : "")
  ).trim();
}

/**
 * Centre-crop to a square and encode as webp via the system python3 + PIL.
 * Returns the output path on success; throws when the tool is unavailable
 * or fails (the caller decides whether to fall back).
 */
export function convertToSquareWebp(inputAbs, outputAbs, { size = TOKEN_ART_SIZE } = {}) {
  const script =
    "import sys\n" +
    "from PIL import Image\n" +
    "src, dst, size = sys.argv[1], sys.argv[2], int(sys.argv[3])\n" +
    "im = Image.open(src).convert('RGBA')\n" +
    "w, h = im.size\n" +
    "side = min(w, h)\n" +
    "left, top = (w - side) // 2, (h - side) // 2\n" +
    "im = im.crop((left, top, left + side, top + side)).resize((size, size), Image.LANCZOS)\n" +
    "im.save(dst, 'WEBP', quality=88, method=6)\n";
  execFileSync("python3", ["-c", script, inputAbs, outputAbs, String(size)], { stdio: ["ignore", "ignore", "pipe"] });
  return outputAbs;
}

const MIME_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/**
 * Generate a candidate face for one bestiary entry.
 *
 * @param {object} p
 * @param {string} p.dataDir     Foundry data dir (files land under it)
 * @param {string} p.world       where to look for the `looks` line and where the file lives
 * @param {string} p.entryId
 * @param {string} [p.looks]     explicit description; default: findLooksForEntry
 * @param {string} [p.avoid]     what a previous attempt got wrong, appended as an "Avoid:" clause -- the re-roll's memory
 * @param {string} [p.apiKey]    default GEMINI_API_KEY / GOOGLE_API_KEY
 * @param {string} [p.model]     default WF_IMAGE_MODEL / gemini-2.5-flash-image
 * @param {object} [opts]        { fetchImpl, postprocess, size }
 * @returns {Promise<{entry:object, candidate:string, prompt:string, looksSource:object|null, squared:boolean, model:string}>}
 */
export async function generateTokenArt({ dataDir, world, entryId, looks, avoid, apiKey, model } = {}, opts = {}) {
  if (!dataDir) throw new Error("generateTokenArt: dataDir is required.");
  if (!world) throw new Error("generateTokenArt: world is required.");
  const entry = getBestiaryEntry(entryId);
  const name = entry.flavorName ?? entry.rawFields?.name ?? "unnamed creature";

  let looksSource = null;
  let text = typeof looks === "string" ? looks.trim() : "";
  if (!text) {
    looksSource = findLooksForEntry(world, entryId);
    text = looksSource?.looks ?? "";
  }
  if (!text) {
    throw new Error(
      `No "looks" line found for "${name}" in world "${world}" -- add one on the scene element that uses this creature, ` +
      `or pass the description explicitly.`
    );
  }

  const key = apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("No GEMINI_API_KEY (or GOOGLE_API_KEY) in the environment -- token art cannot be generated.");
  const modelId = model ?? process.env.WF_IMAGE_MODEL ?? DEFAULT_TOKEN_ART_MODEL;
  const prompt = buildTokenArtPrompt({ name, looks: text, avoid });

  const fetchImpl = opts.fetchImpl ?? fetch;
  const resp = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${body?.error?.message ?? "request failed"}`);
  const parts = body?.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find((p) => p.inline_data?.data || p.inlineData?.data);
  if (!imagePart) {
    const said = parts.map((p) => p.text).filter(Boolean).join(" ").slice(0, 300);
    throw new Error(`Gemini returned no image${said ? ` -- it said: ${said}` : ""}.`);
  }
  const mime = imagePart.inline_data?.mime_type ?? imagePart.inlineData?.mimeType ?? "image/png";
  const rawExt = MIME_EXT[mime] ?? "png";
  const bytes = Buffer.from(imagePart.inline_data?.data ?? imagePart.inlineData.data, "base64");

  const slug = tokenSlug(name);
  const root = resolve(dataDir);
  const rawRel = tokenArtPath(world, slug, { candidate: true, ext: rawExt });
  const rawAbs = join(root, rawRel);
  mkdirSync(dirname(rawAbs), { recursive: true });
  writeFileSync(rawAbs, bytes);

  // Square + webp. A failure here is not fatal: keep the raw bytes.
  let candidateRel = rawRel;
  let squared = false;
  const postprocess = opts.postprocess === undefined ? convertToSquareWebp : opts.postprocess;
  if (postprocess) {
    const webpRel = tokenArtPath(world, slug, { candidate: true, ext: "webp" });
    const webpAbs = join(root, webpRel);
    try {
      if (webpAbs === rawAbs) {
        // Already webp: crop through a temp name, then swap.
        const tmp = webpAbs + ".tmp.webp";
        postprocess(rawAbs, tmp, { size: opts.size });
        renameSync(tmp, webpAbs);
      } else {
        postprocess(rawAbs, webpAbs, { size: opts.size });
        unlinkSync(rawAbs);
      }
      candidateRel = webpRel;
      squared = true;
    } catch {
      squared = false;
    }
  }

  const updated = setBestiaryTokenImgCandidate(entryId, candidateRel);
  return { entry: updated, candidate: candidateRel, prompt, looksSource, squared, model: modelId };
}

/** Resolve a Foundry-Data-relative path under dataDir, refusing escapes. */
export function resolveUnderDataDir(dataDir, rel) {
  const root = resolve(dataDir);
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`Path escapes the data directory: "${rel}"`);
  return abs;
}

/**
 * The GM accepted the candidate: `<slug>.candidate.<ext>` -> `<slug>.<ext>`
 * (overwriting an earlier accepted face), and the record flips.
 */
export function acceptTokenArt({ dataDir, entryId } = {}) {
  if (!dataDir) throw new Error("acceptTokenArt: dataDir is required.");
  const entry = getBestiaryEntry(entryId);
  if (!entry.tokenImgCandidate) throw new Error(`Bestiary entry "${entryId}" has no token-art candidate to accept.`);
  const candRel = entry.tokenImgCandidate;
  const candAbs = resolveUnderDataDir(dataDir, candRel);
  if (!existsSync(candAbs)) throw new Error(`Candidate file is missing on disk: ${candRel} -- generate again.`);
  const finalRel = candRel.replace(/\.candidate(\.[a-z0-9]+)$/i, "$1");
  const finalAbs = resolveUnderDataDir(dataDir, finalRel);
  if (finalAbs === candAbs) throw new Error(`Candidate path has no ".candidate" marker: ${candRel}`);
  renameSync(candAbs, finalAbs);
  return acceptBestiaryTokenImgCandidate(entryId, finalRel);
}

/** The GM rejected the candidate: file deleted, slot cleared. */
export function rejectTokenArt({ dataDir, entryId } = {}) {
  if (!dataDir) throw new Error("rejectTokenArt: dataDir is required.");
  const entry = getBestiaryEntry(entryId);
  if (!entry.tokenImgCandidate) return entry;
  try {
    const abs = resolveUnderDataDir(dataDir, entry.tokenImgCandidate);
    if (existsSync(abs)) unlinkSync(abs);
  } catch {
    // A candidate path that no longer resolves is still cleared below.
  }
  return setBestiaryTokenImgCandidate(entryId, null);
}

/**
 * Extension -> MIME for the preview route; null for anything Foundry would
 * not serve as an image.
 */
export function tokenImgMime(relPath) {
  const ext = extname(relPath ?? "").toLowerCase();
  return { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" }[ext] ?? null;
}
