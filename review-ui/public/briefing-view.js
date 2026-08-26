// Briefing surface (2026-08-26) -- the world-level front matter: an ordered
// grid of cards (title · eyebrow · light-HTML body · span 1|2) rendered in
// the same module-style treatment as the Run spread, one level up. Edit in
// place (click-to-edit title/eyebrow/body via the planner's own
// makeClickToEditField), ↑/↓ reorder, span toggle, add, delete. Thin client
// over /api/session-planner/briefing/* -- no logic that isn't presentation.
//
// The body is trusted local content (the GM's own prep) rendered through a
// small whitelist (paragraphs, lists, tables, emphasis, headings, inline
// SVG): a guard against accidents, not an adversary.
import { makeClickToEditField } from "./session-planner-view.js";

// Same localStorage key every shell surface reads (app-shell.js / session-planner-view.js).
function currentWorld() { return localStorage.getItem("gmReview.world") || null; }

const ALLOWED_TAGS = new Set([
  "p", "b", "strong", "i", "em", "u", "s", "br", "ul", "ol", "li", "h3", "h4", "span", "div", "blockquote", "code", "pre",
  "table", "thead", "tbody", "tr", "th", "td", "hr", "small", "sup", "sub", "a",
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "title", "defs", "use", "marker"
]);
const ALLOWED_ATTRS = new Set([
  "class", "href", "target", "rel", "colspan", "rowspan",
  "viewBox", "d", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "width", "height", "points", "transform",
  "fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "text-anchor", "font-size", "opacity", "style"
]);

