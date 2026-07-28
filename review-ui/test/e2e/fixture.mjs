// Phase 15 task 15.2 -- shared setup for the real-browser (Playwright)
// regression suite. NOT itself an *.e2e.mjs file (the npm run test:e2e glob
// is test/e2e/*.e2e.mjs), so `node --test` never tries to run this as a
// suite on its own; each e2e test file imports what it needs from here.
//
// Mirrors test/routes.test.mjs's established isolation convention exactly
// (scratch WF_DATA_DIR / GM_TOOLS_*_DIR env vars, cleaned up in after()) --
// the only difference from that file is that these tests drive a REAL
// running server via a real headless-Chromium browser (Playwright, this
// project's own devDependency as of task 15.1) instead of calling routes
// in-process with fetch(). The server itself is still spun up in-process
// via createReviewServer({port:0}) -- Playwright's browser is a separate
// OS process either way, so it reaches this server over a real loopback
// HTTP connection exactly as it would reach any other server.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Sets the env vars every library module in this project reads at import
 * time (resolveDir/resolveWorld and each store's own env-var convention) --
 * MUST run before dynamically importing server.mjs or any mutation-engine/
 * graph-import module in the calling test file, same requirement
 * routes.test.mjs's own top-level code documents.
 */
export function setupScratchEnv(prefix) {
  const scratchDir = mkdtempSync(join(tmpdir(), prefix));
  const dataDir = join(scratchDir, "foundrydata");
  process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
  process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
  process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
  process.env.GM_TOOLS_MANUAL_UNDO_DIR = join(scratchDir, "manual-undo");
  process.env.GM_TOOLS_PREP_CONTENT_DIR = join(scratchDir, "prep-content");
  process.env.GM_TOOLS_ENTITY_NARRATION_DIR = join(scratchDir, "entity-narration");
  process.env.GM_TOOLS_USER_SETTINGS_DIR = join(scratchDir, "user-settings");
  process.env.WF_DATA_DIR = dataDir;
  return { scratchDir, dataDir };
}

export function cleanupScratchEnv(scratchDir) {
  rmSync(scratchDir, { recursive: true, force: true });
}

/** The iPhone 13 logical viewport (per plans/phase-15-tasks.md: "~390px wide",
 * matching the original bug-finding session's device-emulation profile).
 * Used by tasks 15.3-15.5's mobile verification, kept here so every file
 * that needs it (mobile e2e tests, and any future ones) shares one
 * definition rather than re-typing the same numbers. */
export const IPHONE_13_VIEWPORT = { width: 390, height: 844 };
export const DESKTOP_VIEWPORT = { width: 1280, height: 900 };
