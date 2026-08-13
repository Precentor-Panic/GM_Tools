// QA W2 fix (Group C #14): shared world-id validation/slugify, used by every
// create-world entry point (connection-menu.js's panel, app-shell.js's
// zero-worlds landing CTA) so the client-side rule can never drift out of
// step across the two copies. Server-side (review-ui/server.mjs's
// POST /api/worlds, wf-mcp-server/lib/resolve.mjs's resolveWorld) is
// slightly MORE permissive (also allows uppercase) -- this deliberately
// guides toward the project's own established lowercase convention
// ("wf-test", "rl-combat") rather than just mirroring the server's floor.
export const VALID_WORLD_ID = /^[a-z0-9_-]+$/;

export function isValidWorldId(raw) {
  return typeof raw === "string" && raw.length > 0 && VALID_WORLD_ID.test(raw);
}

/** Turns free text ("My First Campaign") into a friendly slug ("my-first-campaign"). */
export function slugifyWorldId(raw) {
  return String(raw ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/[-_]{2,}/g, "-") // collapse runs left behind by adjacent invalid chars (e.g. "the -- sunken" -> "the-sunken", not "the----sunken")
    .replace(/^-+|-+$/g, "");
}
