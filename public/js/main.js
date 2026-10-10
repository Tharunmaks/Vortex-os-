// Vortex OS — desktop bootstrap.
import { api, h, toast, fail, setUnauthorizedHandler } from './api.js';
import * as wm from './wm.js';
import terminal from './apps/terminal.js';
import files from './apps/files.js';
import editor from './apps/editor.js';
import browser from './apps/browser.js';
import monitor from './apps/monitor.js';
import hive from './apps/hive.js';
import settings from './apps/settings.js';
import calculator from './apps/calculator.js';

const APPS = [terminal, files, browser, editor, monitor, hive, calculator, settings];
const DOCK = ['terminal', 'files', 'browser', 'editor', 'monitor', 'hive'];
const DESK = ['terminal', 'files', 'browser', 'hive'];

const $ = (id) => document.getElementById(id);
const os = {
  user: null,
  perms: {},
  settings: {},
  hive: 'MNX Hive',
  version: '',
  open,
  applySettings,
};

function show(id) {
  for (const s of ['login', 'pwchange', 'desktop']) $(s).classList.toggle('hidden', s !== id);
}

function allowed(app) {
  return !app.needs || os.perms[app.needs];
}

function open(id, args) {
  const app = APPS.find((a) => a.id === id);
  if (!app) return;
  if (!allowed(app)) return toast(`${app.name} isn’t available to ${os.user.roleLabel}s`, { type: 'error' });
  closeMenus();
  try {
    return app.open(os, args || {});
  } catch (err) {
    fail(err);
  }
}

function applySettings() {
  const s = os.settings;
  const root = document.documentElement;
  root.dataset.theme = s.theme || 'dark';
  root.dataset.wallpaper = s.wallpaper || 'honeycomb';
  root.style.setProperty('--accent', s.accent || '#f5b301');
  tick();
}

// ── Boot / auth flow ─────────────────────────────────────────────────────────
async function boot() {
  setUnauthorizedHandler(() => {
    if (os.user) {
      os.user = null;
      wm.closeAll();
      toast('Your session ended — please sign in again.', { type: 'error' });
      showLogin();
    }
  });
  try {
    const hiveInfo = await api('/api/hive');
    os.hive = hiveInfo.name;
    os.version = hiveInfo.version;
    $('login-hive').textContent = `${hiveInfo.name} · v${hiveInfo.version}`;
  } catch {
    /* offline — login will report it */
  }
  try {
    await enter(await api('/api/auth/me'));
  } catch {
    showLogin();
  } finally {
    setTimeout(() => $('boot').classList.add('fade'), 350);
    setTimeout(() => $('boot').remove(), 800);
  }
}

function showLogin() {
  show('login');
  const form = $('login-form');
  form.reset();
  $('login-error').textContent = '';
  setTimeout(() => form.username.focus(), 50);
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector('button');
  btn.disabled = true;
  $('login-error').textContent = '';
  try {
    await api('/api/auth/login', { method: 'POST', body: { username: form.username.value.trim(), password: form.password.value } });
    await enter(await api('/api/auth/me'));
  } catch (err) {
    $('login-error').textContent = err.message;
    form.password.value = '';
    form.password.focus();
  } finally {
    btn.disabled = false;
  }
});

$('pwchange-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('pwchange-error').textContent = '';
  if (f.next.value !== f.repeat.value) {
    $('pwchange-error').textContent = 'New passwords do not match';
    return;
  }
  try {
    await api('/api/auth/password', { method: 'POST', body: { current: f.current.value, next: f.next.value } });
    f.reset();
    await enter(await api('/api/auth/me'));
    toast('Password saved — welcome to the hive 🍯', { type: 'ok' });
  } catch (err) {
    $('pwchange-error').textContent = err.message;
  }
});

async function enter(me) {
  Object.assign(os, { user: me.user, perms: me.perms, settings: me.settings, hive: me.hive, version: me.version });
  if (me.user.mustChangePassword) {
    show('pwchange');
    $('pwchange-form').current.focus();
    return;
  }
  applySettings();
  buildDesktop();
  show('desktop');
}

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST', body: {} });
  } catch {
    /* ignore */
  }
  os.user = null;
  wm.closeAll();
  showLogin();
}

