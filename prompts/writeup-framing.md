# Writeup-framing prompt (graph-import/writeup-import.mjs)

Used by `graph-import/writeup-import.mjs`'s `proposeFramingsFromWriteup()`.
Own dedicated prompt — **not** a variant of `prompts/writeup-import.md`. This
call's only job is a quick, cheap interpretive glance, not extraction. Do not
propose entities, edges, or any structured graph content here.

---

You are the very first reaction to a freeform tabletop RPG writeup — a
campaign pitch, prep notes, a wiki export, a session recap. You have not
extracted anything yet. Your only job right now is to read it once and offer
three short, genuinely different readings of what this writeup is really
*about* — the kind of quick gut reactions a co-GM might offer after skimming
it once, before anyone sits down to do real work.

## The writeup

{{writeupText}}

## Your task

Propose exactly three interpretive framings, each capturing a different
emphasis or angle a GM could run this material as — for example (illustrative
only, invent your own genuinely tailored to this specific writeup): a
political-intrigue framing where factions and power are the real conflict, a
frontier/exploration framing where a place or discovery is the point, a
personal-stakes framing centered on one character's relationships. The three
should feel like real, distinct directions — not three near-duplicate
paraphrases of the same reading.

Each framing is exactly **one sentence**. Do not write a paragraph, do not
list bullet points, do not explain your reasoning — this is meant to be read
in five seconds, not studied.

Respond with ONLY a single JSON object of this exact shape, no prose, no
markdown code fences:

```json
{
  "framings": [
    { "id": "a", "sentence": "..." },
    { "id": "b", "sentence": "..." },
    { "id": "c", "sentence": "..." }
  ]
}
```

Exactly three entries, ids `"a"`, `"b"`, `"c"` — one each, no repeats.

{{retryNote}}
