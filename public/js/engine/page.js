// Vortex Engine — Page: parse → fetch stylesheets → cascade → layout, plus the image cache.
import { parseHTML, walk, textContent } from './html.js';
import { parseStylesheet, computeStyles, evalMedia } from './css.js';
import { layoutDocument } from './layout.js';

let measureCtx = null;
function measure(font, text) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (measureCtx.font !== font) measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

const MAX_SHEETS = 14;
const MAX_IMAGES = 160;

export class Page {
  /**
   * fetchText(url, signal) → Promise<string>  (stylesheets only; same-origin proxy URLs)
   * onChange() is called when something asynchronous (an image) finished and a relayout is wanted.
   */
  constructor({ fetchText, onChange }) {
    this.fetchText = fetchText;
    this.onChange = onChange || (() => {});
    this.images = new Map();
    this.title = '';
    this.doc = null;
    this.html = null;
    this.sheetTexts = [];
    this.last = null;
    this.key = '';
    this.dead = false;
  }

  async load(htmlSource, { signal } = {}) {
    this.doc = parseHTML(htmlSource);
    this.html = this.doc.children[0];
    const t = [];
    walk(this.html, (el) => {
      if (el.tag === 'title' && !this.title) this.title = textContent(el, new Set()).replace(/\s+/g, ' ').trim().slice(0, 200);
      else if (el.tag === 'style' && (!el.attrs.media || evalMedia(el.attrs.media, 1024, 768))) t.push({ text: el.children.map((c) => c.text || '').join('') });
      else if (el.tag === 'link' && /\bstylesheet\b/i.test(el.attrs.rel || '') && el.attrs.href && (!el.attrs.media || evalMedia(el.attrs.media, 1024, 768))) t.push({ href: el.attrs.href });
      return true;
    });
    let budget = MAX_SHEETS;
    const gather = async (text, depth) => {
      const out = [];
      if (depth < 3) {
        const { imports } = parseStylesheet(text, { vw: 1024, vh: 768 });
        const fetched = await Promise.all(imports.slice(0, 6).map(async (u) => {
          if (budget-- <= 0) return [];
          try { return await gather(await this.fetchText(u, signal), depth + 1); } catch { return []; }
        }));
        for (const f of fetched) out.push(...f);
      }
      out.push(text);
      return out;
    };
    const parts = await Promise.all(t.map(async (s) => {
      if (s.text !== undefined) return gather(s.text, 0);
      if (budget-- <= 0) return [];
      try { return await gather(await this.fetchText(s.href, signal), 0); } catch { return []; }
    }));
    this.sheetTexts = parts.flat();
    this.key = '';
  }

  getImage(node) {
    const src = node.attrs.src;
    if (!src) return { state: 'error', w: 0, h: 0 };
    let rec = this.images.get(src);
    if (!rec) {
      rec = { state: 'loading', w: 0, h: 0, img: null };
      this.images.set(src, rec);
      if (this.images.size > MAX_IMAGES) { rec.state = 'error'; return rec; }
      const img = new Image();
      img.decoding = 'async';
      rec.img = img;
      img.onload = () => {
        rec.state = 'ok';
        rec.w = img.naturalWidth || 0;
        rec.h = img.naturalHeight || 0;
        if (!rec.w || !rec.h) { rec.w = 300; rec.h = 150; }
        if (!this.dead) this.onChange();
      };
      img.onerror = () => {
        rec.state = 'error';
        if (!this.dead) this.onChange();
      };
      img.src = src;
    }
    return rec;
  }

  /** Style + layout for the given viewport. Styles are recomputed only when the viewport changes. */
  layout(width, height) {
    width = Math.max(120, Math.floor(width));
    const env = { vw: width, vh: height };
    const key = `${width}x${height}`;
    if (key !== this.key) {
      const sheets = this.sheetTexts.map((txt) => parseStylesheet(txt, env, 1));
      computeStyles(this.html, sheets, env);
      this.key = key;
    }
    this.last = layoutDocument(this.html, { width, height, measure, getImage: (n) => this.getImage(n) });
    return this.last;
  }

  /** Visible text (for the local search index). */
  text(max = 1500) {
    if (!this.html) return '';
    const skip = new Set(['script', 'style', 'title', 'head', 'noscript', 'template', 'svg']);
    let out = '';
    (function rec(n) {
      if (out.length > max * 2) return;
      if (n.type === 'text') out += n.text;
      else if (n.type === 'el') {
        if (skip.has(n.tag)) return;
        out += ' '; // element boundaries separate words (<a>Home</a><a>About</a>)
        for (const c of n.children) rec(c);
        out += ' ';
      }
    }(this.html));
    return out.replace(/\s+/g, ' ').trim().slice(0, max);
  }

  destroy() {
    this.dead = true;
    for (const r of this.images.values()) if (r.img) { r.img.onload = null; r.img.onerror = null; }
  }
}
