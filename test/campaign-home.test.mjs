// mutation-engine/campaign-home.mjs: the registry and the per-store path
// precedence (store env override -> campaign repo -> legacy root).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratchDir = mkdtempSync(join(tmpdir(), "campaign-home-test-"));
const campaign = join(scratchDir, "campaign-repo");
mkdirSync(campaign, { recursive: true });
// A registry FILE that names a world: it must be ignored under node --test.
process.env.XDG_CONFIG_HOME = join(scratchDir, "config");
mkdirSync(join(scratchDir, "config", "gm-tools"), { recursive: true });
writeFileSync(join(scratchDir, "config", "gm-tools", "campaigns.json"), JSON.stringify({ "file-world": campaign }));

const {
  listCampaigns, campaignDir, campaignDataDir, campaignStoreFile, campaignStoreDir, campaignRegistryPath
} = await import("../mutation-engine/campaign-home.mjs");

const LEGACY = join(scratchDir, "legacy-root");
const SPEC = { store: "session-scenes", envVar: "GM_TOOLS_CAMPAIGN_HOME_TEST_DIR", legacyRoot: LEGACY };

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test("registry file path follows XDG_CONFIG_HOME", () => {
  assert.equal(campaignRegistryPath(), join(scratchDir, "config", "gm-tools", "campaigns.json"));
});

test("under node --test the registry file is ignored: no env, no campaigns", () => {
  withEnv({ GM_TOOLS_CAMPAIGNS: undefined }, () => {
    assert.ok(process.env.NODE_TEST_CONTEXT, "sanity: running under node --test");
    assert.deepEqual(listCampaigns(), {});
    assert.equal(campaignDir("file-world"), null);
  });
});

test("the registry file is read outside a test run", () => {
  withEnv({ GM_TOOLS_CAMPAIGNS: undefined, NODE_TEST_CONTEXT: undefined }, () => {
    assert.deepEqual(listCampaigns(), { "file-world": campaign });
  });
});

test("GM_TOOLS_CAMPAIGNS parses world=dir pairs, wins over the file, and drops relative paths", () => {
  withEnv({ GM_TOOLS_CAMPAIGNS: `w1=${campaign}; w2 = /nope/missing ;bad;rel=some/relative`, NODE_TEST_CONTEXT: undefined }, () => {
    assert.deepEqual(listCampaigns(), { w1: campaign, w2: "/nope/missing" });
    assert.equal(campaignDir("w1"), campaign);
    assert.equal(campaignDataDir("w1"), join(campaign, "data"));
    assert.equal(campaignDir("w2"), null, "a registered folder that does not exist is not a campaign home");
    assert.equal(campaignDir("file-world"), null);
  });
  withEnv({ GM_TOOLS_CAMPAIGNS: "", NODE_TEST_CONTEXT: undefined }, () => {
    assert.deepEqual(listCampaigns(), {}, "set but empty means no campaigns");
  });
});

test("store path precedence: env override, then campaign repo, then legacy root", () => {
  withEnv({ GM_TOOLS_CAMPAIGNS: `w1=${campaign}`, [SPEC.envVar]: undefined }, () => {
    assert.equal(campaignStoreFile("w1", SPEC), join(campaign, "data", "session-scenes.json"));
    assert.equal(campaignStoreDir("w1", SPEC), join(campaign, "data", "session-scenes"));
    assert.equal(campaignStoreFile("other", SPEC), join(LEGACY, "other.json"));
    assert.equal(campaignStoreDir("other", SPEC), join(LEGACY, "other"));
  });
  const override = join(scratchDir, "override");
  withEnv({ GM_TOOLS_CAMPAIGNS: `w1=${campaign}`, [SPEC.envVar]: override }, () => {
    assert.equal(campaignStoreFile("w1", SPEC), join(override, "w1.json"));
    assert.equal(campaignStoreDir("w1", SPEC), join(override, "w1"));
  });
});

test("a real store follows the registry", async () => {
  const { createScene, listScenesForWorld } = await import("../session-planner/scenes.mjs");
  const { existsSync } = await import("node:fs");
  withEnv({
    GM_TOOLS_CAMPAIGNS: `w1=${campaign}`,
    GM_TOOLS_SESSION_SCENES_DIR: undefined,
    GM_TOOLS_REVIEW_STATE_DIR: join(scratchDir, "review-state")
  }, () => {
    createScene("w1", { name: "A scene" });
    assert.ok(existsSync(join(campaign, "data", "session-scenes.json")));
    assert.equal(listScenesForWorld("w1").length, 1);
  });
});
