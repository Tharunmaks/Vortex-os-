// Vortex OS — API client and small UI helpers.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export async function api(path, { method = 'GET', body, raw, signal, headers = {} } = {}) {
  const opts = { method, headers: { ...headers }, credentials: 'same-origin', signal };
  if (raw !== undefined) {
    opts.body = raw;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let data = null;
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) data = await res.json();
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/login')) onUnauthorized();
    throw new ApiError(res.status, data?.error || `Request failed (${res.status})`);
  }
  return data;
}

/** Tiny DOM builder: h('div.cls#id', {attrs}, ...children). Text is always escaped. */
export function h(sel, attrs = {}, ...kids) {
  const [, tag = 'div', rest = ''] = sel.match(/^([a-z0-9-]*)(.*)$/i);
  const el = document.createElement(tag || 'div');
  for (const part of rest.match(/[.#][^.#]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (attrs instanceof Node || typeof attrs === 'string' || Array.isArray(attrs)) {
    kids.unshift(attrs);
    attrs = {};
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'class') el.classList.add(...String(v).split(/\s+/).filter(Boolean));
    else if (k === 'html') el.innerHTML = v; // only ever used with trusted, static markup (icons)
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export function toast(message, { type = 'info', detail, timeout = 4500 } = {}) {
  const el = h(`div.toast.${type}`, {}, h('div', message), detail ? h('pre', detail) : null);
  document.getElementById('toasts').append(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  el.addEventListener('click', () => el.remove());
  return el;
}

export function fail(err) {
  toast(err?.message || String(err), { type: 'error' });
}

/** Promise-based modal. fields: [{name, label, type, value, options}] */
export function modal({ title, message, fields = [], confirm = 'OK', cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const inputs = {};
    const form = h('form.modal', { role: 'dialog', 'aria-label': title });
    form.append(h('h2', title));
    if (message) form.append(h('p', message));
    for (const f of fields) {
      let input;
      if (f.type === 'select') {
        input = h('select', { name: f.name }, f.options.map(([v, l]) => h('option', { value: v, selected: v === f.value }, l)));
      } else {
        input = h('input', { name: f.name, type: f.type || 'text', value: f.value ?? '', placeholder: f.placeholder || '', autocomplete: 'off', spellcheck: 'false' });
      }
      inputs[f.name] = input;
      form.append(h('div.form-row', h('label', f.label), input));
    }
    const close = (val) => {
      back.remove();
      resolve(val);
    };
    form.append(
      h('div.actions',
        cancel ? h('button.btn', { type: 'button', onclick: () => close(null) }, cancel) : null,
        h(`button.btn.${danger ? 'danger' : 'primary'}`, { type: 'submit' }, confirm),
      ),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const out = {};
      for (const [k, el] of Object.entries(inputs)) out[k] = el.value;
      close(fields.length ? out : true);
    });
    const back = h('div.modal-back', { onclick: (e) => e.target === back && close(null) }, form);
    back.addEventListener('keydown', (e) => e.key === 'Escape' && close(null));
    document.body.append(back);
    (form.querySelector('input,select') || form.querySelector('button[type=submit]')).focus();
  });
}

export const fmt = {
  bytes(n) {
    if (!Number.isFinite(n)) return '–';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
  },
  duration(sec) {
    sec = Math.floor(sec);
    const d = Math.floor(sec / 86400);
    const hh = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return d ? `${d}d ${hh}h` : hh ? `${hh}h ${m}m` : `${m}m ${sec % 60}s`;
  },
  ago(iso) {
    if (!iso) return 'never';
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString();
  },
  time(iso) {
    return new Date(iso).toLocaleString();
  },
};
