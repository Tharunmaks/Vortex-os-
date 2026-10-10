// Vortex OS — window manager.
import { h } from './api.js';
import { icons, gradients } from './icons.js';

const layer = () => document.getElementById('windows');
const windows = new Map();
let z = 10;
let nextId = 1;
let cascade = 0;
const listeners = new Set();

export function onChange(fn) {
  listeners.add(fn);
}
function emit() {
  for (const fn of listeners) fn();
}

export function appIcon(appId) {
  return h('span.app-icon', { style: { '--g': gradients[appId] || '' }, html: icons[appId] || icons.hive });
}

/**
 * Open a window.
 *   app: app id (icon + dock grouping)   title, width, height
 *   body: HTMLElement                     onClose(), onResize(), onFocus()
 */
export function openWindow({ app, title, width = 760, height = 500, body, onClose, onResize, onFocus }) {
  const id = nextId++;
  const area = layer().getBoundingClientRect();
  width = Math.min(width, area.width - 20);
  height = Math.min(height, area.height - 90);
  const left = Math.max(10, (area.width - width) / 2 - 120 + (cascade % 6) * 32);
  const top = Math.max(8, (area.height - 80 - height) / 2 - 40 + (cascade % 6) * 28);
  cascade++;

  const titleEl = h('div.win-title', title);
  const win = h('section.win', { role: 'dialog', 'aria-label': title, style: { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` } });
  const bar = h('header.win-bar', appIcon(app), titleEl,
    h('div.win-ctrl',
      h('button', { title: 'Minimise', 'aria-label': 'Minimise', html: icons.min, onclick: (e) => (e.stopPropagation(), minimize(id)) }),
      h('button', { title: 'Maximise', 'aria-label': 'Maximise', html: icons.max, onclick: (e) => (e.stopPropagation(), toggleMax(id)) }),
      h('button.close', { title: 'Close', 'aria-label': 'Close', html: icons.close, onclick: (e) => (e.stopPropagation(), close(id)) }),
    ),
  );
  const content = h('div.win-body', body);
  win.append(bar, content, h('div.win-resize-r'), h('div.win-resize-b'), h('div.win-resize'));
  layer().append(win);

  const w = { id, app, win, titleEl, onClose, onResize, onFocus, minimized: false };
  windows.set(id, w);

  win.addEventListener('pointerdown', () => focus(id), true);
  bar.addEventListener('dblclick', (e) => !e.target.closest('button') && toggleMax(id));
  drag(w, bar);
  resize(w, win.querySelector('.win-resize'), true, true);
  resize(w, win.querySelector('.win-resize-r'), true, false);
  resize(w, win.querySelector('.win-resize-b'), false, true);

  focus(id);
  emit();
  requestAnimationFrame(() => onResize?.());
  return {
    id,
    el: win,
    setTitle(t) {
      titleEl.textContent = t;
      win.setAttribute('aria-label', t);
      if (w.win.classList.contains('focused')) emit();
    },
    close: () => close(id),
    focus: () => focus(id),
  };
}

function drag(w, handle) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button') || w.win.classList.contains('maximized')) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const ox = w.win.offsetLeft;
    const oy = w.win.offsetTop;
    const area = layer().getBoundingClientRect();
    w.win.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const x = Math.min(area.width - 80, Math.max(80 - w.win.offsetWidth, ox + ev.clientX - startX));
      const y = Math.min(area.height - 50, Math.max(0, oy + ev.clientY - startY));
      w.win.style.left = `${x}px`;
      w.win.style.top = `${y}px`;
    };
    const up = () => {
      w.win.classList.remove('dragging');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

function resize(w, handle, horizontal, vertical) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const ow = w.win.offsetWidth;
    const oh = w.win.offsetHeight;
    w.win.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
    let raf = 0;
    const move = (ev) => {
      if (horizontal) w.win.style.width = `${Math.max(280, ow + ev.clientX - sx)}px`;
      if (vertical) w.win.style.height = `${Math.max(160, oh + ev.clientY - sy)}px`;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => w.onResize?.());
    };
    const up = () => {
      w.win.classList.remove('dragging');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      w.onResize?.();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}

export function focus(id) {
  const w = windows.get(id);
  if (!w) return;
  if (w.minimized) {
    w.minimized = false;
    w.win.classList.remove('minimized');
    requestAnimationFrame(() => w.onResize?.());
  }
  const already = w.win.classList.contains('focused') && Number(w.win.style.zIndex) === z;
  for (const o of windows.values()) o.win.classList.toggle('focused', o === w);
  if (!already) w.win.style.zIndex = String(++z);
  w.onFocus?.();
  emit();
}

export function minimize(id) {
  const w = windows.get(id);
  if (!w) return;
  w.minimized = true;
  w.win.classList.add('minimized');
  w.win.classList.remove('focused');
  emit();
}

export function toggleMax(id) {
  const w = windows.get(id);
  if (!w) return;
  w.win.classList.toggle('maximized');
  requestAnimationFrame(() => w.onResize?.());
}

export function close(id) {
  const w = windows.get(id);
  if (!w) return;
  try {
    w.onClose?.();
  } finally {
    w.win.remove();
    windows.delete(id);
    emit();
  }
}

export function closeAll() {
  for (const id of [...windows.keys()]) close(id);
}

export function list() {
  return [...windows.values()];
}

export function focused() {
  return [...windows.values()].find((w) => w.win.classList.contains('focused')) || null;
}

/** Bring the most recent window of an app forward; returns false if none. */
export function raiseApp(app) {
  const ws = [...windows.values()].filter((w) => w.app === app);
  if (!ws.length) return false;
  const top = ws.sort((a, b) => Number(b.win.style.zIndex) - Number(a.win.style.zIndex))[0];
  if (top.win.classList.contains('focused') && !top.minimized) minimize(top.id);
  else focus(top.id);
  return true;
}
