// ---------------------------------------------------------------------------
// Browser — in-page scripts and input parsing (pure)
//
// The snapshot is the agent's primary observation: a compact outline of
// headings and interactive elements, each tagged with a numbered
// `data-dc-ref` attribute the agent clicks/types by. Plain JS strings (no
// template literals inside) because the project lib has no DOM types.
// ---------------------------------------------------------------------------

import { VIEWPORT } from "./launch.js";

export const MAX_SNAPSHOT_REFS = 150;
export const MAX_SNAPSHOT_CHARS = 12_000;

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  "[role=button]",
  "[role=link]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=tab]",
  "[role=menuitem]",
  "[role=option]",
  "[role=textbox]",
  "[role=combobox]",
  "[role=switch]",
  "[contenteditable=true]",
  '[contenteditable=""]',
  "[onclick]",
].join(",");

export const SNAPSHOT_SCRIPT = `(() => {
  var MAX = ${MAX_SNAPSHOT_REFS};
  var SEL = ${JSON.stringify(INTERACTIVE_SELECTOR)};
  document.querySelectorAll('[data-dc-ref]').forEach(function (e) { e.removeAttribute('data-dc-ref'); });
  function clean(s, n) { return String(s || '').replace(/\\s+/g, ' ').trim().slice(0, n); }
  function visible(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    var s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  }
  function valueOf(el) {
    if (el.type === 'password') return el.value ? '********' : '';
    return el.value;
  }
  function nameOf(el) {
    return clean(el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') ||
      el.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || '', 80);
  }
  var n = 0, lines = [];
  var all = document.querySelectorAll('h1,h2,h3,' + SEL);
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (!visible(el)) continue;
    var tag = el.tagName.toLowerCase();
    if (/^h[1-3]$/.test(tag)) {
      var h = clean(el.innerText, 120);
      if (h) lines.push('#'.repeat(Number(tag[1])) + ' ' + h);
      continue;
    }
    if (n >= MAX) continue;
    n++;
    el.setAttribute('data-dc-ref', String(n));
    var kind = el.getAttribute('role') || tag;
    if (tag === 'input') kind = 'input[' + (el.type || 'text') + ']';
    var extra = '';
    if (tag === 'input' || tag === 'textarea') {
      if (el.type === 'checkbox' || el.type === 'radio') { if (el.checked) extra += ' (checked)'; }
      else if (el.value) extra += ' value="' + clean(valueOf(el), 40) + '"';
    }
    if (tag === 'select' && el.options && el.selectedIndex >= 0) extra += ' value="' + clean(el.options[el.selectedIndex].text, 40) + '"';
    if (tag === 'a') {
      var href = el.getAttribute('href') || '';
      if (href && href.indexOf('javascript:') !== 0) extra += ' -> ' + clean(href, 80);
    }
    if (el.disabled) extra += ' (disabled)';
    lines.push('[' + n + '] ' + kind + ' "' + nameOf(el) + '"' + extra);
  }
  return JSON.stringify({
    url: location.href,
    title: document.title,
    lines: lines,
    truncated: n >= MAX,
    text: clean(document.body ? document.body.innerText : '', 1500),
    scrollY: Math.round(window.scrollY),
    scrollHeight: document.documentElement ? document.documentElement.scrollHeight : 0
  });
})()`;

export interface SnapshotData {
  url: string;
  title: string;
  lines: string[];
  truncated: boolean;
  text: string;
  scrollY: number;
  scrollHeight: number;
}

/** The text the agent sees for a snapshot. */
export function formatSnapshot(data: SnapshotData): string {
  const head = [
    `Page: ${data.title || "(untitled)"}`,
    `URL: ${data.url}`,
    `Scroll: y=${data.scrollY} of ${data.scrollHeight}px (viewport ${VIEWPORT.width}x${VIEWPORT.height})`,
    "",
    `Visible text (first 1500 chars): ${data.text || "(none)"}`,
    "",
    "Elements — act on them with browser_click / browser_type by ref:",
  ];
  const tail = data.truncated
    ? [`(stopped at ${MAX_SNAPSHOT_REFS} refs; scroll or narrow down to see more)`]
    : [];
  let out = [...head, ...(data.lines.length ? data.lines : ["(no interactive elements)"]), ...tail].join("\n");
  if (out.length > MAX_SNAPSHOT_CHARS) out = `${out.slice(0, MAX_SNAPSHOT_CHARS - 20)}\n…(truncated)`;
  return out;
}

