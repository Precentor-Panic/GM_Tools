---
name: rules-lookup
description: Authoritative TTRPG rules lookups (D&D 5e 2014 + Draw Steel) from Russell's owned rulebook library at GM_Tools/rules-library/. Use whenever a mechanics question arises — DCs, conditions, spells, actions, monster rules, encounter math — instead of answering from memory. Covers the grep-cite-read workflow, page-marker citations, and the IP rules (library and zips are gitignored; never commit or bulk-quote them).
---

# Rules Lookup

The library lives at `/opt/dev/GM_Tools/rules-library/` (5e/ and draw-steel/
shelves; see `INDEX.md` there for the shelf list and topic→book map). Each
`.txt` is a full book with `[[slug p.N]]` page markers; the matching `.pdf`
sits beside it and marker N = the PDF page for `Read` with `pages`.

## The contract

1. **Never answer a 5e or Draw Steel mechanics question from memory** when
   this library is present. Memory drafts, the library confirms.
2. **Workflow — tool first, grep as fallback** (Aureus table wave, B4):
   when the `world-fabric` MCP server is attached, call **`wf_rules_lookup`**
   `{query, family?, book?}` — one call searches BOTH the structured 5etools
   rules families (variant rules / actions / conditions / skills / senses /
   tables, pre-cited `(SRC p.N)`) and this library's page-marked txt shelf
   (snippet-capped by design). Compose your answer from its hits and cite
   them. Terms are ALL-must-match substrings — prefer stems ("grappl" finds
   grappled/grappling). Without the MCP server: `grep -in "<term>"
   <shelf>/<book>.txt` (case-insensitive, no `^` anchors — extraction
   layout varies) → nearest `[[slug p.N]]` marker above the hit is the
   citation. Either way: for tables, stat blocks, or anything
   layout-dependent, `Read` the PDF at that page (marker N = `pages: "N"`)
   — the tool's capped snippets never carry a whole table.
   (The app has the same search + a GM-only ask panel on the Library's
   Rules tab; `GET /api/rules` is the HTTP mirror.)
3. **Cite** as `(PHB p.N)` / `(DMG p.N)` etc. — page numbers are PDF pages,
   which may differ from printed folios; that's fine, they're reproducible.
4. **Stat blocks for play** still come from the Plutonium index /
   bestiary shelf (real data, importable); the MM text here is for rules
   text, lore, and verification.
5. **IP rules:** the zips and `rules-library/` are gitignored and must stay
   out of every repo and every committed file. Short rules quotes in
   session prep are fine; never reproduce book text at length anywhere
   durable.
6. **Missing book?** The adventure modules stay zipped; pull on demand:
   `unzip -p "<zip>" 'Core Books/<name>.pdf'` — ESCAPE `[` `]` in inner
   paths (they glob) — then `pdftotext` (default mode, NOT -layout: it
   bleeds two-column text) and re-add page markers by splitting on \f.
