// Vortex Engine — HTML parser (written from scratch, no libraries).
// Forgiving tokenizer + tree builder covering the parts of HTML5 that matter for reading pages:
// void elements, raw-text elements, entities, and the implied end tags for p/li/dt/dd/tr/td/option.
// There is deliberately no JavaScript anywhere in this engine: scripts are never run.

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„', laquo: '«',
  raquo: '»', lsaquo: '‹', rsaquo: '›', bull: '•', middot: '·', times: '×', divide: '÷', deg: '°', plusmn: '±',
  euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', larr: '←', rarr: '→', uarr: '↑', darr: '↓',
  harr: '↔', hearts: '♥', spades: '♠', clubs: '♣', diams: '♦', check: '✓', infin: '∞', ne: '≠', le: '≤', ge: '≥',
  frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³', micro: 'µ', iexcl: '¡', iquest: '¿', shy: '­',
  zwj: '‍', zwnj: '‌', ensp: ' ', emsp: ' ', thinsp: ' ', dagger: '†', Dagger: '‡',
  permil: '‰', prime: '′', Prime: '″', oline: '‾', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', pi: 'π',
  sigma: 'σ', omega: 'ω', lambda: 'λ', mu: 'μ', Omega: 'Ω', Delta: 'Δ', Sigma: 'Σ', agrave: 'à', aacute: 'á',
  acirc: 'â', auml: 'ä', eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', iacute: 'í', oacute: 'ó', ouml: 'ö',
  uacute: 'ú', uuml: 'ü', ntilde: 'ñ', ccedil: 'ç', szlig: 'ß', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', Eacute: 'É',
};

export function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '�';
      return String.fromCodePoint(n);
    }
    return Object.prototype.hasOwnProperty.call(NAMED, e) && (m.endsWith(';') || e.length <= 6) ? NAMED[e] : m;
  });
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noembed']);
const P_CLOSE = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul', 'li', 'dd', 'dt']);
const SCOPE = new Set(['table', 'td', 'th', 'caption', 'template', 'object', 'button', 'html']);
const LIST_STOP = new Set(['ul', 'ol', 'menu', ...SCOPE]);
const SECTION = new Set(['thead', 'tbody', 'tfoot']);
const END_STOP_TABLE = new Set(['template']);
const END_STOP_INNER = new Set(['table', 'template']);
const TABLE_INNER = new Set(['tr', 'td', 'th', 'tbody', 'thead', 'tfoot', 'caption']);

const NAME = /([a-zA-Z][^\s/>]*)/y;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/y;
const CLOSE = /<\/([a-zA-Z][^\s/>]*)[^>]*>?/y;

function mk(tag, attrs, parent) {
  return { type: 'el', tag, attrs, children: [], parent };
}

function closeIn(stack, test, stop) {
  for (let k = stack.length - 1; k >= 2; k--) {
    const t = stack[k].tag;
    if (test(t)) {
      stack.length = k;
      return true;
    }
    if (stop.has(t)) return false;
  }
  return false;
}

