// Vortex Engine — layout (written from scratch).
//
// Turns a styled DOM into a flat list of paint commands:
//   box   – background + borders        text – a run of text on a baseline
//   img   – an image                    plus link regions and form-control rectangles
//
// Block flow uses a "cursor + pending margin" model so adjacent margins collapse, including
// parent/first-child and last-child/parent collapsing. Inline content is broken into lines.
// Tables, flexbox and a practical subset of grid are implemented on top of the same primitives.

import { resolveLen, splitTop, anonymousStyle } from './css.js';

const FAMILIES = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, "Helvetica Neue", Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", Times, serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
};

export function fontOf(s) {
  if (s._font) return s._font;
  s._font = `${s.fontStyle === 'italic' ? 'italic ' : ''}${s.fontWeight >= 600 ? 'bold ' : ''}${+s.fontSize.toFixed(2)}px ${FAMILIES[s.fontFamily] || FAMILIES.sans}`;
  return s._font;
}

export function lineHeightOf(s) {
  if (s.lineHeight !== null && s.lineHeight !== undefined) return s.lineHeight;
  if (s.lineHeightNum !== null && s.lineHeightNum !== undefined) return s.lineHeightNum * s.fontSize;
  return s.fontSize * 1.2;
}

const BLOCK = new Set(['block', 'list-item', 'table', 'flex', 'grid', 'flow-root', 'table-row', 'table-row-group', 'table-header-group',
  'table-footer-group', 'table-caption', 'table-cell', 'table-column', 'table-column-group']);
const ATOMIC = new Set(['inline-block', 'inline-flex', 'inline-grid', 'inline-table']);
const isBlockLevel = (d) => BLOCK.has(d);
const collapse = (a, b) => (a >= 0 && b >= 0 ? Math.max(a, b) : a < 0 && b < 0 ? Math.min(a, b) : a + b);
const num = (l) => (l === 'auto' || l === 'none' || l === null || l === undefined || typeof l === 'string' ? 0 : l.px);

function isHidden(el) {
  if (el._hid !== undefined) return el._hid;
  const s = el.style;
  el._hid = s.display === 'none' || s.position === 'fixed' || s.opacity === 0;
  return el._hid;
}

function hasBlockDescendant(el) {
  if (el._hb !== undefined) return el._hb;
  let found = false;
  for (const c of el.children) {
    if (c.type !== 'el' || isHidden(c)) continue;
    const d = c.style.display;
    if (isBlockLevel(d) || (!ATOMIC.has(d) && c.tag !== 'button' && c.tag !== 'img' && hasBlockDescendant(c))) {
      found = true;
      break;
    }
  }
  el._hb = found;
  return found;
}

// ── Context ─────────────────────────────────────────────────────────────────

function flushPending(ctx) {
  if (ctx.pending) {
    ctx.y += ctx.pending;
    ctx.pending = 0;
  }
  for (const f of ctx.open) {
    if (!f.topSet) {
      f.topSet = true;
      f.top = ctx.y;
      if (f.onTop) f.onTop(ctx.y);
    }
  }
}

function shiftRange(ctx, r, dx, dy) {
  for (let i = r.c0; i < r.c1; i++) { ctx.cmds[i].x += dx; ctx.cmds[i].y += dy; }
  for (let i = r.l0; i < r.l1; i++) { ctx.links[i].x += dx; ctx.links[i].y += dy; }
  for (let i = r.k0; i < r.k1; i++) { ctx.controls[i].x += dx; ctx.controls[i].y += dy; }
}

const mark = (ctx) => ({ c0: ctx.cmds.length, l0: ctx.links.length, k0: ctx.controls.length });
const close = (ctx, r) => ({ ...r, c1: ctx.cmds.length, l1: ctx.links.length, k1: ctx.controls.length });

function viewportEnv(ctx) {
  return { w: ctx.vw, h: ctx.vh };
}

// ── Intrinsic sizes ─────────────────────────────────────────────────────────

const collapseWs = (t) => t.replace(/[ \t\r\n\f]+/g, ' ');

function transformText(t, tt) {
  if (tt === 'uppercase') return t.toUpperCase();
  if (tt === 'lowercase') return t.toLowerCase();
  if (tt === 'capitalize') return t.replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase());
  return t;
}

function extras(s) {
  return num(s.padding[1]) + num(s.padding[3]) + s.bw[1] + s.bw[3];
}
function marginsX(s) {
  return num(s.margin[1]) + num(s.margin[3]);
}

function imageInfo(el, ctx) {
  return ctx.getImage ? ctx.getImage(el) : { state: 'error', w: 0, h: 0 };
}

function imageSize(el, ctx, availW) {
  const s = el.style;
  const info = imageInfo(el, ctx);
  let w = s.width === 'auto' || typeof s.width === 'string' ? null : resolveLen(s.width, availW);
  let h = s.height === 'auto' || typeof s.height === 'string' ? null : s.height.pct ? null : resolveLen(s.height, 0);
  const ratio = info.w > 0 && info.h > 0 ? info.w / info.h : 0;
  if (w === null && h === null) {
    if (info.state === 'ok') { w = info.w; h = info.h; } else { w = 0; h = 0; }
  } else if (w === null) w = ratio ? h * ratio : h;
  else if (h === null) h = ratio ? w / ratio : 0;
  const maxW = Math.min(availW > 0 ? availW : Infinity, s.maxWidth === 'none' ? Infinity : resolveLen(s.maxWidth, availW) ?? Infinity);
  if (w > maxW) {
    if (s.height === 'auto' || ratio) h = ratio ? maxW / ratio : h;
    w = maxW;
  }
  return { w, h, info };
}

function controlSpec(el, ctx, availW) {
  const s = el.style;
  const a = el.attrs;
  const px = (l, base) => (l === 'auto' || typeof l === 'string' ? null : resolveLen(l, base));
  if (el.tag === 'input') {
    const type = (a.type || 'text').toLowerCase();
    if (type === 'hidden') return null;
    if (type === 'checkbox' || type === 'radio') return { ctl: type, w: 20, h: 18 };
    if (['submit', 'button', 'reset', 'file', 'image'].includes(type)) {
      const label = a.value || { submit: 'Submit', reset: 'Reset', file: 'Choose file', image: a.alt || 'Submit' }[type] || '';
      const font = '13px ' + FAMILIES.sans;
      const w = px(s.width, availW) ?? ctx.measure(font, label) + 28;
      return { ctl: 'btn', label, w, h: px(s.height, 0) ?? 26, type };
    }
    const size = parseInt(a.size, 10);
    return { ctl: 'text', type, w: px(s.width, availW) ?? (size > 0 ? size * 7.4 + 10 : 176), h: px(s.height, 0) ?? 26 };
  }
  if (el.tag === 'textarea') {
    const cols = parseInt(a.cols, 10) || 20;
    const rows = parseInt(a.rows, 10) || 2;
    return { ctl: 'textarea', w: px(s.width, availW) ?? cols * 7.6 + 12, h: px(s.height, 0) ?? rows * 17 + 10 };
  }
  // select
  const labels = el.children.flatMap((c) => (c.type === 'el' ? (c.tag === 'optgroup' ? c.children : [c]) : [])).filter((c) => c.type === 'el');
  const font = '13px ' + FAMILIES.sans;
  const wLabels = Math.max(40, ...labels.map((o) => ctx.measure(font, (o.children[0]?.text || '').trim())));
  return { ctl: 'select', w: px(s.width, availW) ?? wLabels + 38, h: px(s.height, 0) ?? 26 };
}

