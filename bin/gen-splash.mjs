#!/usr/bin/env node
// gen-splash — on-demand splash/portrait art via the Gemini image API
// ("nano banana": gemini-2.5-flash-image). Saves into the Foundry data
// assets tree, registers a stagecraft asset (kind=splash by default) with
// src, and appends to a campaign art-description index when given one.
//
// Usage:
//   GEMINI_API_KEY=... node bin/gen-splash.mjs \
//     --world kilmarn --name pip-fenwick-portrait \
//     --prompt "..." [--ref /path/to/reference.png ...] \
//     [--kind splash|map] [--desc "shelf description"] \
//     [--art-index /opt/dev/campaigns/one-shot/notes/art-descriptions.json] \
//     [--no-asset] [--model gemini-2.5-flash-image] [--data-dir DIR]
//
// Env: GEMINI_API_KEY (or GOOGLE_API_KEY); GM_TOOLS_APP (default
// http://localhost:8787); WF_DATA_DIR honored for --data-dir default.
// No dependencies; node >= 18.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, extname, basename } from "node:path";

function parseArgs(argv) {
  const out = { refs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ref") out.refs.push(argv[++i]);
    else if (a === "--no-asset") out.noAsset = true;
    else if (a.startsWith("--")) out[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const fail = (msg) => { console.error(`gen-splash: ${msg}`); process.exit(1); };

const KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!KEY) fail("no GEMINI_API_KEY (or GOOGLE_API_KEY) in the environment. Get one at https://aistudio.google.com (API keys), then: export GEMINI_API_KEY=...");
if (!args.world) fail("--world is required (world id, e.g. kilmarn)");
if (!args.name) fail("--name is required (kebab-case output name, e.g. pip-fenwick-portrait)");
if (!args.prompt) fail("--prompt is required");

const MODEL = args.model || process.env.WF_IMAGE_MODEL || "gemini-2.5-flash-image";
const DATA_DIR = args.dataDir || process.env.WF_DATA_DIR || "/home/russell/foundrydata/Data";
const APP = process.env.GM_TOOLS_APP || "http://localhost:8787";
const KIND = args.kind || "splash";

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const parts = [{ text: args.prompt }];
for (const r of args.refs) {
  const mime = MIME[extname(r).toLowerCase()];
  if (!mime) fail(`--ref ${r}: unsupported extension (png/jpg/webp)`);
  if (!existsSync(r)) fail(`--ref ${r}: file not found`);
  parts.push({ inline_data: { mime_type: mime, data: readFileSync(r).toString("base64") } });
}

console.error(`generating via ${MODEL} (${args.refs.length} reference image${args.refs.length === 1 ? "" : "s"})...`);
const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
  body: JSON.stringify({ contents: [{ parts }] })
});
const body = await resp.json().catch(() => ({}));
if (!resp.ok) fail(`API ${resp.status}: ${JSON.stringify(body.error || body).slice(0, 500)}`);
const outParts = body.candidates?.[0]?.content?.parts || [];
const img = outParts.find((p) => p.inline_data?.data || p.inlineData?.data);
if (!img) {
  const text = outParts.map((p) => p.text).filter(Boolean).join(" ").slice(0, 300);
  fail(`no image in response${text ? ` — model said: ${text}` : ""} (raw keys: ${JSON.stringify(Object.keys(body)).slice(0, 200)})`);
}
const data = img.inline_data?.data || img.inlineData.data;
const mime = img.inline_data?.mime_type || img.inlineData.mimeType || "image/png";
const ext = mime.includes("jpeg") ? ".jpg" : mime.includes("webp") ? ".webp" : ".png";

const relDir = `assets/${args.world}-art`;
const absDir = join(DATA_DIR, relDir);
mkdirSync(absDir, { recursive: true });
const file = `${args.name}${ext}`;
const absPath = join(absDir, file);
if (existsSync(absPath) && !args.force) fail(`${absPath} exists — pass --force true to overwrite or choose a new --name`);
writeFileSync(absPath, Buffer.from(data, "base64"));
const relPath = `${relDir}/${file}`;
console.error(`wrote ${absPath}`);

const desc = args.desc || `GENERATED (${MODEL}): ${args.prompt}`;

if (!args.noAsset) {
  try {
    const r1 = await fetch(`${APP}/api/session-planner/stagecraft/hand-add`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: args.world, kind: KIND, name: args.assetName || args.name, desc })
    });
    const j1 = await r1.json();
    if (!r1.ok) throw new Error(JSON.stringify(j1).slice(0, 200));
    const r2 = await fetch(`${APP}/api/session-planner/stagecraft/${j1.asset.id}/src`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: args.world, src: relPath })
    });
    if (!r2.ok) throw new Error(`src set failed: ${r2.status}`);
    console.error(`stagecraft ${KIND} asset registered: ${j1.asset.id}`);
  } catch (e) {
    console.error(`WARN: asset registration failed (${e.message}) — image is on disk at ${relPath}; register by hand.`);
  }
}

if (args.artIndex) {
  try {
    const idx = JSON.parse(readFileSync(args.artIndex, "utf8"));
    idx.entries.push({ file: `modules-relative:${relPath}`, verdict: "GENERATED", description: desc, tags: ["generated", "gemini", KIND], viewedAt: new Date().toISOString().slice(0, 10) });
    writeFileSync(args.artIndex, JSON.stringify(idx, null, 2));
    console.error(`art index updated: ${args.artIndex}`);
  } catch (e) {
    console.error(`WARN: art-index update failed: ${e.message}`);
  }
}

console.log(relPath);