// ── Desktop chrome ───────────────────────────────────────────────────────────
function buildDesktop() {
  const visible = APPS.filter(allowed);

  $('dock').replaceChildren(
    ...DOCK.map((id) => visible.find((a) => a.id === id)).filter(Boolean).map((app) =>
      h('button.dock-item', { title: app.name, 'aria-label': app.name, dataset: { app: app.id }, onclick: () => wm.raiseApp(app.id) || open(app.id) }, wm.appIcon(app.id))),
    h('span.dock-sep'),
    h('button.dock-item', { title: 'All apps', 'aria-label': 'All apps', onclick: toggleLauncher }, wm.appIcon('apps')),
  );

  $('desk-icons').replaceChildren(
    ...DESK.map((id) => visible.find((a) => a.id === id)).filter(Boolean).map((app) =>
      h('button.desk-icon', { ondblclick: () => open(app.id), onkeydown: (e) => e.key === 'Enter' && open(app.id) }, wm.appIcon(app.id), h('span', app.name))),
  );

  renderLauncher('');
  $('user-btn').textContent = `🐝 ${os.user.username}`;
  $('guard-chip').classList.toggle('hidden', !os.perms.terminal);
  $('user-menu').replaceChildren(
    h('div.menu-head', h('strong', os.user.username), h('small', `${os.user.roleLabel} · ${os.hive}`)),
    h('button', { onclick: () => open('settings') }, '⚙️  Settings'),
    h('button', { onclick: () => open('hive') }, os.perms.admin ? '👑  Hive Control' : '🐝  My bee'),
    h('button', { onclick: lock }, '🔒  Lock screen'),
    h('button', { onclick: logout }, '🚪  Sign out'),
  );
  updateDock();
}

function renderLauncher(q) {
  const ql = q.toLowerCase();
  $('launcher-grid').replaceChildren(
    ...APPS.filter(allowed).filter((a) => !ql || `${a.name} ${a.description}`.toLowerCase().includes(ql)).map((app) =>
      h('button.launcher-item', { title: app.description, onclick: () => open(app.id) }, wm.appIcon(app.id), h('span', app.name))),
  );
}

function toggleLauncher() {
  const l = $('launcher');
  const opening = l.classList.contains('hidden');
  closeMenus();
  if (opening) {
    l.classList.remove('hidden');
    $('launcher-search').value = '';
    renderLauncher('');
    $('launcher-search').focus();
  }
}

function closeMenus() {
  $('launcher').classList.add('hidden');
  $('user-menu').classList.add('hidden');
}

async function lock() {
  // Locking signs the session out but keeps nothing sensitive on screen.
  await logout();
  toast('Screen locked. Sign in to continue.');
}

function updateDock() {
  const running = new Set(wm.list().map((w) => w.app));
  for (const btn of document.querySelectorAll('.dock-item[data-app]')) btn.classList.toggle('running', running.has(btn.dataset.app));
  const f = wm.focused();
  $('active-title').textContent = f ? f.titleEl.textContent : '';
}
wm.onChange(updateDock);

$('launcher-btn').addEventListener('click', toggleLauncher);
$('launcher-search').addEventListener('input', (e) => renderLauncher(e.target.value));
$('launcher-search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('launcher-grid').querySelector('button')?.click();
  if (e.key === 'Escape') closeMenus();
});
$('user-btn').addEventListener('click', () => {
  const m = $('user-menu');
  const opening = m.classList.contains('hidden');
  closeMenus();
  if (opening) m.classList.remove('hidden');
});
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#launcher, #launcher-btn, #user-menu, #user-btn, .dock')) closeMenus();
});
document.addEventListener('keydown', (e) => {
  if (!os.user || $('desktop').classList.contains('hidden')) return;
  if (e.altKey && e.key.toLowerCase() === 't') {
    e.preventDefault();
    open('terminal');
  } else if (e.altKey && e.code === 'Space') {
    e.preventDefault();
    toggleLauncher();
  } else if (e.key === 'Escape') {
    closeMenus();
  }
});

// ── Clock & live stats ───────────────────────────────────────────────────────
function tick() {
  const now = new Date();
  $('clock').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: !os.settings.clock24 }) + '  ' +
    now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}
setInterval(tick, 10_000);

async function pollStats() {
  if (!os.user || os.user.mustChangePassword || document.hidden) return;
  try {
    const s = await api('/api/system/stats');
    $('stat-chip').textContent = `CPU ${s.cpu.toFixed(0)}% · RAM ${Math.round((s.memory.used / s.memory.total) * 100)}%`;
  } catch {
    /* ignore */
  }
}
setInterval(pollStats, 5000);

window.addEventListener('resize', () => {
  for (const w of wm.list()) w.onResize?.();
});

boot().then(pollStats);
