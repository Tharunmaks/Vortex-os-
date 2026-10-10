// Vortex Engine — CSS: parser, selector matching, cascade and computed styles (from scratch).

// ── Colours ─────────────────────────────────────────────────────────────────

const NAMED_COLORS = {
  black: '#000000', silver: '#c0c0c0', gray: '#808080', grey: '#808080', white: '#ffffff', maroon: '#800000', red: '#ff0000',
  purple: '#800080', fuchsia: '#ff00ff', magenta: '#ff00ff', green: '#008000', lime: '#00ff00', olive: '#808000', yellow: '#ffff00',
  navy: '#000080', blue: '#0000ff', teal: '#008080', aqua: '#00ffff', cyan: '#00ffff', orange: '#ffa500', pink: '#ffc0cb',
  brown: '#a52a2a', gold: '#ffd700', indigo: '#4b0082', violet: '#ee82ee', coral: '#ff7f50', crimson: '#dc143c',
  tomato: '#ff6347', salmon: '#fa8072', khaki: '#f0e68c', plum: '#dda0dd', orchid: '#da70d6', tan: '#d2b48c', beige: '#f5f5dc',
  ivory: '#fffff0', lavender: '#e6e6fa', turquoise: '#40e0d0', skyblue: '#87ceeb', steelblue: '#4682b4', royalblue: '#4169e1',
  dodgerblue: '#1e90ff', deepskyblue: '#00bfff', slategray: '#708090', slategrey: '#708090', lightgray: '#d3d3d3', lightgrey: '#d3d3d3',
  darkgray: '#a9a9a9', darkgrey: '#a9a9a9', dimgray: '#696969', dimgrey: '#696969', gainsboro: '#dcdcdc', whitesmoke: '#f5f5f5',
  snow: '#fffafa', honeydew: '#f0fff0', azure: '#f0ffff', aliceblue: '#f0f8ff', ghostwhite: '#f8f8ff', seashell: '#fff5ee',
  linen: '#faf0e6', wheat: '#f5deb3', chocolate: '#d2691e', sienna: '#a0522d', peru: '#cd853f', firebrick: '#b22222',
  darkred: '#8b0000', darkgreen: '#006400', darkblue: '#00008b', darkorange: '#ff8c00', darkviolet: '#9400d3', hotpink: '#ff69b4',
  deeppink: '#ff1493', lightblue: '#add8e6', lightgreen: '#90ee90', lightyellow: '#ffffe0', lightpink: '#ffb6c1', limegreen: '#32cd32',
  forestgreen: '#228b22', seagreen: '#2e8b57', springgreen: '#00ff7f', midnightblue: '#191970', mediumpurple: '#9370db',
  rebeccapurple: '#663399', goldenrod: '#daa520', darkgoldenrod: '#b8860b', cornflowerblue: '#6495ed', cadetblue: '#5f9ea0',
  mintcream: '#f5fffa', moccasin: '#ffe4b5', papayawhip: '#ffefd5', peachpuff: '#ffdab9', bisque: '#ffe4c4', cornsilk: '#fff8dc',
  lemonchiffon: '#fffacd', oldlace: '#fdf5e6', floralwhite: '#fffaf0', antiquewhite: '#faebd7', burlywood: '#deb887', navajowhite: '#ffdead',
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function hslToRgb(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/** Returns a canvas-ready colour string, 'transparent', or null when invalid. */
export function parseColor(v, current = '#000000') {
  v = String(v).trim().toLowerCase();
  if (!v) return null;
  if (v === 'transparent') return 'transparent';
  if (v === 'currentcolor') return current;
  if (NAMED_COLORS[v]) return NAMED_COLORS[v];
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = [...h].map((c) => parseInt(c + c, 16));
      return a === undefined ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
    }
    if (h.length === 6) return `#${h}`;
    if (h.length === 8) return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${(parseInt(h.slice(6), 16) / 255).toFixed(3)})`;
    return null;
  }
  m = /^(rgba?|hsla?)\(\s*([^)]*)\)$/.exec(v);
  if (m) {
    const parts = m[2].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const num = (p, scale) => (p.endsWith('%') ? (parseFloat(p) / 100) * scale : parseFloat(p));
    let a = parts[3] === undefined ? 1 : clamp(num(parts[3], 1), 0, 1);
    if (m[1].startsWith('rgb')) {
      const rgb = parts.slice(0, 3).map((p) => Math.round(clamp(num(p, 255), 0, 255)));
      if (rgb.some(Number.isNaN)) return null;
      return a >= 1 ? `rgb(${rgb})` : `rgba(${rgb},${a})`;
    }
    const h = parseFloat(parts[0]);
    const sat = clamp(parseFloat(parts[1]) / 100, 0, 1);
    const lig = clamp(parseFloat(parts[2]) / 100, 0, 1);
    if ([h, sat, lig].some(Number.isNaN)) return null;
    const rgb = hslToRgb(h, sat, lig);
    return a >= 1 ? `rgb(${rgb})` : `rgba(${rgb},${a})`;
  }
  return null;
}

// ── Lengths ─────────────────────────────────────────────────────────────────
// A length is { px, pct } (a linear combination, which is exactly what calc() produces) or 'auto'.

const ZERO = Object.freeze({ px: 0, pct: 0 });
const UNITS = {
  px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6,
};

export function parseLength(v, env) {
  v = String(v).trim().toLowerCase();
  if (v === 'auto') return 'auto';
  if (/^(calc|min|max|clamp)\(/.test(v)) return parseCalc(v, env);
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)$/.exec(v);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const u = m[2];
  if (u === '') return n === 0 ? ZERO : null;
  if (u === '%') return { px: 0, pct: n };
  if (u in UNITS) return { px: n * UNITS[u], pct: 0 };
  if (u === 'em') return { px: n * env.fs, pct: 0 };
  if (u === 'rem') return { px: n * env.rfs, pct: 0 };
  if (u === 'ex' || u === 'ch') return { px: n * env.fs * 0.5, pct: 0 };
  if (u === 'vw') return { px: (n * env.vw) / 100, pct: 0 };
  if (u === 'vh') return { px: (n * env.vh) / 100, pct: 0 };
  if (u === 'vmin') return { px: (n * Math.min(env.vw, env.vh)) / 100, pct: 0 };
  if (u === 'vmax') return { px: (n * Math.max(env.vw, env.vh)) / 100, pct: 0 };
  return null;
}

/** calc()/min()/max()/clamp() evaluated to a linear { px, pct }. */
function parseCalc(src, env) {
  let i = 0;
  const peek = () => src[i];
  const ws = () => { while (src[i] === ' ') i++; };
  const num = (px, pct = 0, unitless = false) => ({ px, pct, unitless });
  function factor() {
    ws();
    if (src[i] === '(') {
      i++;
      const v = expr();
      ws();
      if (src[i] === ')') i++;
      return v;
    }
    const fn = /^(calc|min|max|clamp)\(/.exec(src.slice(i));
    if (fn) {
      i += fn[0].length;
      const args = [];
      for (;;) {
        args.push(expr());
        ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === ')') i++;
        break;
      }
      if (fn[1] === 'calc') return args[0];
      const pure = args.every((a) => a && a.pct === 0);
      if (!pure) return args[0];
      const px = args.map((a) => a.px);
      if (fn[1] === 'min') return num(Math.min(...px));
      if (fn[1] === 'max') return num(Math.max(...px));
      return num(clamp(px[1] ?? 0, px[0] ?? -Infinity, px[2] ?? Infinity));
    }
    const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?[a-z%]*/.exec(src.slice(i));
    if (!m) throw new Error('calc');
    i += m[0].length;
    const mm = /^([+-]?[\d.e+-]+?)([a-z%]*)$/.exec(m[0]);
    if (mm && mm[2] === '') return num(parseFloat(mm[1]), 0, true);
    const l = parseLength(m[0], env);
    if (!l || l === 'auto') throw new Error('calc');
    return num(l.px, l.pct);
  }
  function term() {
    let a = factor();
    for (;;) {
      ws();
      const op = peek();
      if (op !== '*' && op !== '/') return a;
      i++;
      const b = factor();
      if (op === '*') {
        if (a.unitless) a = num(b.px * a.px, b.pct * a.px, b.unitless);
        else if (b.unitless) a = num(a.px * b.px, a.pct * b.px, false);
        else throw new Error('calc');
      } else {
        if (!b.unitless || b.px === 0) throw new Error('calc');
        a = num(a.px / b.px, a.pct / b.px, a.unitless);
      }
    }
  }
  function expr() {
    let a = term();
    for (;;) {
      ws();
      const op = peek();
      if (op !== '+' && op !== '-') return a;
      i++;
      const b = term();
      a = op === '+' ? num(a.px + b.px, a.pct + b.pct) : num(a.px - b.px, a.pct - b.pct);
    }
  }
  try {
    src = src.replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').replace(/([^\s(,*/+-])([+-])(?=[\d.])/g, '$1 $2');
    const r = expr();
    return { px: r.px, pct: r.pct };
  } catch {
    return null;
  }
}

export function resolveLen(len, base) {
  if (len === 'auto' || len === null || len === undefined) return null;
  return len.px + (len.pct * base) / 100;
}

// ── Value helpers ───────────────────────────────────────────────────────────

/** Split on spaces/commas at the top level (not inside parentheses or strings). */
export function splitTop(s, sep = /\s/) {
  const out = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (const ch of s) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === '(') {
      depth++;
      cur += ch;
    } else if (ch === ')') {
      depth--;
      cur += ch;
    } else if (depth === 0 && sep.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function substVars(v, vars, depth = 0) {
  if (!v.includes('var(')) return v;
  if (depth > 8) return null;
  let out = '';
  let i = 0;
  while (i < v.length) {
    const at = v.indexOf('var(', i);
    if (at < 0) {
      out += v.slice(i);
      break;
    }
    out += v.slice(i, at);
    let j = at + 4;
    let d = 1;
    while (j < v.length && d > 0) {
      if (v[j] === '(') d++;
      else if (v[j] === ')') d--;
      j++;
    }
    const inner = v.slice(at + 4, j - 1);
    const comma = inner.indexOf(',');
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? null : inner.slice(comma + 1).trim();
    let val = vars[name];
    if (val === undefined) val = fallback;
    if (val === null || val === undefined) return null;
    const sub = substVars(val, vars, depth + 1);
    if (sub === null) return null;
    out += sub;
    i = j;
  }
  return out;
}

// ── Stylesheet parsing ──────────────────────────────────────────────────────

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

function matchBrace(s, i) {
  let depth = 0;
  let quote = '';
  for (; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return s.length;
}

export function parseDeclarations(block) {
  const out = [];
  for (const part of splitTop(block, /;/)) {
    const c = part.indexOf(':');
    if (c < 0) continue;
    let prop = part.slice(0, c).trim();
    let value = part.slice(c + 1).trim();
    if (!prop || !value) continue;
    if (!prop.startsWith('--')) prop = prop.toLowerCase();
    let important = false;
    const im = /\s*!\s*important\s*$/i.exec(value);
    if (im) {
      important = true;
      value = value.slice(0, im.index).trim();
    }
    out.push({ prop, value, important });
  }
  return out;
}

export function evalMedia(query, vw, vh) {
  const list = query.split(',');
  return list.some((q) => {
    q = q.trim().toLowerCase();
    if (!q) return true;
    let negate = false;
    if (q.startsWith('not ')) { negate = true; q = q.slice(4); }
    q = q.replace(/^only\s+/, '');
    const ok = q.split(/\s+and\s+/).every((cond) => {
      cond = cond.trim();
      if (cond === 'screen' || cond === 'all' || cond === '') return true;
      if (cond === 'print' || cond === 'speech' || cond === 'tv') return false;
      const m = /^\(\s*([a-z-]+)\s*(?::\s*([^)]+))?\)$/.exec(cond);
      if (!m) return false;
      const [, f, raw] = m;
      const val = raw ? parseLength(raw.trim(), { fs: 16, rfs: 16, vw, vh }) : null;
      const px = val && val !== 'auto' ? val.px : NaN;
      switch (f) {
        case 'min-width': return vw >= px;
        case 'max-width': return vw <= px;
        case 'min-height': return vh >= px;
        case 'max-height': return vh <= px;
        case 'orientation': return raw && raw.trim() === (vw >= vh ? 'landscape' : 'portrait');
        case 'hover': return raw?.trim() === 'hover';
        case 'pointer': return raw?.trim() === 'fine';
        case 'prefers-color-scheme': return raw?.trim() === 'light';
        case 'color': return true;
        default: return false;
      }
    });
    return negate ? !ok : ok;
  });
}

/** Parse a stylesheet. Returns { rules, imports }. */
export function parseStylesheet(text, env = { vw: 1024, vh: 768 }, origin = 1) {
  const rules = [];
  const imports = [];
  let order = 0;
  function run(src) {
    let i = 0;
    while (i < src.length) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (i >= src.length) break;
      if (src[i] === '@') {
        const semi = src.indexOf(';', i);
        const brace = src.indexOf('{', i);
        if (brace < 0 || (semi >= 0 && semi < brace)) {
          const stmt = src.slice(i, semi < 0 ? src.length : semi);
          const im = /^@import\s+(?:url\(\s*)?["']?([^"')\s]+)["']?\s*\)?\s*(.*)$/i.exec(stmt);
          if (im && (!im[2] || evalMedia(im[2], env.vw, env.vh))) imports.push(im[1]);
          i = semi < 0 ? src.length : semi + 1;
          continue;
        }
        const end = matchBrace(src, brace);
        const head = src.slice(i, brace).trim();
        const inner = src.slice(brace + 1, end);
        const name = /^@([\w-]+)/.exec(head)[1].toLowerCase();
        if (name === 'media') {
          if (evalMedia(head.slice(6), env.vw, env.vh)) run(inner);
        } else if (name === 'supports' || name === 'layer' || name === 'container' || name === 'document') run(inner);
        i = end + 1;
        continue;
      }
      const brace = src.indexOf('{', i);
      if (brace < 0) break;
      const end = matchBrace(src, brace);
      const selText = src.slice(i, brace).trim();
      const decls = parseDeclarations(src.slice(brace + 1, end));
      i = end + 1;
      if (!decls.length) continue;
      for (const sel of parseSelectorList(selText)) {
        rules.push({ sel, spec: sel.spec, decls, order: order++, origin });
      }
    }
  }
  run(stripComments(text));
  return { rules, imports };
}

// ── Selectors ───────────────────────────────────────────────────────────────

const IDENT = /(?:[\w-]|[^\x00-\x7f]|\\.)+/y;
const unescapeIdent = (s) => s.replace(/\\(.)/g, '$1');

function parseCompound(s, i) {
  const c = { tag: null, id: null, classes: [], attrs: [], pseudos: [], never: false, a: 0, b: 0, c: 0 };
  const start = i;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch) || ch === '>' || ch === '+' || ch === '~' || ch === ',') break;
    if (ch === '*') {
      c.tag = '*';
      i++;
    } else if (ch === '#' || ch === '.') {
      IDENT.lastIndex = i + 1;
      const m = IDENT.exec(s);
      if (!m) return null;
      if (ch === '#') { c.id = unescapeIdent(m[0]); c.a++; } else { c.classes.push(unescapeIdent(m[0])); c.b++; }
      i = IDENT.lastIndex;
    } else if (ch === '[') {
      let j = i + 1;
      let quote = '';
      for (; j < s.length; j++) {
        if (quote) { if (s[j] === quote) quote = ''; } else if (s[j] === '"' || s[j] === "'") quote = s[j];
        else if (s[j] === ']') break;
      }
      const inner = s.slice(i + 1, j).trim();
      const m = /^([\w:-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))\s*([iIsS])?)?$/.exec(inner);
      if (!m) return null;
      c.attrs.push({ name: m[1].toLowerCase(), op: m[2] || null, val: m[3] ?? m[4] ?? m[5] ?? '', ci: /i/i.test(m[6] || '') });
      c.b++;
      i = j + 1;
    } else if (ch === ':') {
      if (s[i + 1] === ':') {
        IDENT.lastIndex = i + 2;
        IDENT.exec(s);
        c.never = true;
        c.c++;
        i = IDENT.lastIndex || i + 2;
        continue;
      }
      IDENT.lastIndex = i + 1;
      const m = IDENT.exec(s);
      if (!m) return null;
      const name = m[0].toLowerCase();
      i = IDENT.lastIndex;
      let arg = null;
      if (s[i] === '(') {
        let d = 0;
        let j = i;
        for (; j < s.length; j++) {
          if (s[j] === '(') d++;
          else if (s[j] === ')' && --d === 0) break;
        }
        arg = s.slice(i + 1, j);
        i = j + 1;
      }
      if (name === 'not' || name === 'is' || name === 'where' || name === 'matches') {
        const list = parseSelectorList(arg || '');
        if (!list.length) c.never = true;
        const top = Math.max(0, ...list.map((l) => l.spec));
        if (name !== 'where') { c.a += Math.floor(top / 10000); c.b += Math.floor((top % 10000) / 100); c.c += top % 100; }
        c.pseudos.push({ name: name === 'matches' ? 'is' : name, list });
      } else if (/^nth-(last-)?(child|of-type)$/.test(name)) {
        c.pseudos.push({ name, nth: parseNth(arg || '') });
        c.b++;
      } else if (['first-child', 'last-child', 'only-child', 'first-of-type', 'last-of-type', 'only-of-type', 'root', 'empty', 'link',
        'any-link', 'checked', 'disabled', 'enabled', 'read-only', 'required', 'optional'].includes(name)) {
        c.pseudos.push({ name });
        c.b++;
      } else c.never = true; // :hover, :focus, :visited, … never match in a static render
    } else {
      IDENT.lastIndex = i;
      const m = IDENT.exec(s);
      if (!m) return null;
      c.tag = unescapeIdent(m[0]).toLowerCase();
      c.c++;
      i = IDENT.lastIndex;
    }
  }
  return i === start ? null : [c, i];
}

function parseNth(arg) {
  arg = arg.trim().toLowerCase().replace(/\s+/g, '');
  if (arg === 'odd') return [2, 1];
  if (arg === 'even') return [2, 0];
  const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(arg);
  if (m) return [m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0];
  const n = parseInt(arg, 10);
  return Number.isNaN(n) ? [0, -1] : [0, n];
}

function parseComplex(s) {
  s = s.trim();
  const parts = [];
  let i = 0;
  let comb = null;
  const spec = { a: 0, b: 0, c: 0 };
  while (i < s.length) {
    const r = parseCompound(s, i);
    if (!r) return null;
    parts.push({ comb, c: r[0] });
    spec.a += r[0].a;
    spec.b += r[0].b;
    spec.c += r[0].c;
    i = r[1];
    const m = /^\s*([>+~])\s*|^\s+/.exec(s.slice(i));
    if (!m) break;
    comb = m[1] || ' ';
    i += m[0].length;
  }
  if (!parts.length || i < s.length) return null;
  return { parts, spec: spec.a * 10000 + spec.b * 100 + spec.c };
}

export function parseSelectorList(text) {
  return splitTop(text, /,/).map((p) => parseComplex(p)).filter(Boolean);
}

function ensureIndex(parent) {
  if (parent._els) return;
  parent._els = parent.children.filter((c) => c.type === 'el');
  parent._els.forEach((c, i) => { c._ei = i; });
}

function nthMatch([a, b], pos) {
  if (a === 0) return pos === b;
  const k = (pos - b) / a;
  return Number.isInteger(k) && k >= 0;
}

function matchCompound(el, c) {
  if (c.never) return false;
  if (c.tag && c.tag !== '*' && el.tag !== c.tag) return false;
  if (c.id !== null && el.attrs.id !== c.id) return false;
  if (c.classes.length) {
    const cls = el._cls || (el._cls = new Set((el.attrs.class || '').split(/\s+/).filter(Boolean)));
    for (const k of c.classes) if (!cls.has(k)) return false;
  }
  for (const a of c.attrs) {
    const v = el.attrs[a.name];
    if (v === undefined) return false;
    if (!a.op) continue;
    const x = a.ci ? v.toLowerCase() : v;
    const y = a.ci ? a.val.toLowerCase() : a.val;
    switch (a.op) {
      case '=': if (x !== y) return false; break;
      case '~=': if (!x.split(/\s+/).includes(y)) return false; break;
      case '|=': if (x !== y && !x.startsWith(`${y}-`)) return false; break;
      case '^=': if (!y || !x.startsWith(y)) return false; break;
      case '$=': if (!y || !x.endsWith(y)) return false; break;
      case '*=': if (!y || !x.includes(y)) return false; break;
      default: return false;
    }
  }
  for (const p of c.pseudos) {
    const parent = el.parent;
    switch (p.name) {
      case 'root': if (el.tag !== 'html') return false; break;
      case 'empty': if (el.children.some((k) => k.type === 'el' || k.text.trim())) return false; break;
      case 'link': case 'any-link': if (!(el.tag === 'a' || el.tag === 'area') || el.attrs.href === undefined) return false; break;
      case 'checked': if (el.attrs.checked === undefined && el.attrs.selected === undefined) return false; break;
      case 'disabled': if (el.attrs.disabled === undefined) return false; break;
      case 'enabled': if (el.attrs.disabled !== undefined) return false; break;
      case 'required': if (el.attrs.required === undefined) return false; break;
      case 'optional': if (el.attrs.required !== undefined) return false; break;
      case 'read-only': break;
      case 'not': if (p.list.some((l) => matchComplex(el, l.parts))) return false; break;
      case 'is': case 'where': if (!p.list.some((l) => matchComplex(el, l.parts))) return false; break;
      default: {
        if (!parent) return false;
        ensureIndex(parent);
        const sibs = parent._els;
        const ofType = /type$/.test(p.name);
        const pool = ofType ? sibs.filter((s) => s.tag === el.tag) : sibs;
        const idx = pool.indexOf(el);
        const last = pool.length - 1 - idx;
        if (p.name === 'first-child' || p.name === 'first-of-type') { if (idx !== 0) return false; }
        else if (p.name === 'last-child' || p.name === 'last-of-type') { if (last !== 0) return false; }
        else if (p.name === 'only-child' || p.name === 'only-of-type') { if (pool.length !== 1) return false; }
        else if (p.name.startsWith('nth-last')) { if (!nthMatch(p.nth, last + 1)) return false; }
        else if (p.name.startsWith('nth-')) { if (!nthMatch(p.nth, idx + 1)) return false; }
      }
    }
  }
  return true;
}

function matchComplex(el, parts, idx = parts.length - 1) {
  if (!matchCompound(el, parts[idx].c)) return false;
  if (idx === 0) return true;
  const comb = parts[idx].comb;
  if (comb === '>') {
    const p = el.parent;
    return !!p && p.type === 'el' && matchComplex(p, parts, idx - 1);
  }
  if (comb === ' ') {
    for (let p = el.parent; p && p.type === 'el'; p = p.parent) if (matchComplex(p, parts, idx - 1)) return true;
    return false;
  }
  const parent = el.parent;
  if (!parent) return false;
  ensureIndex(parent);
  const sibs = parent._els;
  if (comb === '+') return el._ei > 0 && matchComplex(sibs[el._ei - 1], parts, idx - 1);
  for (let k = el._ei - 1; k >= 0; k--) if (matchComplex(sibs[k], parts, idx - 1)) return true;
  return false;
}

// ── Rule index ──────────────────────────────────────────────────────────────

export class RuleIndex {
  constructor() {
    this.byId = new Map();
    this.byClass = new Map();
    this.byTag = new Map();
    this.universal = [];
  }

  add(rules) {
    for (const r of rules) {
      const key = r.sel.parts[r.sel.parts.length - 1].c;
      const push = (map, k) => {
        const l = map.get(k);
        if (l) l.push(r);
        else map.set(k, [r]);
      };
      if (key.never) continue;
      if (key.id !== null) push(this.byId, key.id);
      else if (key.classes.length) push(this.byClass, key.classes[0]);
      else if (key.tag && key.tag !== '*') push(this.byTag, key.tag);
      else this.universal.push(r);
    }
  }

  matching(el) {
    const out = [];
    const test = (list) => {
      if (!list) return;
      for (const r of list) if (matchComplex(el, r.sel.parts)) out.push(r);
    };
    test(this.universal);
    test(this.byTag.get(el.tag));
    if (el.attrs.id) test(this.byId.get(el.attrs.id));
    if (el.attrs.class) for (const k of new Set(el.attrs.class.split(/\s+/))) test(this.byClass.get(k));
    return out;
  }
}

// ── Computed style ──────────────────────────────────────────────────────────

const FONT_SIZES = { 'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48 };
const BORDER_W = { thin: 1, medium: 3, thick: 5 };
const SIDES = ['top', 'right', 'bottom', 'left'];

function rootStyle() {
  return {
    display: 'block', color: '#000000', fontFamily: 'sans', fontSize: 16, fontWeight: 400, fontStyle: 'normal',
    lineHeight: null, lineHeightNum: null, textAlign: 'left', whiteSpace: 'normal', textTransform: 'none',
    listStyleType: 'disc', visibility: 'visible', href: null, deco: null, vars: {}, rootFontSize: 16,
  };
}

function newStyle(ps) {
  return {
    // inherited
    color: ps.color, fontFamily: ps.fontFamily, fontSize: ps.fontSize, fontWeight: ps.fontWeight, fontStyle: ps.fontStyle,
    lineHeight: ps.lineHeight, lineHeightNum: ps.lineHeightNum, textAlign: ps.textAlign, whiteSpace: ps.whiteSpace,
    textTransform: ps.textTransform, listStyleType: ps.listStyleType, visibility: ps.visibility, href: ps.href, deco: ps.deco,
    vars: ps.vars, rootFontSize: ps.rootFontSize,
    // not inherited
    display: 'inline', position: 'static', float: 'none', opacity: 1, boxSizing: 'content-box',
    bg: null, radius: 0,
    width: 'auto', height: 'auto', minWidth: 'auto', maxWidth: 'none', minHeight: 'auto', maxHeight: 'none',
    margin: [ZERO, ZERO, ZERO, ZERO], padding: [ZERO, ZERO, ZERO, ZERO],
    bw: [0, 0, 0, 0], bc: [null, null, null, null], bs: ['none', 'none', 'none', 'none'],
    flexDirection: 'row', flexWrap: 'nowrap', flexGrow: 0, flexShrink: 1, flexBasis: 'auto', justify: 'flex-start',
    alignItems: 'stretch', alignSelf: 'auto', gapRow: 0, gapCol: 0, gridCols: null, order: 0,
    valign: null, borderCollapse: 'separate', borderSpacing: 2, textIndent: 0, overflow: 'visible',
    cellpadding: null, tableBorder: 0,
  };
}

function expand(map, prop, value, env) {
  const set = (k, v) => map.set(k, v);
  const box = (name, v) => {
    const t = splitTop(v);
    if (!t.length || t.length > 4) return;
    const [a, b = a, c = a, d = b] = t;
    [a, b, c, d].forEach((x, i) => set(`${name}-${SIDES[i]}`, x));
  };
  const borderParts = (v) => {
    let w = null;
    let st = null;
    let col = null;
    for (const tok of splitTop(v)) {
      const l = tok.toLowerCase();
      if (['none', 'hidden', 'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset'].includes(l)) st = l;
      else if (BORDER_W[l] !== undefined || parseLength(l, env) !== null) w = l;
      else col = tok;
    }
    return { w, st, col };
  };
  switch (prop) {
    case 'margin': case 'padding': box(prop, value); break;
    case 'border-width': box('border-width', value); break;
    case 'border-style': box('border-style', value); break;
    case 'border-color': box('border-color', value); break;
    case 'border': case 'border-top': case 'border-right': case 'border-bottom': case 'border-left': {
      const sides = prop === 'border' ? SIDES : [prop.slice(7)];
      const { w, st, col } = borderParts(value);
      for (const sd of sides) {
        set(`border-${sd}-style`, st ?? (w || col ? 'solid' : 'none'));
        set(`border-${sd}-width`, w ?? 'medium');
        if (col) set(`border-${sd}-color`, col);
      }
      break;
    }
    case 'border-top-width': case 'border-right-width': case 'border-bottom-width': case 'border-left-width':
    case 'border-top-style': case 'border-right-style': case 'border-bottom-style': case 'border-left-style':
    case 'border-top-color': case 'border-right-color': case 'border-bottom-color': case 'border-left-color':
      set(prop, value);
      break;
    case 'background': {
      let color = null;
      for (const tok of splitTop(value)) {
        if (/^(url|linear-gradient|radial-gradient|conic-gradient|repeating-)/i.test(tok)) continue;
        const c = parseColor(tok);
        if (c) color = tok;
      }
      set('background-color', color ?? 'transparent');
      break;
    }
    case 'font': {
      const toks = splitTop(value);
      const sizeIdx = toks.findIndex((t) => /^(\d|\.|xx?-|small|medium|large|larger|smaller)/i.test(t) && !/^(normal|bold|italic|oblique)$/i.test(t) && !/^\d{3}$/.test(t));
      if (sizeIdx < 0) break;
      const [size, lh] = toks[sizeIdx].split('/');
      set('font-size', size);
      if (lh) set('line-height', lh);
      for (const t of toks.slice(0, sizeIdx)) {
        if (/^(italic|oblique)$/i.test(t)) set('font-style', 'italic');
        else if (/^(bold|bolder|[1-9]00)$/i.test(t)) set('font-weight', t);
      }
      set('font-family', toks.slice(sizeIdx + 1).join(' '));
      break;
    }
    case 'list-style': {
      const t = splitTop(value.toLowerCase()).find((x) => ['disc', 'circle', 'square', 'decimal', 'none', 'lower-alpha', 'upper-alpha', 'lower-roman', 'upper-roman', 'lower-latin', 'upper-latin'].includes(x));
      if (t) set('list-style-type', t);
      break;
    }
    case 'flex': {
      const t = splitTop(value.toLowerCase());
      if (t[0] === 'none') { set('flex-grow', '0'); set('flex-shrink', '0'); break; }
      if (t[0] === 'auto') { set('flex-grow', '1'); set('flex-shrink', '1'); break; }
      if (/^[\d.]+$/.test(t[0])) {
        set('flex-grow', t[0]);
        if (t[1] && /^[\d.]+$/.test(t[1])) { set('flex-shrink', t[1]); if (t[2]) set('flex-basis', t[2]); }
        else { if (t[1]) set('flex-basis', t[1]); set('flex-basis', t[1] ?? '0px'); }
        if (!t[1]) set('flex-basis', '0px');
      } else set('flex-basis', t[0]);
      break;
    }
    case 'flex-flow': {
      for (const tok of splitTop(value.toLowerCase())) {
        if (tok.startsWith('wrap') || tok === 'nowrap') set('flex-wrap', tok);
        else set('flex-direction', tok);
      }
      break;
    }
    case 'gap': case 'grid-gap': {
      const t = splitTop(value);
      set('row-gap', t[0]);
      set('column-gap', t[1] ?? t[0]);
      break;
    }
    case 'grid-row-gap': set('row-gap', value); break;
    case 'grid-column-gap': set('column-gap', value); break;
    case 'text-decoration': {
      const t = splitTop(value.toLowerCase()).find((x) => ['none', 'underline', 'line-through', 'overline'].includes(x));
      if (t) set('text-decoration-line', t);
      break;
    }
    case 'overflow': set('overflow', splitTop(value)[0]); break;
    case 'border-spacing': set('border-spacing', splitTop(value)[0]); break;
    default: set(prop, value);
  }
}

function lengthOrNull(v, env) {
  const l = parseLength(v, env);
  return l;
}

function applyMap(s, map, ps, el, env) {
  const fsEnv = { fs: ps.fontSize, rfs: ps.rootFontSize, vw: env.vw, vh: env.vh };
  // font-size first: other em units depend on it.
  const fsv = map.get('font-size');
  if (fsv !== undefined) {
    const v = fsv.toLowerCase();
    if (v === 'inherit') s.fontSize = ps.fontSize;
    else if (FONT_SIZES[v]) s.fontSize = FONT_SIZES[v];
    else if (v === 'larger') s.fontSize = ps.fontSize * 1.2;
    else if (v === 'smaller') s.fontSize = ps.fontSize / 1.2;
    else {
      const l = parseLength(v, fsEnv);
      if (l && l !== 'auto') s.fontSize = Math.max(0, l.px + (l.pct * ps.fontSize) / 100);
    }
  }
  if (el.tag === 'html') s.rootFontSize = s.fontSize;
  const e = { fs: s.fontSize, rfs: s.rootFontSize, vw: env.vw, vh: env.vh };
  const color = (v) => parseColor(v, s.color);
  const colorV = map.get('color');
  if (colorV !== undefined) {
    if (colorV.toLowerCase() === 'inherit') s.color = ps.color;
    else {
      const c = parseColor(colorV, ps.color);
      if (c && c !== 'transparent') s.color = c;
    }
  }
  for (const [prop, raw] of map) {
    const v = raw.trim();
    const lv = v.toLowerCase();
    if (lv === 'initial' || lv === 'unset' || lv === 'revert') continue;
    switch (prop) {
      case 'display': s.display = lv.split(/\s+/)[0] === 'inline' && lv.includes('flow-root') ? 'inline-block' : lv.split(/\s+/)[0]; break;
      case 'visibility': s.visibility = lv === 'inherit' ? ps.visibility : lv; break;
      case 'position': s.position = lv; break;
      case 'float': s.float = lv; break;
      case 'overflow': s.overflow = lv; break;
      case 'opacity': { const o = parseFloat(v); if (!Number.isNaN(o)) s.opacity = clamp(o, 0, 1); break; }
      case 'box-sizing': s.boxSizing = lv; break;
      case 'font-style': s.fontStyle = lv === 'oblique' ? 'italic' : lv === 'inherit' ? ps.fontStyle : lv; break;
      case 'font-weight': {
        if (lv === 'bold') s.fontWeight = 700;
        else if (lv === 'bolder') s.fontWeight = Math.min(900, ps.fontWeight + 300);
        else if (lv === 'lighter') s.fontWeight = Math.max(100, ps.fontWeight - 300);
        else if (lv === 'normal') s.fontWeight = 400;
        else if (lv === 'inherit') s.fontWeight = ps.fontWeight;
        else if (/^\d+$/.test(lv)) s.fontWeight = clamp(parseInt(lv, 10), 1, 1000);
        break;
      }
      case 'font-family': {
        if (lv === 'inherit') break;
        const first = lv.split(',')[0].replace(/["']/g, '').trim();
        if (/(mono|courier|consolas|menlo|monaco)/.test(first) || first === 'ui-monospace') s.fontFamily = 'mono';
        else if (['serif', 'georgia', 'times', 'times new roman', 'garamond', 'palatino', 'cambria', 'book antiqua', 'ui-serif'].includes(first)) s.fontFamily = 'serif';
        else s.fontFamily = 'sans';
        break;
      }
      case 'line-height': {
        if (lv === 'normal') { s.lineHeight = null; s.lineHeightNum = null; break; }
        if (/^[\d.]+$/.test(lv)) { s.lineHeightNum = parseFloat(lv); s.lineHeight = null; break; }
        const l = parseLength(lv, e);
        if (l && l !== 'auto') { s.lineHeight = l.px + (l.pct * s.fontSize) / 100; s.lineHeightNum = null; }
        break;
      }
      case 'text-align': s.textAlign = lv === 'start' ? 'left' : lv === 'end' ? 'right' : lv === '-webkit-center' ? 'center' : lv; break;
      case 'white-space': s.whiteSpace = lv; break;
      case 'text-transform': s.textTransform = lv; break;
      case 'text-decoration-line': s.deco = lv === 'none' ? null : lv; break;
      case 'list-style-type': s.listStyleType = lv; break;
      case 'background-color': { const c = color(v); s.bg = c === 'transparent' || c === null ? null : c; break; }
      case 'border-radius': { const l = parseLength(splitTop(v)[0], e); if (l && l !== 'auto') s.radius = Math.max(0, l.px); break; }
      case 'width': case 'height': case 'min-width': case 'max-width': case 'min-height': case 'max-height': {
        const key = prop.replace(/-(\w)/g, (m, ch) => ch.toUpperCase());
        if ((lv === 'none' && prop.startsWith('max')) || lv === 'auto') s[key] = prop.startsWith('max') ? 'none' : 'auto';
        else if (lv === 'min-content' || lv === 'max-content' || lv === 'fit-content') s[key] = lv;
        else { const l = lengthOrNull(v, e); if (l && l !== 'auto') s[key] = l; }
        break;
      }
      case 'flex-direction': s.flexDirection = lv; break;
      case 'flex-wrap': s.flexWrap = lv; break;
      case 'flex-grow': s.flexGrow = parseFloat(v) || 0; break;
      case 'flex-shrink': s.flexShrink = Number.isNaN(parseFloat(v)) ? 1 : parseFloat(v); break;
      case 'flex-basis': { const l = lengthOrNull(v, e); if (l) s.flexBasis = l; break; }
      case 'justify-content': s.justify = lv.replace(/^(start|left)$/, 'flex-start').replace(/^(end|right)$/, 'flex-end'); break;
      case 'align-items': s.alignItems = lv.replace(/^(start|self-start)$/, 'flex-start').replace(/^(end|self-end)$/, 'flex-end'); break;
      case 'align-self': s.alignSelf = lv.replace(/^(start|self-start)$/, 'flex-start').replace(/^(end|self-end)$/, 'flex-end'); break;
      case 'order': s.order = parseInt(v, 10) || 0; break;
      case 'row-gap': { const l = parseLength(v, e); if (l && l !== 'auto') s.gapRow = l.px; break; }
      case 'column-gap': { const l = parseLength(v, e); if (l && l !== 'auto') s.gapCol = l.px; break; }
      case 'grid-template-columns': s.gridCols = v; break;
      case 'vertical-align': s.valign = lv; break;
      case 'border-collapse': s.borderCollapse = lv; break;
      case 'border-spacing': { const l = parseLength(v, e); if (l && l !== 'auto') s.borderSpacing = l.px; break; }
      case 'text-indent': { const l = parseLength(v, e); if (l && l !== 'auto') s.textIndent = l.px; break; }
      default: {
        const m = /^(margin|padding)-(top|right|bottom|left)$/.exec(prop);
        if (m) {
          const l = lengthOrNull(v, e);
          if (l && (l !== 'auto' || m[1] === 'margin')) s[m[1] === 'margin' ? 'margin' : 'padding'][SIDES.indexOf(m[2])] = l;
          break;
        }
        const bw = /^border-(top|right|bottom|left)-(width|style|color)$/.exec(prop);
        if (bw) {
          const k = SIDES.indexOf(bw[1]);
          if (bw[2] === 'width') s.bw[k] = BORDER_W[lv] ?? (() => { const l = parseLength(v, e); return l && l !== 'auto' ? Math.max(0, l.px) : 0; })();
          else if (bw[2] === 'style') s.bs[k] = lv;
          else { const c = color(v); s.bc[k] = c === 'transparent' ? null : c; }
        }
      }
    }
  }
  // Borders without a style do not exist.
  for (let k = 0; k < 4; k++) if (s.bs[k] === 'none' || s.bs[k] === 'hidden') s.bw[k] = 0;
}

// ── User-agent stylesheet ───────────────────────────────────────────────────

export const UA_CSS = `
html,body,div,p,h1,h2,h3,h4,h5,h6,ul,ol,dl,dt,dd,li,pre,blockquote,form,fieldset,legend,address,section,article,aside,nav,header,footer,main,figure,figcaption,details,summary,hgroup,menu,dir,center,caption,optgroup{display:block}
head,script,style,title,meta,link,base,template,noscript,datalist,svg,canvas,video,audio,iframe,object,embed,map,area,param,source,track,rp,dialog:not([open]),[hidden],input[type=hidden]{display:none}
body{margin:8px}
h1{font-size:2em;font-weight:bold;margin:.67em 0}
h2{font-size:1.5em;font-weight:bold;margin:.83em 0}
h3{font-size:1.17em;font-weight:bold;margin:1em 0}
h4{font-weight:bold;margin:1.33em 0}
h5{font-size:.83em;font-weight:bold;margin:1.67em 0}
h6{font-size:.67em;font-weight:bold;margin:2.33em 0}
p,dl,menu,figure{margin:1em 0}
blockquote{margin:1em 40px}
figure{margin:1em 40px}
ul,ol,menu,dir{margin:1em 0;padding-left:40px}
ul ul,ol ul,ul ol,ol ol{margin:0}
ul{list-style-type:disc}
ul ul{list-style-type:circle}
ul ul ul{list-style-type:square}
ol{list-style-type:decimal}
li{display:list-item}
dd{margin-left:40px}
pre,xmp,listing,plaintext{font-family:monospace;white-space:pre;margin:1em 0}
code,kbd,samp,tt{font-family:monospace}
pre code{font-size:1em}
b,strong,th{font-weight:bold}
i,em,cite,var,dfn,address{font-style:italic}
u,ins{text-decoration:underline}
s,strike,del{text-decoration:line-through}
small{font-size:.83em}
big{font-size:1.17em}
sub,sup{font-size:.83em}
mark{background-color:#ffff00;color:#000}
a:link{color:#0000ee;text-decoration:underline}
abbr[title]{text-decoration:underline}
center{text-align:center}
hr{display:block;margin:.5em 0;border-top:1px solid #9a9a9a;height:0}
img{display:inline}
table{display:table;border-spacing:2px;text-indent:0}
caption{display:table-caption;text-align:center}
thead{display:table-header-group}
tbody{display:table-row-group}
tfoot{display:table-footer-group}
tr{display:table-row}
td,th{display:table-cell;padding:1px}
th{text-align:center}
col,colgroup{display:none}
fieldset{margin:0 2px;padding:.35em .75em .625em;border:2px groove #c0c0c0}
legend{padding:0 2px}
summary{display:block}
details:not([open])>:not(summary){display:none}
input,select,textarea,button{display:inline-block;font-size:13.333px}
button{padding:1px 6px;border:2px outset #767676;background-color:#efefef;text-align:center}
label{display:inline}
details>summary{font-weight:bold}
`;

/** Style for anonymous boxes the layout engine synthesises (e.g. text directly inside a flex container). */
export function anonymousStyle(ps, display = 'block') {
  const s = newStyle(ps);
  s.display = display;
  return s;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Compute styles for every element under `root`. `sheets` is a list of
 * { rules } (author sheets, in document order). Results land on `el.style`.
 */
export function computeStyles(root, sheets, env) {
  const ua = new RuleIndex();
  ua.add(parseStylesheet(UA_CSS, env, 0).rules);
  const author = new RuleIndex();
  for (const sh of sheets) author.add(sh.rules);
  const base = rootStyle();

  (function visit(el, ps) {
    const map = new Map();
    const vars = Object.assign({}, ps.vars);
    const entries = [];
    const push = (decl, level, spec, order) => entries.push({ decl, level, spec, order });
    for (const r of ua.matching(el)) for (const d of r.decls) push(d, 0, r.spec, r.order);
    hints(el, push);
    for (const r of author.matching(el)) for (const d of r.decls) push(d, d.important ? 3 : 1, r.spec, r.order);
    if (el.attrs.style) {
      for (const d of parseDeclarations(el.attrs.style)) push(d, d.important ? 4 : 2, 0, 0);
    }
    entries.sort((a, b) => a.level - b.level || a.spec - b.spec || a.order - b.order);
    for (const { decl } of entries) if (decl.prop.startsWith('--')) vars[decl.prop] = decl.value;
    const s = newStyle(ps);
    s.vars = vars;
    const e = { fs: ps.fontSize, rfs: ps.rootFontSize, vw: env.vw, vh: env.vh };
    for (const { decl } of entries) {
      if (decl.prop.startsWith('--')) continue;
      const value = substVars(decl.value, vars);
      if (value === null) continue;
      expand(map, decl.prop, value, e);
    }
    s.cellpadding = null;
    if (el.tag === 'a' && el.attrs.href !== undefined) s.href = el.attrs.href;
    applyMap(s, map, ps, el, env);
    el.style = s;
    for (const c of el.children) if (c.type === 'el') visit(c, s);
  }(root, base));
}

/** Presentational HTML attributes → low-priority declarations. */
function hints(el, push) {
  const a = el.attrs;
  const L = (d) => push(d, 0.5, 0, 0);
  const dim = (v) => (/^\d+(\.\d+)?%$/.test(v) ? v : /^\d+(\.\d+)?$/.test(v) ? `${v}px` : null);
  switch (el.tag) {
    case 'img': case 'table': case 'td': case 'th': case 'col': case 'iframe': case 'canvas': case 'video': case 'embed': case 'object': {
      const w = a.width && dim(a.width.trim());
      const h = a.height && dim(a.height.trim());
      if (w) L({ prop: 'width', value: w });
      if (h) L({ prop: 'height', value: h });
      break;
    }
    default:
  }
  if (a.bgcolor) L({ prop: 'background-color', value: a.bgcolor.startsWith('#') || !/^[0-9a-f]{6}$/i.test(a.bgcolor) ? a.bgcolor : `#${a.bgcolor}` });
  if (a.align && ['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th', 'tr', 'tbody', 'thead', 'caption', 'img'].includes(el.tag)) {
    const v = a.align.toLowerCase();
    if (v === 'center' || v === 'left' || v === 'right') L({ prop: 'text-align', value: v });
  }
  if (a.valign) L({ prop: 'vertical-align', value: a.valign.toLowerCase() });
  if (el.tag === 'table') {
    if (a.align === 'center') { L({ prop: 'margin-left', value: 'auto' }); L({ prop: 'margin-right', value: 'auto' }); }
    if (a.cellspacing !== undefined && /^\d+$/.test(a.cellspacing)) L({ prop: 'border-spacing', value: `${a.cellspacing}px` });
    if (a.border && /^[1-9]\d*$/.test(a.border)) L({ prop: 'border', value: `${a.border}px outset #808080` });
  }
  if (el.tag === 'td' || el.tag === 'th') {
    let t = el.parent;
    while (t && t.tag !== 'table') t = t.parent;
    if (t) {
      if (t.attrs.cellpadding && /^\d+$/.test(t.attrs.cellpadding)) L({ prop: 'padding', value: `${t.attrs.cellpadding}px` });
      if (t.attrs.border && /^[1-9]\d*$/.test(t.attrs.border)) L({ prop: 'border', value: '1px inset #808080' });
    }
    if (a.nowrap !== undefined) L({ prop: 'white-space', value: 'nowrap' });
  }
  if (el.tag === 'font') {
    if (a.color) L({ prop: 'color', value: a.color.startsWith('#') || !/^[0-9a-f]{6}$/i.test(a.color) ? a.color : `#${a.color}` });
    if (a.size) {
      const n = parseInt(a.size, 10);
      if (n >= 1 && n <= 7) L({ prop: 'font-size', value: ['x-small', 'small', 'medium', 'large', 'x-large', 'xx-large', 'xxx-large'][n - 1] });
    }
  }
  if (el.tag === 'body' && a.text) L({ prop: 'color', value: a.text });
  if (el.tag === 'ol' && a.type) L({ prop: 'list-style-type', value: { 1: 'decimal', a: 'lower-alpha', A: 'upper-alpha', i: 'lower-roman', I: 'upper-roman' }[a.type] || 'decimal' });
  if (el.tag === 'hr') L({ prop: 'border-top', value: '1px solid #9a9a9a' });
  if (a.nowrap !== undefined && el.tag !== 'td') L({ prop: 'white-space', value: 'nowrap' });
}
