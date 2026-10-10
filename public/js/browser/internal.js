// Vortex Browser — built-in vortex:// pages. They are plain HTML rendered by the Vortex Engine itself.

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const CSS = `
html{background:#14110b}
body{margin:0;padding:28px 20px 40px;color:#f4efe4;font-family:system-ui,sans-serif;font-size:15px;line-height:1.55}
.wrap{max-width:680px;margin:0 auto}
h1{font-size:34px;letter-spacing:.04em;margin:18px 0 4px;text-align:center}
h1 b{color:#f5b301}
h2{font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:#a99f8b;margin:28px 0 10px}
p{margin:8px 0}
.sub{text-align:center;color:#a99f8b;margin:0 0 20px}
a{color:#f5b301;text-decoration:none}
form{display:flex;gap:8px;margin:18px auto}
input{flex:1;padding:12px 16px;border:1px solid #5a4a22;border-radius:999px;background:#1f1a10;color:#f4efe4;font-size:16px}
button{padding:0 22px;border:0;border-radius:999px;background:#f5b301;color:#1b1400;font-weight:bold;font-size:15px}
.tiles{display:flex;flex-wrap:wrap;gap:10px}
.tile{display:block;width:150px;padding:12px;border:1px solid #3a3020;border-radius:12px;background:#1f1a10;color:#f4efe4;font-size:13px}
.tile b{display:block;color:#f4efe4;font-size:14px}
.tile span{color:#a99f8b;font-size:12px}
.item{margin:0 0 16px}
.item a{font-size:17px}
.url{color:#7fbf7f;font-size:12px}
.snip{color:#cfc6b2;font-size:13px}
.muted{color:#a99f8b}
.note{margin-top:30px;padding:12px 14px;border:1px solid #3a3020;border-radius:12px;background:#1a160d;color:#a99f8b;font-size:12px}
.answer{margin:4px 0 24px;padding:16px 18px;border:1px solid #5a4a22;border-radius:14px;background:#1f1a10}
.answer .label{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#a99f8b}
.answer .big{font-size:30px;font-weight:bold;color:#f5b301;margin:4px 0}
.answer .title{font-size:20px;font-weight:bold;margin:4px 0 2px}
.answer .desc{color:#a99f8b;font-size:13px;margin:0 0 6px}
.answer .body{color:#e7e0d0}
.answer .src{font-size:12px;margin-top:8px}
.tag{font-size:11px;color:#8a7f69}
.err{margin:40px auto;max-width:520px;text-align:center}
.err .big{font-size:56px}
code{font-family:monospace;color:#f5b301}
pre{white-space:pre-wrap;word-break:break-all;font-family:monospace;font-size:13px;color:#e7e0d0}
ul{padding-left:22px}
li{margin:4px 0}
`;

const shell = (title, body) => `<!doctype html><html><head><title>${esc(title)}</title><style>${CSS}</style></head><body><div class="wrap">${body}</div></body></html>`;

const host = (u) => {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; }
};

export function home(user, store) {
  const tiles = store.bookmarks.slice(0, 12).map((b) => `<a class="tile" href="${esc(b.url)}"><b>${esc((b.title || host(b.url)).slice(0, 22))}</b><span>${esc(host(b.url))}</span></a>`).join('');
  const recent = store.history.slice(0, 6).map((h) => `<div class="item"><a href="${esc(h.url)}">${esc((h.title || h.url).slice(0, 70))}</a><div class="url">${esc(host(h.url))}</div></div>`).join('');
  return shell('Start', `
    <h1>🐝 Vortex <b>Browser</b></h1>
    <p class="sub">Hello, ${esc(user)}. Search the web, ask a question, or type an address.</p>
    <form data-vortex-action="vortex://search" method="get"><input name="q" placeholder="Search anything — weather in Paris, define hive, 12*(3+4)…"><button>Search</button></form>
    ${tiles ? `<h2>Bookmarks</h2><div class="tiles">${tiles}</div>` : '<h2>Bookmarks</h2><p class="muted">Nothing here yet. Press ☆ in the toolbar to bookmark a page.</p>'}
    ${recent ? `<h2>Recently visited</h2>${recent}<p><a href="vortex://history">All history →</a></p>` : ''}
    <div class="note">Vortex Browser is built from scratch for Vortex OS: its own HTML parser, CSS engine, layout and renderer. Vortex Search asks DuckDuckGo, Bing and Wikipedia at once and ranks the answers. Every page is fetched by the hive proxy, and there is no JavaScript. <a href="vortex://about">What works →</a></div>`);
}

function hostPath(u) {
  try {
    const x = new URL(u);
    return (x.hostname.replace(/^www\./, '') + decodeURIComponent(x.pathname).replace(/\/$/, '')).slice(0, 80);
  } catch {
    return u.slice(0, 80);
  }
}

function answerCard(a) {
  if (!a) return '';
  const label = { weather: 'Live weather', time: 'Local time', define: 'Definition', wiki: 'From Wikipedia', snippet: 'Top answer', math: 'Calculator' }[a.kind] || 'Answer';
  return `<div class="answer"><div class="label">${esc(label)}</div>
    ${a.big ? `<div class="big">${esc(a.big)}</div>` : ''}
    ${a.title && a.kind !== 'math' ? `<div class="title">${esc(a.title)}</div>` : ''}
    ${a.description ? `<p class="desc">${esc(a.description)}</p>` : ''}
    ${a.text ? `<div class="body">${esc(a.text)}</div>` : ''}
    ${a.url ? `<div class="src"><a href="${esc(a.url)}">${esc(a.source || hostPath(a.url))} → ${esc(hostPath(a.url))}</a></div>` : a.source ? `<div class="src tag">${esc(a.source)}</div>` : ''}
  </div>`;
}

