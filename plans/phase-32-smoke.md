# Phase 32 — Live-Foundry smoke test (the phase's acceptance gate)

**Who runs this: Russell, by hand.** There is no automated live-Foundry harness in either repo — the pure
logic on both sides is already unit-tested against fixtures (see "What's already verified" below); this
runbook exercises the parts that only exist inside a real running Foundry client (`FilePicker.upload`, the
document-creation API, the file-system poll loop). Budget ~15 minutes.

Consolidates the live-smoke block already embedded in
`foundry_worldFabric/scripts/data/foundry-bridge.mjs` (lines 421–453) with the GM_Tools-side pull/push routes,
into one linear pass. If that file's own comment block and this doc ever disagree, the code comment is a stale
copy — fix it to match this doc (this doc is the maintained, authoritative version going forward).

## What's already verified (you don't need to re-check these — just know they're covered)

- `foundry-bridge.mjs`'s pure core (`buildFoundryIndex`, `applyFoundryOps`) — unit-tested in Node against the
  32.0 contract fixtures, `foundry_worldFabric/test/foundry-bridge.test.mjs`.
- GM_Tools's pull mappers (`combat-planning/foundry-actor-mapper.mjs`), pull orchestration
  (`wf-mcp-server/lib/foundry-pull-ops.mjs`), and push writer (`wf-mcp-server/lib/foundry-ops.mjs`,
  `wf-mcp-server/lib/foundry-push-ops.mjs`) — unit-tested against the same fixtures, no live Foundry involved.

What ONLY this manual pass can check: the in-client `FilePicker.upload`/`fetch`-poll transport actually works
against a real Foundry server, real `game.actors`/`game.users`/`game.scenes` extraction produces sane data, and
a real `getDocumentClass("Scene").create(...)` call actually creates a visible Scene.

---

## 0. Install

1. In `foundry_worldFabric`, re-package the module (check `package.json`'s `"scripts"` for the exact packaging
   command — e.g. `npm run package`, confirm the actual script name before running it blind) to produce the
   updated module zip containing `scripts/data/foundry-bridge.mjs` and the `module.mjs` wiring
   (`api.reindexForGmTools`, the `graph.exportSnapshot` piggyback, `startFoundryOpsWatcher()` at `ready`).
2. Re-install that zip into your Foundry instance (Foundry's own module-management "Install Module" flow, or
   whatever your existing update mechanism is for this module — same process you've used for prior World Fabric
   updates).
3. Open the campaign world at `http://localhost:30000`, log in as **GM** (the watcher and index export are both
   GM-gated — `game.user?.isGM` — a non-GM login will silently no-op both halves of this bridge).
4. Confirm the module loaded: open the browser console and look for

   ```
   world-fabric | ready — <N> entities, <M> edges
   ```

   (the existing ready-hook log line, `module.mjs` — its continued presence confirms the module initialized
   without throwing; the Foundry-bridge wiring runs in the same hook, right after this line, so if this line is
   missing the whole hook failed and nothing below will work either).

---

## 1. Pull smoke — index export + GM_Tools ingest

### 1a. Trigger a reindex

In the browser console:

```js
game.modules.get("world-fabric").api.reindexForGmTools()
```

(This also fires automatically on `ready` and piggybacks every graph-snapshot flush — the manual call is just
to get an immediate, on-demand export for this test rather than waiting on the next natural flush.)

### 1b. Confirm the index file is rich

```bash
curl http://localhost:30000/worlds/<worldId>/world-fabric-foundry-index.json
```

