'use strict';
/**
 * Vortex Search — web search for the Vortex Browser.
 *
 * Queries several public search sources in parallel through the SSRF-safe fetcher, parses their
 * result pages on the server, merges and de-duplicates the links, and builds an answer card
 * (Wikipedia summary when available, otherwise the best direct snippet). Sources that fail or
 * challenge the request are skipped, so one blocked engine never breaks search.
 */
const { safeFetch } = require('./browser');

const SEARCH_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
const WIKI_UA = 'VortexOS/1.0 (https://github.com/Tharunmaks/Vortex-os-; MNX Hive search)';
const ENGINE_TIMEOUT_MS = 9000;
const MAX_RESULTS = 20;
const CACHE_MS = 10 * 60_000;
const cache = new Map();

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', middot: '·', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', copy: '©', reg: '®', trade: '™' };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}
const text = (html) => decode(String(html || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

function withTimeout(promise, ms, name) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${name} timed out`)), ms))]);
}

function normalizeUrl(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return null;
    x.hash = '';
    return x.href;
  } catch {
    return null;
  }
}

function dedupeKey(u) {
  try {
    const x = new URL(u);
    return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '') + x.search).toLowerCase();
  } catch {
    return u;
  }
}

// ── DuckDuckGo (HTML endpoint) ──────────────────────────────────────────────

function ddgTarget(href) {
  href = decode(href);
  if (href.startsWith('//')) href = `https:${href}`;
  try {
    const u = new URL(href);
    if (/duckduckgo\.com$/.test(u.hostname) && u.searchParams.get('uddg')) return u.searchParams.get('uddg');
    if (/duckduckgo\.com$/.test(u.hostname)) return null; // ads and internal links
    return u.href;
  } catch {
    return null;
  }
}

function parseDuckDuckGo(html) {
  const out = [];
  const chunks = html.split(/class="result results_links|class="result results_links_deep|class="links_main/);
  for (const chunk of chunks.slice(1)) {
    if (/result--ad|badge--ad/.test(chunk.slice(0, 400))) continue;
    const a = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(chunk) || /<a[^>]*href="([^"]+)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/.exec(chunk);
    if (!a) continue;
    const url = normalizeUrl(ddgTarget(a[1]) || '');
    if (!url) continue;
    const sn = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/.exec(chunk);
    out.push({ title: text(a[2]), url, snippet: sn ? text(sn[1]) : '', source: 'DuckDuckGo' });
  }
  return out;
}

async function duckduckgo(q) {
  const res = await safeFetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=wt-wt`, 'text/html', { 'User-Agent': SEARCH_UA });
  const results = parseDuckDuckGo(res.body.toString('utf8'));
  if (!results.length) throw new Error(res.status === 202 || /anomaly/i.test(res.body.toString('utf8')) ? 'asked for a robot check' : 'no results');
  return results;
}

// ── Bing (HTML) ─────────────────────────────────────────────────────────────

function bingTarget(href) {
  href = decode(href);
  try {
    const u = new URL(href, 'https://www.bing.com/');
    if (/(^|\.)bing\.com$/.test(u.hostname) && u.pathname.startsWith('/ck/')) {
      const enc = u.searchParams.get('u');
      if (enc && enc.startsWith('a1')) {
        const b64 = enc.slice(2).replace(/-/g, '+').replace(/_/g, '/');
        return Buffer.from(b64, 'base64').toString('utf8');
      }
      return null;
    }
    if (/(^|\.)bing\.com$/.test(u.hostname)) return null;
    return u.href;
  } catch {
    return null;
  }
}

function parseBing(html) {
  const out = [];
  const chunks = html.split('<li class="b_algo"');
  for (const chunk of chunks.slice(1)) {
    const block = chunk.split(/<li class="b_(?:algo|ans|pag|ad)/)[0];
    const a = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!a) continue;
    const url = normalizeUrl(bingTarget(a[1]) || '');
    if (!url) continue;
    const sn = /<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(block) || /<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    out.push({ title: text(a[2]), url, snippet: sn ? text(sn[1]).replace(/^(?:\d+\s+(?:minutes?|hours?|days?|weeks?|months?|years?)\s+ago|[A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4}|\d{1,2}\s+[A-Z][a-z]{2,8}\s+\d{4})\s*·\s*/, '') : '', source: 'Bing' });
  }
  return out;
}

