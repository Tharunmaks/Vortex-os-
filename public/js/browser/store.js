// Vortex Browser — bookmarks, history and the local search index (per bee, kept in this browser).

const MAX_HISTORY = 300;

export class Store {
  constructor(user) {
    this.key = `vortex.browser.v1.${user}`;
    this.data = { bookmarks: [], history: [] };
    try {
      const raw = JSON.parse(localStorage.getItem(this.key) || 'null');
      if (raw && Array.isArray(raw.bookmarks) && Array.isArray(raw.history)) this.data = raw;
    } catch {
      /* storage unavailable: run in memory */
    }
  }

  save() {
    try {
      localStorage.setItem(this.key, JSON.stringify(this.data));
    } catch {
      /* quota or private mode */
    }
  }

  get bookmarks() {
    return this.data.bookmarks;
  }

  get history() {
    return this.data.history;
  }

  addVisit({ url, title, text }) {
    const h = this.data.history;
    const i = h.findIndex((e) => e.url === url);
    const entry = { url, title: title || url, text: text || '', ts: Date.now(), visits: 1 };
    if (i >= 0) {
      entry.visits = (h[i].visits || 1) + 1;
      h.splice(i, 1);
    }
    h.unshift(entry);
    if (h.length > MAX_HISTORY) h.length = MAX_HISTORY;
    this.save();
  }

  clearHistory() {
    this.data.history = [];
    this.save();
  }

  isBookmarked(url) {
    return this.data.bookmarks.some((b) => b.url === url);
  }

  toggleBookmark(url, title) {
    const b = this.data.bookmarks;
    const i = b.findIndex((e) => e.url === url);
    if (i >= 0) b.splice(i, 1);
    else b.unshift({ url, title: title || url, ts: Date.now() });
    this.save();
    return i < 0;
  }

  /** Search the pages this bee has visited or bookmarked. All words must match somewhere. */
  search(query) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const pool = new Map();
    for (const h of this.data.history) pool.set(h.url, { ...h });
    for (const b of this.data.bookmarks) pool.set(b.url, { ...(pool.get(b.url) || { text: '' }), ...b, bookmarked: true });
    const out = [];
    for (const e of pool.values()) {
      const title = (e.title || '').toLowerCase();
      const url = e.url.toLowerCase();
      const text = (e.text || '').toLowerCase();
      let score = e.bookmarked ? 3 : 0;
      let ok = true;
      for (const t of terms) {
        const inTitle = title.includes(t);
        const inUrl = url.includes(t);
        const inText = text.split(t).length - 1;
        if (!inTitle && !inUrl && !inText) { ok = false; break; }
        score += (inTitle ? 6 : 0) + (inUrl ? 3 : 0) + Math.min(inText, 5);
      }
      if (!ok) continue;
      let snippet = '';
      const at = text.indexOf(terms[0]);
      if (at >= 0) {
        const start = Math.max(0, at - 50);
        snippet = (start ? '… ' : '') + (e.text || '').slice(start, start + 170) + ' …';
      } else snippet = (e.text || '').slice(0, 140);
      out.push({ ...e, score, snippet });
    }
    return out.sort((a, b) => b.score - a.score || b.ts - a.ts).slice(0, 40);
  }
}