/** Max-content width of an element's content box (excluding its own padding/border/margin). */
function maxContent(el, ctx) {
  const hit = ctx.mc.get(el);
  if (hit !== undefined) return hit;
  ctx.mc.set(el, 0); // guards against cycles
  const v = computeMaxContent(el, ctx);
  ctx.mc.set(el, v);
  return v;
}

function outerMax(el, ctx) {
  const s = el.style;
  const mc = maxContent(el, ctx);
  const spec = typeof s.width === 'object' && !s.width.pct ? s.width.px + (s.boxSizing === 'border-box' ? 0 : extras(s)) : mc + extras(s);
  return spec + marginsX(s);
}

function textRunWidth(text, st, ctx) {
  const ws = st.whiteSpace;
  const t = ws === 'pre' || ws === 'pre-wrap' ? text : collapseWs(text);
  const tt = transformText(t, st.textTransform);
  if (ws === 'pre' || ws === 'pre-wrap') return Math.max(0, ...tt.split('\n').map((l) => ctx.measure(fontOf(st), l.replace(/\t/g, '    '))));
  return ctx.measure(fontOf(st), tt);
}

function computeMaxContent(el, ctx) {
  const s = el.style;
  if (el.tag === 'img') return imageSize(el, ctx, ctx.vw).w;
  if (el.tag === 'input' || el.tag === 'select' || el.tag === 'textarea') return controlSpec(el, ctx, ctx.vw)?.w ?? 0;
  if (typeof s.width === 'object' && !s.width.pct) return Math.max(0, s.width.px - (s.boxSizing === 'border-box' ? extras(s) : 0));
  if (s.display === 'table') return tableMetrics(el, ctx).sumMax + tableMetrics(el, ctx).spaceTotal;
  const kids = el.children.filter((c) => c.type === 'text' || !isHidden(c));
  if (s.display === 'flex') {
    const items = kids.filter((c) => c.type === 'el' || c.text.trim());
    const row = !s.flexDirection.startsWith('column');
    const ws = items.map((c) => (c.type === 'el' ? outerMax(c, ctx) : textRunWidth(c.text.trim(), s, ctx)));
    return row ? ws.reduce((a, b) => a + b, 0) + s.gapCol * Math.max(0, ws.length - 1) : Math.max(0, ...ws);
  }
  if (s.display === 'grid') {
    const ws = kids.filter((c) => c.type === 'el').map((c) => outerMax(c, ctx));
    const cols = Math.max(1, gridTrackCount(s));
    return Math.max(0, ...ws) * cols + s.gapCol * (cols - 1);
  }
  let best = 0;
  let line = 0;
  const flushLine = () => { best = Math.max(best, line); line = 0; };
  const visit = (nodes) => {
    for (const c of nodes) {
      if (c.type === 'text') {
        line += textRunWidth(c.text, c.parent.style, ctx);
      } else if (isHidden(c)) continue;
      else if (c.tag === 'br') flushLine();
      else if (c.tag === 'img' || c.tag === 'input' || c.tag === 'select' || c.tag === 'textarea' || c.tag === 'button' || ATOMIC.has(c.style.display)) line += outerMax(c, ctx);
      else if (isBlockLevel(c.style.display)) { flushLine(); best = Math.max(best, outerMax(c, ctx)); }
      else visit(c.children);
    }
  };
  visit(kids);
  flushLine();
  return best;
}

/** Min-content width (longest unbreakable piece). */
function minContent(el, ctx) {
  const hit = ctx.mn.get(el);
  if (hit !== undefined) return hit;
  ctx.mn.set(el, 0);
  const s = el.style;
  let v = 0;
  if (el.tag === 'img' || el.tag === 'input' || el.tag === 'select' || el.tag === 'textarea') v = maxContent(el, ctx);
  else if (s.whiteSpace === 'nowrap' || s.whiteSpace === 'pre') v = maxContent(el, ctx);
  else {
    const walkMin = (nodes) => {
      for (const c of nodes) {
        if (c.type === 'text') {
          const st = c.parent.style;
          for (const w of transformText(collapseWs(c.text), st.textTransform).split(' ')) if (w) v = Math.max(v, ctx.measure(fontOf(st), w));
        } else if (!isHidden(c)) {
          if (c.tag === 'img' || c.tag === 'input' || c.tag === 'select' || c.tag === 'textarea') v = Math.max(v, outerMax(c, ctx) - (c.tag === 'img' ? 0 : 0));
          else if (ATOMIC.has(c.style.display) || c.tag === 'button') v = Math.max(v, minContent(c, ctx) + extras(c.style));
          else if (typeof c.style.width === 'object' && !c.style.width.pct && isBlockLevel(c.style.display)) v = Math.max(v, c.style.width.px + marginsX(c.style));
          else if (c.style.display === 'table') v = Math.max(v, tableMetrics(c, ctx).sumMin + tableMetrics(c, ctx).spaceTotal);
          else walkMin(c.children);
        }
      }
    };
    walkMin(el.children);
  }
  ctx.mn.set(el, v);
  return v;
}

// ── Tables ──────────────────────────────────────────────────────────────────

const isRowGroup = (d) => d === 'table-row-group' || d === 'table-header-group' || d === 'table-footer-group';