async function bing(q) {
  const res = await safeFetch(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en&count=15`, 'text/html', { 'User-Agent': SEARCH_UA });
  const results = parseBing(res.body.toString('utf8'));
  if (!results.length) throw new Error('no results');
  return results;
}

// ── Wikipedia (API) ─────────────────────────────────────────────────────────

async function wikiJson(url) {
  const res = await safeFetch(url, 'application/json', { 'User-Agent': WIKI_UA });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(res.body.toString('utf8'));
}

async function wikipedia(q) {
  const s = await wikiJson(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=5&srsearch=${encodeURIComponent(q)}`);
  const hits = (s.query?.search || []).map((h) => ({
    title: h.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`,
    snippet: text(h.snippet),
    source: 'Wikipedia',
  }));
  let answer = null;
  for (const hit of hits.slice(0, 2)) {
    try {
      const sum = await wikiJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`);
      if (sum.type === 'disambiguation' || !sum.extract) continue;
      answer = { title: sum.title, text: sum.extract, url: sum.content_urls?.desktop?.page || hit.url, source: 'Wikipedia', description: sum.description || '' };
      break;
    } catch {
      /* try the next hit */
    }
  }
  return { hits, answer };
}

// ── Instant answers (live data a snippet can't get right) ───────────────────

const WEATHER_CODES = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog', 51: 'Light drizzle',
  53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Rain showers',
  81: 'Rain showers', 82: 'Violent rain showers', 85: 'Snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm',
  96: 'Thunderstorm with hail', 99: 'Thunderstorm with heavy hail',
};

async function json(url, ua = WIKI_UA) {
  const res = await safeFetch(url, 'application/json', { 'User-Agent': ua });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(res.body.toString('utf8'));
}

