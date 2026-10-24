// The control room page. One file, no build step, no dependencies: it is served by the harness itself.
//
// Names and URLs shown here come from the world's data, which an AI tester can write to, so every value
// is set with textContent and never parsed as HTML. The title is the product's own, escaped here.

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const page = (title: string): string => /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Swarmbox</title>
<style>
  :root {
    --bg: #f6f5f2; --panel: #ffffff; --ink: #1c1b19; --muted: #6b6860; --line: #e2dfd8;
    --agent: #2f6f4f; --agent-bg: #e3f0e8; --person: #9a4a12; --person-bg: #fbeadb;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #141413; --panel: #1d1c1a; --ink: #ece9e2; --muted: #9a968c; --line: #2e2d2a;
      --agent: #7fc8a1; --agent-bg: #1d3328; --person: #f0a26a; --person-bg: #3a2516;
      color-scheme: dark;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  header { display: flex; align-items: baseline; gap: 16px; padding: 18px 24px 8px; flex-wrap: wrap; }
  h1 { font-size: 17px; margin: 0; font-weight: 650; letter-spacing: -0.01em; }
  #worlds { color: var(--muted); font-size: 13px; }
  #worlds a { color: inherit; }
  main { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 520px), 1fr)); gap: 16px; padding: 12px 24px 32px; }
  .tile { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; display: flex; flex-direction: column; }
  .tile.person { border-color: var(--person); box-shadow: 0 0 0 1px var(--person); }
  .bar { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
  .who { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .where { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
  .badge { font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
  .badge.agent { color: var(--agent); background: var(--agent-bg); }
  .badge.person { color: var(--person); background: var(--person-bg); }
  button { font: inherit; font-size: 12px; font-weight: 600; padding: 5px 10px; border-radius: 6px; cursor: pointer;
    border: 1px solid var(--line); background: var(--bg); color: var(--ink); white-space: nowrap; }
  button:hover { border-color: var(--muted); }
  .view { aspect-ratio: 16 / 10; background: var(--bg); display: grid; place-items: center; }
  .view img { width: 100%; height: 100%; object-fit: contain; display: block; }
  .view:focus { outline: none; }
  .tile.person .view { cursor: crosshair; }
  .tile.person .view:focus { box-shadow: inset 0 0 0 2px var(--person); }
  .hint { padding: 6px 12px; font-size: 12px; color: var(--person); border-top: 1px solid var(--line); }
  .url { padding: 6px 12px; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted);
    border-top: 1px solid var(--line); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .empty { grid-column: 1 / -1; color: var(--muted); padding: 48px 0; text-align: center; }
  .empty code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--ink); }
</style>
</head>
<body>
<header><h1>${esc(title)} · Swarmbox</h1><div id="worlds"></div></header>
<main id="tiles"></main>
<script>
  const tiles = new Map();
  const main = document.getElementById('tiles');
  const worldsEl = document.getElementById('worlds');

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  async function post(path, body) {
    try {
      await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch {}
  }

  // Where on the screen a point on the picture is, as fractions: the picture is letterboxed in the tile
  // (object-fit: contain), so the margins are not part of the screen.
  function pointOn(img, e) {
    const r = img.getBoundingClientRect();
    const iw = img.naturalWidth || 16, ih = img.naturalHeight || 10;
    const scale = Math.min(r.width / iw, r.height / ih);
    const w = iw * scale, h = ih * scale;
    const left = r.left + (r.width - w) / 2, top = r.top + (r.height - h) / 2;
    const x = (e.clientX - left) / w, y = (e.clientY - top) / h;
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
  }

  const KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

  function tile(s) {
    const root = el('section', 'tile');
    const bar = el('div', 'bar');
    const who = el('div', 'who');
    const where = el('div', 'where');
    const badge = el('span', 'badge');
    const btn = el('button');
    bar.append(who, where, badge, btn);
    const view = el('div', 'view');
    view.tabIndex = 0;
    const img = el('img');
    img.alt = 'Live view of ' + s.person;
    view.append(img);
    const hint = el('div', 'hint', 'You have this screen: click, scroll and type here. Hand back when done.');
    const url = el('div', 'url');
    root.append(bar, view, hint, url);
    const t = { root, who, where, badge, btn, url, img, view, hint, seq: -1, loading: false, objectUrl: null, id: s.id };
    const mine = () => root.dataset.controller === 'person';
    btn.addEventListener('click', async () => {
      const to = mine() ? 'agent' : 'person';
      await post('/screens/' + s.id + '/control', { controller: to });
      await refresh();
      if (to === 'person') view.focus();
    });
    view.addEventListener('click', (e) => {
      if (!mine()) return;
      view.focus();
      const p = pointOn(img, e);
      if (p) post('/screens/' + s.id + '/input', { type: 'click', x: p.x, y: p.y }).then(() => refresh());
    });
    let wheel = 0, wheelAt = null, wheelTimer = null;
    view.addEventListener('wheel', (e) => {
      if (!mine()) return;
      e.preventDefault();
      wheel += e.deltaY;
      wheelAt = pointOn(img, e) || { x: 0.5, y: 0.5 };
      if (!wheelTimer) wheelTimer = setTimeout(() => {
        const dy = wheel;
        wheel = 0; wheelTimer = null;
        post('/screens/' + s.id + '/input', { type: 'wheel', x: wheelAt.x, y: wheelAt.y, dy });
      }, 80);
    }, { passive: false });
    view.addEventListener('keydown', (e) => {
      if (!mine() || e.metaKey || e.ctrlKey) return;
      if (e.key.length === 1) {
        e.preventDefault();
        post('/screens/' + s.id + '/input', { type: 'text', text: e.key });
      } else if (KEYS.has(e.key)) {
        e.preventDefault();
        post('/screens/' + s.id + '/input', { type: 'key', key: e.key });
      }
    });
    return t;
  }

  // The tile's picture, fetched only when the screen has a new frame.
  async function picture(t, seq) {
    if (t.loading || seq === t.seq) return;
    t.loading = true;
    try {
      const r = await fetch('/screens/' + t.id + '/frame', { cache: 'no-store' });
      if (r.status === 200) {
        const next = URL.createObjectURL(await r.blob());
        const prev = t.objectUrl;
        t.img.onload = () => { if (prev) URL.revokeObjectURL(prev); };
        t.img.src = next;
        t.objectUrl = next;
        t.seq = Number(r.headers.get('x-frame-seq') || seq);
      }
    } catch {} finally {
      t.loading = false;
    }
  }

  function update(t, s) {
    t.root.dataset.controller = s.controller;
    t.root.classList.toggle('person', s.controller === 'person');
    t.hint.hidden = s.controller !== 'person';
    t.who.textContent = s.person;
    t.where.textContent = s.tenant + ' · ' + s.world + ' · ' + s.id;
    t.badge.className = 'badge ' + s.controller;
    t.badge.textContent = s.controller === 'person' ? 'You have it' : 'Agent driving';
    t.btn.textContent = s.controller === 'person' ? 'Hand back' : 'Take over';
    t.url.textContent = s.url;
    picture(t, s.frameSeq);
  }

  async function refresh() {
    let state;
    try { state = await (await fetch('/state', { cache: 'no-store' })).json(); } catch { return; }
    worldsEl.replaceChildren();
    for (const w of state.worlds) {
      for (const c of w.tenants) {
        const a = el('a', null, c.slug);
        a.href = c.origin;
        worldsEl.append(w.id + ' ', a, '  ');
      }
    }
    const seen = new Set();
    for (const s of state.screens) {
      seen.add(s.id);
      let t = tiles.get(s.id);
      if (!t) { t = tile(s); tiles.set(s.id, t); main.append(t.root); }
      update(t, s);
    }
    for (const [id, t] of tiles) if (!seen.has(id)) { t.root.remove(); if (t.objectUrl) URL.revokeObjectURL(t.objectUrl); tiles.delete(id); }
    const empty = main.querySelector('.empty');
    if (state.screens.length === 0 && !empty) {
      const e = el('div', 'empty');
      e.append('No screens open. From Claude: ', el('code', null, 'world_create'), ', then ', el('code', null, 'screen_open'), '.');
      main.append(e);
    } else if (state.screens.length && empty) empty.remove();
  }

  // Short, frequent requests: a tile's picture is fetched only when its screen has a new frame.
  refresh();
  setInterval(refresh, 300);
</script>
</body>
</html>
`;
