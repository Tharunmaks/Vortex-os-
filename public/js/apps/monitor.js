// System Monitor — live CPU, memory, disk and process view straight from /proc.
import { api, h, fail, modal, fmt } from '../api.js';
import { openWindow } from '../wm.js';

function sparkline(values, color) {
  const w = 240;
  const hgt = 48;
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * w},${hgt - (v / 100) * hgt}`).join(' ');
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.cssText = 'width:100%;height:48px;margin-top:8px;display:block';
  const area = document.createElementNS(ns, 'polygon');
  area.setAttribute('points', `0,${hgt} ${pts} ${w},${hgt}`);
  area.setAttribute('fill', color);
  area.setAttribute('fill-opacity', '0.18');
  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('points', pts);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', color);
  line.setAttribute('stroke-width', '2');
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(area, line);
  return svg;
}

const meter = (pct) => h('div.meter', h('i', { class: pct > 85 ? 'hot' : '', style: { width: `${Math.min(100, pct)}%` } }));

export default {
  id: 'monitor',
  name: 'Monitor',
  description: 'CPU, memory, disks and processes',
  open(os) {
    const cpuHist = Array(40).fill(0);
    const memHist = Array(40).fill(0);
    let tab = 'overview';
    let filter = '';
    let onlyMine = !os.perms.admin;
    let timer;

    const tabs = h('div.tabs');
    const content = h('div.scroll');
    const body = h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } }, tabs, content);
    const win = openWindow({ app: 'monitor', title: 'System Monitor', width: 820, height: 560, body, onClose: () => clearInterval(timer) });

    function renderTabs() {
      tabs.replaceChildren(
        ...[['overview', 'Overview'], ['procs', 'Processes']].map(([id, label]) =>
          h('button', { class: tab === id ? 'active' : '', onclick: () => ((tab = id), renderTabs(), refresh()) }, label)),
      );
    }

    async function refresh() {
      try {
        if (tab === 'overview') renderOverview(await api('/api/system/stats'));
        else renderProcs(await api('/api/system/processes'));
      } catch (err) {
        clearInterval(timer);
        fail(err);
      }
    }

    function renderOverview(s) {
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#f5b301';
      cpuHist.push(s.cpu);
      cpuHist.shift();
      const memPct = (s.memory.used / s.memory.total) * 100;
      memHist.push(memPct);
      memHist.shift();
      content.replaceChildren(
        h('div.pad.grid-2',
          h('div.card', h('h3', 'CPU'), h('div.big', `${s.cpu.toFixed(1)}%`), h('div.muted', `${s.cpus} cores · load ${s.load.join(' / ')}`), sparkline(cpuHist, accent)),
          h('div.card', h('h3', 'Memory'), h('div.big', `${memPct.toFixed(0)}%`), h('div.muted', `${fmt.bytes(s.memory.used)} of ${fmt.bytes(s.memory.total)}`), sparkline(memHist, '#38bdf8')),
          ...s.disks.map((d) => h('div.card', h('h3', `Disk — ${d.label}`), h('div.big', fmt.bytes(d.free)), h('div.muted', `free of ${fmt.bytes(d.total)}`), meter((d.used / d.total) * 100))),
          h('div.card', h('h3', 'Hive'),
            h('div', `🐝 ${s.bees.online} bee${s.bees.online === 1 ? '' : 's'} online of ${s.bees.total}`),
            h('div', `💻 ${s.terminals} open terminal${s.terminals === 1 ? '' : 's'}`),
            h('div.muted', `Vortex OS ${s.vortex.version} · up ${fmt.duration(s.vortex.uptime)}`)),
          h('div.card', { style: { gridColumn: '1 / -1' } }, h('h3', 'System'),
            h('table.data', h('tbody',
              ...[
                ['Host', s.hostname], ['OS', s.os], ['Kernel', `${s.kernel} (${s.arch})`], ['CPU', s.cpuModel],
                ['Uptime', fmt.duration(s.uptime)], ['Runtime', `Node ${s.vortex.node} · pid ${s.vortex.pid}`],
              ].map(([k, v]) => h('tr', h('td.muted', k), h('td.wrap', v))),
            ))),
        ),
      );
    }

    function renderProcs(list) {
      const scrollTop = content.scrollTop;
      const shown = list.filter((p) => (!onlyMine || p.mine) && (!filter || `${p.name} ${p.cmd} ${p.pid}`.toLowerCase().includes(filter)));
      const search = h('input', { type: 'search', placeholder: 'Filter processes…', value: filter, oninput: (e) => ((filter = e.target.value.toLowerCase()), refresh()) });
      const mineBox = h('label.muted', { style: { display: 'flex', gap: '4px', alignItems: 'center', fontSize: '12px' } },
        h('input', { type: 'checkbox', checked: onlyMine, onchange: (e) => ((onlyMine = e.target.checked), refresh()) }), 'Only my processes');
      content.replaceChildren(
        h('div.toolbar', search, mineBox, h('span.muted', { style: { fontSize: '12px' } }, `${shown.length} of ${list.length}`)),
        h('table.data',
          h('thead', h('tr', h('th.num', 'PID'), h('th', 'Name'), h('th.num', 'CPU %'), h('th.num', 'Memory'), h('th', 'State'), h('th', 'Command'), h('th', ''))),
          h('tbody', ...shown.slice(0, 300).map((p) => h('tr',
            h('td.num', p.pid), h('td', p.mine ? '🐝 ' : '', p.name), h('td.num', p.cpu.toFixed(1)), h('td.num', fmt.bytes(p.rss)),
            h('td', p.state), h('td.wrap.mono', { style: { fontSize: '11px', maxWidth: '320px' } }, p.cmd),
            h('td', p.killable ? h('button.btn.small.danger', { onclick: () => kill(p) }, 'End') : ''),
          ))),
        ),
      );
      const input = content.querySelector('input[type=search]');
      if (filter && input) {
        input.focus();
        input.setSelectionRange(filter.length, filter.length);
      }
      content.scrollTop = scrollTop;
    }

    async function kill(p) {
      const r = await modal({
        title: `End process ${p.pid}?`,
        message: p.cmd,
        fields: [{ name: 'signal', label: 'Signal', type: 'select', value: 'SIGTERM', options: [['SIGTERM', 'SIGTERM (ask nicely)'], ['SIGKILL', 'SIGKILL (force)']] }],
        confirm: 'End process',
        danger: true,
      });
      if (!r) return;
      try {
        await api('/api/system/kill', { method: 'POST', body: { pid: p.pid, signal: r.signal } });
        setTimeout(refresh, 300);
      } catch (err) {
        fail(err);
      }
    }

    renderTabs();
    refresh();
    timer = setInterval(() => {
      if (win.el.isConnected && !win.el.classList.contains('minimized') && !(tab === 'procs' && document.activeElement?.closest?.('.win') === win.el && document.activeElement.tagName === 'INPUT')) refresh();
    }, 2000);
    return win;
  },
};
