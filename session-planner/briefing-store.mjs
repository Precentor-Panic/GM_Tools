/**
 * Briefing store — the world-level "front matter" a GM wants on the table
 * before any scene: the premise, the clock, the cast, the party, the town
 * map, table rules. One ordered list of CARDS per world, rendered by
 * review-ui's Briefing surface as a two-column card grid (the same
 * module-style treatment the Run spread uses one level down).
 *
 * World-agnostic and deliberately loose: a card is a title, an optional
 * eyebrow (small caps category label), a body (light HTML -- paragraphs,
 * lists, tables, inline SVG -- sanitised at render time, never here), and a
 * `span` (1 = one column, 2 = full width). No schema for what a campaign's
 * front matter "should" contain; that's the GM's call.
 *
 * Storage: `briefing/<world>.json`, same flat-JSON / env-override / withLock
 * convention as fortune-track.mjs and every other per-world planner store.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { withLock } from "../mutation-engine/review-state.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "briefing");

export const BRIEFING_SCHEMA_VERSION = 1;

export const BriefingCard = z.object({
  id: z.string(),
  world: z.string(),
  title: z.string(),
  eyebrow: z.string().nullable(),
  body: z.string(),
  span: z.union([z.literal(1), z.literal(2)]),
  order: z.number(),
  createdAt: z.string(),
  updatedAt: z.string()
}).strict();

export function briefingRoot() {
  return process.env.GM_TOOLS_BRIEFING_DIR || DEFAULT_ROOT;
}

function worldFilePath(world) {
  return join(briefingRoot(), `${world}.json`);
}

function readCards(world) {
  const filePath = worldFilePath(world);
  if (!existsSync(filePath)) return [];
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeCards(world, cards) {
  const validated = cards.map((c) => BriefingCard.parse(c));
  const filePath = worldFilePath(world);
  withLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(validated, null, 2), "utf8");
  });
  return validated;
}

export function makeBriefingCardId() {
  return `brf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normaliseSpan(span) {
  return span === 2 || span === "2" ? 2 : 1;
}

/** @returns {object[]} every card for the world, in `order`. [] if none. */
export function listBriefingCards(world) {
  return readCards(world).sort((a, b) => a.order - b.order);
}

export function getBriefingCard(world, cardId) {
  const card = readCards(world).find((c) => c.id === cardId);
  if (!card) throw new Error(`No briefing card found: world="${world}" cardId="${cardId}"`);
  return card;
}

/**
 * @param {string} world
 * @param {{title:string, eyebrow?:string|null, body?:string, span?:1|2}} fields
 * @returns {object} the created card, appended at the end
 */
export function createBriefingCard(world, { title, eyebrow = null, body = "", span = 1 } = {}, opts = {}) {
  if (typeof title !== "string" || !title.trim()) throw new Error("A briefing card needs a non-empty title.");
  const now = opts.now ?? new Date().toISOString();
  const cards = readCards(world);
  const nextOrder = cards.length ? Math.max(...cards.map((c) => c.order)) + 1 : 0;
  const card = {
    id: (opts.makeId ?? makeBriefingCardId)(),
    world,
    title: title.trim(),
    eyebrow: eyebrow == null || eyebrow === "" ? null : String(eyebrow),
    body: String(body ?? ""),
    span: normaliseSpan(span),
    order: nextOrder,
    createdAt: now,
    updatedAt: now
  };
  writeCards(world, [...cards, card]);
  return card;
}

/** Patch-style: only supplied keys change. */
export function updateBriefingCard(world, cardId, { title, eyebrow, body, span } = {}, opts = {}) {
  const cards = readCards(world);
  const card = cards.find((c) => c.id === cardId);
  if (!card) throw new Error(`No briefing card found: world="${world}" cardId="${cardId}"`);
  if (title !== undefined) {
    if (typeof title !== "string" || !title.trim()) throw new Error("A briefing card needs a non-empty title.");
    card.title = title.trim();
  }
  if (eyebrow !== undefined) card.eyebrow = eyebrow == null || eyebrow === "" ? null : String(eyebrow);
  if (body !== undefined) card.body = String(body ?? "");
  if (span !== undefined) card.span = normaliseSpan(span);
  card.updatedAt = opts.now ?? new Date().toISOString();
  writeCards(world, cards);
  return card;
}

/** Idempotent. */
export function removeBriefingCard(world, cardId) {
  const cards = readCards(world);
  const next = cards.filter((c) => c.id !== cardId);
  const deleted = next.length !== cards.length;
  if (deleted) writeCards(world, next);
  return { deleted };
}

/** Reorder-by-array (listed ids take their index; unlisted keep their order). */
export function reorderBriefingCards(world, orderedIds) {
  const cards = readCards(world);
  orderedIds.forEach((id, index) => {
    const card = cards.find((c) => c.id === id);
    if (card) card.order = index;
  });
  writeCards(world, cards);
  return listBriefingCards(world);
}