/** Parse HTML into { type:'doc', children:[html] } with html > body always present. */
export function parseHTML(src, { maxNodes = 150000, maxDepth = 256 } = {}) {
  src = String(src);
  const doc = { type: 'doc', children: [], parent: null };
  const html = mk('html', Object.create(null), doc);
  const body = mk('body', Object.create(null), html);
  doc.children.push(html);
  html.children.push(body);
  const stack = [html, body];
  let count = 0;
  const n = src.length;
  let i = 0;

  const addText = (t) => {
    if (!t) return;
    const p = stack[stack.length - 1];
    const last = p.children[p.children.length - 1];
    if (last && last.type === 'text') last.text += t;
    else {
      p.children.push({ type: 'text', text: t, parent: p });
      count++;
    }
  };

  const openTag = (tag, attrs, selfClose, afterOpen) => {
    if (tag === 'html' || tag === 'body') {
      const target = tag === 'html' ? html : body;
      for (const k of Object.keys(attrs)) if (!(k in target.attrs)) target.attrs[k] = attrs[k];
      return;
    }
    if (tag === 'head') return;
    if (P_CLOSE.has(tag)) closeIn(stack, (t) => t === 'p', SCOPE);
    switch (tag) {
      case 'li': closeIn(stack, (t) => t === 'li', LIST_STOP); break;
      case 'dt': case 'dd': closeIn(stack, (t) => t === 'dt' || t === 'dd', new Set(['dl', ...SCOPE])); break;
      case 'tr': closeIn(stack, (t) => t === 'tr', new Set(['table', 'template'])); break;
      case 'td': case 'th': closeIn(stack, (t) => t === 'td' || t === 'th', new Set(['tr', 'table'])); break;
      case 'thead': case 'tbody': case 'tfoot': closeIn(stack, (t) => SECTION.has(t), new Set(['table'])); break;
      case 'option': closeIn(stack, (t) => t === 'option', new Set(['select', 'datalist'])); break;
      case 'optgroup': closeIn(stack, (t) => t === 'optgroup' || t === 'option', new Set(['select'])); break;
      default:
    }
    if (count >= maxNodes) return;
    const parent = stack[stack.length - 1];
    const el = mk(tag, attrs, parent);
    parent.children.push(el);
    count++;
    if (VOID.has(tag)) return;
    if (RAW.has(tag) && !selfClose) {
      // Raw text: everything up to the matching close tag is one text node.
      const re = new RegExp(`</${tag}[\\s>/]`, 'ig');
      re.lastIndex = afterOpen;
      const m = re.exec(src);
      const end = m ? m.index : n;
      const raw = src.slice(afterOpen, end);
      if (raw) el.children.push({ type: 'text', text: tag === 'textarea' || tag === 'title' ? decodeEntities(raw) : raw, parent: el });
      const gt = m ? src.indexOf('>', end) : -1;
      i = gt < 0 ? n : gt + 1;
      return;
    }
    if (stack.length < maxDepth && !(selfClose && tag === 'svg')) stack.push(el);
  };

  while (i < n && count < maxNodes) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      addText(decodeEntities(src.slice(i)));
      break;
    }
    if (lt > i) addText(decodeEntities(src.slice(i, lt)));
    i = lt;
    const c1 = src.charCodeAt(i + 1);
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      i = end < 0 ? n : end + 3;
    } else if (c1 === 33 /* ! */ || c1 === 63 /* ? */) {
      const end = src.indexOf('>', i);
      i = end < 0 ? n : end + 1;
    } else if (c1 === 47 /* / */) {
      CLOSE.lastIndex = i;
      const m = CLOSE.exec(src);
      if (!m) {
        addText('<');
        i++;
        continue;
      }
      i = CLOSE.lastIndex;
      const tag = m[1].toLowerCase();
      if (tag === 'br') openTag('br', Object.create(null), false, i);
      else if (tag !== 'html' && tag !== 'body' && tag !== 'head') {
        // End tags may cross cells/rows only when closing the table itself.
        const stop = tag === 'table' ? END_STOP_TABLE : TABLE_INNER.has(tag) ? END_STOP_INNER : SCOPE;
        closeIn(stack, (t) => t === tag, stop);
      }
    } else if ((c1 >= 65 && c1 <= 90) || (c1 >= 97 && c1 <= 122)) {
      NAME.lastIndex = i + 1;
      const m = NAME.exec(src);
      const tag = m[1].toLowerCase();
      let j = NAME.lastIndex;
      const attrs = Object.create(null);
      let self = false;
      for (;;) {
        while (j < n && src.charCodeAt(j) <= 32) j++;
        if (j >= n) break;
        const ch = src[j];
        if (ch === '>') {
          j++;
          break;
        }
        if (ch === '/') {
          if (src[j + 1] === '>') {
            self = true;
            j += 2;
            break;
          }
          j++;
          continue;
        }
        ATTR.lastIndex = j;
        const a = ATTR.exec(src);
        if (!a) {
          j++;
          continue;
        }
        const name = a[1].toLowerCase();
        if (!(name in attrs)) attrs[name] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
        j = ATTR.lastIndex;
      }
      i = j;
      openTag(tag, attrs, self, j);
    } else {
      addText('<');
      i++;
    }
  }
  return doc;
}

/** Depth-first walk of elements. */
export function walk(node, fn) {
  if (node.type === 'el' && fn(node) === false) return;
  if (node.children) for (const c of node.children) walk(c, fn);
}

export function textContent(node, skip = new Set(['script', 'style', 'head', 'title', 'noscript', 'template'])) {
  let out = '';
  (function rec(n) {
    if (n.type === 'text') out += n.text;
    else if (n.children && !(n.type === 'el' && skip.has(n.tag))) for (const c of n.children) rec(c);
  })(node);
  return out;
}