async function geocode(place) {
  const g = await json(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en&format=json`);
  const r = g.results?.[0];
  if (!r) return null;
  return { name: [r.name, r.admin1, r.country].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', '), lat: r.latitude, lon: r.longitude, tz: r.timezone };
}

async function weatherAnswer(place) {
  const g = await geocode(place);
  if (!g) return null;
  const w = await json(`https://api.open-meteo.com/v1/forecast?latitude=${g.lat}&longitude=${g.lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1`);
  const c = w.current;
  const d = w.daily;
  if (!c) return null;
  const f = (x) => Math.round(x);
  return {
    kind: 'weather',
    title: `Weather in ${g.name}`,
    big: `${f(c.temperature_2m)}°C · ${WEATHER_CODES[c.weather_code] || 'Weather'}`,
    text: `Feels like ${f(c.apparent_temperature)}°C. Today ${f(d.temperature_2m_min[0])}–${f(d.temperature_2m_max[0])}°C, ${d.precipitation_probability_max[0] ?? 0}% chance of rain. Humidity ${c.relative_humidity_2m}%, wind ${f(c.wind_speed_10m)} km/h.`,
    url: `https://open-meteo.com/en/docs#latitude=${g.lat}&longitude=${g.lon}`,
    source: 'Open-Meteo (live)',
  };
}

async function timeAnswer(place) {
  const g = await geocode(place);
  if (!g || !g.tz) return null;
  const now = new Date();
  return {
    kind: 'time',
    title: `Local time in ${g.name}`,
    big: now.toLocaleTimeString('en-GB', { timeZone: g.tz, hour: '2-digit', minute: '2-digit' }),
    text: `${now.toLocaleDateString('en-GB', { timeZone: g.tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · time zone ${g.tz}`,
    url: '',
    source: 'Vortex clock + Open-Meteo geocoding',
  };
}

async function defineAnswer(word) {
  // Wiktionary first (Wikimedia), then the Free Dictionary API.
  try {
    const d = await json(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`);
    const senses = (d.en || []).slice(0, 3).map((m) => {
      const def = (m.definitions || []).map((x) => text(x.definition)).find((x) => x.length > 3);
      return def ? `(${m.partOfSpeech.toLowerCase()}) ${def}` : null;
    }).filter(Boolean);
    if (senses.length) return { kind: 'define', title: word, big: '', text: senses.join('  '), url: `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}`, source: 'Wiktionary' };
  } catch {
    /* fall through */
  }
  const d = await json(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
  const e = Array.isArray(d) ? d[0] : null;
  if (!e) return null;
  const meanings = (e.meanings || []).slice(0, 3).map((m) => `(${m.partOfSpeech}) ${m.definitions?.[0]?.definition || ''}`).filter((x) => x.length > 4);
  if (!meanings.length) return null;
  return { kind: 'define', title: e.word, big: e.phonetic || '', text: meanings.join('  '), url: e.sourceUrls?.[0] || '', source: 'Free Dictionary' };
}

function instantIntent(q) {
  const l = q.toLowerCase().replace(/[?!.]+$/, '').trim();
  let m = /^(?:what(?:'s| is) the )?weather(?: (?:like )?(?:in|at|for))? (.+)$/.exec(l) || /^(.+?) weather(?: today| now| forecast)?$/.exec(l) || /^(?:temperature|forecast) (?:in|at|for) (.+)$/.exec(l);
  if (m) return ['weather', m[1]];
  m = /^(?:what(?:'s| is) the )?(?:current |local )?time (?:is it )?(?:now )?(?:in|at) (.+)$/.exec(l) || /^what time is it (?:now |right now )?(?:in|at) (.+)$/.exec(l) || /^(.+?) (?:local )?time(?: now)?$/.exec(l);
  if (m && !/\b(how|much|long|many|of)\b/.test(m[1])) return ['time', m[1]];
  m = /^(?:define|definition of|meaning of|what does (.+?) mean)\s*(.*)$/.exec(l);
  if (m) {
    const word = (m[1] || m[2] || '').trim();
    if (/^[a-z-]{2,30}$/.test(word)) return ['define', word];
  }
  return null;
}

async function instant(q) {
  const intent = instantIntent(q);
  if (!intent) return null;
  const [kind, arg] = intent;
  try {
    if (kind === 'weather') return await withTimeout(weatherAnswer(arg), ENGINE_TIMEOUT_MS, 'weather');
    if (kind === 'time') return await withTimeout(timeAnswer(arg), ENGINE_TIMEOUT_MS, 'time');
    if (kind === 'define') return await withTimeout(defineAnswer(arg), ENGINE_TIMEOUT_MS, 'dictionary');
  } catch {
    /* fall back to the normal answer */
  }
  return null;
}

// ── Merge & answer ──────────────────────────────────────────────────────────

const STOP = new Set(['the', 'a', 'an', 'of', 'is', 'are', 'was', 'were', 'what', 'who', 'whom', 'how', 'why', 'when', 'where', 'which', 'do', 'does', 'did', 'in', 'on', 'for', 'to', 'and', 'or', 'it', 'its', 'by', 'with', 'from', 'about', 'can', 'i', 'me', 'my', 'you', 'define', 'definition', 'meaning', 'mean', 'means', 'tell', 'much', 'many', 'tall', 'old', 'long', 'far', 'big', 'high']);
const words = (q) => q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !STOP.has(w));

function relevance(q, snippet) {
  const ws = words(q);
  if (!ws.length) return 0;
  const s = snippet.toLowerCase();
  return ws.filter((w) => s.includes(w)).length / ws.length;
}

/** Reciprocal-rank fusion: results several engines agree on rise to the top. */
function fuse(lists, q) {
  const table = new Map();
  for (const { items, weight } of lists) {
    items.forEach((r, rank) => {
      const k = dedupeKey(r.url);
      const e = table.get(k) || { r, score: 0, engines: new Set() };
      e.score += weight / (8 + rank);
      e.engines.add(r.source);
      if (!e.r.snippet && r.snippet) e.r = { ...e.r, snippet: r.snippet };
      table.set(k, e);
    });
  }
  for (const e of table.values()) e.score += 0.1 * relevance(q, `${e.r.title} ${e.r.snippet}`);
  return [...table.values()].sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS).map((e) => ({ ...e.r, engines: [...e.engines] }));
}

async function wikiSummary(title) {
  const sum = await json(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`);
  if (sum.type === 'disambiguation' || !sum.extract) return null;
  return { kind: 'wiki', title: sum.title, text: sum.extract, description: sum.description || '', url: sum.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`, source: 'Wikipedia' };
}

/** The Wikipedia article the web itself ranks highest is the most reliable encyclopedic answer. */
async function wikiFromResults(results) {
  for (const r of results.slice(0, 5)) {
    const m = /^https?:\/\/en\.(?:m\.)?wikipedia\.org\/wiki\/([^?#]+)/.exec(r.url);
    if (!m) continue;
    const title = decodeURIComponent(m[1]);
    if (/^(Special|Talk|User|Category|File|Help|Portal|Template|Wikipedia|List_of):?/i.test(title)) continue;
    try {
      const s = await withTimeout(wikiSummary(title), 6000, 'Wikipedia');
      if (s) return s;
    } catch {
      /* next */
    }
  }
  return null;
}

/** Search the web. Returns { query, answer, results, sources }. */
async function search(rawQuery) {
  const q = String(rawQuery || '').trim().slice(0, 300);
  if (!q) return { query: q, answer: null, results: [], sources: [] };
  const key = q.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit.value, cached: true };

  const engines = [
    ['DuckDuckGo', duckduckgo, 1],
    ['Bing', bing, 1],
  ];
  const [webResults, wiki, inst] = await Promise.all([
    Promise.allSettled(engines.map(([name, fn]) => withTimeout(fn(q), ENGINE_TIMEOUT_MS, name))),
    withTimeout(wikipedia(q), ENGINE_TIMEOUT_MS, 'Wikipedia').then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })),
    instant(q),
  ]);

  const sources = engines.map(([name], i) => ({
    name,
    ok: webResults[i].status === 'fulfilled',
    count: webResults[i].status === 'fulfilled' ? webResults[i].value.length : 0,
    error: webResults[i].status === 'rejected' ? String(webResults[i].reason?.message || webResults[i].reason) : undefined,
  }));
  sources.push({ name: 'Wikipedia', ok: wiki.ok, count: wiki.ok ? wiki.v.hits.length : 0, error: wiki.ok ? undefined : String(wiki.e?.message || wiki.e) });

  const lists = engines.map(([, , weight], i) => ({ items: webResults[i].status === 'fulfilled' ? webResults[i].value : [], weight }));
  const webCount = lists.reduce((a, l) => a + l.items.length, 0);
  // Wikipedia's own search is a weak ranker: a small vote normally, the main list only when engines fail.
  if (wiki.ok) lists.push({ items: wiki.v.hits, weight: webCount ? 0.35 : 1 });
  const merged = fuse(lists, q);

  let answer = inst;
  // "How tall/how many/when…" want a number: a snippet that contains one beats an encyclopedia intro.
  if (!answer && /^(how (much|many|tall|old|long|far|big|high|deep|heavy|fast)|when\b|what year|what time|how much does)/i.test(q)) {
    const numeric = merged.slice(0, 6).filter((r) => r.snippet && /\d/.test(r.snippet))
      .map((r) => ({ r, rel: relevance(q, `${r.title} ${r.snippet}`) }))
      .sort((x, y) => y.rel - x.rel)[0];
    if (numeric && numeric.rel >= 0.6) answer = { kind: 'snippet', title: numeric.r.title, text: numeric.r.snippet, url: numeric.r.url, source: numeric.r.source };
  }
  if (!answer) answer = await wikiFromResults(merged);
  if (!answer && wiki.ok && wiki.v.answer && relevance(q, wiki.v.answer.title) >= 0.99) answer = { kind: 'wiki', ...wiki.v.answer };
  if (!answer) {
    const best = merged.slice(0, 6).filter((r) => r.snippet && r.snippet.length > 40)
      .map((r) => ({ r, rel: relevance(q, `${r.title} ${r.snippet}`) }))
      .sort((a, b) => b.rel - a.rel)[0];
    if (best && best.rel >= 0.6) answer = { kind: 'snippet', title: best.r.title, text: best.r.snippet, url: best.r.url, source: best.r.source };
  }

  const value = { query: q, answer, results: merged, sources };
  if (merged.length) {
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
  }
  return value;
}

module.exports = { search, parseDuckDuckGo, parseBing, bingTarget, ddgTarget, relevance, instantIntent, fuse };
