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
    <p class="sub">Hello, ${esc(user)}. Search the pages you have visited, or type a web address above.</p>
    <form data-vortex-action="vortex://search" method="get"><input name="q" placeholder="Search your hive history and bookmarks…"><button>Search</button></form>
    ${tiles ? `<h2>Bookmarks</h2><div class="tiles">${tiles}</div>` : '<h2>Bookmarks</h2><p class="muted">Nothing here yet. Press ☆ in the toolbar to bookmark a page.</p>'}
    ${recent ? `<h2>Recently visited</h2>${recent}<p><a href="vortex://history">All history →</a></p>` : ''}
    <div class="note">Vortex Browser is built from scratch for Vortex OS: its own HTML parser, CSS engine, layout and renderer. Every page is fetched by the hive proxy, and there is no JavaScript. <a href="vortex://about">What works →</a></div>`);
}

export function results(q, store) {
  const hits = store.search(q);
  const list = hits.map((h) => `<div class="item"><a href="${esc(h.url)}">${esc(h.title || h.url)}</a><div class="url">${esc(h.url.slice(0, 90))}</div><div class="snip">${esc(h.snippet)}</div></div>`).join('');
  return shell(`Search: ${q}`, `
    <h1>🐝 Vortex <b>Search</b></h1>
    <form data-vortex-action="vortex://search" method="get"><input name="q" value="${esc(q)}"><button>Search</button></form>
    ${hits.length ? `<p class="muted">${hits.length} result${hits.length === 1 ? '' : 's'} from your history and bookmarks</p>${list}`
    : `<p>No matches for <b>${esc(q)}</b> in the pages you have visited.</p><p class="muted">Vortex Search looks through your own history and bookmarks. To go somewhere new, type a web address such as <code>example.com</code> in the address bar.</p>`}`);
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
