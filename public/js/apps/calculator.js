// Calculator — a safe expression evaluator (no eval).
import { h } from '../api.js';
import { openWindow } from '../wm.js';

/** Shunting-yard evaluator for + - × ÷ % ^ and parentheses. */
export function evaluate(expr) {
  const tokens = expr.replace(/×/g, '*').replace(/÷/g, '/').match(/\d*\.?\d+(?:e[+-]?\d+)?|[-+*/%^()]/gi);
  if (!tokens || tokens.join('') !== expr.replace(/×/g, '*').replace(/÷/g, '/').replace(/\s+/g, '')) throw new Error('Syntax error');
  const prec = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3, neg: 2.5 };
  const out = [];
  const ops = [];
  let prev = null;
  for (const t of tokens) {
    if (/^[\d.]/.test(t)) out.push(parseFloat(t));
    else if (t === '(') ops.push(t);
    else if (t === ')') {
      while (ops.length && ops.at(-1) !== '(') out.push(ops.pop());
      if (!ops.length) throw new Error('Mismatched )');
      ops.pop();
    } else {
      const unary = t === '-' && (prev === null || (prev !== ')' && !/^[\d.]/.test(prev)));
      if (unary) {
        // Prefix operator: binds tighter than × ÷ but looser than ^, so -2^2 = -4.
        ops.push('neg');
        prev = t;
        continue;
      }
      const op = t;
      while (ops.length && ops.at(-1) !== '(' && (prec[ops.at(-1)] > prec[op] || (prec[ops.at(-1)] === prec[op] && op !== '^' && op !== 'neg'))) out.push(ops.pop());
      ops.push(op);
    }
    prev = t;
  }
  while (ops.length) {
    const op = ops.pop();
    if (op === '(') throw new Error('Mismatched (');
    out.push(op);
  }
  const st = [];
  for (const t of out) {
    if (typeof t === 'number') st.push(t);
    else if (t === 'neg') st.push(-st.pop());
    else {
      const b = st.pop();
      const a = st.pop();
      if (a === undefined || b === undefined) throw new Error('Syntax error');
      st.push({ '+': a + b, '-': a - b, '*': a * b, '/': a / b, '%': a % b, '^': a ** b }[t]);
    }
  }
  if (st.length !== 1 || !Number.isFinite(st[0])) throw new Error('Math error');
  return Math.round(st[0] * 1e12) / 1e12;
}

export default {
  id: 'calculator',
  name: 'Calculator',
  description: 'Quick maths for busy bees',
  open() {
    let expr = '';
    const prevEl = h('small');
    const cur = h('span', '0');
    const screen = h('div.calc-screen', prevEl, cur);
    const press = (k) => {
      if (k === 'C') expr = '';
      else if (k === '⌫') expr = expr.slice(0, -1);
      else if (k === '=') {
        try {
          const r = evaluate(expr);
          prevEl.textContent = expr + ' =';
          expr = String(r);
        } catch (e) {
          prevEl.textContent = e.message;
        }
      } else expr += k;
      cur.textContent = expr || '0';
    };
    const keys = ['C', '(', ')', '÷', '7', '8', '9', '×', '4', '5', '6', '-', '1', '2', '3', '+', '0', '.', '⌫', '='];
    const pad = h('div.calc-keys', keys.map((k) => h('button', { class: k === '=' ? 'eq' : /[÷×+\-()C⌫]/.test(k) ? 'op' : '', onclick: () => press(k) }, k)));
    const body = h('div.calc', { tabindex: '0' }, screen, pad);
    body.addEventListener('keydown', (e) => {
      const map = { Enter: '=', '=': '=', Backspace: '⌫', Escape: 'C', '*': '×', '/': '÷' };
      const k = map[e.key] || (/^[\d.+\-()%^]$/.test(e.key) ? e.key : null);
      if (k) {
        e.preventDefault();
        press(k);
      }
    });
    const win = openWindow({ app: 'calculator', title: 'Calculator', width: 300, height: 440, body, onFocus: () => body.focus() });
    body.focus();
    return win;
  },
};
