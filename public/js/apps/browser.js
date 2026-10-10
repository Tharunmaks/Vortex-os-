// Vortex Browser — pages are fetched by the hive proxy (SSRF-safe) and shown in a
// script-less sandboxed frame. Links and GET forms are routed back through the proxy.
import { api, h, toast } from '../api.js';
import { openWindow } from '../wm.js';
import { icons } from '../icons.js';

const START = 'vortex://start';
const SEARCH = 'https://lite.duckduckgo.com/lite/?q=';
const BOOKMARKS = [
  ['Wikipedia', 'https://en.m.wikipedia.org/wiki/Honey_bee', '📚'],
  ['Hacker News', 'https://news.ycombinator.com/', '🟧'],
  ['MDN Web Docs', 'https://developer.mozilla.org/en-US/', '🦖'],
  ['Debian', 'https://www.debian.org/', '🌀'],
  ['Arch Wiki', 'https://wiki.archlinux.org/', '🐧'],
  ['Lobsters', 'https://lobste.rs/', '🦞'],
];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function startPage(user) {
  const tiles = BOOKMARKS.map(([name, url, emoji]) => `<a class="tile" href="${escapeHtml(url)}"><span>${emoji}</span>${escapeHtml(name)}</a>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;min-height:100vh;font:15px/1.5 system-ui,sans-serif;color:#f4efe4;display:grid;place-content:center;gap:22px;padding:24px;
      background:radial-gradient(circle at 30% 20%,rgba(245,179,1,.25),transparent 50%),linear-gradient(160deg,#1a150b,#0b0a08)}
    h1{margin:0;text-align:center;font-size:34px;letter-spacing:.06em}h1 b{color:#f5b301}
    p{margin:0;text-align:center;color:#a99f8b}
    form{display:flex;gap:8px;width:min(560px,90vw);margin:auto}
    input{flex:1;padding:12px 16px;border-radius:999px;border:1px solid rgba(255,220,140,.25);background:rgba(255,255,255,.06);color:#f4efe4;font-size:16px;outline:none}
    button{padding:0 20px;border:0;border-radius:999px;background:#f5b301;color:#1b1400;font-weight:700;cursor:pointer}
    .tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;width:min(600px,90vw);margin:auto}
    .tile{display:grid;justify-items:center;gap:6px;padding:14px;border-radius:14px;background:rgba(255,255,255,.05);border:1px solid rgba(255,220,140,.12);color:#f4efe4;text-decoration:none}
    .tile:hover{background:rgba(245,179,1,.14)} .tile span{font-size:26px}
    .safe{font-size:12px}
  </style></head><body>
    <h1>🐝 Vortex <b>Browser</b></h1>
    <p>Hello, ${escapeHtml(user)}. Search the web or pick a bookmark.</p>
    <form data-vortex-action="https://lite.duckduckgo.com/lite/" method="get"><input name="q" placeholder="Search with DuckDuckGo…"><button>Search</button></form>
    <div class="tiles">${tiles}</div>
    <p class="safe">🛡️ Every page is fetched by the hive proxy · scripts are disabled · internal networks are blocked</p>
  </body></html>`;
}

function normalise(input) {
  const v = input.trim();
  if (!v || v === START) return START;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(v) && !/\s/.test(v)) return `https://${v}`;
  return SEARCH + encodeURIComponent(v);
}