function tableMetrics(el, ctx) {
  const cached = ctx.tm.get(el);
  if (cached) return cached;
  const s = el.style;
  const sp = s.borderCollapse === 'collapse' ? 0 : s.borderSpacing;
  const rows = [];
  const caps = [];
  const addRow = (tr) => rows.push({ el: tr, cells: tr.children.filter((c) => c.type === 'el' && !isHidden(c) && (c.style.display === 'table-cell' || c.tag === 'td' || c.tag === 'th')) });
  for (const c of el.children) {
    if (c.type !== 'el' || isHidden(c)) continue;
    const d = c.style.display;
    if (d === 'table-row') addRow(c);
    else if (isRowGroup(d)) for (const r of c.children) if (r.type === 'el' && !isHidden(r) && r.style.display === 'table-row') addRow(r);
    else if (d === 'table-caption') caps.push(c);
  }
  const occ = [];
  let ncols = 0;
  rows.forEach((row, ri) => {
    let col = 0;
    occ[ri] = occ[ri] || [];
    for (const cell of row.cells) {
      while (occ[ri][col]) col++;
      cell._col = col;
      cell._cs = Math.max(1, Math.min(60, parseInt(cell.attrs.colspan, 10) || 1));
      cell._rs = Math.max(1, Math.min(60, parseInt(cell.attrs.rowspan, 10) || 1));
      for (let dr = 0; dr < cell._rs; dr++) {
        occ[ri + dr] = occ[ri + dr] || [];
        for (let dc = 0; dc < cell._cs; dc++) occ[ri + dr][col + dc] = true;
      }
      col += cell._cs;
      ncols = Math.max(ncols, col);
    }
  });
  const colMin = Array(ncols).fill(0);
  const colMax = Array(ncols).fill(0);
  const colPct = Array(ncols).fill(0);
  const spanning = [];
  for (const row of rows) {
    for (const cell of row.cells) {
      const cs = cell.style;
      const ex = extras(cs);
      let mn = minContent(cell, ctx) + ex;
      let mx = maxContent(cell, ctx) + ex;
      if (typeof cs.width === 'object') {
        if (cs.width.pct) { if (cell._cs === 1) colPct[cell._col] = Math.max(colPct[cell._col], cs.width.pct); } else {
          const w = cs.width.px + (cs.boxSizing === 'border-box' ? 0 : ex);
          mx = Math.max(w, mn);
          mn = Math.max(mn, Math.min(w, mx));
        }
      }
      if (cell._cs === 1) {
        colMin[cell._col] = Math.max(colMin[cell._col], mn);
        colMax[cell._col] = Math.max(colMax[cell._col], mx);
      } else spanning.push({ cell, mn, mx });
    }
  }
  for (const { cell, mn, mx } of spanning) {
    const cols = Array.from({ length: cell._cs }, (_, k) => cell._col + k);
    const sp2 = sp * (cell._cs - 1);
    for (const [arr, want] of [[colMin, mn - sp2], [colMax, mx - sp2]]) {
      const have = cols.reduce((a, c) => a + arr[c], 0);
      if (have < want) for (const c of cols) arr[c] += (want - have) / cols.length;
    }
  }
  for (let c = 0; c < ncols; c++) colMax[c] = Math.max(colMax[c], colMin[c]);
  const m = {
    rows, caps, ncols, colMin, colMax, colPct, sp,
    sumMin: colMin.reduce((a, b) => a + b, 0),
    sumMax: colMax.reduce((a, b) => a + b, 0),
    spaceTotal: ncols ? sp * (ncols + 1) : 0,
  };
  ctx.tm.set(el, m);
  return m;
}

function layoutTableContent(el, cx, tw, ctx) {
  const m = tableMetrics(el, ctx);
  const { rows, caps, ncols, sp } = m;
  for (const cap of caps) layoutBlock(cap, cx, tw, ctx, {});
  if (!ncols) return;
  flushPending(ctx);
  // Column widths.
  const free = tw - m.spaceTotal;
  let widths;
  if (free <= m.sumMin) widths = m.colMin.slice();
  else if (free >= m.sumMax) {
    const extra = free - m.sumMax;
    widths = m.colMax.map((w) => w + (m.sumMax > 0 ? (extra * w) / m.sumMax : extra / ncols));
  } else {
    const t = (free - m.sumMin) / (m.sumMax - m.sumMin);
    widths = m.colMin.map((mn, i) => mn + (m.colMax[i] - mn) * t);
  }
  // Percentage columns take their share.
  const pctTotal = m.colPct.reduce((a, b) => a + b, 0);
  if (pctTotal > 0 && pctTotal <= 100) {
    for (let i = 0; i < ncols; i++) if (m.colPct[i]) widths[i] = Math.max(m.colMin[i], (free * m.colPct[i]) / 100);
    const fixed = widths.reduce((a, w, i) => (m.colPct[i] ? a + w : a), 0);
    const restIdx = widths.map((w, i) => i).filter((i) => !m.colPct[i]);
    const restMax = restIdx.reduce((a, i) => a + m.colMax[i], 0);
    for (const i of restIdx) widths[i] = Math.max(m.colMin[i], restMax ? ((free - fixed) * m.colMax[i]) / restMax : 0);
  }
  const colX = [];
  let x = cx + sp;
  for (let i = 0; i < ncols; i++) {
    colX[i] = x;
    x += widths[i] + sp;
  }
  ctx.y += sp;
  for (const row of rows) {
    const rowTop = ctx.y;
    const rs = row.el.style;
    let rbox = null;
    if (rs.bg) {
      rbox = { t: 'box', x: cx, y: rowTop, w: tw, h: 0, bg: rs.bg, r: 0, b: [0, 0, 0, 0], bc: [], alpha: 1 };
      ctx.cmds.push(rbox);
    }
    let rowH = 0;
    const placed = [];
    for (const cell of row.cells) {
      const w = widths.slice(cell._col, cell._col + cell._cs).reduce((a, b) => a + b, 0) + sp * (cell._cs - 1);
      ctx.y = rowTop;
      ctx.pending = 0;
      const r0 = mark(ctx);
      const cs = cell.style;
      const res = layoutBlock(cell, colX[cell._col], w, ctx, { contentW: Math.max(0, w - extras(cs)), bfc: true, cell: true });
      const range = close(ctx, r0);
      const h = ctx.y - rowTop;
      if (cell._rs === 1) rowH = Math.max(rowH, h);
      placed.push({ cell, res, range, h });
    }
    for (const p of placed) {
      const va = p.cell.style.valign || 'middle';
      let dy = 0;
      if (p.cell._rs === 1) {
        if (va === 'middle' || va === 'center') dy = (rowH - p.h) / 2;
        else if (va === 'bottom') dy = rowH - p.h;
      }
      if (dy > 0.5) shiftRange(ctx, p.range, 0, dy);
      if (p.res.box) {
        p.res.box.y = rowTop;
        p.res.box.h = p.cell._rs === 1 ? rowH : p.h;
      }
    }
    if (rbox) rbox.h = rowH;
    ctx.y = rowTop + rowH + sp;
    ctx.pending = 0;
  }
}

