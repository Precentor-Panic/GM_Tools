// GM Review — Phase 37 task 37.2: THE shared proposal / diff card. ONE
// vanilla-ES-module component (`renderProposalCard(mutation, opts)` -> a DOM
// node) mountable ANYWHERE a StoredMutation-shaped object needs review UI:
// Chronicle's "What changed" panel first (37.2), then the Wrap rail + the
// Connection-Menu lore-intake review (37.3) replacing their own local card
// renderers -- the README's "implement once" rule. This is the graph review
// engine an agent-proposed batch will flow through later, so it is NOT
// Chronicle-local.
//
// DOM/testid contract: phase37-fixture.mjs §7 (pinned there so 37.3 adopts it
// verbatim). Markup/spacing/copy/glyphs ported from Chronicle.dc.html's own
// review-list card (its lines ~277-303) -- the pixel authority.
//
// Accepts BOTH shapes it will ever be handed, by reading defensively:
//  - a batchDetailPayload region entity ({ mutationId, entityId, name, op,
//    rationale, type, risk, diff, data, status }), Chronicle's own source;
//  - a raw StoredMutation ({ mutationId, op, id, data, rationale, type, risk,
//    diff, entityContext, status }), any future agent-proposed batch's source.
// accept/reject call the EXISTING, unmodified /api/batches/:id/accept|reject
// routes (scope:"entity", id=mutationId) -- never a second review-state path.
"use strict";

const TYPES = {
  place: { glyph: "▢", accent: "oklch(0.55 0.075 185)" },
  person: { glyph: "◉", accent: "oklch(0.60 0.10 65)" },
  object: { glyph: "◆", accent: "oklch(0.52 0.08 300)" },
  faction: { glyph: "⬗", accent: "oklch(0.50 0.09 145)" },
  event: { glyph: "✧", accent: "oklch(0.55 0.11 40)" },
  concept: { glyph: "◌", accent: "oklch(0.55 0.03 260)" }
};

// RISK labels/colours -- verbatim from Chronicle.dc.html's own RISK table.
const RISK = {
  safe: { label: "safe", color: "oklch(0.48 0.09 150)" },
  look: { label: "wants a look", color: "oklch(0.55 0.10 65)" },
  contradict: { label: "fights canon", color: "oklch(0.52 0.13 25)" }
};

function el(tag, { style, testid, text, ...attrs } = {}, children = []) {
  const node = document.createElement(tag);
  if (style) node.setAttribute("style", style);
  if (testid) node.setAttribute("data-testid", testid);
  if (text != null) node.textContent = text;
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.appendChild(c);
  return node;
}

function mutationId(m) {
  return m.mutationId ?? m.id ?? null;
}

function displayName(m) {
  return m.name ?? m.entityContext?.name ?? m.data?.name ?? m.entityId ?? m.id ?? "(unnamed)";
}

/** op + a create-vs-edit check -> the prototype's kind vocabulary. */
function kindLabel(m, created) {
  switch (m.op) {
    case "delete_entity":
    case "delete_edge":
      return "removed";
    case "upsert_edge":
      return created ? "new edge" : "edge edit";
    case "upsert_entity":
    default:
      return created ? "new node" : "field edit";
  }
}

/**
 * Pull before/after prose from the attached diff (diff.mjs's {field,from,to}
 * tuples), per §7: prefer the `description` field's text; otherwise fall back
 * to plain "field: value" lines. A create has an after but no before.
 */
function diffText(m) {
  const changes = Array.isArray(m.diff) ? m.diff : [];
  const created = changes.length > 0 && changes[0].field === "(created)";

  if (created) {
    const after = changes[0].to || m.data || {};
    return {
      hasBefore: false,
      before: "",
      after: after.description ?? after.name ?? shortObject(after)
    };
  }

  const real = changes.filter((c) => c.field !== "(created)");
  const desc = real.find((c) => c.field === "description");
  if (desc) {
    return { hasBefore: desc.from != null && desc.from !== "", before: String(desc.from ?? ""), after: String(desc.to ?? "") };
  }
  if (real.length) {
    const before = real.map((c) => `${c.field}: ${fmt(c.from)}`).join(" · ");
    const after = real.map((c) => `${c.field}: ${fmt(c.to)}`).join(" · ");
    return { hasBefore: real.some((c) => c.from != null && c.from !== ""), before, after };
  }

  // No diff attached (e.g. a mutation persisted before diff.mjs ran): show
  // whatever the patch data itself says, after-only.
  const d = m.data || {};
  return { hasBefore: false, before: "", after: d.description ?? d.name ?? shortObject(d) };
}

