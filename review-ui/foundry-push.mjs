/**
 * "Drop this into Foundry" — pushes an entity's own description text into
 * live Foundry chat. Phase 26 task 26.10, §26.F.
 *
 * Replaces buildPlayerKnownGate (a pure read-only status display with no
 * real action behind it -- the project owner's own assessment: "I don't
 * care if I know that they know about some element or not... nor do I know
 * how this ... would even know to tell me this information") with a
 * genuine action.
 *
 * A reusable version of foundry_worldFabric/gm/gm-say.mjs's own logic (READ
 * ONLY, never modified, confirmed by this module's own header comment): a
 * small script that launches headless Chromium, logs into the local
 * Foundry instance as the Gamemaster user, and calls Foundry's own
 * `ChatMessage.create({content, speaker, type})` directly in-page. No
 * entity docs, no `foundryRef` write-back, no sync/bridge machinery -- this
 * is deliberately NOT "Graph Push to Foundry" (PLAN.md's Tool 1, explicitly
 * never built, filed as a separate feature request).
 *
 * §26.F's two deliberate, flagged deviations from this project's prior
 * convention, not oversights: (1) `playwright` is promoted from a
 * devDependency to a real runtime dependency in review-ui/package.json --
 * this is the first genuine RUNTIME (not just test-time) use of it in this
 * package. (2) launching headless Chromium + logging in takes real
 * seconds, not milliseconds -- callers should give this the same
 * `withSlowNotice`-style loading affordance this app's other genuinely
 * slow actions (develop-scene, quick-gen) already get, not a bare instant
 * button.
 *
 * Lives directly under review-ui/ (a sibling of server.mjs), NOT
 * wf-mcp-server/lib/ where most of review-ui's other shared-with-MCP
 * operation modules live -- `playwright` only resolves from review-ui's own
 * node_modules (its package.json is where it's declared), and this feature
 * has no MCP tool surface anyway (an LLM-driven call reaching a real,
 * externally-visible Foundry chat post would be a genuinely different, much
 * riskier surface than this project's existing no-silent-auto-write graph
 * mutations -- deliberately not exposed there, matching manual-edit-ops.mjs
 * 's own precedent for GM-direct-only actions).
 */
import { chromium } from "playwright";
import { loadSnapshot } from "../wf-mcp-server/lib/snapshot.mjs";

const DEFAULT_FOUNDRY_BASE_URL = "http://localhost:30000";

/**
 * @param {string} dir            WF data dir (same convention as every other op in this file's sibling modules)
 * @param {string} world
 * @param {string} entityId
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]           default DEFAULT_FOUNDRY_BASE_URL, override for tests
 * @param {typeof chromium} [opts.browserFactory]  injectable (opts.browserFactory.launch), for tests -- never invoked for real inside an already-running Playwright session, per this project's established convention
 * @returns {Promise<{posted:true, entityId:string, entityName:string}>}
 */
export async function pushEntityToFoundry(dir, world, entityId, opts = {}) {
  const { entities } = loadSnapshot(dir, world).snapshot;
  const entity = entities.find((e) => e.id === entityId);
  if (!entity) {
    throw new Error(`No entity "${entityId}" found in the live graph for world "${world}" -- cannot push a description that doesn't exist.`);
  }
  const content = entity.description?.trim() || `${entity.name} — no description written yet.`;
  await postHtmlToFoundryChat(`<p><strong>${escapeHtml(entity.name)}</strong></p><p>${escapeHtml(content)}</p>`, opts);
  return { posted: true, entityId, entityName: entity.name };
}

/** Minimal HTML escape for GM_Tools-composed chat content — every caller builds its markup from ESCAPED text, never raw user HTML. */
export function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * The generalized chat post (Aureus table wave B4/G13): log in as the GM
 * headlessly and ChatMessage.create the given HTML — extracted from
 * pushEntityToFoundry above so the rules oracle's "Post ruling to table"
 * shares one login/post path instead of forking a second one. Same
 * GM-direct-only, no-MCP-surface stance as the header documents; callers
 * compose `html` exclusively from escapeHtml'd text.
 *
 * @param {string} html
 * @param {object} [opts]  {baseUrl?, browserFactory?, alias?} — same injection seams as pushEntityToFoundry
 */
export async function postHtmlToFoundryChat(html, opts = {}) {
  const baseUrl = opts.baseUrl ?? DEFAULT_FOUNDRY_BASE_URL;
  const browserFactory = opts.browserFactory ?? chromium;

  const browser = await browserFactory.launch({ headless: true });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await page.goto(`${baseUrl}/join`, { waitUntil: "networkidle" });
    await page.locator('select[name="userid"]').selectOption({ label: "Gamemaster" });
    await page.locator('button[name="join"], button[type="submit"]').first().click();
    await page.waitForFunction(() => window.game?.ready === true, { timeout: 60000 });

    await page.evaluate(async ({ content, alias }) => {
      await ChatMessage.create({
        content,
        speaker: { alias },
        type: 0
      });
    }, { content: html, alias: opts.alias ?? "Game Master" });
  } finally {
    await browser.close();
  }
  return { posted: true };
}