(`<worldId>` = `game.world.id`, visible in the console or Foundry's world-management screen.)

**Success looks like:**
- `"version": 1` at the top level.
- `actors[]` non-empty, each entry with a populated `system` block — at minimum `hp`/`ac` for actors that have
  them, and `items[]` present (possibly empty, but the key exists) for every actor.
- `users[]` non-empty, and at least one entry with a non-null `characterUuid` if any player has an assigned PC
  in this world.
- `scenes[]` non-empty, at least one entry with a real `background.src` (not null) if any scene has a map set.
- `tokens[]` — a flat array with `sceneUuid` stamped on each entry, matching the token counts you'd expect from
  what's actually placed on your scenes.

If any of the above is present but suspiciously empty (e.g. `items: []` on an actor you know has inventory),
that's a real bug worth investigating before moving on — don't wave it through as "close enough."

### 1c. Pull into GM_Tools

From GM_Tools (adjust the base URL to wherever `review-ui/server.mjs` is actually running, and the data dir to
wherever `dataDir` resolves for this environment):

```bash
curl -X POST http://localhost:<gmToolsPort>/api/foundry/pull-actors \
  -H "Content-Type: application/json" \
  -d '{"world": "<worldId>"}'
```

(Or the MCP tool equivalent, `wf_pull_foundry_actors`, if you're driving this from Claude/an MCP client instead
of curl directly — same underlying call, `wf-mcp-server/lib/foundry-pull-ops.mjs`'s `pullFoundryActorsToStores`.)

**Success looks like:** a response with non-empty `bestiaryProposed` and/or `partyProposed` arrays (whichever
your world's actors classify as), each record carrying `foundryActorRef` set to the matching `Actor.<id>` uuid
from the index. Then confirm those landed for real:

```bash
# bestiary entries (library-wide, no world scoping in the URL)
curl http://localhost:<gmToolsPort>/api/bestiary
# party roster (per-world)
curl http://localhost:<gmToolsPort>/api/party-roster/<worldId>
```

Look for entries with `"status": "proposed"` and a `foundryActorRef` matching an actor uuid from step 1b's
index dump. **Re-run step 1a + this curl a second time** and confirm: entries you haven't accepted get updated
in place (same `id`, refreshed content) rather than duplicating, and if you manually accept one first (via
whatever accept endpoint/UI exists today) a third re-pull leaves it untouched and reports it under
`alreadyLinked` instead of silently overwriting your accepted edit.

---

## 2. Push smoke — GM_Tools scene → Foundry Scene

### 2a. Pick a real map image already inside Foundry's data directory

`mapSrc` is a path Foundry's own `Scene.background.src` will resolve — it must already be somewhere under your
Foundry install's `Data/` directory (e.g. `scenes/some-map.webp`), not an arbitrary GM_Tools-side path. If you
don't have one handy, any existing scene's background path (visible in Foundry's Scene config, or in step 1b's
`scenes[].background.src`) works fine for this smoke test.

### 2b. Push

```bash
curl -X POST http://localhost:<gmToolsPort>/api/foundry/push-scene \
  -H "Content-Type: application/json" \
  -d '{"world": "<worldId>", "sceneId": "<a GM_Tools scene id>", "mapSrc": "scenes/some-map.webp"}'
```

(`sceneId` must be a real id from GM_Tools's own `session-planner/scenes.mjs` store for this world — list
existing scenes first if you don't have one handy, or create one, before pushing.)

**Success looks like**, within about 5 seconds (the watcher polls every 5s; the route itself polls for up to
7s before giving up and reporting `queued`):

- The curl response is `{"status":"applied","sceneId":...,"opId":...,"ok":true,"foundryUuid":"Scene.<id>","scene":{...,"foundrySceneRef":"Scene.<id>"}}`.
- In Foundry's Scenes directory, a **new Scene** appears with the name you'd expect (either the `name` you
  passed, or the scene's own resolved display name — see `foundry-push-ops.mjs`'s `resolveSceneName`) and the
  background image you specified.
- `curl http://localhost:30000/worlds/<worldId>/world-fabric-foundry-results.json` shows
  `[{"opId":"<the same opId>","ok":true,"foundryUuid":"Scene.<id>"}]` **momentarily** — GM_Tools clears this
  back to `[]` immediately after reading it, so if you curl it fast enough right after the push you should see
  the result; a moment later it'll read `[]` again. Both states are correct, just timing-dependent.
- `curl http://localhost:30000/worlds/<worldId>/world-fabric-foundry-ops.json` reads `[]` (cleared — the
  watcher applied it and signaled done).
- GM_Tools's own scene record now carries `foundrySceneRef` — confirm via whatever scene-detail route/UI
  exists, or by re-running the pull-actors-shaped list route for scenes if one exists, or simply trusting the
  push response's own `scene.foundrySceneRef` field (it's the authoritative post-write value).

### 2c. Negative check — unsupported op kind

Drop a hand-written ops file with a kind the watcher doesn't implement, to confirm the "one bad op never blocks
the batch" contract rule actually holds live, not just in the unit tests:

```bash
cat > /path/to/foundryData/worlds/<worldId>/world-fabric-foundry-ops.json <<'EOF'
[{"opId":"op_smoke_neg_1","kind":"create_actor","data":{}}]
EOF
```

Wait ~5s, then:

```bash
curl http://localhost:30000/worlds/<worldId>/world-fabric-foundry-results.json
curl http://localhost:30000/worlds/<worldId>/world-fabric-foundry-ops.json
```

**Success looks like:** results shows `[{"opId":"op_smoke_neg_1","ok":false,"error":"unsupported kind \"create_actor\""}]`
(momentarily, same clearing caveat as 2b), the ops file reads back `[]` (cleared — the watcher didn't hang or
throw on the unrecognized kind), and the browser console shows a `world-fabric | applied 0/1 foundry-op(s)` +
warning line, not an uncaught exception.

---

## 3. If it doesn't work

- **Nothing happens at all (no index file ever appears, ops never get picked up):** the watcher and the index
  export are both **GM-gated** (`game.user?.isGM`) AND require a Foundry client to actually be **open and
  logged in** — this is an eventually-consistent, client-driven bridge, not a server-side daemon. If no GM
  browser tab has this world open, nothing on the Foundry side runs, full stop. Confirm you're logged in as GM
  in an open tab before assuming something's broken.
- **Index file exists but looks stale:** the export is fire-and-forget on flush/ready + the manual
  `reindexForGmTools()` call — it does NOT run on a timer. If you changed an actor's stats after the last
  export, either flush the graph (whatever normally triggers `exportSnapshot()`) or call
  `reindexForGmTools()` again manually.
- **Push never applies, stays `queued` forever:** same GM-client-must-be-open requirement as above, PLUS check
  the ops-watcher's actual poll interval (5s) against the route's poll budget (7s) — if your Foundry client is
  slow to notice the file (e.g. tab was backgrounded/throttled by the browser), a single push attempt can
  legitimately time out to `queued` even though the watcher picks it up moments later. Re-poll
  `world-fabric-foundry-results.json` by hand after waiting longer before concluding it's actually broken.
- **`mapSrc`/`background.src` resolves to a broken image in the new Scene:** the path is resolved relative to
  Foundry's `Data/` directory by Foundry itself — confirm the path is correct via Foundry's own `FilePicker` UI
  (browse to the same path manually and confirm the image shows) before assuming the bridge code is at fault;
  this is very likely a path-string issue, not a transport issue, given the transport's own negative-kind check
  (2c) already proves the round-trip works end to end.
- **A concurrent-push 409 (`FoundryOpsInFlightError`):** means a PRIOR push's ops file was never cleared to
  `[]` — almost always because no GM client was open to process it. Confirm a GM client is open, wait for the
  existing 5s watcher tick to clear it, then retry.