/** Scroll a ref into view and return its centre in viewport CSS pixels. */
export function refCenterScript(ref: number): string {
  return `(() => {
  var el = document.querySelector('[data-dc-ref="${ref}"]');
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  var r = el.getBoundingClientRect();
  return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
})()`;
}

/** Select the focused field's content so the next insertText replaces it. */
export const SELECT_FOCUSED_SCRIPT = `(() => {
  var el = document.activeElement;
  if (!el) return false;
  if (typeof el.select === 'function') { el.select(); return true; }
  if (el.isContentEditable) { document.execCommand('selectAll'); return true; }
  return false;
})()`;

export const META_SCRIPT = "JSON.stringify([location.href, document.title])";

/** Accept bare hosts ("example.com"); only http(s) and about:blank are allowed. */
export function normalizeBrowserUrl(raw: string): string {
  const input = String(raw ?? "").trim();
  if (!input) throw new Error("url is required");
  if (input === "about:blank") return input;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Not a valid URL: ${input}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http(s) URLs are allowed (got ${url.protocol})`);
  }
  return url.toString();
}

// ---------------------------------------------------------------------------
// Viewer input
// ---------------------------------------------------------------------------

export type HumanInput =
  | {
      t: "mouse";
      type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
      x: number;
      y: number;
      button: "left" | "middle" | "right" | "none";
      buttons: number;
      clickCount: number;
      deltaX: number;
      deltaY: number;
      modifiers: number;
    }
  | {
      t: "key";
      type: "keyDown" | "keyUp";
      key: string;
      code: string;
      keyCode: number;
      text?: string;
      modifiers: number;
    }
  | { t: "text"; text: string };

const MOUSE_TYPES = new Set(["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"]);
const BUTTONS = new Set(["left", "middle", "right", "none"]);

function finite(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Validate a viewer message into a CDP-ready input, or null. */
export function parseHumanInput(raw: unknown): HumanInput | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const modifiers = clamp(Math.trunc(finite(m.modifiers)), 0, 15);
  if (m.t === "mouse") {
    if (typeof m.type !== "string" || !MOUSE_TYPES.has(m.type)) return null;
    const button = typeof m.button === "string" && BUTTONS.has(m.button) ? m.button : "none";
    return {
      t: "mouse",
      type: m.type as Extract<HumanInput, { t: "mouse" }>["type"],
      x: clamp(finite(m.x), 0, VIEWPORT.width),
      y: clamp(finite(m.y), 0, VIEWPORT.height),
      button: button as Extract<HumanInput, { t: "mouse" }>["button"],
      buttons: clamp(Math.trunc(finite(m.buttons)), 0, 31),
      clickCount: clamp(Math.trunc(finite(m.clickCount, 1)), 0, 3),
      deltaX: clamp(finite(m.deltaX), -5000, 5000),
      deltaY: clamp(finite(m.deltaY), -5000, 5000),
      modifiers,
    };
  }
  if (m.t === "key") {
    if (m.type !== "keyDown" && m.type !== "keyUp") return null;
    if (typeof m.key !== "string" || m.key.length === 0 || m.key.length > 32) return null;
    const text = typeof m.text === "string" && m.text.length > 0 && m.text.length <= 4 ? m.text : undefined;
    return {
      t: "key",
      type: m.type,
      key: m.key,
      code: typeof m.code === "string" ? m.code.slice(0, 32) : "",
      keyCode: clamp(Math.trunc(finite(m.keyCode)), 0, 255),
      ...(text ? { text } : {}),
      modifiers,
    };
  }
  if (m.t === "text") {
    if (typeof m.text !== "string" || m.text.length === 0) return null;
    return { t: "text", text: m.text.slice(0, 2000) };
  }
  return null;
}
