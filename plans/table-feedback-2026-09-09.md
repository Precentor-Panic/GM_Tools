# Table feedback — 2026-09-09 (first live session run from the app)

Captured from Russell after running a full session out of the Run spread.
Not yet adjudicated into tasks; this is the raw list plus enough detail to
build from. All four are app-general — nothing here is campaign-specific.

## 1. Notes must be enabled in Run mode

`Add Event` is currently mounted on the Prep page only
(`review-ui/public/session-planner-view.js`, `mountAddEventControl` at its
single call site). Live play happens in Run, so capture is unavailable at
exactly the moment there is something to capture.

Related, and probably the same piece of work: the **write-only notes gap**
is still open (flagged in the 2026-08-31 persona round, never adjudicated).
`captureNote` appends to `session-notes/<world>.json` and no surface
anywhere reads notes back, so a note taken at the table is not findable
afterward by any route the GM has.

## 2. Wrap should be session-grained, not scene-grained

> "notes on the scene but wrap the whole session"

Capture stays per-scene (a note knows which scene it was taken in — that
anchor is useful). The **wrap** is one act over the whole session, not a
per-scene ritual. Check this against the existing Plan-page wrap-up panel
(`session-planner/session-wrap.mjs`) — it may already be session-grained,
in which case the work is making that legible rather than rebuilding it.

## 3. Remove subtitles from generated scenes — they leak

Generated scene subtitles contained spoilers. The subtitle sits in the
scene header where it is visible before the scene is run, and in at least
some cases it stated the thing the scene was supposed to reveal. Kill the
subtitle rather than trying to write safer ones.

## 4. Run-spread reading order does not match how a GM reads at the table

The headline complaint: **"I still found your generated scenes hard to
run."** The narration intro was good; the layout around it was not.

Russell's eye goes **down the left column first**, so everything he
delivers to the players must be in the left column, in delivery order.
A key element (a courier arriving with a bundle) was placed top-right and
was missed for exactly this reason.

Target order, left column, top to bottom:

1. **Read aloud** — what the place looks like + sensory detail.
2. **What's happening now** — the current activity/motion in the scene.
   May be folded into the read-aloud block rather than split out.
3. **The main interactive elements / NPCs** — and these need to carry
   *visual description, mannerisms, race* — enough to describe a person
   rapidly out loud without composing it on the spot. This is a content
   requirement on the generator as much as a layout one.

Right column is reserved for: the map snapshot, optional events, the
"linger here too long and…" table, and fallback plans.

### Rename

`residue` → **"what's happening"**. The role label is opaque at the table.
(`runFieldLabel` / `ROLE_LABELS` in `run-layout.mjs` — one shared mapping,
so Prep, Layout and Run all follow.)

### The principle behind all of it

> "I just want the info I'm delivering to the PCs to be clear and on the
> page in an order that aligns with the way I'd read it."

Left column = what comes out of the GM's mouth, in the order it comes out.
Right column = what the GM reaches for only if something happens.

## 5. Small token art for named NPCs

Named NPCs pushed to Foundry land with generic chassis art (the Ledger-Man
is a Commoner.webp, the Rust-Eaters are Bandit.webp). A named face needs
its own small token. Whether that is generated, picked from a library, or
hand-supplied is open — but the push path has to be able to carry a
per-entry token image, and the Library needs somewhere to set it.

## 6. Bake music into scenes

> "your remastered tracks are good but I forget to switch between them."

The playlists exist and the per-scene music draft exists; what's missing is
the scene carrying its own track so activating the scene starts it. Foundry
Scenes have `playlist` / `playlistSound` fields for exactly this. The
bridge's `create_scene` / `update_scene` don't carry them, and GM_Tools
scenes have no music field to push from.

## 7. Box resizing and text jumping between Prep / Layout / Run

Switching between the three views, and clicking into edit fields on the
Prep page, still produces visible box resizing and text jumping. The
2026-09-02 round fixed one instance (`.scene-field--editing` keeping the
resting text's shape) but the class of problem is still there. Needs a
measured reproduction — Playwright bounding boxes across each transition —
before a fix, not a guess.

## Also in scope for the same pass (found during the intake, not table feedback)

- **Bridge tokens land HOSTILE.** `buildTokenData` in foundry_worldFabric's
  `foundry-bridge.mjs` hand-composes `{name,x,y,actorId,texture}` and
  never sets `disposition`; Foundry v14's TokenDocument schema default is
  `-1`. Verified live: every PC token on every pushed combat scene is
  hostile-red, and the Ledger-Man "looked hostile" for the same reason.
  Same class as the lighting trap — the bridge should derive from
  `actor.getTokenDocument()` (prototype token) rather than compose from
  scratch, which also restores vision/bars/size.
- **Retired bestiary rows stay droppable.** Renaming a row "(retired)"
  keeps its `foundryActorRef`, so the tray still offers it and the retired
  actor's token ended up on the live scene.
- **Session-one cast is not in the graph.** Vashan, the charm, Tariq
  al-Zahabi, the second ledger exist only as scene prep + Foundry actors.
  No narrative-state records, no gating. Needs an ingest.
