#!/usr/bin/env node
/**
 * Headless Foundry GM client for the World Fabric bridge.
 *
 * Logs into a Foundry world as a GM-role user, waits for the world to be ready
 * (which starts the module's ops watcher and re-exports the index), stays
 * connected until the ops queue has been empty for a quiet period, then exits.
 * Prints the browser console so bridge errors are visible from the terminal.
 *
 *   node gm-client.mjs                 # drain the queue, then exit
 *   node gm-client.mjs --hold 600      # stay connected 10 min regardless
 *   node gm-client.mjs --set-password  # after login, set FOUNDRY_GM_PASSWORD on the
 *                                      # account (for a freshly created blank-password user)
 *
 * Env (from ../.env via --env-file-if-exists, or the shell):
 *   FOUNDRY_URL           default http://localhost:30000
 *   FOUNDRY_GM_USER       user name to log in as (must have the Gamemaster role)
 *   FOUNDRY_GM_PASSWORD   its password ("" for a user without one)
 *   WF_OPS_FILE           ops file to watch; default derived from FOUNDRY_DATA_DIR + WF_WORLD
 *   FOUNDRY_DATA_DIR      default /opt/dev/foundrydata/Data
 *   WF_WORLD              default aureus
 *
 * Refuses to run while ANOTHER GM is connected: two watchers see the same ops
 * file and apply it twice. Must run from review-ui/ so Playwright resolves.
 */
import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };

const URL = process.env.FOUNDRY_URL ?? "http://localhost:30000";
const USER = process.env.FOUNDRY_GM_USER;
const PASSWORD = process.env.FOUNDRY_GM_PASSWORD ?? "";
const DATA = process.env.FOUNDRY_DATA_DIR ?? "/opt/dev/foundrydata/Data";
const WORLD = process.env.WF_WORLD ?? "aureus";
const OPS = process.env.WF_OPS_FILE ?? `${DATA}/worlds/${WORLD}/world-fabric-foundry-ops.json`;
const HOLD_S = Number(opt("--hold", "0"));
const QUIET_S = Number(opt("--quiet", "20"));
const MAX_S = Number(opt("--max", String(6 * 3600)));

if (!USER) { console.error("FOUNDRY_GM_USER is not set."); process.exit(2); }
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const queueEmpty = () => !existsSync(OPS) || readFileSync(OPS, "utf8").trim() === "[]";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await context.newPage();
page.on("console", (m) => { const t = m.text(); if (/world-fabric|World Fabric|WF |error|Error/i.test(t)) log(`[browser:${m.type()}]`, t.slice(0, 400)); });
page.on("pageerror", (e) => log("[pageerror]", String(e).slice(0, 400)));

let exitCode = 0;
try {
  await page.goto(`${URL}/join`, { waitUntil: "domcontentloaded", timeout: 60000 });
  // The join form: a <select name="userid"> of user names, a password input, and a Join button.
  await page.waitForSelector('select[name="userid"]', { timeout: 60000 });
  const picked = await page.evaluate((name) => {
    const sel = document.querySelector('select[name="userid"]');
    const o = [...sel.options].find((x) => x.textContent.trim() === name);
    if (!o) return null;
    sel.value = o.value; sel.dispatchEvent(new Event("change", { bubbles: true }));
    return o.value;
  }, USER);
  if (!picked) throw new Error(`no user named "${USER}" on the join screen`);
  if (PASSWORD) await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL(/\/game/, { timeout: 60000 }),
    page.click('button[name="join"], button[type="submit"]')
  ]);
  log(`joined as ${USER}; waiting for the world to be ready`);
  await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 180000 });

  const who = await page.evaluate(() => ({
    me: game.user.name, isGM: game.user.isGM,
    otherGMs: game.users.filter((u) => u.active && u.isGM && u.id !== game.user.id).map((u) => u.name),
    wf: !!game.modules.get("world-fabric")?.active,
    version: game.version
  }));
  log("ready:", JSON.stringify(who));
  if (!who.isGM) throw new Error(`"${USER}" is not a Gamemaster-role user`);
  if (!who.wf) throw new Error("the world-fabric module is not active in this world");
  if (who.otherGMs.length && !flag("--force") && !flag("--claim-watcher")) {
    throw new Error(`another GM is connected (${who.otherGMs.join(", ")}); two watchers would double-apply. Pass --force only if you know that client is not running the bridge.`);
  }

  if (flag("--claim-watcher")) {
    // The bridge's watcher yields to game.users.activeGM (the first active GM by id).
    // When another GM is connected but its client is NOT running the bridge (a tab
    // left open with the module errored), that guard stalls every push. This makes
    // THIS client the active GM in its own eyes only; nothing changes for anyone else.
    await page.evaluate(() => Object.defineProperty(game.users, "activeGM", { get: () => game.user, configurable: true }));
    log("claimed the ops watcher for this client (activeGM override, local to this page)");
  }

  if (flag("--set-password")) {
    if (!PASSWORD) throw new Error("--set-password needs FOUNDRY_GM_PASSWORD");
    await page.evaluate((pw) => game.user.update({ password: pw }), PASSWORD);
    log("password set on the account through Foundry's own user update");
  }

  // Stay connected: until the queue has been empty for QUIET_S (or HOLD_S if longer).
  const t0 = Date.now();
  let emptySince = queueEmpty() ? Date.now() : null;
  while (Date.now() - t0 < MAX_S * 1000) {
    const empty = queueEmpty();
    if (empty && emptySince == null) { emptySince = Date.now(); log("ops queue is empty"); }
    if (!empty) emptySince = null;
    const heldLongEnough = Date.now() - t0 >= HOLD_S * 1000;
    if (empty && heldLongEnough && Date.now() - emptySince >= QUIET_S * 1000) break;
    await sleep(2000);
  }
  await page.evaluate(() => game.modules.get("world-fabric")?.api?.reindexForGmTools?.());
  await sleep(2000);
  log("done; leaving the world");
} catch (e) {
  log("FAILED:", e.message);
  exitCode = 1;
} finally {
  await browser.close();
}
process.exit(exitCode);
