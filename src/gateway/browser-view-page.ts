// ---------------------------------------------------------------------------
// Gateway — self-contained live browser viewer page
//
// Canvas + JPEG frames over /ws/browser/:id, with Take control / Release /
// Done. Input is captured only while the state is human-control and mapped
// from canvas CSS pixels onto the fixed 1280x800 viewport.
// ---------------------------------------------------------------------------

import { VIEWPORT } from "../browser/launch.js";

function jsString(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const STYLE = `
*{box-sizing:border-box}
body{margin:0;background:#111214;color:#dbdee1;font:14px/1.4 system-ui,sans-serif}
header{display:flex;gap:10px;align-items:center;padding:8px 12px;background:#1e1f22;flex-wrap:wrap}
#dot{width:10px;height:10px;border-radius:50%;background:#80848e}
#dot.live{background:#23a55a}#dot.down{background:#f23f43}
#state{font-weight:600}
#url{flex:1;min-width:200px;color:#949ba4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
button{background:#4e5058;color:#fff;border:0;border-radius:4px;padding:6px 12px;cursor:pointer;font:inherit}
button.primary{background:#5865f2}button.ok{background:#248046}
button:disabled{opacity:.4;cursor:default}
main{padding:12px;display:flex;justify-content:center}
#wrap{position:relative;width:100%;max-width:${VIEWPORT.width}px}
canvas{width:100%;height:auto;display:block;background:#000;outline:none;border:2px solid transparent;border-radius:4px}
canvas.control{border-color:#eb459e;cursor:crosshair}
#note{text-align:center;color:#949ba4;padding:0 12px 12px}
`;

const SCRIPT = `
(function () {
  var W = ${VIEWPORT.width}, H = ${VIEWPORT.height};
  var token = new URLSearchParams(location.search).get('t') || '';
  var cv = document.getElementById('cv'), ctx = cv.getContext('2d');
  var dot = document.getElementById('dot'), stateEl = document.getElementById('state');
  var urlEl = document.getElementById('url'), note = document.getElementById('note');
  var bTake = document.getElementById('take'), bRelease = document.getElementById('release'), bDone = document.getElementById('done');
  var ws = null, state = 'connecting', retry = 0, seq = 0, drawn = 0, lastMove = 0;
  var LABEL = { running: 'Agent driving', paused: 'Paused', 'needs-human': 'Needs you', 'human-control': 'Human in control', closed: 'Closed' };

  function inControl() { return state === 'human-control'; }
  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  function setConn(kind, text) { dot.className = kind; if (text) note.textContent = text; }

  function applyState(m) {
    state = m.state;
    stateEl.textContent = LABEL[state] || state;
    urlEl.textContent = (m.title ? m.title + ' — ' : '') + (m.url || '');
    bTake.disabled = state === 'human-control' || state === 'closed';
    bRelease.disabled = state !== 'human-control';
    bDone.disabled = !(state === 'needs-human' || state === 'human-control');
    cv.classList.toggle('control', inControl());
    if (state === 'closed') setConn('down', 'The browser is closed.');
    else if (inControl()) note.textContent = 'You have control: click, type and scroll on the page. Press Done to hand back to the agent.';
    else if (state === 'needs-human') note.textContent = 'The agent is waiting for you: ' + (m.reason || '') + ' Take control, then press Done.';
    else note.textContent = 'Watching live. Take control to click and type.';
  }

  function draw(buf) {
    var mine = ++seq;
    createImageBitmap(new Blob([buf], { type: 'image/jpeg' })).then(function (bmp) {
      if (mine < drawn) { bmp.close(); return; }
      drawn = mine;
      ctx.drawImage(bmp, 0, 0, W, H);
      bmp.close();
    }).catch(function () {});
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var id = location.pathname.split('/').pop();
    ws = new WebSocket(proto + location.host + '/ws/browser/' + encodeURIComponent(id) + '?t=' + encodeURIComponent(token));
    ws.binaryType = 'arraybuffer';
    ws.onopen = function () { retry = 0; setConn('live'); };
    ws.onmessage = function (ev) {
      if (typeof ev.data === 'string') {
        try { var m = JSON.parse(ev.data); if (m.t === 'state') applyState(m); } catch (e) {}
      } else draw(ev.data);
    };
    ws.onclose = function () {
      if (state === 'closed') return;
      setConn('down', 'Disconnected — reconnecting…');
      if (retry < 6) { retry++; setTimeout(connect, 1000 * retry); }
      else note.textContent = 'Disconnected. The link may have expired; ask for a new Live view in Discord.';
    };
  }

  function pt(e) {
    var r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height };
  }
  function mods(e) { return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0); }
  var BTN = ['left', 'middle', 'right'];

  function mouse(type, e, extra) {
    if (!inControl()) return;
    var p = pt(e), m = { t: 'mouse', type: type, x: p.x, y: p.y, button: BTN[e.button] || 'none', buttons: e.buttons, clickCount: e.detail || 1, modifiers: mods(e) };
    if (extra) for (var k in extra) m[k] = extra[k];
    send(m);
  }

  cv.addEventListener('mousedown', function (e) { cv.focus(); if (inControl()) { e.preventDefault(); mouse('mousePressed', e); } });
  cv.addEventListener('mouseup', function (e) { if (inControl()) { e.preventDefault(); mouse('mouseReleased', e); } });
  cv.addEventListener('mousemove', function (e) {
    var now = Date.now();
    if (now - lastMove < 33) return;
    lastMove = now;
    mouse('mouseMoved', e, { button: e.buttons & 1 ? 'left' : 'none' });
  });
  cv.addEventListener('wheel', function (e) {
    if (!inControl()) return;
    e.preventDefault();
    mouse('mouseWheel', e, { button: 'none', deltaX: e.deltaX, deltaY: e.deltaY });
  }, { passive: false });
  cv.addEventListener('contextmenu', function (e) { if (inControl()) e.preventDefault(); });

  function key(type, e) {
    if (!inControl()) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) return;
    e.preventDefault();
    var text = !e.ctrlKey && !e.metaKey && e.key.length === 1 ? e.key : (e.key === 'Enter' ? '\\r' : undefined);
    send({ t: 'key', type: type, key: e.key, code: e.code, keyCode: e.keyCode, text: type === 'keyDown' ? text : undefined, modifiers: mods(e) });
  }
  cv.addEventListener('keydown', function (e) { key('keyDown', e); });
  cv.addEventListener('keyup', function (e) { key('keyUp', e); });
  cv.addEventListener('paste', function (e) {
    if (!inControl()) return;
    var text = (e.clipboardData || window.clipboardData).getData('text');
    if (text) { e.preventDefault(); send({ t: 'text', text: text }); }
  });

  bTake.onclick = function () { send({ t: 'take' }); cv.focus(); };
  bRelease.onclick = function () { send({ t: 'release' }); };
  bDone.onclick = function () { send({ t: 'done' }); };

  connect();
})();
`;

export function renderViewerPage(browserId: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>DiscordClaw browser ${browserId}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <span id="dot"></span><span id="state">Connecting…</span><span id="url"></span>
  <button id="take" class="primary" disabled>Take control</button>
  <button id="release" disabled>Release</button>
  <button id="done" class="ok" disabled>Done</button>
</header>
<main><div id="wrap"><canvas id="cv" width="${VIEWPORT.width}" height="${VIEWPORT.height}" tabindex="0"></canvas></div></main>
<div id="note">Connecting…</div>
<script>window.__BROWSER_ID__ = ${jsString(browserId)};</script>
<script>${SCRIPT}</script>
</body>
</html>`;
}

export function renderViewerError(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Browser viewer</title><style>${STYLE}</style></head><body><main><p>${message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")}</p></main></body></html>`;
}
