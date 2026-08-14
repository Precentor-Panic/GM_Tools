// W6a — the shared attach-or-create world picker.
//
// Friction source (one-shot friction log, 2026-08-14): "Gear menu: no way to
// point at an EXISTING Foundry world." Russell had a real Foundry world
// (kilmarn) on disk and the create card only offered "type a new id" — typing
// the existing name would have 500'd "already exists", and the topbar
// world-select (which lists only snapshot-bearing worlds) wasn't the obvious
// place to look. This module renders the ONE surface both gaps asked for:
// every Data/worlds/* directory (GET /api/worlds' worldDirs, W6a), each row
// either selectable (has a World Fabric snapshot already — switching is all
// "picking" it means) or attachable (no snapshot yet — Attach bootstraps a
// snapshot INTO that existing folder via the same POST /api/worlds route),
// with plain "new id" creation kept as the explicit fallback underneath.
//
// Standalone in the exact same way world-id.js / connection-menu.js are (own
// fetch helper, no app.js import) so every host — the connection panel's
// Foundry section, app-shell.js's zero-worlds landing — mounts the same
// component instead of keeping its own world list.
"use strict";
import { isValidWorldId, slugifyWorldId } from "./world-id.js";

async function wpApi(path, opts) {
  const res = await fetch(path, opts);
  let body = null;
  try { body = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Render the attach-or-create picker into `host` (cleared first).
 *
 * @param {HTMLElement} host
 * @param {{
 *   currentWorld?: string|null,   // marked "current", its Select disabled
 *   onPicked: (worldId: string, how: "selected"|"attached"|"created") => void,
 *   createLabel?: string          // fallback-row button label (default "Create world")
 * }} opts
 *
 * onPicked fires AFTER the server call succeeds (attach/create) or
 * immediately (select of an existing GM_Tools world) — the host owns what
 * "picking a world" means for its surface (shell re-render, panel refresh…).
 */
export async function renderWorldPicker(host, opts = {}) {
  host.innerHTML = "";
  // Mark the mount point -- but never clobber a testid the host surface
  // already owns (e.g. the conn panel's own conn-world-switch-list).
  if (!host.hasAttribute("data-testid")) host.setAttribute("data-testid", "world-picker");

  let worldDirs = [];
  try {
    ({ worldDirs = [] } = await wpApi("/api/worlds"));
  } catch (err) {
    host.appendChild(el("div", { class: "world-picker-empty", "data-testid": "world-picker-error" },
      `Could not list worlds: ${err.message}`));
    return;
  }

  const list = el("div", { class: "world-picker-list", "data-testid": "world-picker-list" });
  host.appendChild(list);

  if (worldDirs.length === 0) {
    list.appendChild(el("div", { class: "world-picker-empty", "data-testid": "world-picker-empty" },
      "No world folders on disk yet — create one below."));
  }

  // GM_Tools worlds first (selectable), then attachable Foundry folders,
  // then anything unattachable; alphabetical inside each group.
  const rank = (w) => (w.hasSnapshot ? 0 : w.attachable ? 1 : 2);
  const sorted = [...worldDirs].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));

  for (const w of sorted) {
    const row = el("div", {
      class: "world-picker-row",
      "data-testid": "world-picker-row",
      "data-world": w.id,
      "data-has-snapshot": String(!!w.hasSnapshot)
    });
    row.appendChild(el("span", { class: "world-picker-name" }, w.id));

    if (w.hasSnapshot) {
      row.appendChild(el("span", { class: "world-picker-badge world-picker-badge--ready", "data-testid": "world-picker-badge" },
        "GM_Tools world"));
      const isCurrent = opts.currentWorld && opts.currentWorld === w.id;
      if (isCurrent) {
        row.appendChild(el("span", { class: "world-picker-current", "data-testid": "world-picker-current" }, "current"));
      } else {
        const btn = el("button", { type: "button", class: "btn world-picker-select-btn", "data-testid": "world-picker-select-btn" }, "Select");
        btn.addEventListener("click", () => opts.onPicked?.(w.id, "selected"));
        row.appendChild(btn);
      }
    } else if (w.attachable) {
      row.appendChild(el("span", { class: "world-picker-badge world-picker-badge--foundry", "data-testid": "world-picker-badge" },
        "Foundry world · not attached"));
      const btn = el("button", { type: "button", class: "btn btn--accept world-picker-attach-btn", "data-testid": "world-picker-attach-btn" }, "Attach");
      const status = el("span", { class: "world-picker-row-status", "data-testid": "world-picker-row-status" });
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        status.textContent = "Attaching…";
        try {
          const result = await wpApi("/api/worlds", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ world: w.id })
          });
          status.textContent = "Attached.";
          opts.onPicked?.(result.world, "attached");
        } catch (err) {
          btn.disabled = false;
          status.textContent = `Attach failed: ${err.message}`;
        }
      });
      row.append(btn, status);
    } else {
      // A real directory whose name doesn't fit the world-id floor (spaces,
      // dots…) — shown, never hidden, but not actionable from here.
      row.appendChild(el("span", { class: "world-picker-badge world-picker-badge--invalid", "data-testid": "world-picker-badge" },
        "folder name not usable as a world id"));
    }
    list.appendChild(row);
  }

  // ------- the plain "new id" fallback (Task 14.2's flow, unchanged rules) --
  const create = el("div", { class: "world-picker-create", "data-testid": "world-picker-create" });
  create.appendChild(el("div", { class: "world-picker-create-label" }, "Or start a brand-new world"));
  const row = el("div", { class: "world-picker-create-row" });
  const input = el("input", { type: "text", class: "world-picker-create-input", "data-testid": "world-picker-create-input", placeholder: "world id, e.g. my-campaign" });
  const btn = el("button", { type: "button", class: "btn btn--accept world-picker-create-btn", "data-testid": "world-picker-create-btn" }, opts.createLabel || "Create world");
  const status = el("div", { class: "world-picker-create-status", "data-testid": "world-picker-create-status" });
  // Same client-side validate + auto-slug-suggest flow as the QA W2 fix
  // (Group C #14) — world-id.js is the single shared rule.
  let suggestedSlug = "";
  function refreshHint() {
    const raw = input.value.trim();
    if (!raw || isValidWorldId(raw)) { status.textContent = ""; suggestedSlug = ""; return; }
    suggestedSlug = slugifyWorldId(raw);
    status.textContent = suggestedSlug
      ? `Only lowercase letters, digits, hyphens, and underscores — try "${suggestedSlug}"?`
      : "Only lowercase letters, digits, hyphens, and underscores.";
  }
  input.addEventListener("input", refreshHint);
  btn.addEventListener("click", async () => {
    const id = input.value.trim();
    if (!id) { status.textContent = "Enter a world id first."; return; }
    if (!isValidWorldId(id)) {
      if (suggestedSlug && suggestedSlug !== id) {
        input.value = suggestedSlug;
        refreshHint();
        status.textContent = `Cleaned up to "${suggestedSlug}" — click again to confirm.`;
        return;
      }
      status.textContent = "Only lowercase letters, digits, hyphens, and underscores are allowed.";
      return;
    }
    btn.disabled = true;
    status.textContent = "Creating…";
    try {
      const result = await wpApi("/api/worlds", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: id })
      });
      status.textContent = result.attached
        ? `"${result.world}" was already on disk — attached it instead.`
        : `Created "${result.world}".`;
      opts.onPicked?.(result.world, result.attached ? "attached" : "created");
    } catch (err) {
      btn.disabled = false;
      status.textContent = err.status === 409
        ? `"${id}" is already a GM_Tools world — select it from the list above.`
        : `Create failed: ${err.message}`;
    }
  });
  row.append(input, btn);
  create.append(row, status);
  host.appendChild(create);
}