// ── Flex & grid ─────────────────────────────────────────────────────────────

function flexItems(el) {
  const out = [];
  for (const c of el.children) {
    if (c.type === 'el') {
      if (!isHidden(c)) out.push(c);
    } else if (c.text.trim()) {
      const anon = { type: 'el', tag: '#anon', attrs: Object.create(null), children: [c], parent: el };
      anon.style = anonymousStyle(el.style, 'block');
      c.parent = anon;
      out.push(anon);
    }
  }
  return out.sort((a, b) => a.style.order - b.style.order);
}

function layoutFlexContent(el, cx, w, ctx) {
  const s = el.style;
  const items = flexItems(el);
  if (!items.length) return;
  flushPending(ctx);
  const column = s.flexDirection.startsWith('column');
  if (s.flexDirection.endsWith('reverse')) items.reverse();
  if (column) {
    items.forEach((it, i) => {
      if (i) ctx.y += s.gapRow;
      const st = it.style;
      const align = st.alignSelf !== 'auto' ? st.alignSelf : s.alignItems;
      const opts = { bfc: true };
      let x = cx;
      if (align !== 'stretch' && st.width === 'auto') {
        const cw = Math.min(w - marginsX(st) - extras(st), maxContent(it, ctx));
        opts.contentW = cw;
        const outer = cw + extras(st) + marginsX(st);
        if (align === 'center') x = cx + (w - outer) / 2;
        else if (align === 'flex-end') x = cx + w - outer;
      }
      layoutBlock(it, x, w, ctx, opts);
    });
    return;
  }
  const info = items.map((it) => {
    const st = it.style;
    const hp = extras(st);
    const mlAuto = st.margin[3] === 'auto';
    const mrAuto = st.margin[1] === 'auto';
    const ml = mlAuto ? 0 : num(st.margin[3]);
    const mr = mrAuto ? 0 : num(st.margin[1]);
    let base;
    if (typeof st.flexBasis === 'object' && !(st.flexBasis.px === 0 && st.flexBasis.pct === 0 && st.width !== 'auto')) {
      base = resolveLen(st.flexBasis, w) + (st.boxSizing === 'border-box' ? 0 : hp);
    } else if (typeof st.width === 'object') base = resolveLen(st.width, w) + (st.boxSizing === 'border-box' ? 0 : hp);
    else base = maxContent(it, ctx) + hp;
    const min = minContent(it, ctx) + hp;
    return { it, st, hp, ml, mr, mlAuto, mrAuto, base: Math.max(base, 0), min, grow: st.flexGrow, shrink: st.flexShrink };
  });
  const lines = [];
  if (s.flexWrap === 'nowrap') lines.push(info);
  else {
    let cur = [];
    let sum = 0;
    for (const f of info) {
      const outer = f.base + f.ml + f.mr;
      if (cur.length && sum + s.gapCol + outer > w + 0.5) {
        lines.push(cur);
        cur = [];
        sum = 0;
      }
      sum += (cur.length ? s.gapCol : 0) + outer;
      cur.push(f);
    }
    if (cur.length) lines.push(cur);
  }
  lines.forEach((line, li) => {
    if (li) ctx.y += s.gapRow;
    const gaps = s.gapCol * (line.length - 1);
    let used = line.reduce((a, f) => a + f.base + f.ml + f.mr, 0) + gaps;
    let free = w - used;
    const grow = line.reduce((a, f) => a + f.grow, 0);
    if (free > 0 && grow > 0) {
      for (const f of line) f.base += (free * f.grow) / grow;
      free = 0;
    } else if (free < 0) {
      const shrinkBase = line.reduce((a, f) => a + f.shrink * f.base, 0);
      if (shrinkBase > 0) for (const f of line) f.base = Math.max(f.min, f.base + (free * f.shrink * f.base) / shrinkBase);
      used = line.reduce((a, f) => a + f.base + f.ml + f.mr, 0) + gaps;
      free = Math.max(0, w - used);
    }
    let off = 0;
    let between = 0;
    const autos = line.reduce((a, f) => a + (f.mlAuto ? 1 : 0) + (f.mrAuto ? 1 : 0), 0);
    if (free > 0 && autos > 0) {
      for (const f of line) {
        if (f.mlAuto) f.ml = free / autos;
        if (f.mrAuto) f.mr = free / autos;
      }
    } else if (free > 0) {
      if (s.justify === 'center') off = free / 2;
      else if (s.justify === 'flex-end') off = free;
      else if (s.justify === 'space-between' && line.length > 1) between = free / (line.length - 1);
      else if (s.justify === 'space-around') { between = free / line.length; off = between / 2; }
      else if (s.justify === 'space-evenly') { between = free / (line.length + 1); off = between; }
    }
    const lineTop = ctx.y;
    let x = cx + off;
    const placed = [];
    for (const f of line) {
      ctx.y = lineTop;
      ctx.pending = 0;
      const r0 = mark(ctx);
      const res = layoutBlock(f.it, x, f.base + f.ml + f.mr, ctx, { contentW: Math.max(0, f.base - f.hp), bfc: true, ml: f.ml, mr: f.mr });
      placed.push({ f, res, range: close(ctx, r0), h: ctx.y - lineTop });
      x += f.ml + f.base + f.mr + s.gapCol + between;
    }
    const lineH = Math.max(0, ...placed.map((p) => p.h));
    for (const p of placed) {
      const align = p.f.st.alignSelf !== 'auto' ? p.f.st.alignSelf : s.alignItems;
      let dy = 0;
      if (align === 'center') dy = (lineH - p.h) / 2;
      else if (align === 'flex-end') dy = lineH - p.h;
      else if (align === 'stretch' && p.res.box && p.f.st.height === 'auto') p.res.box.h += lineH - p.h;
      if (dy > 0.5) shiftRange(ctx, p.range, 0, dy);
    }
    ctx.y = lineTop + lineH;
  });
}

function gridTrackCount(s) {
  if (!s.gridCols) return 1;
  const rep = /repeat\(\s*(\d+)\s*,/.exec(s.gridCols);
  if (rep) return parseInt(rep[1], 10) * Math.max(1, splitTop(s.gridCols.replace(/repeat\([^)]*\)/, 'x')).length);
  return Math.max(1, splitTop(s.gridCols).length);
}