function sanitizeBody(html) {
  const doc = new DOMParser().parseFromString(`<div>${String(html || "")}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  const walk = (node) => {
    for (const child of Array.from(node.children)) {
      const tag = child.tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) { child.replaceWith(...Array.from(child.childNodes)); continue; }
      for (const attr of Array.from(child.attributes)) {
        const n = attr.name;
        const bad = !ALLOWED_ATTRS.has(n) && !(n.startsWith("data-")) || n.toLowerCase().startsWith("on") || (/href$/i.test(n) && /^\s*javascript:/i.test(attr.value)) || (n === "style" && /url\(|expression/i.test(attr.value));
        if (bad) child.removeAttribute(n);
      }
      if (tag === "a") { child.setAttribute("rel", "noopener"); if (!child.getAttribute("target")) child.setAttribute("target", "_blank"); }
      walk(child);
    }
  };
  walk(root);
  const frag = document.createDocumentFragment();
  for (const n of Array.from(root.childNodes)) frag.appendChild(document.adoptNode(n));
  return frag;
}

async function api(path, init) {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}
const q = () => `?world=${encodeURIComponent(currentWorld())}`;
const post = (path, payload) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ world: currentWorld(), ...payload }) });

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "testid") n.setAttribute("data-testid", v);
    else if (k === "text") n.textContent = v;
    else n.setAttribute(k, v);
  }
  n.append(...kids);
  return n;
}

let renderToken = 0;

export async function renderBriefingSurface() {
  const token = ++renderToken;
  const main = document.getElementById("shell-main");
  const root = el("div", { class: "briefing-surface", testid: "briefing-surface-root" });
  main.innerHTML = "";
  main.appendChild(root);

  const world = currentWorld();
  let cards = [];
  try { ({ cards } = await api(`/api/session-planner/briefing${q()}`)); } catch { cards = []; }
  if (token !== renderToken) return;

  const head = el("div", { class: "briefing-head" });
  head.append(
    el("div", { class: "briefing-eyebrow", text: "Briefing" }),
    el("h2", { class: "briefing-title", text: world || "" }),
    el("p", { class: "briefing-sub", text: "The front matter — premise, clock, cast, party, maps, table rules. Everything you want in front of you before the first scene." })
  );
  const addBtn = el("button", { type: "button", class: "btn briefing-add-btn", testid: "briefing-add-btn", text: "+ Add card" });
  head.appendChild(addBtn);
  root.appendChild(head);

  const grid = el("div", { class: "briefing-grid", testid: "briefing-grid" });
  root.appendChild(grid);

  const refresh = () => renderBriefingSurface();

  if (!cards.length) {
    grid.appendChild(el("div", { class: "briefing-empty", testid: "briefing-empty", text: "No briefing cards yet. Add one, or have an agent write them from your campaign notes (wf_upsert_briefing_card)." }));
  }

  cards.forEach((card, idx) => {
    const c = el("article", { class: `briefing-card${card.span === 2 ? " briefing-card--span2" : ""}`, testid: "briefing-card" });
    c.setAttribute("data-card-id", card.id);
    c.setAttribute("data-span", String(card.span));

    const eyebrow = makeClickToEditField({
      tag: "div", className: "briefing-card-eyebrow", testid: "briefing-card-eyebrow", inputTestid: "briefing-card-eyebrow-input",
      value: card.eyebrow ?? "", placeholder: "Eyebrow…", emptyText: "+ eyebrow",
      save: (v) => post(`/api/session-planner/briefing/${encodeURIComponent(card.id)}`, { eyebrow: v })
    });
    const title = makeClickToEditField({
      tag: "h3", className: "briefing-card-title", testid: "briefing-card-title", inputTestid: "briefing-card-title-input",
      value: card.title, placeholder: "Title…", emptyText: "(untitled)",
      save: (v) => post(`/api/session-planner/briefing/${encodeURIComponent(card.id)}`, { title: v })
    });
    c.append(eyebrow.el, title.el);

    // Body: rendered (sanitised) at rest; click swaps to a textarea holding the raw HTML.
    const bodyHost = el("div", { class: "briefing-card-body", testid: "briefing-card-body" });
    let editing = false;
    const paintBody = () => {
      bodyHost.innerHTML = "";
      if (card.body && card.body.trim()) bodyHost.appendChild(sanitizeBody(card.body));
      else bodyHost.appendChild(el("span", { class: "briefing-card-empty", text: "+ body (HTML or plain text)" }));
    };
    paintBody();
    bodyHost.addEventListener("click", (e) => {
      if (editing || e.target.closest("a")) return;
      editing = true;
      const ta = el("textarea", { class: "briefing-card-body-input", testid: "briefing-card-body-input" });
      ta.value = card.body || "";
      ta.rows = Math.min(24, Math.max(6, (card.body || "").split("\n").length + 2));
      bodyHost.innerHTML = "";
      bodyHost.appendChild(ta);
      ta.focus();
      ta.addEventListener("blur", async () => {
        const v = ta.value;
        editing = false;
        if (v !== card.body) {
          try { ({ card: { body: card.body } } = await post(`/api/session-planner/briefing/${encodeURIComponent(card.id)}`, { body: v })); }
          catch { /* keep local */ card.body = v; }
        }
        paintBody();
      });
    });
    c.appendChild(bodyHost);

    const tools = el("div", { class: "briefing-card-tools" });
    const up = el("button", { type: "button", class: "icon-btn", testid: "briefing-card-up", title: "Move up", text: "↑" });
    const down = el("button", { type: "button", class: "icon-btn", testid: "briefing-card-down", title: "Move down", text: "↓" });
    up.disabled = idx === 0; down.disabled = idx === cards.length - 1;
    const move = async (delta) => {
      const ids = cards.map((x) => x.id);
      const [id] = ids.splice(idx, 1);
      ids.splice(idx + delta, 0, id);
      await post("/api/session-planner/briefing/reorder", { cardIds: ids });
      refresh();
    };
    up.addEventListener("click", () => move(-1));
    down.addEventListener("click", () => move(1));
    const span = el("button", { type: "button", class: "icon-btn briefing-card-span", testid: "briefing-card-span", title: card.span === 2 ? "Make one column" : "Make full width", text: card.span === 2 ? "⇤" : "⇔" });
    span.addEventListener("click", async () => { await post(`/api/session-planner/briefing/${encodeURIComponent(card.id)}`, { span: card.span === 2 ? 1 : 2 }); refresh(); });
    const del = el("button", { type: "button", class: "icon-btn briefing-card-delete", testid: "briefing-card-delete", title: "Delete card", text: "✕" });
    del.addEventListener("click", async () => {
      if (!window.confirm(`Delete the card “${card.title}”?`)) return;
      await api(`/api/session-planner/briefing/${encodeURIComponent(card.id)}${q()}`, { method: "DELETE" });
      refresh();
    });
    tools.append(up, down, span, del);
    c.appendChild(tools);
    grid.appendChild(c);
  });

  addBtn.addEventListener("click", async () => {
    addBtn.disabled = true;
    try { await post("/api/session-planner/briefing", { title: "New card", eyebrow: null, body: "", span: 1 }); refresh(); }
    finally { addBtn.disabled = false; }
  });
}
