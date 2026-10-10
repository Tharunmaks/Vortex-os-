'use strict';
const path = require('path');
const pty = require('node-pty');
const config = require('./config');
const audit = require('./audit');
const { homeOf } = require('./files');

const RC_FILE = path.join(__dirname, 'shell', 'hive-rc.sh');
const GUARD_OSC = /\x1b\]7771;hive-guard;([^\x07]{0,200})\x07/g;
const MAX_INPUT_FRAME = 64 * 1024;

/** All live terminals, keyed by id. */
const terminals = new Map();
let nextId = 1;

function forUser(username) {
  return [...terminals.values()].filter((t) => t.username === username);
}

function list() {
  return [...terminals.values()].map((t) => ({
    id: t.id,
    user: t.username,
    pid: t.proc.pid,
    started: new Date(t.started).toISOString(),
    lastActive: new Date(t.lastActive).toISOString(),
  }));
}

function shellEnv(user) {
  // A clean environment — never leak the server's own secrets to the shell.
  const env = {
    HOME: homeOf(user.username),
    USER: user.username,
    LOGNAME: user.username,
    SHELL: config.terminal.shell,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: process.env.LANG || 'C.UTF-8',
    PATH: config.terminal.path,
    HIVE_ROLE: user.role,
    HIVE_NAME: config.hiveName,
    VORTEX_OS: config.version,
  };
  if (process.env.TZ) env.TZ = process.env.TZ;
  return env;
}

/**
 * Attach a WebSocket to a fresh PTY running bash in the bee's home.
 * Protocol (JSON text frames):
 *   client → server  {t:'i', d:'keystrokes'} | {t:'r', c:cols, r:rows}
 *   server → client  {t:'o', d:'output'} | {t:'x', code} | {t:'e', m:'error'}
 */
function attach(ws, auth) {
  const { user } = auth;
  const send = (msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  if (forUser(user.username).length >= config.terminal.maxPerBee) {
    send({ t: 'e', m: `Terminal limit reached (${config.terminal.maxPerBee} per bee). Close one first.` });
    ws.close(4008, 'limit');
    return;
  }

  const args = config.terminal.guard ? ['--rcfile', RC_FILE, '-i'] : ['-i'];
  let proc;
  try {
    proc = pty.spawn(config.terminal.shell, args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: homeOf(user.username),
      env: shellEnv(user),
    });
  } catch (err) {
    send({ t: 'e', m: 'Could not start shell: ' + err.message });
    ws.close(1011, 'spawn failed');
    return;
  }

  const term = { id: nextId++, username: user.username, proc, started: Date.now(), lastActive: Date.now(), ws };
  terminals.set(term.id, term);
  audit.log('terminal.open', { user: user.username, terminal: term.id, pid: proc.pid });

  let guardHits = 0;
  let lineBuf = '';
  let lastLine = '';

  proc.onData((data) => {
    if (data.includes('\x1b]7771;')) {
      data = data.replace(GUARD_OSC, (_, reason) => {
        if (++guardHits <= 50) {
          audit.log('guard.blocked', { user: user.username, terminal: term.id, reason, command: lastLine.slice(0, 300) }, 'alert');
        }
        return '';
      });
    }
    send({ t: 'o', d: data });
  });

  proc.onExit(({ exitCode }) => {
    terminals.delete(term.id);
    audit.log('terminal.exit', { user: user.username, terminal: term.id, code: exitCode });
    send({ t: 'x', code: exitCode });
    ws.close(1000, 'exited');
  });

  // Rough reconstruction of typed lines for the audit trail.
  const trackInput = (d) => {
    for (const ch of d) {
      if (ch === '\r' || ch === '\n') {
        const line = lineBuf.trim();
        if (line) lastLine = line;
        if (line) audit.log('terminal.cmd', { user: user.username, terminal: term.id, line: line.slice(0, 500) });
        lineBuf = '';
      } else if (ch === '\x7f' || ch === '\b') {
        lineBuf = lineBuf.slice(0, -1);
      } else if (ch === '\x03' || ch === '\x15') {
        lineBuf = '';
      } else if (ch >= ' ' && lineBuf.length < 2000) {
        lineBuf += ch;
      }
    }
  };

  ws.on('message', (raw, isBinary) => {
    if (isBinary || raw.length > MAX_INPUT_FRAME) return;
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    term.lastActive = Date.now();
    if (msg.t === 'i' && typeof msg.d === 'string') {
      // Strip escape sequences before tracking so arrow keys don't pollute the log line.
      trackInput(msg.d.replace(/\x1b\[[0-9;]*[A-Za-z~]|\x1b./g, ''));
      proc.write(msg.d);
    } else if (msg.t === 'r') {
      const cols = Math.max(10, Math.min(500, msg.c | 0));
      const rows = Math.max(4, Math.min(200, msg.r | 0));
      try {
        proc.resize(cols, rows);
      } catch {
        /* process already gone */
      }
    }
  });

  ws.on('close', () => {
    if (terminals.has(term.id)) {
      terminals.delete(term.id);
      try {
        proc.kill('SIGHUP');
      } catch {
        /* already gone */
      }
      audit.log('terminal.close', { user: user.username, terminal: term.id });
    }
  });
}

function killUser(username, reason = 'revoked') {
  for (const t of forUser(username)) {
    try {
      t.ws.close(4001, reason);
      t.proc.kill('SIGHUP');
    } catch {
      /* ignore */
    }
  }
}

function sweep() {
  const now = Date.now();
  for (const t of terminals.values()) {
    if (now - t.lastActive > config.terminal.idleMs) {
      audit.log('terminal.idle-timeout', { user: t.username, terminal: t.id });
      try {
        t.ws.close(4002, 'idle');
        t.proc.kill('SIGHUP');
      } catch {
        /* ignore */
      }
    }
  }
}

function ptyPids(username) {
  return forUser(username).map((t) => t.proc.pid);
}

module.exports = { attach, list, killUser, sweep, ptyPids, RC_FILE };