function gridTracks(s, w) {
  const src = s.gridCols;
  if (!src) return [{ fr: 1 }];
  let tokens = [];
  const re = /repeat\(\s*(auto-fill|auto-fit|\d+)\s*,\s*((?:[^()]|\([^)]*\))*)\)/gi;
  const flat = src.replace(re, (m, count, inner) => {
    const parts = splitTop(inner);
    let n = parseInt(count, 10);
    if (Number.isNaN(n)) {
      const mm = /minmax\(\s*([\d.]+)px/i.exec(inner) || /^([\d.]+)px/.exec(inner);
      const min = mm ? parseFloat(mm[1]) : 200;
      n = Math.max(1, Math.floor((w + s.gapCol) / (min + s.gapCol)));
    }
    return Array(n).fill(parts.join(' ')).join(' ');
  });
  tokens = splitTop(flat);
  return tokens.map((t) => {
    t = t.toLowerCase();
    const mm = /^minmax\(\s*[^,]+,\s*([^)]+)\)$/.exec(t);
    if (mm) t = mm[1].trim();
    const fr = /^([\d.]+)fr$/.exec(t);
    if (fr) return { fr: parseFloat(fr[1]) };
    const px = /^([\d.]+)px$/.exec(t);
    if (px) return { px: parseFloat(px[1]) };
    const pc = /^([\d.]+)%$/.exec(t);
    if (pc) return { px: (parseFloat(pc[1]) / 100) * w };
    return { fr: 1 };
  });
}

function layoutGridContent(el, cx, w, ctx) {
  const s = el.style;
  const items = flexItems(el);
  if (!items.length) return;
  flushPending(ctx);
  const tracks = gridTracks(s, w);
  const fixed = tracks.reduce((a, t) => a + (t.px || 0), 0);
  const frTotal = tracks.reduce((a, t) => a + (t.fr || 0), 0);
  const rest = Math.max(0, w - fixed - s.gapCol * (tracks.length - 1));
  const widths = tracks.map((t) => (t.px !== undefined ? t.px : frTotal ? (rest * t.fr) / frTotal : 0));
  const xs = [];
  let x = cx;
  widths.forEach((tw, i) => { xs[i] = x; x += tw + s.gapCol; });
  for (let i = 0; i < items.length; i += tracks.length) {
    if (i) ctx.y += s.gapRow;
    const rowItems = items.slice(i, i + tracks.length);
    const top = ctx.y;
    const placed = rowItems.map((it, k) => {
      ctx.y = top;
      ctx.pending = 0;
      const st = it.style;
      const res = layoutBlock(it, xs[k], widths[k], ctx, { contentW: Math.max(0, widths[k] - extras(st) - marginsX(st)), bfc: true });
      return { res, h: ctx.y - top, it };
    });
    const rowH = Math.max(0, ...placed.map((p) => p.h));
    for (const p of placed) if (p.res.box && p.it.style.height === 'auto' && s.alignItems === 'stretch') p.res.box.h += rowH - p.h;
    ctx.y = top + rowH;
  }
}

// ── Block layout ────────────────────────────────────────────────────────────

function toRoman(n, upper) {
  const map = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let out = '';
  for (const [v, r] of map) while (n >= v) { out += r; n -= v; }
  return upper ? out.toUpperCase() : out;
}

function markerText(el) {
  const s = el.style;
  const t = s.listStyleType;
  if (t === 'none') return null;
  if (t === 'disc') return '•';
  if (t === 'circle') return '◦';
  if (t === 'square') return '▪';
  let n = 1;
  const parent = el.parent;
  if (parent) {
    const start = parseInt(parent.attrs.start, 10);
    if (!Number.isNaN(start)) n = start;
    for (const c of parent.children) {
      if (c === el) break;
      if (c.type === 'el' && c.style.display === 'list-item') {
        const v = parseInt(c.attrs.value, 10);
        n = Number.isNaN(v) ? n + 1 : v + 1;
      }
    }
    const own = parseInt(el.attrs.value, 10);
    if (!Number.isNaN(own)) n = own;
    if (parent.attrs.reversed !== undefined) n = parent.children.filter((c) => c.type === 'el' && c.style.display === 'list-item').length - n + 1;
  }
  if (t === 'lower-alpha' || t === 'lower-latin') return `${String.fromCharCode(96 + ((n - 1) % 26) + 1)}.`;
  if (t === 'upper-alpha' || t === 'upper-latin') return `${String.fromCharCode(64 + ((n - 1) % 26) + 1)}.`;
  if (t === 'lower-roman') return `${toRoman(n, false)}.`;
  if (t === 'upper-roman') return `${toRoman(n, true)}.`;
  return `${n}.`;
}