/** Search results page. `web` comes from the hive's search service; `math` is a local calculation. */
export function results(q, store, web, math) {
  const local = store.search(q).slice(0, 4);
  const list = (web?.results || []).map((r) => `<div class="item"><a href="${esc(r.url)}">${esc(r.title || r.url)}</a><div class="url">${esc(hostPath(r.url))}</div>${r.snippet ? `<div class="snip">${esc(r.snippet)}</div>` : ''}<div class="tag">${esc((r.engines || [r.source]).join(' · '))}</div></div>`).join('');
  const localList = local.map((h) => `<div class="item"><a href="${esc(h.url)}">${esc(h.title || h.url)}</a><div class="url">${esc(hostPath(h.url))}</div></div>`).join('');
  const okSources = (web?.sources || []).filter((s) => s.ok).map((s) => s.name);
  const failed = (web?.sources || []).filter((s) => !s.ok).map((s) => `${s.name} (${s.error || 'failed'})`);
  let status = '';
  if (web?.error) status = `<p class="muted">Web search is unavailable right now: ${esc(web.error)}</p>`;
  else if (web && !web.results.length) status = `<p class="muted">No web results. ${failed.length ? `Search sources could not be reached: ${esc(failed.join(', '))}.` : 'Try different words.'}</p>`;
  return shell(`${q} — Vortex Search`, `
    <h1>🐝 Vortex <b>Search</b></h1>
    <form data-vortex-action="vortex://search" method="get"><input name="q" value="${esc(q)}"><button>Search</button></form>
    ${answerCard(math || web?.answer)}
    ${status}
    ${list}
    ${localList ? `<h2>From your history</h2>${localList}` : ''}
    ${okSources.length ? `<div class="note">Results from ${esc(okSources.join(', '))}, merged and ranked by Vortex Search. Every result page opens in Vortex Browser through the hive proxy.${failed.length ? ` Unavailable this time: ${esc(failed.join(', '))}.` : ''}</div>` : ''}`);
}

export function history(store) {
  const rows = store.history.map((h) => `<div class="item"><a href="${esc(h.url)}">${esc(h.title || h.url)}</a><div class="url">${esc(h.url.slice(0, 90))}</div><div class="muted" style="font-size:12px">${esc(new Date(h.ts).toLocaleString())}</div></div>`).join('');
  return shell('History', `<h1>History</h1>${rows || '<p class="sub">No history yet.</p>'}${rows ? '<p><a href="vortex://clear-history">Clear all history</a></p>' : ''}<p><a href="vortex://home">← Start page</a></p>`);
}

export function bookmarks(store) {
  const rows = store.bookmarks.map((h) => `<div class="item"><a href="${esc(h.url)}">${esc(h.title || h.url)}</a><div class="url">${esc(h.url.slice(0, 90))}</div></div>`).join('');
  return shell('Bookmarks', `<h1>Bookmarks</h1>${rows || '<p class="sub">No bookmarks yet. Press ☆ in the toolbar.</p>'}<p><a href="vortex://home">← Start page</a></p>`);
}

export function about(version) {
  return shell('About Vortex Browser', `
    <h1>🐝 Vortex <b>Browser</b></h1>
    <p class="sub">Part of Vortex OS ${esc(version || '')}</p>
    <h2>Built from scratch</h2>
    <p>No Chrome, no WebKit, no iframe. Every stage is code in this project:</p>
    <ul>
      <li><b>Network</b> — the hive proxy fetches pages, blocks private networks and strips scripts</li>
      <li><b>HTML</b> — our own tokenizer and tree builder</li>
      <li><b>CSS</b> — selectors, specificity, cascade, <code>var()</code>, <code>calc()</code>, media queries</li>
      <li><b>Layout</b> — block flow with margin collapsing, inline lines, tables, flexbox, grid</li>
      <li><b>Paint</b> — drawn to a canvas, with scrolling, zoom and hit-testing</li>
    </ul>
    <h2>Vortex Search</h2>
    <p>Searches go to the hive's search service, which asks DuckDuckGo, Bing and Wikipedia in parallel, merges the results (links several engines agree on rank first) and builds an answer card. Weather, local time and definitions come from live sources (Open-Meteo, Wiktionary); sums like <code>12*(3+4)</code> are calculated right here. If one engine is unavailable, the others still answer.</p>
    <h2>What it does not do (yet)</h2>
    <ul>
      <li>No JavaScript — pages that need scripts to show content will look empty</li>
      <li>No video, audio, web fonts, CSS animations or positioned layers</li>
      <li>Forms submit with GET only. Text selection and find-in-page are not built yet</li>
    </ul>
    <h2>Shortcuts</h2>
    <p><code>Ctrl+L</code> address bar · <code>Ctrl+T</code> new tab · <code>Ctrl+W</code> close tab · <code>Alt+←/→</code> back/forward · <code>F5</code> reload · <code>Ctrl +/−/0</code> zoom</p>
    <p><a href="vortex://home">← Start page</a></p>`);
}

export function errorPage(title, message, url) {
  return shell(title, `<div class="err"><div class="big">🐝</div><h1 style="font-size:24px">${esc(title)}</h1><p class="muted">${esc(message)}</p>${url ? `<p class="url">${esc(url.slice(0, 120))}</p>` : ''}<p><a href="vortex://home">Start page</a></p></div>`);
}

export function imagePage(src, url) {
  return shell(url.split('/').pop() || 'Image', `<p class="url">${esc(url)}</p><p><img src="${esc(src)}" alt="image"></p>`);
}

export function textPage(title, text) {
  return shell(title || 'Text', `<pre>${esc(text)}</pre>`);
}
