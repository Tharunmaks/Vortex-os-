// Terminal — a real bash shell over a WebSocket-backed PTY.
import { h, toast } from '../api.js';
import { openWindow } from '../wm.js';

const THEME = {
  background: '#0b0a08',
  foreground: '#f4efe4',
  cursor: '#f5b301',
  cursorAccent: '#0b0a08',
  selectionBackground: 'rgba(245,179,1,0.35)',
  black: '#1c1a16', red: '#ef4444', green: '#22c55e', yellow: '#f5b301',
  blue: '#60a5fa', magenta: '#f472b6', cyan: '#22d3ee', white: '#e7e0d0',
  brightBlack: '#6b6352', brightRed: '#f87171', brightGreen: '#4ade80', brightYellow: '#ffd23f',
  brightBlue: '#93c5fd', brightMagenta: '#f9a8d4', brightCyan: '#67e8f9', brightWhite: '#ffffff',
};

export default {
  id: 'terminal',
  name: 'Terminal',
  description: 'Real bash shell with Hive Guard',
  needs: 'terminal',
  open(os) {
    const wrap = h('div.term-wrap');
    const term = new window.Terminal({
      fontFamily: getComputedStyle(document.body).getPropertyValue('--mono'),
      fontSize: 13.5,
      cursorBlink: true,
      allowProposedApi: false,
      scrollback: 5000,
      theme: THEME,
    });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);

    let ws;
    let closedByUser = false;
    const win = openWindow({
      app: 'terminal',
      title: `${os.user.username}@vortex — Terminal`,
      width: 820,
      height: 500,
      body: wrap,
      onResize: () => {
        try {
          fit.fit();
        } catch {
          /* not visible yet */
        }
      },
      onFocus: () => term.focus(),
      onClose: () => {
        closedByUser = true;
        ws?.close();
        term.dispose();
      },
    });

    term.open(wrap);
    requestAnimationFrame(() => {
      fit.fit();
      term.focus();
    });

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws/terminal`);
    const send = (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

    ws.addEventListener('open', () => {
      send({ t: 'r', c: term.cols, r: term.rows });
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.t === 'o') term.write(msg.d);
      else if (msg.t === 'e') term.write(`\r\n\x1b[31m${msg.m}\x1b[0m\r\n`);
      else if (msg.t === 'x') term.write(`\r\n\x1b[2m[process exited with code ${msg.code}]\x1b[0m\r\n`);
    });
    ws.addEventListener('close', (ev) => {
      if (closedByUser) return;
      const why = { 4001: 'Your session was revoked by the queen.', 4002: 'Closed after being idle.', 4008: 'Terminal limit reached.' }[ev.code];
      term.write(`\r\n\x1b[33m🐝 Connection closed.${why ? ' ' + why : ''}\x1b[0m\r\n`);
      if (ev.code === 1006) toast('Terminal connection lost', { type: 'error' });
    });

    term.onData((d) => send({ t: 'i', d }));
    term.onResize(({ cols, rows }) => send({ t: 'r', c: cols, r: rows }));
    term.onTitleChange((t) => t && win.setTitle(t));
    return win;
  },
};