function layoutBlock(el, x, availW, ctx, opts = {}) {
  const s = el.style;
  const rl = (l) => resolveLen(l, availW);
  const detached = opts.bfc || s.overflow === 'hidden' || s.overflow === 'auto' || s.overflow === 'scroll' || s.display === 'flow-root' || s.float !== 'none';
  const mt = s.margin[0] === 'auto' ? 0 : rl(s.margin[0]);
  const mb = s.margin[2] === 'auto' ? 0 : rl(s.margin[2]);
  let ml = opts.ml !== undefined ? opts.ml : s.margin[3] === 'auto' ? null : rl(s.margin[3]);
  let mr = opts.mr !== undefined ? opts.mr : s.margin[1] === 'auto' ? null : rl(s.margin[1]);
  const pt = rl(s.padding[0]);
  const pr = rl(s.padding[1]);
  const pb = rl(s.padding[2]);
  const pl = rl(s.padding[3]);
  const [bt, br, bb, bl] = s.bw;
  const hpad = pl + pr + bl + br;
  const vpad = pt + pb + bt + bb;
  const bs = s.boxSizing === 'border-box' || s.display === 'table';

  let contentW;
  if (opts.contentW !== undefined) contentW = opts.contentW;
  else {
    let w = null;
    if (typeof s.width === 'object') w = rl(s.width);
    else if (s.width === 'max-content') w = maxContent(el, ctx);
    else if (s.width === 'min-content') w = minContent(el, ctx);
    else if (s.width === 'fit-content') w = Math.min(maxContent(el, ctx), availW - hpad - (ml || 0) - (mr || 0));
    if (w !== null) contentW = bs && typeof s.width === 'object' ? w - hpad : w;
    else if (s.display === 'table') {
      const m = tableMetrics(el, ctx);
      contentW = Math.min(availW - (ml || 0) - (mr || 0) - hpad, m.sumMax + m.spaceTotal);
    } else contentW = availW - (ml || 0) - (mr || 0) - hpad;
    if (typeof s.maxWidth === 'object') contentW = Math.min(contentW, rl(s.maxWidth) - (bs ? hpad : 0));
    if (typeof s.minWidth === 'object') contentW = Math.max(contentW, rl(s.minWidth) - (bs ? hpad : 0));
  }
  contentW = Math.max(0, contentW);
  const boxW = contentW + hpad;
  if (opts.contentW === undefined) {
    const free = availW - boxW - (ml || 0) - (mr || 0);
    if (ml === null && mr === null) { ml = Math.max(0, free / 2); mr = Math.max(0, free / 2); }
    else if (ml === null) ml = Math.max(0, free);
    else if (mr === null) mr = Math.max(0, free);
  }
  ml = ml || 0;
  mr = mr || 0;
  const boxX = x + ml;
  ctx.maxX = Math.max(ctx.maxX, boxX + boxW);

  // Vertical placement.
  if (detached) {
    flushPending(ctx);
    ctx.y += mt;
  } else ctx.pending = collapse(ctx.pending, mt);

  const visible = s.visibility !== 'hidden';
  let box = null;
  const bgColor = el === ctx.skipBgEl ? null : s.bg;
  const hasDecor = bgColor || bt || br || bb || bl;
  if (hasDecor && visible) {
    box = {
      t: 'box', x: boxX, y: 0, w: boxW, h: 0, bg: bgColor, r: s.radius, alpha: s.opacity,
      b: [bt, br, bb, bl], bc: s.bc.map((c) => c || s.color),
    };
    ctx.cmds.push(box);
  }
  const frame = { top: 0, topSet: false, onTop: null };
  ctx.open.push(frame);
  const cx = boxX + bl + pl;
  if (el.attrs.id) {
    const id = el.attrs.id;
    frame.onTop = (y) => { if (!(id in ctx.anchors)) ctx.anchors[id] = y; };
  }

  if (s.display === 'list-item' && visible) {
    const text = markerText(el);
    if (text) {
      const prevTop = frame.onTop;
      frame.onTop = (top) => {
        if (prevTop) prevTop(top);
        const fs = s.fontSize;
        const lh = lineHeightOf(s);
        const font = fontOf(s);
        const wText = ctx.measure(font, text);
        ctx.cmds.push({ t: 'text', x: cx - wText - 7, y: top + bt + pt + (lh - fs) / 2 + fs * 0.8, text, font, c: s.color, w: wText });
      };
    }
  }

  const edgeTop = pt > 0 || bt > 0 || detached;
  const explicitH = typeof s.height === 'object' && !s.height.pct;
  const edgeBottom = pb > 0 || bb > 0 || detached || explicitH;
  if (edgeTop) {
    flushPending(ctx);
    ctx.y += bt + pt;
  }

  const controlTag = el.tag === 'input' || el.tag === 'select' || el.tag === 'textarea';
  const spec = controlTag ? controlSpec(el, ctx, availW) : null;
  if (spec) {
    // A replaced element in a block context (e.g. an <input> that is a flex item).
    flushPending(ctx);
    const ch = typeof s.height === 'object' && !s.height.pct ? Math.max(0, bs ? rl(s.height) - vpad : rl(s.height)) : Math.max(0, spec.h - vpad);
    const y0 = ctx.y - bt - pt;
    const w = Math.max(contentW + hpad, 0);
    if (visible) {
      if (spec.ctl === 'btn') {
        emitBox({ kind: 'control', spec: { ...spec, w, h: ch + vpad }, h: ch + vpad, mx: 0, node: el, st: s }, boxX, y0 + (ch + vpad) * 0.72, ctx);
      } else {
        ctx.controls.push({ node: el, ctl: spec.ctl, type: spec.type, x: boxX, y: y0, w, h: ch + vpad });
      }
    }
    ctx.y += ch;
  } else {
    switch (s.display) {
      case 'flex': layoutFlexContent(el, cx, contentW, ctx); break;
      case 'grid': layoutGridContent(el, cx, contentW, ctx); break;
      case 'table': layoutTableContent(el, cx, contentW, ctx); break;
      default: flow(el.children, cx, contentW, ctx, el);
    }
  }

  if (edgeBottom) flushPending(ctx);
  if (frame.topSet) {
    const contentTop = frame.top + bt + pt;
    if (explicitH) {
      const h = bs ? rl(s.height) - vpad : rl(s.height);
      ctx.y = contentTop + Math.max(0, h);
    }
    if (typeof s.minHeight === 'object' && !s.minHeight.pct) {
      const mh = bs ? rl(s.minHeight) - vpad : rl(s.minHeight);
      ctx.y = Math.max(ctx.y, contentTop + mh);
    }
  } else if (explicitH || (typeof s.minHeight === 'object' && !s.minHeight.pct && s.minHeight.px > 0)) {
    flushPending(ctx);
    const h = explicitH ? (bs ? rl(s.height) - vpad : rl(s.height)) : (bs ? rl(s.minHeight) - vpad : rl(s.minHeight));
    ctx.y += Math.max(0, h) + bt + pt;
  }
  if (edgeBottom) ctx.y += pb + bb;
  ctx.open.pop();
  const top = frame.topSet ? frame.top : ctx.y;
  if (box) {
    box.y = top;
    box.h = ctx.y - top;
  }
  if (el.tag === 'button' && visible) ctx.controls.push({ node: el, ctl: 'button', x: boxX, y: top, w: boxW, h: ctx.y - top });
  if (detached) ctx.y += mb;
  else ctx.pending = collapse(ctx.pending, mb);
  return { box, top, bottom: ctx.y, boxW, ml, mr };
}

function flow(children, x, w, ctx, parentEl) {
  let run = [];
  const flushRun = () => {
    if (run.length) {
      layoutInline(run, x, w, ctx, parentEl);
      run = [];
    }
  };
  for (const ch of children) {
    if (ch.type === 'text') {
      run.push(ch);
      continue;
    }
    if (isHidden(ch)) continue;
    const d = ch.style.display;
    if (d === 'contents') {
      flushRun();
      flow(ch.children, x, w, ctx, ch);
    } else if (isBlockLevel(d)) {
      flushRun();
      layoutBlock(ch, x, w, ctx, {});
    } else if (ch.tag !== 'img' && ch.tag !== 'button' && !ATOMIC.has(d) && hasBlockDescendant(ch)) {
      flushRun();
      flow(ch.children, x, w, ctx, ch);
    } else run.push(ch);
  }
  flushRun();
}

// ── Inline layout ───────────────────────────────────────────────────────────

