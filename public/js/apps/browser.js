// Vortex Browser — a web browser written from scratch for Vortex OS.
//
// Pipeline: hive proxy (network, script stripping, SSRF guard) → Vortex Engine
// (HTML parser → CSS cascade → layout → canvas paint). No iframe, no third-party engine.
import { api, h, toast } from '../api.js';
import { openWindow } from '../wm.js';
import { icons } from '../icons.js';
import { Page } from '../engine/page.js';
import { Viewport } from '../engine/viewport.js';
import { Store } from '../browser/store.js';
import * as pages from '../browser/internal.js';

const MAX_TABS = 12;
const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export function resolveInput(raw) {
  const v = String(raw).trim();
  if (!v) return 'vortex://home';
  if (/^vortex:\/\//i.test(v) || /^https?:\/\//i.test(v)) return v;
  if (/^[^\s/]+\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i.test(v) || /^localhost(:\d+)?([/?#]|$)/i.test(v)) return `https://${v}`;
  return `vortex://search?q=${encodeURIComponent(v)}`;
}

async function fetchText(url, signal) {
  const res = await fetch(url, { signal, credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

const SAFE_INPUT = new Set(['text', 'search', 'email', 'url', 'password', 'number', 'tel']);

export default {
  id: 'browser',
  name: 'Browser',
  description: 'Vortex Browser — built from scratch',
  open(os, { url } = {}) {
    const store = new Store(os.user.username);
    const tabs = [];
    let active = null;
    let tabSeq = 0;

    // ── UI skeleton ──
    const tabStrip = h('div.vb-tabs');
    const back = h('button.btn.icon', { title: 'Back (Alt+←)', 'aria-label': 'Back', html: icons.back });
    const fwd = h('button.btn.icon', { title: 'Forward (Alt+→)', 'aria-label': 'Forward', html: icons.fwd });
    const reload = h('button.btn.icon', { title: 'Reload (F5)', 'aria-label': 'Reload', html: icons.reload });
    const home = h('button.btn.icon', { title: 'Start page', 'aria-label': 'Start page', html: icons.home });
    const address = h('input.grow', { type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Address', placeholder: 'Search your history or enter a web address' });
    const star = h('button.btn.icon', { title: 'Bookmark this page', 'aria-label': 'Bookmark' }, '☆');
    const menuBtn = h('button.btn.icon', { title: 'Menu', 'aria-label': 'Menu' }, '⋯');
    const pill = h('span.secure-pill', { title: 'Own engine · no scripts · proxied · private networks blocked' }, '🛡️ Vortex Engine');
    const progress = h('div.browser-progress');
    const canvas = h('canvas.vb-canvas', { tabindex: '0', 'aria-label': 'Web page' });
    const overlayHost = h('div.vb-overlay');
    const status = h('div.vb-status');
    const stage = h('div.vb-stage', canvas, overlayHost, status);
    const menu = h('div.menu.hidden.vb-menu', { role: 'menu' });
    const toolbar = h('div.toolbar', back, fwd, reload, home,
      h('form', { style: { display: 'flex', flex: '1', minWidth: '140px' }, onsubmit: (e) => (e.preventDefault(), go(active, resolveInput(address.value)), canvas.focus()) }, address),
      pill, star, menuBtn);
    const body = h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' } }, tabStrip, toolbar, progress, stage, menu);

    const viewport = new Viewport(canvas);
    let win;

    // ── Tabs ──
    function newTab(target, { background = false } = {}) {
      if (tabs.length >= MAX_TABS) return toast(`Tab limit reached (${MAX_TABS})`, { type: 'error' });
      const tab = {
        id: ++tabSeq, url: '', title: 'New tab', page: null, hist: [], hi: -1, scroll: 0, zoom: 1, loading: false,
        nav: 0, abort: null, inner: h('div.vb-inner'), ctls: new Map(), layout: null,
      };
      tabs.push(tab);
      if (!background) activate(tab);
      else renderTabs();
      go(tab, target || 'vortex://home', { push: true });
      return tab;
    }

    function activate(tab) {
      if (active && active !== tab) {
        active.scroll = viewport.scrollY;
        active.inner.remove();
      }
      active = tab;
      overlayHost.replaceChildren(tab.inner);
      viewport.zoom = tab.zoom;
      if (tab.page) draw(tab, tab.scroll);
      else viewport.setLayout(null);
      syncChrome();
      renderTabs();
    }

    function closeTab(tab) {
      const i = tabs.indexOf(tab);
      if (i < 0) return;
      tab.abort?.abort();
      tab.page?.destroy();
      tab.inner.remove();
      tabs.splice(i, 1);
      if (!tabs.length) return win.close();
      if (active === tab) activate(tabs[Math.min(i, tabs.length - 1)]);
      else renderTabs();
      return undefined;
    }

    function renderTabs() {
      tabStrip.replaceChildren(
        ...tabs.map((t) => h('div.vb-tab', { class: t === active ? 'active' : '', title: t.title, onclick: () => activate(t), onauxclick: (e) => e.button === 1 && closeTab(t) },
          h('span.vb-tab-title', t.loading ? '⏳ Loading…' : t.title || 'New tab'),
          h('button.vb-tab-x', { 'aria-label': 'Close tab', onclick: (e) => (e.stopPropagation(), closeTab(t)) }, '×'))),
        h('button.vb-newtab', { title: 'New tab (Ctrl+T)', 'aria-label': 'New tab', onclick: () => newTab('vortex://home') }, '+'),
      );
    }

    function syncChrome() {
      const t = active;
      if (!t) return;
      back.disabled = t.hi <= 0;
      fwd.disabled = t.hi >= t.hist.length - 1;
      reload.innerHTML = t.loading ? icons.close : icons.reload;
      reload.title = t.loading ? 'Stop' : 'Reload (F5)';
      if (document.activeElement !== address) address.value = t.url === 'vortex://home' ? '' : t.url;
      const bookmarkable = t.url && !t.url.startsWith('vortex://');
      star.textContent = bookmarkable && store.isBookmarked(t.url) ? '★' : '☆';
      star.disabled = !bookmarkable;
      progress.style.width = t.loading ? '60%' : '0';
      win.setTitle(`${t.title || 'New tab'} — Browser`);
    }

    // ── Navigation ──
    function internalHtml(u) {
      const url2 = new URL(u.replace(/^vortex:\/\//i, 'http://vortex.internal/'));
      const name = u.replace(/^vortex:\/\//i, '').split(/[?#]/)[0].replace(/\/$/, '');
      switch (name) {
        case 'home': return pages.home(os.user.username, store);
        case 'search': return pages.results(url2.searchParams.get('q') || '', store);
        case 'history': return pages.history(store);
        case 'bookmarks': return pages.bookmarks(store);
        case 'about': return pages.about(os.version);
        case 'clear-history': store.clearHistory(); return pages.history(store);
        default: return pages.errorPage('Unknown page', `There is no built-in page called “${name}”.`, u);
      }
    }

    async function go(tab, target, { push = true, scroll = 0 } = {}) {
      if (!tab) return;
      tab.abort?.abort();
      const ac = new AbortController();
      tab.abort = ac;
      const token = ++tab.nav;
      if (tab === active && tab.hist[tab.hi]) tab.hist[tab.hi].scroll = viewport.scrollY;
      tab.loading = true;
      renderTabs();
      if (tab === active) {
        if (document.activeElement !== address) address.value = target.startsWith('vortex://home') ? '' : target;
        syncChrome();
      }
      let html;
      let finalUrl = target;
      let record = false;
      try {
        if (target.startsWith('vortex://')) {
          html = internalHtml(target);
        } else {
          const res = await api(`/api/browser/page?url=${encodeURIComponent(target)}`, { signal: ac.signal });
          finalUrl = res.url;
          record = true;
          if (res.kind === 'html') html = res.html;
          else if (res.kind === 'image') html = pages.imagePage(res.src, res.url);
          else if (res.kind === 'text') html = pages.textPage(res.title, res.text);
          else {
            html = pages.errorPage('This file can’t be shown here', `${res.contentType} · ${res.size} bytes. Vortex Browser shows pages, images and text.`, res.url);
            record = false;
          }
        }
        const page = new Page({ fetchText, onChange: () => tab.page === page && relayoutSoon(tab) });
        await page.load(html, { signal: ac.signal });
        if (token !== tab.nav) return page.destroy();
        applyPage(tab, page, finalUrl, push, scroll);
        if (record) store.addVisit({ url: finalUrl, title: page.title, text: page.text() });
      } catch (err) {
        if (err.name === 'AbortError' || token !== tab.nav) return undefined;
        const blocked = err.status === 403;
        const page = new Page({ fetchText, onChange: () => {} });
        await page.load(pages.errorPage(blocked ? 'Blocked by the hive' : 'Could not load this page', err.message, target));
        page.title = blocked ? 'Blocked' : 'Page not loaded';
        applyPage(tab, page, target, push, 0);
      }
      return undefined;
    }

    function applyPage(tab, page, finalUrl, push, scroll) {
      tab.page?.destroy();
      tab.page = page;
      tab.url = finalUrl;
      tab.title = page.title || finalUrl.replace(/^https?:\/\//, '').slice(0, 40);
      tab.loading = false;
      for (const el of tab.ctls.values()) el.remove();
      tab.ctls.clear();
      if (push) {
        tab.hist.length = tab.hi + 1;
        tab.hist.push({ url: finalUrl, scroll: 0 });
        tab.hi = tab.hist.length - 1;
      } else if (tab.hist[tab.hi]) tab.hist[tab.hi].url = finalUrl;
      tab.scroll = scroll;
      if (tab === active) {
        draw(tab, scroll);
        syncChrome();
        setTimeout(() => (progress.style.width = '0'), 150);
      }
      renderTabs();
    }

    function histGo(tab, delta) {
      const i = tab.hi + delta;
      if (i < 0 || i >= tab.hist.length) return;
      if (tab === active && tab.hist[tab.hi]) tab.hist[tab.hi].scroll = viewport.scrollY;
      tab.hi = i;
      go(tab, tab.hist[i].url, { push: false, scroll: tab.hist[i].scroll || 0 });
    }

    // ── Drawing ──
    function draw(tab, scroll) {
      if (tab !== active || !tab.page) return;
      viewport.zoom = tab.zoom;
      const layout = tab.page.layout(viewport.pageWidth, viewport.pageHeight);
      tab.layout = layout;
      viewport.setLayout(layout);
      if (scroll !== undefined) viewport.scrollTo(scroll);
      syncControls(tab);
    }

    let relayoutTimer = 0;
    function relayoutSoon(tab) {
      clearTimeout(relayoutTimer);
      relayoutTimer = setTimeout(() => {
        if (tab !== active || !tab.page) return;
        draw(tab, viewport.scrollY);
      }, 80);
    }

    // ── Form controls (real inputs overlaid on the canvas; the page never touches them) ──
    function formOf(node) {
      for (let n = node.parent; n; n = n.parent) if (n.tag === 'form') return n;
      return null;
    }

    const formKeys = new WeakMap();
    let formSeq = 0;
    function formKey(form) {
      if (!form) return 0;
      if (!formKeys.has(form)) formKeys.set(form, ++formSeq);
      return formKeys.get(form);
    }

    function makeControl(c, tab) {
      const n = c.node;
      let el;
      if (c.ctl === 'textarea') {
        el = h('textarea.vb-ctl', { spellcheck: 'false' });
        el.value = n.children.map((k) => k.text || '').join('').replace(/^\n/, '');
      } else if (c.ctl === 'select') {
        el = h('select.vb-ctl');
        const opts = n.children.flatMap((k) => (k.type === 'el' ? (k.tag === 'optgroup' ? k.children : [k]) : [])).filter((k) => k.type === 'el' && k.tag === 'option');
        for (const o of opts) {
          const label = o.children.map((k) => k.text || '').join('').trim();
          el.append(h('option', { value: o.attrs.value ?? label, selected: o.attrs.selected !== undefined }, label));
        }
      } else if (c.ctl === 'checkbox' || c.ctl === 'radio') {
        el = h('input.vb-ctl', { type: c.ctl });
        // Radios are grouped per form so only one in a group can be on.
        if (c.ctl === 'radio' && n.attrs.name) el.name = `${tab.id}:${formKey(formOf(n))}:${n.attrs.name}`;
        el.checked = n.attrs.checked !== undefined;
      } else {
        const type = SAFE_INPUT.has(c.type) ? c.type : 'text';
        el = h('input.vb-ctl', { type, placeholder: n.attrs.placeholder || '', maxlength: n.attrs.maxlength || undefined, autocomplete: 'off', spellcheck: 'false' });
        el.value = n.attrs.value || '';
      }
      // Let the page's own look carry over onto the real input.
      const st = n.style;
      if (st) {
        const px = (l) => (typeof l === 'object' ? l.px : 0);
        if (st.bg) { el.style.background = st.bg; el.style.color = st.color; }
        if (st.bw.some(Boolean)) el.style.border = `${Math.max(...st.bw)}px solid ${st.bc.find(Boolean) || st.color}`;
        if (st.radius && c.ctl !== 'checkbox' && c.ctl !== 'radio') el.style.borderRadius = `${st.radius}px`;
        if (c.ctl !== 'checkbox' && c.ctl !== 'radio') el.style.padding = `${px(st.padding[0])}px ${px(st.padding[1])}px ${px(st.padding[2])}px ${px(st.padding[3])}px`;
      }
      if (n.attrs.disabled !== undefined) el.disabled = true;
      if (n.attrs.readonly !== undefined) el.readOnly = true;
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && c.ctl === 'text') {
          e.preventDefault();
          const f = formOf(n);
          if (f) submitForm(tab, f, null);
        }
        e.stopPropagation();
      });
      tab.inner.append(el);
      tab.ctls.set(n, el);
      return el;
    }

    function syncControls(tab) {
      if (tab !== active || !tab.layout) return;
      const z = tab.zoom;
      const seen = new Set();
      for (const c of tab.layout.controls) {
        if (c.ctl === 'button') continue;
        const el = tab.ctls.get(c.node) || makeControl(c, tab);
        seen.add(c.node);
        el.style.display = '';
        el.style.left = `${c.x * z}px`;
        el.style.top = `${c.y * z}px`;
        el.style.fontSize = `${13 * z}px`;
        if (c.ctl === 'checkbox' || c.ctl === 'radio') {
          el.style.width = `${14 * z}px`;
          el.style.height = `${14 * z}px`;
          el.style.left = `${(c.x + 3) * z}px`;
          el.style.top = `${(c.y + 2) * z}px`;
        } else {
          el.style.width = `${c.w * z}px`;
          el.style.height = `${c.h * z}px`;
        }
      }
      for (const [node, el] of tab.ctls) if (!seen.has(node)) el.style.display = 'none';
      scrollOverlay();
    }

    function scrollOverlay() {
      if (active) active.inner.style.transform = `translateY(${-viewport.scrollY * viewport.zoom}px)`;
    }
    viewport.onScroll = scrollOverlay;

    function collectForm(tab, form, submitter) {
      const params = [];
      (function walk(n) {
        for (const c of n.children || []) {
          if (c.type !== 'el') continue;
          const name = c.attrs.name;
          if (name && c.attrs.disabled === undefined) {
            const el = tab.ctls.get(c);
            if (c.tag === 'input') {
              const type = (c.attrs.type || 'text').toLowerCase();
              if (type === 'hidden') params.push([name, c.attrs.value ?? '']);
              else if (type === 'checkbox' || type === 'radio') { if (el?.checked) params.push([name, c.attrs.value ?? 'on']); }
              else if (type === 'submit' || type === 'image' || type === 'button' || type === 'reset') { if (c === submitter) params.push([name, c.attrs.value ?? '']); }
              else if (el) params.push([name, el.value]);
            } else if (c.tag === 'textarea' || c.tag === 'select') { if (el) params.push([name, el.value]); }
            else if (c.tag === 'button' && c === submitter) params.push([name, c.attrs.value ?? '']);
          }
          walk(c);
        }
      }(form));
      return params;
    }

    function submitForm(tab, form, submitter) {
      const method = (form.attrs.method || 'get').toLowerCase();
      const action = form.attrs['data-vortex-action'] ?? form.attrs.action ?? '';
      if (method !== 'get') return toast('This form posts data. Vortex Browser submits GET forms only.', { type: 'error' });
      const params = new URLSearchParams(collectForm(tab, form, submitter));
      if (action.startsWith('vortex://')) return go(tab, `${action.split('?')[0]}?${params}`);
      let target;
      try {
        target = new URL(action || tab.url, tab.url);
      } catch {
        return toast('This form has no usable address.', { type: 'error' });
      }
      target.search = params.toString();
      return go(tab, target.href);
    }

    function activateHref(tab, href, { newTab: nt = false } = {}) {
      if (href.startsWith('#')) {
        const id = decodeURIComponent(href.slice(1));
        const y = id ? tab.layout?.anchors?.[id] : 0;
        if (y !== undefined) viewport.scrollTo(y * 1);
        return undefined;
      }
      if (/^(mailto|tel|sms):/i.test(href)) return toast(`Vortex Browser doesn’t open ${href.split(':')[0]} links.`);
      if (!/^(https?|vortex):/i.test(href)) {
        try { href = new URL(href, tab.url).href; } catch { return undefined; }
      }
      if (nt) return newTab(href, { background: false });
      return go(tab, href);
    }

    // ── Canvas interaction ──
    let down = null;
    canvas.addEventListener('pointerdown', (e) => {
      canvas.focus({ preventScroll: true });
      down = { x: e.clientX, y: e.clientY, last: e.clientY, moved: false, type: e.pointerType };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      if (down && e.pointerType !== 'mouse') {
        if (Math.abs(e.clientY - down.y) > 6) down.moved = true;
        if (down.moved) {
          viewport.scrollBy((down.last - e.clientY) / viewport.zoom);
          down.last = e.clientY;
        }
        return;
      }
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) down.moved = true;
      const link = viewport.linkAt(px, py);
      const btn = viewport.buttonAt(px, py);
      canvas.style.cursor = link || btn ? 'pointer' : 'default';
      status.textContent = link ? link.href.slice(0, 160) : '';
      status.classList.toggle('show', !!link);
    });
    canvas.addEventListener('pointerleave', () => status.classList.remove('show'));
    canvas.addEventListener('pointerup', (e) => {
      const d = down;
      down = null;
      if (!d || d.moved || !active) return;
      const r = canvas.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const btn = viewport.buttonAt(px, py);
      if (btn) {
        const form = formOf(btn.node);
        const type = (btn.node.attrs.type || 'submit').toLowerCase();
        if (form && type === 'submit') submitForm(active, form, btn.node);
        else if (form && type === 'reset') for (const el of active.ctls.values()) if (form.children) el.value = el.defaultValue ?? '';
        return;
      }
      const link = viewport.linkAt(px, py);
      if (link) activateHref(active, link.href, { newTab: e.button === 1 || e.ctrlKey || e.metaKey });
    });
    canvas.addEventListener('auxclick', (e) => {
      if (e.button !== 1 || !active) return;
      const r = canvas.getBoundingClientRect();
      const link = viewport.linkAt(e.clientX - r.left, e.clientY - r.top);
      if (link) activateHref(active, link.href, { newTab: true });
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey) return zoomBy(e.deltaY < 0 ? 1 : -1);
      viewport.scrollBy((e.deltaMode === 1 ? e.deltaY * 18 : e.deltaY) / viewport.zoom);
      return undefined;
    }, { passive: false });
    canvas.addEventListener('keydown', (e) => {
      const page = viewport.pageHeight * 0.9;
      const k = e.key;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (k === 'ArrowDown') viewport.scrollBy(48);
      else if (k === 'ArrowUp') viewport.scrollBy(-48);
      else if (k === 'PageDown' || (k === ' ' && !e.shiftKey)) viewport.scrollBy(page);
      else if (k === 'PageUp' || (k === ' ' && e.shiftKey)) viewport.scrollBy(-page);
      else if (k === 'Home') viewport.scrollTo(0);
      else if (k === 'End') viewport.scrollTo(1e9);
      else return;
      e.preventDefault();
    });

    // ── Chrome behaviour ──
    function zoomBy(dir) {
      if (!active) return;
      let i = ZOOMS.findIndex((z) => Math.abs(z - active.zoom) < 0.01);
      if (i < 0) i = ZOOMS.indexOf(1);
      active.zoom = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + dir))];
      draw(active, viewport.scrollY);
    }

    back.addEventListener('click', () => active && histGo(active, -1));
    fwd.addEventListener('click', () => active && histGo(active, 1));
    reload.addEventListener('click', () => {
      if (!active) return;
      if (active.loading) {
        active.abort?.abort();
        active.loading = false;
        syncChrome();
        renderTabs();
      } else go(active, active.url || 'vortex://home', { push: false, scroll: viewport.scrollY });
    });
    home.addEventListener('click', () => active && go(active, 'vortex://home'));
    star.addEventListener('click', () => {
      if (!active || active.url.startsWith('vortex://')) return;
      const on = store.toggleBookmark(active.url, active.title);
      toast(on ? 'Bookmarked' : 'Bookmark removed', { type: 'ok', timeout: 1500 });
      syncChrome();
    });
    address.addEventListener('focus', () => address.select());

    function openMenu() {
      const item = (label, fn) => h('button', { role: 'menuitem', onclick: () => { menu.classList.add('hidden'); fn(); } }, label);
      menu.replaceChildren(
        item('New tab', () => newTab('vortex://home')),
        item('History', () => active && go(active, 'vortex://history')),
        item('Bookmarks', () => active && go(active, 'vortex://bookmarks')),
        item('Zoom in', () => zoomBy(1)),
        item('Zoom out', () => zoomBy(-1)),
        item('Reset zoom', () => { if (active) { active.zoom = 1; draw(active, viewport.scrollY); } }),
        item('About Vortex Browser', () => active && go(active, 'vortex://about')),
      );
      menu.classList.toggle('hidden');
    }
    menuBtn.addEventListener('click', (e) => (e.stopPropagation(), openMenu()));
    body.addEventListener('pointerdown', (e) => { if (!e.target.closest('.vb-menu') && e.target !== menuBtn) menu.classList.add('hidden'); });

    body.addEventListener('keydown', (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === 'l') { e.preventDefault(); address.focus(); }
      else if (ctrl && e.key.toLowerCase() === 't') { e.preventDefault(); newTab('vortex://home'); }
      else if (ctrl && e.key.toLowerCase() === 'w') { e.preventDefault(); active && closeTab(active); }
      else if (e.key === 'F5' || (ctrl && e.key.toLowerCase() === 'r')) { e.preventDefault(); reload.click(); }
      else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); back.click(); }
      else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); fwd.click(); }
      else if (ctrl && (e.key === '+' || e.key === '=')) { e.preventDefault(); zoomBy(1); }
      else if (ctrl && e.key === '-') { e.preventDefault(); zoomBy(-1); }
      else if (ctrl && e.key === '0') { e.preventDefault(); if (active) { active.zoom = 1; draw(active, viewport.scrollY); } }
    });

    // ── Window ──
    let lastW = 0;
    let resizeTimer = 0;
    const doResize = () => {
      const sw = stage.clientWidth; // layout size: unaffected by the window-open scale animation
      const sh = stage.clientHeight;
      if (sw < 2 || sh < 2) return;
      viewport.resize(sw, sh);
      overlayHost.style.width = `${sw}px`;
      overlayHost.style.height = `${sh}px`;
      if (active && active.page) {
        const widthChanged = Math.abs(sw - lastW) > 0.5;
        lastW = sw;
        if (widthChanged || !active.layout) draw(active, viewport.scrollY);
        else viewport.draw();
      }
    };
    win = openWindow({
      app: 'browser',
      title: 'Browser',
      width: 1000,
      height: 660,
      body,
      onResize: () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(doResize, 30);
      },
      onFocus: () => {},
      onClose: () => {
        clearTimeout(relayoutTimer);
        for (const t of tabs) {
          t.abort?.abort();
          t.page?.destroy();
        }
      },
    });
    const ro = new ResizeObserver(() => doResize());
    ro.observe(stage);

    requestAnimationFrame(() => {
      doResize();
      newTab(url ? resolveInput(url) : 'vortex://home');
    });
    return win;
  },
};
