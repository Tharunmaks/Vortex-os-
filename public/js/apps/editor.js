// Editor — plain text / code editor backed by the bee's home.
import { api, h, toast, fail, modal } from '../api.js';
import { openWindow } from '../wm.js';

export default {
  id: 'editor',
  name: 'Editor',
  description: 'Edit text and code',
  open(os, { path } = {}) {
    let current = path || null;
    let dirty = false;
    const canWrite = os.perms.write;

    const area = h('textarea.editor-area', { spellcheck: 'false', wrap: 'off', 'aria-label': 'Editor', placeholder: 'Start typing…' });
    const pos = h('span', 'Ln 1, Col 1');
    const info = h('span', canWrite ? 'Ctrl+S to save' : 'Read-only (drone)');
    const nameEl = h('span.grow.mono', { style: { fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, current || 'untitled');

    const toolbar = h('div.toolbar',
      h('button.btn.small', { onclick: openPrompt }, 'Open…'),
      h('button.btn.small.primary', { onclick: () => save(false), disabled: !canWrite }, 'Save'),
      h('button.btn.small', { onclick: () => save(true), disabled: !canWrite }, 'Save as…'),
      nameEl,
      h('label.muted', { style: { fontSize: '12px', display: 'flex', gap: '4px', alignItems: 'center' } },
        h('input', { type: 'checkbox', onchange: (e) => area.setAttribute('wrap', e.target.checked ? 'soft' : 'off') }), 'Wrap'),
    );
    const body = h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } }, toolbar, area, h('div.statusbar', pos, info));

    const win = openWindow({
      app: 'editor',
      title: 'Editor',
      width: 760,
      height: 520,
      body,
      onFocus: () => area.focus(),
      onClose: () => {
        if (dirty) toast(`Unsaved changes in ${current || 'untitled'} were discarded`);
      },
    });

    const setTitle = () => {
      const name = current ? current.split('/').pop() : 'untitled';
      win.setTitle(`${dirty ? '● ' : ''}${name} — Editor`);
      nameEl.textContent = current ? `~${current}` : 'untitled';
    };

    async function load(p) {
      try {
        const data = await api(`/api/fs/read?path=${encodeURIComponent(p)}`);
        current = data.path;
        area.value = data.content;
        dirty = false;
        setTitle();
        area.focus();
        area.setSelectionRange(0, 0);
      } catch (err) {
        fail(err);
      }
    }

    async function openPrompt() {
      const r = await modal({ title: 'Open file', fields: [{ name: 'path', label: 'Path inside your home', value: current || '/README.txt' }], confirm: 'Open' });
      if (r?.path) load(r.path);
    }

    async function save(as) {
      if (!canWrite) return;
      let target = current;
      if (as || !target) {
        const r = await modal({ title: 'Save as', fields: [{ name: 'path', label: 'Path inside your home', value: current || '/Documents/untitled.txt' }], confirm: 'Save' });
        if (!r?.path) return;
        target = r.path.startsWith('/') ? r.path : '/' + r.path;
      }
      try {
        const res = await api('/api/fs/write', { method: 'PUT', body: { path: target, content: area.value } });
        current = res.path;
        dirty = false;
        setTitle();
        toast(`Saved ~${current}`, { type: 'ok', timeout: 1800 });
      } catch (err) {
        fail(err);
      }
    }

    area.addEventListener('input', () => {
      if (!dirty) {
        dirty = true;
        setTitle();
      }
    });
    area.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save(e.shiftKey);
      } else if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const { selectionStart: s, selectionEnd: en } = area;
        area.setRangeText('    ', s, en, 'end');
        area.dispatchEvent(new Event('input'));
      }
    });
    const updatePos = () => {
      const before = area.value.slice(0, area.selectionStart);
      const line = before.split('\n').length;
      const col = before.length - before.lastIndexOf('\n');
      pos.textContent = `Ln ${line}, Col ${col} · ${area.value.length} chars`;
    };
    area.addEventListener('keyup', updatePos);
    area.addEventListener('click', updatePos);

    if (current) load(current);
    else setTitle();
    return win;
  },
};