function fmt(v) {
  if (v == null || v === "") return "—";
  if (typeof v === "object") return shortObject(v);
  return String(v);
}

function shortObject(o) {
  if (!o || typeof o !== "object") return String(o ?? "—");
  const parts = [];
  for (const k of ["name", "type", "relationshipType", "description"]) {
    if (o[k] != null && o[k] !== "") parts.push(`${k}: ${o[k]}`);
  }
  return parts.length ? parts.join(" · ") : "(created)";
}

function statusToDecided(status) {
  if (status === "accepted") return "yes";
  if (status === "rejected") return "no";
  return "";
}

async function postDecision(world, batchId, mid, kind) {
  const res = await fetch(`/api/batches/${encodeURIComponent(batchId)}/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world, scope: "entity", id: mid })
  });
  if (!res.ok) {
    let body = null;
    try { body = await res.json(); } catch { /* no body */ }
    throw new Error((body && body.error) || `${res.status} ${res.statusText}`);
  }
  return res.json().catch(() => ({}));
}

/**
 * @param {object} m       a StoredMutation-shaped object (see module header).
 * @param {object} opts    { world, batchId, onDecided?(decided) }
 * @returns {HTMLElement}
 */
export function renderProposalCard(m, opts = {}) {
  const { world, batchId, onDecided } = opts;
  const mid = mutationId(m);
  const type = m.type ?? m.data?.type ?? "concept";
  const risk = RISK[m.risk] ? m.risk : "";
  const riskMeta = RISK[risk];
  const t = TYPES[type] || TYPES.concept;
  const changes = Array.isArray(m.diff) ? m.diff : [];
  const created = changes.length > 0 && changes[0].field === "(created)";
  const { hasBefore, before, after } = diffText(m);

  let decided = statusToDecided(m.status);

  const riskColor = riskMeta ? riskMeta.color : "oklch(0.86 0.010 80)";

  const root = el("div", {
    testid: "proposal-card",
    "data-mutation-id": mid || "",
    "data-type": type,
    "data-risk": risk,
    "data-decided": decided,
    style: cardStyle(decided, riskColor)
  });

  // Header row: kind badge · type glyph · target · risk label
  const kindBadge = el("span", {
    testid: "proposal-card-kind-badge",
    text: kindLabel(m, created),
    style: "padding: 2px 7px; border-radius: 20px; background: oklch(0.90 0.030 185); font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: 0.05em; text-transform: uppercase; color: oklch(0.38 0.060 185);"
  });
  const glyph = el("span", { text: t.glyph, style: `font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; color: ${t.accent};` });
  const target = el("span", { testid: "proposal-card-target", text: displayName(m), style: "font-size: 13px; font-weight: 500;" });
  const spacer = el("span", { style: "flex: 1;" });
  const riskLabel = el("span", {
    testid: "proposal-card-risk-label",
    text: riskMeta ? riskMeta.label : "unclassified",
    style: `font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; letter-spacing: 0.05em; color: ${riskColor};`
  });
  const header = el("div", { style: "display: flex; align-items: center; gap: 9px;" }, [kindBadge, glyph, target, spacer, riskLabel]);

  // Diff rows (−/+)
  const diffRows = el("div", { style: "display: flex; flex-direction: column; gap: 3px; margin: 9px 0 8px;" });
  if (hasBefore) {
    diffRows.appendChild(el("div", {
      testid: "proposal-card-diff-before",
      style: "display: flex; gap: 9px; padding: 4px 8px; border-radius: 3px; background: oklch(0.90 0.030 25 / 0.35);"
    }, [
      el("span", { text: "−", style: "font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: oklch(0.48 0.10 25); flex: none;" }),
      el("span", { text: before, style: "font-size: 12.5px; line-height: 1.45; color: oklch(0.40 0.020 40);" })
    ]));
  }
  diffRows.appendChild(el("div", {
    testid: "proposal-card-diff-after",
    style: "display: flex; gap: 9px; padding: 4px 8px; border-radius: 3px; background: oklch(0.90 0.045 150 / 0.40);"
  }, [
    el("span", { text: "+", style: "font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: oklch(0.42 0.09 150); flex: none;" }),
    el("span", { text: after, style: "font-size: 12.5px; line-height: 1.45; color: oklch(0.30 0.020 150);" })
  ]));

  // Footer: rationale + accept/reject
  const why = el("div", {
    testid: "proposal-card-why",
    text: m.rationale ?? "",
    style: "flex: 1; font-size: 11.5px; line-height: 1.45; color: oklch(0.56 0.012 70);"
  });
  const acceptBtn = el("div", { testid: "proposal-card-accept-btn", role: "button", text: "Accept", style: "" });
  const rejectBtn = el("div", { testid: "proposal-card-reject-btn", role: "button", text: "Reject", style: "" });

  function paint() {
    root.setAttribute("data-decided", decided);
    root.setAttribute("style", cardStyle(decided, riskColor));
    acceptBtn.setAttribute("style", acceptStyle(decided));
    rejectBtn.setAttribute("style", rejectStyle(decided));
  }

  async function decide(kind) {
    if (!world || !batchId || !mid) return;
    const target = kind === "accept" ? "yes" : "no";
    // Toggle off if already in that state -> revert to pending is not exposed
    // by the accept/reject routes, so we only ever move forward here (the card
    // reflects the persisted status; a mis-click is corrected by the other btn).
    try {
      await postDecision(world, batchId, mid, kind);
      decided = target;
      paint();
      onDecided?.(decided, m);
    } catch (err) {
      // Surface loudly in the console; leave the card visually unchanged.
      console.error("proposal-card decision failed:", err);
    }
  }
  acceptBtn.addEventListener("click", () => decide("accept"));
  rejectBtn.addEventListener("click", () => decide("reject"));

  const btns = el("div", { style: "display: flex; gap: 6px; flex: none;" }, [acceptBtn, rejectBtn]);
  const footer = el("div", { style: "display: flex; align-items: flex-end; gap: 12px;" }, [why, btns]);

  root.append(header, diffRows, footer);
  paint();
  return root;
}

function cardStyle(decided, riskColor) {
  const bg = decided === "yes" ? "oklch(0.968 0.020 150)" : decided === "no" ? "oklch(0.955 0.004 85)" : "oklch(0.985 0.005 85)";
  const border = decided === "yes" ? "oklch(0.78 0.070 150)" : decided === "no" ? "oklch(0.90 0.006 80)" : "oklch(0.88 0.010 80)";
  return `border: 1px solid ${border}; border-left: 3px solid ${riskColor}; border-radius: 4px; background: ${bg}; padding: 11px 13px;`;
}

function acceptStyle(decided) {
  const bg = decided === "yes" ? "oklch(0.86 0.070 150)" : "oklch(1 0 0)";
  const fg = decided === "yes" ? "oklch(0.28 0.07 150)" : "oklch(0.42 0.07 150)";
  const border = decided === "yes" ? "oklch(0.70 0.080 150)" : "oklch(0.86 0.010 80)";
  return `padding: 4px 11px; border: 1px solid ${border}; border-radius: 4px; cursor: pointer; font-size: 11.5px; background: ${bg}; color: ${fg};`;
}

function rejectStyle(decided) {
  const bg = decided === "no" ? "oklch(0.90 0.030 25)" : "oklch(1 0 0)";
  const fg = decided === "no" ? "oklch(0.36 0.10 25)" : "oklch(0.52 0.014 65)";
  const border = decided === "no" ? "oklch(0.76 0.080 25)" : "oklch(0.86 0.010 80)";
  return `padding: 4px 11px; border: 1px solid ${border}; border-radius: 4px; cursor: pointer; font-size: 11.5px; background: ${bg}; color: ${fg};`;
}

// Triage bucket definitions -- verbatim from Chronicle.dc.html's BUCKETS.
// Exported so the "Triaged" review mode groups the SAME proposal-card
// instances by risk (one card, two containers -- the reuse discipline).
export const RISK_BUCKETS = [
  { id: "safe", label: "Safe to apply", glyph: "✓", accent: "oklch(0.44 0.09 150)", border: "oklch(0.86 0.045 150)", bg: "oklch(0.968 0.020 150)", titleColor: "oklch(0.30 0.05 150)", blurb: "follows from what you wrote, touches nothing the party leans on" },
  { id: "look", label: "Wants a look", glyph: "◐", accent: "oklch(0.50 0.10 65)", border: "oklch(0.86 0.050 65)", bg: "oklch(0.970 0.024 65)", titleColor: "oklch(0.34 0.07 65)", blurb: "invents a name or moves an object you never placed" },
  { id: "contradict", label: "Fights your canon", glyph: "!", accent: "oklch(0.50 0.13 25)", border: "oklch(0.85 0.060 25)", bg: "oklch(0.968 0.026 25)", titleColor: "oklch(0.36 0.09 25)", blurb: "disagrees with an earlier session note — read every word" }
];