export default {
  id: 'browser',
  name: 'Browser',
  description: 'Sandboxed, proxy-protected web browser',
  open(os, { url } = {}) {
    const back = [];
    const fwd = [];
    let current = null;
    let loadToken = 0;

    const address = h('input.grow', { type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Address', placeholder: 'Search or enter address' });
    const pill = h('span.secure-pill', { title: 'Scripts off · proxied · private networks blocked' }, '🛡️ Sandboxed');
    const progress = h('div.browser-progress');
    const view = h('div', { style: { flex: '1', display: 'flex', flexDirection: 'column', minHeight: '0' } });
    const b = (icon, title, fn) => h('button.btn.icon', { title, 'aria-label': title, html: icon, onclick: fn });

    const toolbar = h('div.toolbar',
      b(icons.back, 'Back', () => back.length && (fwd.push(current), go(back.pop(), false))),
      b(icons.fwd, 'Forward', () => fwd.length && (back.push(current), go(fwd.pop(), false))),
      b(icons.reload, 'Reload', () => go(current || START, false)),
      b(icons.home, 'Start page', () => go(START)),
      h('form', { style: { display: 'flex', flex: '1', minWidth: '160px' }, onsubmit: (e) => (e.preventDefault(), go(normalise(address.value))) }, address),
      pill,
      b(icons.external, 'Open in a real browser tab', () => {
        if (current && current !== START) window.open(current, '_blank', 'noopener,noreferrer');
      }),
    );
    const body = h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } }, toolbar, progress, view);
    const win = openWindow({ app: 'browser', title: 'Browser', width: 980, height: 640, body });

    function showMessage(emoji, title, detail) {
      view.replaceChildren(h('div.browser-msg', h('div.big-emoji', emoji), h('h3', { style: { margin: 0 } }, title), detail ? h('p.muted', { style: { margin: 0 } }, detail) : null));
    }

    function mountFrame(html) {
      // allow-same-origin (and nothing else) lets this window wire up links, while
      // the page itself can run no scripts, submit no forms and open no popups.
      const frame = h('iframe.browser-frame', { sandbox: 'allow-same-origin', referrerpolicy: 'no-referrer', title: 'Web page' });
      frame.srcdoc = html;
      frame.addEventListener('load', () => wire(frame));
      view.replaceChildren(frame);
    }

    function wire(frame) {
      const doc = frame.contentDocument;
      if (!doc) return;
      doc.addEventListener('click', (e) => {
        const a = e.target.closest('a[href]');
        if (a) {
          e.preventDefault();
          const href = a.getAttribute('href');
          if (href.startsWith('#')) {
            doc.getElementById(href.slice(1))?.scrollIntoView();
            return;
          }
          go(href);
          return;
        }
        const submit = e.target.closest('button:not([type=button]):not([type=reset]), input[type=submit], input[type=image]');
        if (submit?.form) {
          e.preventDefault();
          submitForm(submit.form, submit);
        }
      });
      doc.addEventListener('keydown', (e) => {
        const input = e.target.closest?.('input');
        if (e.key === 'Enter' && input?.form) {
          e.preventDefault();
          submitForm(input.form);
        }
      });
    }

    function submitForm(form, submitter) {
      const action = form.getAttribute('data-vortex-action');
      if (!action) return;
      if ((form.getAttribute('method') || 'get').toLowerCase() !== 'get') {
        toast('This form posts data — the hive browser only submits GET forms. Use “Open in a real tab”.');
        return;
      }
      const params = new URLSearchParams();
      for (const el of form.elements) {
        if (!el.name || el.disabled) continue;
        if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) continue;
        if (['submit', 'button', 'image', 'reset', 'file'].includes(el.type) && el !== submitter) continue;
        params.append(el.name, el.value);
      }
      const u = new URL(action);
      u.search = params.toString();
      go(u.href);
    }

    async function go(target, record = true) {
      if (record && current) {
        back.push(current);
        fwd.length = 0;
      }
      current = target;
      address.value = target === START ? '' : target;
      const token = ++loadToken;
      if (target === START) {
        win.setTitle('Start — Browser');
        mountFrame(startPage(os.user.username));
        return;
      }
      progress.style.width = '35%';
      try {
        const page = await api(`/api/browser/page?url=${encodeURIComponent(target)}`);
        if (token !== loadToken) return;
        current = page.url;
        address.value = page.url;
        win.setTitle(`${page.title || page.url} — Browser`);
        if (page.kind === 'html') mountFrame(page.html);
        else if (page.kind === 'image') view.replaceChildren(h('div.browser-msg', h('img', { src: page.src, alt: '', style: { maxWidth: '100%', maxHeight: '100%' } })));
        else if (page.kind === 'text') view.replaceChildren(h('pre.browser-text', page.text));
        else showMessage('📦', 'This file can’t be shown here', `${page.contentType} · ${page.size} bytes. Use “Open in a real tab” to download it.`);
      } catch (err) {
        if (token !== loadToken) return;
        const blockedNet = err.status === 403;
        showMessage(blockedNet ? '🛡️' : '🐝', blockedNet ? 'Blocked by the hive' : 'Could not load this page', err.message);
      } finally {
        if (token === loadToken) {
          progress.style.width = '100%';
          setTimeout(() => (progress.style.width = '0'), 250);
        }
      }
    }

    go(url ? normalise(url) : START, false);
    return win;
  },
};