function addText(n, atoms, ctx) {
  const s = n.parent.style;
  const ws = s.whiteSpace;
  const font = fontOf(s);
  const nowrap = ws === 'nowrap' || ws === 'pre';
  if (ws === 'pre' || ws === 'pre-wrap' || ws === 'break-spaces') {
    const lines = transformText(n.text.replace(/\r\n?/g, '\n'), s.textTransform).split('\n');
    lines.forEach((line, i) => {
      if (i > 0) atoms.push({ k: 'br', st: s });
      for (const seg of line.replace(/\t/g, '    ').split(/( +)/)) {
        if (!seg) continue;
        if (seg[0] === ' ') {
          if (ws === 'pre') atoms.push({ k: 'w', text: seg, st: s, w: ctx.measure(font, seg) });
          else for (let c = 0; c < seg.length; c++) atoms.push({ k: 's', st: s, w: ctx.measure(font, ' '), keep: true });
        } else atoms.push({ k: 'w', text: seg, st: s, w: ctx.measure(font, seg) });
      }
    });
    return;
  }
  const t = transformText(collapseWs(n.text), s.textTransform);
  const re = /\S+| /g;
  let m;
  while ((m = re.exec(t))) {
    if (m[0] === ' ') {
      const last = atoms[atoms.length - 1];
      if (!last || last.k === 's' || last.k === 'br') continue;
      atoms.push({ k: 's', st: s, w: ctx.measure(font, ' '), nowrap });
    } else atoms.push({ k: 'w', text: m[0], st: s, w: ctx.measure(font, m[0]) });
  }
}

function collect(n, atoms, ctx, availW) {
  if (n.type === 'text') return addText(n, atoms, ctx);
  if (isHidden(n)) return undefined;
  const s = n.style;
  if (n.tag === 'br') {
    atoms.push({ k: 'br', st: s });
    return undefined;
  }
  if (n.tag === 'img') {
    const { w, h, info } = imageSize(n, ctx, availW);
    if (info.state === 'error' || !n.attrs.src) {
      const alt = (n.attrs.alt || '').trim();
      if (alt) for (const tok of alt.split(/\s+/)) {
        const last = atoms[atoms.length - 1];
        if (last && last.k !== 's' && last.k !== 'br') atoms.push({ k: 's', st: s, w: ctx.measure(fontOf(s), ' ') });
        atoms.push({ k: 'w', text: tok, st: s, w: ctx.measure(fontOf(s), tok) });
      }
      return undefined;
    }
    if (w > 0 || h > 0) atoms.push({ k: 'b', kind: 'img', w, h, node: n, img: info.img, st: s });
    return undefined;
  }
  if (n.tag === 'input' || n.tag === 'select' || n.tag === 'textarea') {
    const spec = controlSpec(n, ctx, availW);
    if (spec) atoms.push({ k: 'b', kind: 'control', spec, w: spec.w + marginsX(s), h: spec.h, node: n, st: s, mx: num(s.margin[3]) });
    return undefined;
  }
  if (ATOMIC.has(s.display) || n.tag === 'button' || isBlockLevel(s.display)) {
    const saved = { y: ctx.y, pending: ctx.pending, open: ctx.open };
    ctx.y = 0;
    ctx.pending = 0;
    ctx.open = [];
    const r0 = mark(ctx);
    const hp = extras(s);
    let cw;
    if (typeof s.width === 'object') cw = s.boxSizing === 'border-box' ? resolveLen(s.width, availW) - hp : resolveLen(s.width, availW);
    else cw = Math.min(Math.max(0, availW - marginsX(s) - hp), maxContent(n, ctx));
    if (typeof s.minWidth === 'object') cw = Math.max(cw, resolveLen(s.minWidth, availW) - (s.boxSizing === 'border-box' ? hp : 0));
    if (typeof s.maxWidth === 'object') cw = Math.min(cw, resolveLen(s.maxWidth, availW) - (s.boxSizing === 'border-box' ? hp : 0));
    const res = layoutBlock(n, 0, availW, ctx, { contentW: Math.max(0, cw), bfc: true });
    const h = ctx.y;
    const range = close(ctx, r0);
    Object.assign(ctx, saved);
    atoms.push({ k: 'b', kind: 'sub', w: res.ml + res.boxW + res.mr, h, range, node: n, st: s, isButton: n.tag === 'button' });
    return undefined;
  }
  for (const c of n.children) collect(c, atoms, ctx, availW);
  return undefined;
}

