---
name: splash-gen
description: Generate splash art, PC portraits, and scene art on demand via the Gemini image API ("nano banana") and register it into a world's stagecraft catalog. Load when asked to generate art for any GM_Tools world — covers the gen-splash script, prompt recipes, the character-consistency workflow (portrait once, reference forever), and where art lands (Foundry assets tree + stagecraft + art index).
---

# splash-gen — on-demand art for GM_Tools worlds

Requires `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) in the environment —
from https://aistudio.google.com. Anthropic models don't generate images;
this is always an external Gemini call. If the key is missing, the script
says so and exits — never fake an image path.

## The tool

`bin/gen-splash.mjs` (repo root, no deps, modern node — use
`/home/russell/.local/node/bin/node`):

```
GEMINI_API_KEY=... node bin/gen-splash.mjs \
  --world kilmarn --name pip-fenwick-portrait \
  --prompt "..." \
  [--ref path.png ...]        # reference images for consistency/editing
  [--kind splash|map]         # stagecraft kind, default splash
  [--desc "shelf blurb"]      # default: GENERATED (<model>): <prompt>
  [--art-index <campaign>/notes/art-descriptions.json]
  [--no-asset]                # skip stagecraft registration
  [--force true]              # overwrite an existing file
```

What it does: generates → writes `<dataDir>/assets/<world>-art/<name>.png`
(servable by Foundry directly) → registers a stagecraft asset with `src`
→ appends the campaign art index. Model default `gemini-2.5-flash-image`;
override with `--model` or `WF_IMAGE_MODEL` if the id has moved.

## Workflow rules

1. **Portrait once, reference forever.** Generate each PC/NPC portrait
   from their sheet description first. For every later image of that
   character (action shots, group scenes), pass the portrait via `--ref`
   — nano banana's strength is keeping a referenced character consistent.
   Keep portraits at `assets/<world>-art/<name>-portrait.png`.
2. **Prompts from stored text, not improvisation.** PC prompts come from
   the campaign's pregen sheets (appearance, gear, class tells); scene
   prompts from the scene's Read Aloud + the verified map description in
   the art index. Include: subject, mood/tone-state (Present/Bad/Good
   bleed), lighting, palette anchors, and "fantasy illustration, painterly,
   no text, no watermark".
3. **Tone-states are variants.** Name them `<thing>-present / -bad-bleed /
   -good-bleed` and generate from the same reference so the drift IS the
   art.
4. **Everything self-indexes.** Always pass `--art-index` when a campaign
   repo exists — generated art joins the metadata-first pipeline
   (cull by stored description before ever re-looking).
5. **Cost sanity.** Batch requests deliberately (a party is ~8 images,
   plus retries); confirm with the owner before batches much larger than
   that.

## Registered-asset conventions

Same as scene-authoring §7: desc written right at creation (immutable),
`kind=splash` for money-moment art with "show at <beat>" in the desc,
`kind=map` only for actual battle maps. Link scene `mapAssetId` for maps;
splash stays catalog-only.
