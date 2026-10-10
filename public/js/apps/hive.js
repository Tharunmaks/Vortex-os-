// Hive Control — bees, sessions, terminals and the security audit trail.
import { api, h, toast, fail, modal, fmt } from '../api.js';
import { openWindow } from '../wm.js';

const levelTag = (l) => h(`span.tag.${l}`, l);
const roleTag = (u) => h(`span.tag.${u.role}`, u.roleLabel || u.role);

function describe(e) {
  const skip = new Set(['ts', 'level', 'event', 'user']);
  return Object.entries(e)
    .filter(([k, v]) => !skip.has(k) && v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('  ');
}

export default {
  id: 'hive',
  name: 'Hive Control',
  description: 'Manage bees and watch the hive’s security',
  open(os) {
    const admin = os.perms.admin;
    let tab = admin ? 'bees' : 'me';
    let auditLevel = '';
    let timer;

    const tabs = h('div.tabs');
    const content = h('div.scroll');
    const body = h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } }, tabs, content);
    const win = openWindow({ app: 'hive', title: 'Hive Control', width: 900, height: 580, body, onClose: () => clearInterval(timer) });

    const TABS = admin
      ? [['bees', '🐝 Bees'], ['sessions', '🔑 Sessions'], ['terminals', '💻 Terminals'], ['audit', '📜 Audit log'], ['guard', '🛡️ Guard']]
      : [['me', '🐝 My bee'], ['guard', '🛡️ Guard']];

    function renderTabs() {
      tabs.replaceChildren(...TABS.map(([id, label]) => h('button', { class: tab === id ? 'active' : '', onclick: () => ((tab = id), renderTabs(), refresh()) }, label)));
    }

    async function refresh() {
      try {
        if (tab === 'bees') await renderBees();
        else if (tab === 'sessions') await renderSessions();
        else if (tab === 'terminals') await renderTerminals();
        else if (tab === 'audit') await renderAudit();
        else if (tab === 'guard') renderGuard();
        else renderMe();
      } catch (err) {
        fail(err);
      }
    }

    async function renderBees() {
      const bees = await api('/api/hive/bees');
      const add = h('button.btn.primary.small', { onclick: addBee }, '+ Add bee');
      content.replaceChildren(
        h('div.toolbar', h('strong', `${bees.length} bees in ${os.hive}`), h('span.grow'), add),
        h('table.data',
          h('thead', h('tr', h('th', 'Bee'), h('th', 'Role'), h('th', 'Status'), h('th', 'Last login'), h('th', 'Actions'))),
          h('tbody', ...bees.map((b) => {
            const self = b.username === os.user.username;
            return h('tr',
              h('td', h('strong', b.username), self ? h('span.muted', ' (you)') : ''),
              h('td', roleTag(b)),
              h('td', b.disabled ? h('span.tag.alert', 'disabled') : b.sessions ? h('span.tag.ok', `online (${b.sessions})`) : h('span.tag.info', 'offline'),
                b.mustChangePassword ? h('span.tag.warn', { style: { marginLeft: '4px' } }, 'temp password') : ''),
              h('td.muted', fmt.ago(b.lastLogin)),
              h('td', h('div.inline-form',
                h('select', { 'aria-label': `Role for ${b.username}`, disabled: self, onchange: (e) => update(b, { role: e.target.value }) },
                  ['queen', 'worker', 'drone'].map((r) => h('option', { value: r, selected: r === b.role }, r))),
                h('button.btn.small', { disabled: self, onclick: () => update(b, { disabled: !b.disabled }) }, b.disabled ? 'Enable' : 'Disable'),
                h('button.btn.small', { onclick: () => resetPw(b) }, 'Reset pw'),
                h('button.btn.small', { disabled: !b.sessions, onclick: () => kick(b) }, 'Kick'),
                h('button.btn.small.danger', { disabled: self, onclick: () => removeBee(b) }, 'Remove'),
              )),
            );
          })),
        ),
        h('p.pad.muted', { style: { fontSize: '12px', margin: 0 } },
          'Queens administer the hive · Worker bees get a full shell · Drones can browse and read files only (no terminal, no writes).'),
      );
    }

    async function addBee() {
      const r = await modal({
        title: 'Welcome a new bee',
        message: 'A one-time password will be generated. The bee must change it on first login.',
        fields: [
          { name: 'username', label: 'Bee name (a-z, 0-9, _ -)', placeholder: 'e.g. buzz' },
          { name: 'role', label: 'Role', type: 'select', value: 'worker', options: [['worker', 'Worker Bee — full shell'], ['drone', 'Drone — read-only, no shell'], ['queen', 'Queen — administrator']] },
        ],
        confirm: 'Create bee',
      });
      if (!r?.username) return;
      try {
        const res = await api('/api/hive/bees', { method: 'POST', body: { username: r.username.trim().toLowerCase(), role: r.role } });
        toast(`🐝 ${res.user.username} joined the hive. One-time password (shown once):`, { type: 'ok', detail: res.password, timeout: 0 });
        refresh();
      } catch (err) {
        fail(err);
      }
    }

    async function update(b, changes) {
      try {
        await api(`/api/hive/bees/${b.username}`, { method: 'PATCH', body: changes });
        toast(`Updated ${b.username}`, { type: 'ok', timeout: 2000 });
      } catch (err) {
        fail(err);
      }
      refresh();
    }

    async function resetPw(b) {
      const ok = await modal({ title: `Reset ${b.username}'s password?`, message: 'Their sessions and terminals will be closed and a new one-time password generated.', confirm: 'Reset', danger: true });
      if (!ok) return;
      try {
        const res = await api(`/api/hive/bees/${b.username}/password`, { method: 'POST', body: {} });
        toast(`New one-time password for ${b.username} (shown once):`, { type: 'ok', detail: res.password, timeout: 0 });
        if (b.username === os.user.username) location.reload();
        refresh();
      } catch (err) {
        fail(err);
      }
    }

    async function kick(b) {
      try {
        const res = await api(`/api/hive/bees/${b.username}/kick`, { method: 'POST', body: {} });
        toast(`Kicked ${b.username} (${res.sessions} session${res.sessions === 1 ? '' : 's'})`, { type: 'ok' });
        if (b.username === os.user.username) location.reload();
        refresh();
      } catch (err) {
        fail(err);
      }
    }

    async function removeBee(b) {
      const ok = await modal({ title: `Remove ${b.username} from the hive?`, message: 'Their account is deleted and they are signed out. Their home folder is kept on disk.', confirm: 'Remove', danger: true });
      if (!ok) return;
      try {
        await api(`/api/hive/bees/${b.username}`, { method: 'DELETE', body: {} });
        refresh();
      } catch (err) {
        fail(err);
      }
    }

    async function renderSessions() {
      const sessions = await api('/api/hive/sessions');
      content.replaceChildren(h('table.data',
        h('thead', h('tr', h('th', 'Bee'), h('th', 'IP'), h('th', 'Signed in'), h('th', 'Last seen'), h('th', 'Client'))),
        h('tbody', ...sessions.map((s) => h('tr', h('td', h('strong', s.username)), h('td.mono', s.ip), h('td', fmt.ago(new Date(s.created).toISOString())),
          h('td', fmt.ago(new Date(s.lastSeen).toISOString())), h('td.wrap.muted', { style: { fontSize: '11px' } }, s.userAgent)))),
      ));
    }

    async function renderTerminals() {
      const terms = await api('/api/hive/terminals');
      content.replaceChildren(terms.length
        ? h('table.data',
          h('thead', h('tr', h('th', '#'), h('th', 'Bee'), h('th.num', 'Shell PID'), h('th', 'Started'), h('th', 'Last active'))),
          h('tbody', ...terms.map((t) => h('tr', h('td', t.id), h('td', h('strong', t.user)), h('td.num', t.pid), h('td', fmt.ago(t.started)), h('td', fmt.ago(t.lastActive))))))
        : h('div.empty', 'No terminals are open right now.'));
    }

    async function renderAudit() {
      const rows = await api(`/api/hive/audit?limit=300${auditLevel ? `&level=${auditLevel}` : ''}`);
      const sel = h('select', { onchange: (e) => ((auditLevel = e.target.value), refresh()) },
        [['', 'All events'], ['alert', 'Alerts only'], ['warn', 'Warnings only'], ['info', 'Info only']].map(([v, l]) => h('option', { value: v, selected: v === auditLevel }, l)));
      content.replaceChildren(
        h('div.toolbar', sel, h('span.muted', { style: { fontSize: '12px' } }, `${rows.length} recent events · full log in data/audit.log`)),
        h('table.data',
          h('thead', h('tr', h('th', 'Time'), h('th', 'Level'), h('th', 'Event'), h('th', 'Bee'), h('th', 'Details'))),
          h('tbody', ...rows.map((e) => h('tr', h('td.muted', new Date(e.ts).toLocaleTimeString()), h('td', levelTag(e.level)), h('td.mono', e.event), h('td', e.user || ''),
            h('td.wrap.mono', { style: { fontSize: '11px' } }, describe(e))))),
        ),
      );
    }

    function renderGuard() {
      const items = [
        ['🔐', 'Accounts', 'scrypt-hashed passwords, strength rules, one-time passwords for new bees, lockout after repeated failures.'],
        ['🍪', 'Sessions', 'HttpOnly + SameSite=Strict cookies, idle and absolute timeouts, Origin checks on every change and WebSocket.'],
        ['👑', 'Roles', 'Queen (admin) · Worker (shell + files) · Drone (read-only, no shell). Enforced on the server.'],
        ['🛡️', 'Hive Guard', 'Every terminal command line is checked before it runs. Wiping disks, fork bombs, reverse shells, curl|sh, miners and attempts to disable the guard are refused and reported.'],
        ['📁', 'File cells', 'Each bee is confined to their own home: path traversal and symlink escapes are rejected, with upload limits and quotas.'],
        ['🌐', 'Browser', 'Pages are fetched by the hive proxy. Scripts never run, forms are GET-only, and private, loopback and cloud-metadata networks are unreachable — even via redirects or DNS tricks.'],
        ['📜', 'Audit trail', 'Logins, commands, blocked actions, file changes and admin actions are recorded for the queen.'],
        ['📦', 'Container', 'In production Vortex runs as an unprivileged user in a read-only container with no Linux capabilities and pid/memory limits.'],
      ];
      content.replaceChildren(h('div.pad', h('div.grid-2', ...items.map(([i, t, d]) => h('div.card', h('h3', `${i} ${t}`), h('div', d))))));
    }

    function renderMe() {
      content.replaceChildren(h('div.pad.grid-2',
        h('div.card', h('h3', 'Bee'), h('div.big', os.user.username), roleTag(os.user)),
        h('div.card', h('h3', 'Permissions'),
          h('div', os.perms.terminal ? '✅ Terminal access' : '🚫 No terminal'),
          h('div', os.perms.write ? '✅ Can write files' : '🚫 Read-only files'),
          h('div', os.perms.admin ? '✅ Hive administration' : '🚫 No hive administration')),
        h('div.card', h('h3', 'Last login'), h('div', fmt.ago(os.user.lastLogin))),
      ));
    }

    renderTabs();
    refresh();
    timer = setInterval(() => {
      if (['sessions', 'terminals', 'audit'].includes(tab) && !win.el.classList.contains('minimized')) refresh();
    }, 5000);
    return win;
  },
};