function fitChars(text, font, maxW, ctx) {
  let lo = 1;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measure(font, text.slice(0, mid)) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function buildLines(atoms, w, indent, ctx) {
  const lines = [];
  let cur = { atoms: [], w: 0 };
  const hasContent = (l) => l.atoms.some((a) => a.k !== 's');
  const trim = (l) => {
    while (l.atoms.length && l.atoms[l.atoms.length - 1].k === 's' && !l.atoms[l.atoms.length - 1].keep) l.w -= l.atoms.pop().w;
  };
  const push = () => {
    trim(cur);
    lines.push(cur);
    cur = { atoms: [], w: 0 };
  };
  for (const a of atoms) {
    if (a.k === 'br') {
      cur.hard = true;
      cur.br = a;
      push();
      continue;
    }
    if (a.k === 's') {
      if (!cur.atoms.length && !a.keep) continue;
      cur.atoms.push(a);
      cur.w += a.w;
      continue;
    }
    const avail = w - (lines.length === 0 ? indent : 0);
    const nowrap = a.st.whiteSpace === 'nowrap' || a.st.whiteSpace === 'pre';
    if (!nowrap && cur.w + a.w > avail + 0.5 && hasContent(cur)) push();
    const avail2 = w - (lines.length === 0 ? indent : 0);
    if (a.k === 'w' && !nowrap && a.w > avail2 + 0.5 && avail2 > 20) {
      let rest = a.text;
      const font = fontOf(a.st);
      while (rest) {
        const room = w - (lines.length === 0 ? indent : 0) - cur.w;
        const n = fitChars(rest, font, Math.max(room, 1), ctx);
        if (n < rest.length && cur.atoms.length && room < a.w * 0.5) {
          push();
          continue;
        }
        const piece = rest.slice(0, n);
        cur.atoms.push({ k: 'w', text: piece, st: a.st, w: ctx.measure(font, piece) });
        cur.w += cur.atoms[cur.atoms.length - 1].w;
        rest = rest.slice(n);
        if (rest) push();
      }
      continue;
    }
    cur.atoms.push(a);
    cur.w += a.w;
  }
  if (hasContent(cur)) push();
  return lines;
}

function layoutInline(nodes, x, w, ctx, container) {
  const cs = container.style;
  const atoms = [];
  for (const n of nodes) collect(n, atoms, ctx, w);
  if (!atoms.some((a) => a.k !== 's')) return;
  const indent = cs.textIndent || 0;
  const lines = buildLines(atoms, w, indent, ctx);
  const csFont = fontOf(cs);
  const strutLh = lineHeightOf(cs);
  const strutAbove = (strutLh - cs.fontSize) / 2 + cs.fontSize * 0.8;
  const strutBelow = strutLh - strutAbove;
  lines.forEach((line, li) => {
    while (line.atoms.length && line.atoms[0].k === 's' && !line.atoms[0].keep) line.w -= line.atoms.shift().w;
    let above = strutAbove;
    let below = strutBelow;
    for (const a of line.atoms) {
      if (a.k === 'b') {
        const baselineFrac = a.kind === 'img' ? 1 : a.kind === 'sub' ? 1 : 0.72;
        above = Math.max(above, a.h * baselineFrac);
        below = Math.max(below, a.h * (1 - baselineFrac));
      } else {
        const lh = lineHeightOf(a.st);
        const ab = (lh - a.st.fontSize) / 2 + a.st.fontSize * 0.8;
        above = Math.max(above, ab);
        below = Math.max(below, lh - ab);
      }
    }
    if (line.br && !line.atoms.length) {
      const lh = lineHeightOf(line.br.st);
      above = Math.max(above, (lh - line.br.st.fontSize) / 2 + line.br.st.fontSize * 0.8);
    }
    flushPending(ctx);
    const top = ctx.y;
    const baseline = top + above;
    const startIndent = li === 0 ? indent : 0;
    let off = startIndent;
    const avail = w - startIndent;
    if (cs.textAlign === 'center') off += (avail - line.w) / 2;
    else if (cs.textAlign === 'right') off += avail - line.w;
    else if (cs.textAlign === 'justify' && !line.hard && li < lines.length - 1) {
      const gaps = line.atoms.filter((a) => a.k === 's').length;
      if (gaps > 0) {
        const extra = (avail - line.w) / gaps;
        for (const a of line.atoms) if (a.k === 's') a.w += extra;
        line.w = avail;
      }
    }
    let cur = x + Math.max(0, off);
    ctx.maxX = Math.max(ctx.maxX, cur + line.w);
    // Merge neighbouring text atoms that share a style into one run.
    let run = null;
    const flushRun = () => {
      if (!run) return;
      const st = run.st;
      if (st.visibility !== 'hidden') {
        if (st.bg && st.display === 'inline') ctx.cmds.push({ t: 'box', x: run.x, y: baseline - st.fontSize * 0.95, w: run.w, h: st.fontSize * 1.25, bg: st.bg, r: 0, alpha: 1, b: [0, 0, 0, 0], bc: [] });
        ctx.cmds.push({ t: 'text', x: run.x, y: baseline, text: run.text, font: run.font, c: st.color, deco: st.deco, w: run.w, fs: st.fontSize });
        if (st.href) ctx.links.push({ x: run.x, y: baseline - st.fontSize, w: run.w, h: st.fontSize * 1.3, href: st.href });
      }
      run = null;
    };
    for (const a of line.atoms) {
      if (a.k === 'b') {
        flushRun();
        emitBox(a, cur, baseline, ctx);
        cur += a.w;
        continue;
      }
      const text = a.k === 's' ? ' ' : a.text;
      const font = fontOf(a.st);
      if (run && run.st === a.st) {
        run.text += text;
        run.w += a.w;
      } else {
        flushRun();
        run = { x: cur, text, font, w: a.w, st: a.st };
      }
      cur += a.w;
    }
    flushRun();
    ctx.y = top + above + below;
  });
  void csFont;
}

function emitBox(a, x, baseline, ctx) {
  const s = a.st;
  if (a.kind === 'img') {
    const y = baseline - a.h;
    if (s.visibility !== 'hidden') {
      ctx.cmds.push({ t: 'img', x, y, w: a.w, h: a.h, img: a.img, alpha: s.opacity });
      if (s.href) ctx.links.push({ x, y, w: a.w, h: a.h, href: s.href });
    }
    return;
  }
  if (a.kind === 'sub') {
    const y = baseline - a.h;
    shiftRange(ctx, a.range, x, y);
    return;
  }
  // Form control.
  const spec = a.spec;
  const above = a.h * 0.72;
  const y = baseline - above;
  const cxp = x + (a.mx || 0);
  if (spec.ctl === 'btn') {
    const font = `13px ${FAMILIES.sans}`;
    ctx.cmds.push({ t: 'box', x: cxp, y, w: spec.w, h: spec.h, bg: '#efefef', r: 4, alpha: 1, b: [1, 1, 1, 1], bc: ['#767676', '#767676', '#767676', '#767676'] });
    const tw = ctx.measure(font, spec.label);
    ctx.cmds.push({ t: 'text', x: cxp + (spec.w - tw) / 2, y: y + spec.h / 2 + 4.6, text: spec.label, font, c: '#000000', w: tw });
    ctx.controls.push({ node: a.node, ctl: 'button', x: cxp, y, w: spec.w, h: spec.h });
  } else {
    ctx.controls.push({ node: a.node, ctl: spec.ctl, type: spec.type, x: cxp, y, w: spec.w, h: spec.h });
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * opts: { width, height, measure(font, text) → px, getImage(node) → { state, w, h, img } }
 * Returns { cmds, links, controls, width, height, bg }.
 */
export function layoutDocument(html, opts) {
  const ctx = {
    cmds: [], links: [], controls: [], y: 0, pending: 0, open: [], maxX: opts.width,
    vw: opts.width, vh: opts.height || 800, measure: opts.measure, getImage: opts.getImage,
    mc: new Map(), mn: new Map(), tm: new Map(), anchors: Object.create(null), skipBgEl: null,
  };
  void viewportEnv;
  const body = html.children.find((c) => c.type === 'el' && c.tag === 'body');
  let bg = html.style.bg;
  if (!bg && body && body.style.bg) {
    bg = body.style.bg; // the body background paints the whole canvas, not just the body box
    ctx.skipBgEl = body;
  }
  const m = new Map();
  const measure = (font, text) => {
    let fm = m.get(font);
    if (!fm) { fm = new Map(); m.set(font, fm); }
    let v = fm.get(text);
    if (v === undefined) { v = opts.measure(font, text); fm.set(text, v); }
    return v;
  };
  ctx.measure = measure;
  layoutBlock(html, 0, opts.width, ctx, { bfc: true });
  flushPending(ctx);
  return { cmds: ctx.cmds, links: ctx.links, controls: ctx.controls, anchors: ctx.anchors, width: ctx.maxX, height: Math.ceil(ctx.y), bg: bg || '#ffffff' };
}
