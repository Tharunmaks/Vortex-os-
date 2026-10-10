// Files — browse and manage the bee's home cell.
import { api, h, toast, fail, modal, fmt } from '../api.js';
import { openWindow } from '../wm.js';
import { icons } from '../icons.js';

const TEXT_EXT = /\.(txt|md|markdown|json|js|mjs|cjs|ts|tsx|jsx|css|scss|html?|xml|ya?ml|toml|ini|conf|cfg|env|sh|bash|zsh|py|rb|go|rs|c|h|cpp|hpp|java|kt|php|sql|csv|log|gitignore|dockerfile|makefile)$/i;

function glyph(e) {
  if (e.type === 'dir') return e.name === 'Honey' ? '🍯' : '📁';
  if (e.type === 'link') return '🔗';
  if (/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(e.name)) return '🖼️';
  if (/\.(zip|tar|gz|tgz|xz|7z|rar)$/i.test(e.name)) return '📦';
  if (/\.(sh|bash|py|js|ts|go|rs|c|cpp|rb|php)$/i.test(e.name)) return '📜';
  if (/\.(md|txt|log)$/i.test(e.name)) return '📝';
  return '📄';
}

export default {
  id: 'files',
  name: 'Files',
  description: 'Your home cell in the hive',
  open(os, { path = '/' } = {}) {
    let cwd = path;
    let selected = null;
    const history = [];
    const canWrite = os.perms.write;

    const crumbs = h('div.crumbs');
    const grid = h('div.file-grid');
    const status = h('div.statusbar', h('span', ''), h('span', ''));
    const fileInput = h('input', { type: 'file', multiple: true, class: 'hidden' });

    const btn = (label, title, fn, opts = {}) => h('button.btn.small', { title, onclick: fn, disabled: opts.disabled, html: opts.icon }, opts.icon ? null : label);

    const toolbar = h('div.toolbar',
      btn('', 'Back', () => history.length && load(history.pop(), false), { icon: icons.back }),
      btn('', 'Up', () => cwd !== '/' && load(cwd.replace(/\/[^/]+\/?$/, '') || '/'), { icon: icons.up }),
      btn('', 'Home', () => load('/'), { icon: icons.home }),
      crumbs,
      btn('New folder', 'New folder', newFolder, { disabled: !canWrite }),
      btn('New file', 'New text file', newFile, { disabled: !canWrite }),
      btn('Upload', 'Upload files', () => fileInput.click(), { disabled: !canWrite }),
    );
    const actions = h('div.toolbar',
      h('span.muted', { style: { fontSize: '12px' } }, 'Selection:'),
      btn('Open', 'Open', () => selected && activate(selected)),
      btn('Download', 'Download', () => selected && download(selected)),
      btn('Rename', 'Rename', () => selected && renameSel(), { disabled: !canWrite }),
      h('button.btn.small.danger', { onclick: () => selected && removeSel(), disabled: !canWrite }, 'Delete'),
      h('span.grow'),
      btn('Terminal here', 'Open a terminal', () => os.open('terminal'), { disabled: !os.perms.terminal }),
    );
    const body = h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } }, toolbar, actions, h('div.scroll', grid), status, fileInput);

    const win = openWindow({ app: 'files', title: 'Files', width: 760, height: 500, body });

    const full = (name) => (cwd === '/' ? '' : cwd) + '/' + name;

    async function load(path, push = true) {
      try {
        const data = await api(`/api/fs/list?path=${encodeURIComponent(path)}`);
        if (push && data.path !== cwd) history.push(cwd);
        cwd = data.path;
        selected = null;
        render(data.entries);
      } catch (err) {
        fail(err);
      }
    }

    function render(entries) {
      win.setTitle(`Files — ~${cwd === '/' ? '' : cwd}`);
      crumbs.replaceChildren(h('button', { onclick: () => load('/') }, `🏠 ${os.user.username}`));
      let acc = '';
      for (const part of cwd.split('/').filter(Boolean)) {
        acc += '/' + part;
        const target = acc;
        crumbs.append(h('span.muted', '›'), h('button', { onclick: () => load(target) }, part));
      }
      grid.replaceChildren();
      if (!entries.length) grid.append(h('div.empty', { style: { gridColumn: '1/-1' } }, 'This cell is empty. Drop files here to upload.'));
      for (const e of entries) {
        const item = h('button.file-item', { title: `${e.name}\n${e.type === 'dir' ? 'Folder' : fmt.bytes(e.size)} · ${fmt.time(e.mtime)}` },
          h('span.ficon', glyph(e)), h('span', e.name));
        item.addEventListener('click', () => {
          grid.querySelectorAll('.selected').forEach((n) => n.classList.remove('selected'));
          item.classList.add('selected');
          selected = e;
          status.firstChild.textContent = `${e.name} — ${e.type === 'dir' ? 'folder' : fmt.bytes(e.size)} · modified ${fmt.ago(e.mtime)} · mode ${e.mode}`;
        });
        item.addEventListener('dblclick', () => activate(e));
        item.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') activate(e);
          if (ev.key === 'Delete' && canWrite) {
            selected = e;
            removeSel();
          }
        });
        grid.append(item);
      }
      status.firstChild.textContent = `${entries.length} item${entries.length === 1 ? '' : 's'}`;
      api('/api/fs/usage').then((u) => (status.lastChild.textContent = `${fmt.bytes(u.used)} of ${fmt.bytes(u.quota)} used`)).catch(() => {});
    }

    function activate(e) {
      if (e.type === 'dir') return load(full(e.name));
      if (TEXT_EXT.test(e.name) || !/\.[^.]+$/.test(e.name)) {
        return os.open('editor', { path: full(e.name) });
      }
      download(e);
    }

    function download(e) {
      if (e.type === 'dir') return toast('Folders cannot be downloaded directly — use tar in the terminal.');
      const a = h('a', { href: `/api/fs/download?path=${encodeURIComponent(full(e.name))}`, download: e.name });
      document.body.append(a);
      a.click();
      a.remove();
    }

    async function newFolder() {
      const r = await modal({ title: 'New folder', fields: [{ name: 'name', label: 'Folder name', value: 'New Folder' }], confirm: 'Create' });
      if (!r?.name) return;
      try {
        await api('/api/fs/mkdir', { method: 'POST', body: { path: cwd, name: r.name } });
        load(cwd, false);
      } catch (err) {
        fail(err);
      }
    }

    async function newFile() {
      const r = await modal({ title: 'New file', fields: [{ name: 'name', label: 'File name', value: 'notes.txt' }], confirm: 'Create' });
      if (!r?.name) return;
      try {
        await api('/api/fs/write', { method: 'PUT', body: { path: full(r.name), content: '' } });
        await load(cwd, false);
        os.open('editor', { path: full(r.name) });
      } catch (err) {
        fail(err);
      }
    }

    async function renameSel() {
      const r = await modal({ title: 'Rename', fields: [{ name: 'name', label: 'New name', value: selected.name }], confirm: 'Rename' });
      if (!r?.name || r.name === selected.name) return;
      try {
        await api('/api/fs/rename', { method: 'POST', body: { path: full(selected.name), name: r.name } });
        load(cwd, false);
      } catch (err) {
        fail(err);
      }
    }

    async function removeSel() {
      const ok = await modal({
        title: `Delete “${selected.name}”?`,
        message: selected.type === 'dir' ? 'The folder and everything inside it will be permanently deleted.' : 'This cannot be undone.',
        confirm: 'Delete',
        danger: true,
      });
      if (!ok) return;
      try {
        await api('/api/fs/delete', { method: 'POST', body: { path: full(selected.name) } });
        load(cwd, false);
      } catch (err) {
        fail(err);
      }
    }

    async function uploadFiles(list) {
      if (!canWrite) return toast('Drones cannot upload files', { type: 'error' });
      for (const file of list) {
        try {
          await api(`/api/fs/upload?dir=${encodeURIComponent(cwd)}&name=${encodeURIComponent(file.name)}`, {
            method: 'POST',
            raw: file,
            headers: { 'Content-Type': 'application/octet-stream' },
          });
          toast(`Uploaded ${file.name}`, { type: 'ok', timeout: 2500 });
        } catch (err) {
          fail(err);
        }
      }
      load(cwd, false);
    }

    fileInput.addEventListener('change', () => {
      uploadFiles([...fileInput.files]);
      fileInput.value = '';
    });
    const scroller = grid.parentElement;
    scroller.addEventListener('dragover', (e) => {
      e.preventDefault();
      scroller.classList.add('drop-hint');
    });
    scroller.addEventListener('dragleave', () => scroller.classList.remove('drop-hint'));
    scroller.addEventListener('drop', (e) => {
      e.preventDefault();
      scroller.classList.remove('drop-hint');
      if (e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files]);
    });

    load(cwd, false);
    return win;
  },
};
