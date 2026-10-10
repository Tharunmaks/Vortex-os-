// Settings — appearance, password and about.
import { api, h, toast, fail } from '../api.js';
import { openWindow } from '../wm.js';

const ACCENTS = ['#f5b301', '#ff7a18', '#22c55e', '#38bdf8', '#a78bfa', '#f472b6', '#ef4444'];
const WALLS = [
  ['honeycomb', 'Honeycomb', 'linear-gradient(160deg,#3a2a05,#0b0a08)'],
  ['vortex', 'Vortex', 'conic-gradient(from 210deg,#2b1a00,#f5b301,#3a1d00,#ff7a18,#2b1a00)'],
  ['meadow', 'Meadow', 'linear-gradient(180deg,#11283a,#1f6b3a)'],
  ['midnight', 'Midnight', 'linear-gradient(160deg,#1b2550,#05060b)'],
  ['amber', 'Amber', 'linear-gradient(135deg,#ffb703,#6a2c00)'],
];

export default {
  id: 'settings',
  name: 'Settings',
  description: 'Appearance, password and system info',
  open(os) {
    let tab = 'look';
    const tabs = h('div.tabs');
    const content = h('div.scroll');
    const body = h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } }, tabs, content);
    const win = openWindow({ app: 'settings', title: 'Settings', width: 620, height: 520, body });

    function renderTabs() {
      tabs.replaceChildren(...[['look', 'Appearance'], ['security', 'Password'], ['about', 'About']].map(([id, l]) =>
        h('button', { class: tab === id ? 'active' : '', onclick: () => ((tab = id), renderTabs(), render()) }, l)));
    }

    async function save(changes) {
      try {
        os.settings = await api('/api/settings', { method: 'PUT', body: changes });
        os.applySettings();
        render();
      } catch (err) {
        fail(err);
      }
    }

    function render() {
      const s = os.settings;
      if (tab === 'look') {
        content.replaceChildren(h('div.pad',
          h('div.form-row', h('label', 'Theme'), h('div.inline-form',
            ...['dark', 'light'].map((t) => h(`button.btn${s.theme === t ? '.primary' : ''}`, { onclick: () => save({ theme: t }) }, t === 'dark' ? '🌙 Dark' : '☀️ Light')))),
          h('div.form-row', h('label', 'Accent colour'), h('div.swatches',
            ...ACCENTS.map((c) => h('button.swatch', { class: s.accent === c ? 'active' : '', style: { background: c }, 'aria-label': c, onclick: () => save({ accent: c }) })))),
          h('div.form-row', h('label', 'Wallpaper'), h('div.wall-opts',
            ...WALLS.map(([id, name, bg]) => h('button.wall-opt', { class: s.wallpaper === id ? 'active' : '', style: { background: bg }, onclick: () => save({ wallpaper: id }) }, name)))),
          h('div.form-row', h('label', 'Clock'), h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
            h('input', { type: 'checkbox', checked: s.clock24, onchange: (e) => save({ clock24: e.target.checked }) }), '24-hour clock')),
        ));
      } else if (tab === 'security') {
        const form = h('form.pad', { style: { maxWidth: '380px' } },
          h('div.form-row', h('label', 'Current password'), h('input', { type: 'password', name: 'current', autocomplete: 'current-password', required: true })),
          h('div.form-row', h('label', 'New password'), h('input', { type: 'password', name: 'next', autocomplete: 'new-password', required: true, minlength: 10 })),
          h('div.form-row', h('label', 'Repeat new password'), h('input', { type: 'password', name: 'repeat', autocomplete: 'new-password', required: true })),
          h('p.hint', 'At least 10 characters, with 3 of: lowercase, uppercase, digit, symbol. Your other sessions will be signed out.'),
          h('button.btn.primary', { type: 'submit', style: { marginTop: '10px' } }, 'Change password'),
        );
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const f = new FormData(form);
          if (f.get('next') !== f.get('repeat')) return toast('New passwords do not match', { type: 'error' });
          try {
            await api('/api/auth/password', { method: 'POST', body: { current: f.get('current'), next: f.get('next') } });
            toast('Password changed 🍯', { type: 'ok' });
            form.reset();
          } catch (err) {
            fail(err);
          }
        });
        content.replaceChildren(form);
      } else {
        content.replaceChildren(h('div.pad', { style: { textAlign: 'center' } },
          h('img', { src: '/img/logo.svg', alt: '', style: { width: '84px', height: '84px' } }),
          h('h2', { style: { margin: '8px 0 0' } }, 'Vortex OS'),
          h('p.muted', `Version ${os.version} · ${os.hive}`),
          h('p', 'A secure cloud Linux desktop for the MNX Hive bees.'),
          h('p.muted', { style: { fontSize: '12px' } }, 'Real bash · Files · Editor · Sandboxed Browser · Monitor · Hive Control'),
        ));
      }
    }

    renderTabs();
    render();
    return win;
  },
};
