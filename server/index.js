'use strict';
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const config = require('./config');
const audit = require('./audit');
const files = require('./files');
const system = require('./system');
const browser = require('./browser');
const webSearch = require('./search');
const terminal = require('./terminal');
const { Auth, ROLES, generatePassword } = require('./auth');
const { securityHeaders, sendJson, readJson, parseCookies, clientIp, originAllowed, HttpError } = require('./http-util');

const COOKIE = 'vortex_sid';
const PUBLIC_DIR = path.join(config.root, 'public');
const VENDOR = {
  '/vendor/xterm.js': require.resolve('@xterm/xterm/lib/xterm.js'),
  '/vendor/xterm.css': require.resolve('@xterm/xterm/css/xterm.css'),
  '/vendor/addon-fit.js': require.resolve('@xterm/addon-fit/lib/addon-fit.js'),
};
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const SETTINGS_DEFAULTS = { theme: 'dark', accent: '#f5b301', wallpaper: 'honeycomb', clock24: true };
const ACCENTS = ['#f5b301', '#ff7a18', '#22c55e', '#38bdf8', '#a78bfa', '#f472b6', '#ef4444'];
const WALLPAPERS = ['honeycomb', 'vortex', 'meadow', 'midnight', 'amber'];

function createServer(auth = new Auth()) {
  const browserBucket = new browser.Bucket(90);
  const assetBucket = new browser.Bucket(900);

  function cookie(token, maxAgeSec) {
    const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
    if (config.secureCookies) parts.push('Secure');
    return parts.join('; ');
  }

  function authenticate(req) {
    return auth.resolve(parseCookies(req.headers.cookie)[COOKIE]);
  }

  function need(ctx, perm) {
    if (!ctx) throw new HttpError(401, 'Please sign in');
    if (ctx.user.mustChangePassword && perm !== 'session') throw new HttpError(403, 'Change your password first');
    if (perm && perm !== 'session' && !ctx.perms[perm]) throw new HttpError(403, `Your role (${ctx.user.roleLabel}) cannot do that`);
    return ctx;
  }

  async function settingsFor(username) {
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(config.dataDir, 'settings', `${username}.json`), 'utf8'));
      return { ...SETTINGS_DEFAULTS, ...raw };
    } catch {
      return { ...SETTINGS_DEFAULTS };
    }
  }

  // ── Route table ────────────────────────────────────────────────────────────
  const routes = {
    'GET /api/hive': async () => ({ name: config.hiveName, version: config.version }),

    'POST /api/auth/login': async (req) => {
      const body = await readJson(req, 4096);
      const { token, user } = await auth.login(body.username, body.password, clientIp(req), req.headers['user-agent']);
      await files.ensureHome(user.username);
      return { status: 200, headers: { 'Set-Cookie': cookie(token, Math.floor(config.sessionMaxMs / 1000)) }, body: { user } };
    },

    'POST /api/auth/logout': async (req, ctx) => {
      if (ctx) {
        auth.sessions.destroy(ctx.token);
        audit.log('auth.logout', { user: ctx.user.username });
      }
      return { status: 200, headers: { 'Set-Cookie': cookie('', 0) }, body: { ok: true } };
    },

    'GET /api/auth/me': async (req, ctx) => {
      need(ctx, 'session');
      return { user: ctx.user, perms: ctx.perms, settings: await settingsFor(ctx.user.username), hive: config.hiveName, version: config.version };
    },

    'POST /api/auth/password': async (req, ctx) => {
      need(ctx, 'session');
      const { current, next } = await readJson(req, 4096);
      const { verifyPassword } = require('./auth');
      const record = auth.store.get(ctx.user.username);
      if (!(await verifyPassword(String(current || ''), record))) throw new HttpError(400, 'Current password is wrong');
      if (current === next) throw new HttpError(400, 'Pick a new password');
      try {
        await auth.store.setPassword(ctx.user.username, next);
      } catch (err) {
        throw new HttpError(400, err.message);
      }
      auth.sessions.destroyUser(ctx.user.username, ctx.token);
      audit.log('auth.password-changed', { user: ctx.user.username });
      return { ok: true };
    },

    // ── Settings ──
    'GET /api/settings': async (req, ctx) => settingsFor(need(ctx).user.username),
    'PUT /api/settings': async (req, ctx) => {
      need(ctx);
      const body = await readJson(req, 4096);
      const cur = await settingsFor(ctx.user.username);
      if (body.theme === 'dark' || body.theme === 'light') cur.theme = body.theme;
      if (ACCENTS.includes(body.accent)) cur.accent = body.accent;
      if (WALLPAPERS.includes(body.wallpaper)) cur.wallpaper = body.wallpaper;
      if (typeof body.clock24 === 'boolean') cur.clock24 = body.clock24;
      const dir = path.join(config.dataDir, 'settings');
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      await fsp.writeFile(path.join(dir, `${ctx.user.username}.json`), JSON.stringify(cur), { mode: 0o600 });
      return cur;
    },

    // ── Files ──
    'GET /api/fs/list': async (req, ctx, url) => files.list(home(need(ctx)), url.searchParams.get('path') || '/'),
    'GET /api/fs/read': async (req, ctx, url) => files.readText(home(need(ctx)), url.searchParams.get('path')),
    'GET /api/fs/usage': async (req, ctx) => ({ used: await files.usage(home(need(ctx))), quota: config.files.quotaBytes }),
    'PUT /api/fs/write': async (req, ctx) => {
      need(ctx, 'write');
      const body = await readJson(req, config.files.maxEditBytes * 2);
      const r = await files.writeText(home(ctx), body.path, body.content);
      audit.log('fs.write', { user: ctx.user.username, path: r.path });
      return r;
    },
    'POST /api/fs/mkdir': async (req, ctx) => {
      need(ctx, 'write');
      const body = await readJson(req);
      return files.mkdir(home(ctx), body.path, body.name);
    },
    'POST /api/fs/rename': async (req, ctx) => {
      need(ctx, 'write');
      const body = await readJson(req);
      const r = await files.rename(home(ctx), body.path, body.name);
      audit.log('fs.rename', { user: ctx.user.username, from: body.path, to: r.path });
      return r;
    },
    'POST /api/fs/delete': async (req, ctx) => {
      need(ctx, 'write');
      const body = await readJson(req);
      await files.remove(home(ctx), body.path);
      audit.log('fs.delete', { user: ctx.user.username, path: body.path }, 'warn');
      return { ok: true };
    },
    'POST /api/fs/upload': async (req, ctx, url) => {
      need(ctx, 'write');
      const r = await files.upload(home(ctx), url.searchParams.get('dir') || '/', url.searchParams.get('name'), req);
      audit.log('fs.upload', { user: ctx.user.username, path: r.path });
      return r;
    },
    'GET /api/fs/download': async (req, ctx, url, res) => {
      need(ctx);
      const { file, size, name } = await files.openDownload(home(ctx), url.searchParams.get('path'));
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(file).pipe(res);
      return null;
    },

    // ── System ──
    'GET /api/system/stats': async (req, ctx) => {
      need(ctx);
      return { ...(await system.stats()), bees: { online: new Set(auth.sessions.list().map((s) => s.username)).size, total: auth.store.count() }, terminals: terminal.list().length };
    },
    'GET /api/system/processes': async (req, ctx) => {
      need(ctx);
      const procs = await system.processes();
      const mine = terminal.ptyPids(ctx.user.username);
      return procs.map((p) => ({
        ...p,
        mine: system.descendsFrom(p.pid, mine, procs),
        killable: p.pid !== process.pid && (ctx.perms.admin || system.descendsFrom(p.pid, mine, procs)),
      }));
    },
    'POST /api/system/kill': async (req, ctx) => {
      need(ctx, 'terminal');
      const { pid, signal } = await readJson(req);
      const n = Number(pid);
      if (!Number.isInteger(n) || n <= 1 || n === process.pid) throw new HttpError(400, 'Invalid process');
      const sig = signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM';
      const procs = await system.processes();
      if (!ctx.perms.admin && !system.descendsFrom(n, terminal.ptyPids(ctx.user.username), procs)) {
        throw new HttpError(403, 'You can only stop processes started from your own terminals');
      }
      try {
        process.kill(n, sig);
      } catch (err) {
        throw new HttpError(400, err.code === 'ESRCH' ? 'Process already exited' : 'Not permitted');
      }
      audit.log('system.kill', { user: ctx.user.username, pid: n, signal: sig }, 'warn');
      return { ok: true };
    },

    // ── Browser ──
    'GET /api/browser/page': async (req, ctx, url) => {
      need(ctx);
      if (!config.browser.enabled) throw new HttpError(403, 'The hive browser is disabled');
      if (!browserBucket.take(ctx.user.username)) throw new HttpError(429, 'Slow down, busy bee');
      const target = url.searchParams.get('url');
      try {
        const page = await browser.page(target);
        audit.log('browser.visit', { user: ctx.user.username, url: page.url.slice(0, 500) });
        return page;
      } catch (err) {
        if (err.status === 403) audit.log('browser.blocked', { user: ctx.user.username, url: String(target).slice(0, 500), reason: err.message }, 'warn');
        throw err;
      }
    },
    'GET /api/search': async (req, ctx, url) => {
      need(ctx);
      if (!config.browser.enabled) throw new HttpError(403, 'The hive browser is disabled');
      if (!browserBucket.take(ctx.user.username)) throw new HttpError(429, 'Slow down, busy bee');
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) throw new HttpError(400, 'Type something to search for');
      const result = await webSearch.search(q);
      audit.log('browser.search', { user: ctx.user.username, q: q.slice(0, 200), results: result.results.length });
      return result;
    },
    'GET /api/browser/asset': async (req, ctx, url, res) => {
      need(ctx);
      if (!config.browser.enabled) throw new HttpError(403, 'The hive browser is disabled');
      if (!assetBucket.take(ctx.user.username)) throw new HttpError(429, 'Too many requests');
      const a = await browser.asset(url.searchParams.get('url'));
      res.writeHead(a.status >= 400 ? a.status : 200, {
        'Content-Type': a.type,
        'Content-Length': a.body.length,
        'Cache-Control': 'private, max-age=600',
        // Even if opened directly, proxied content can never run script on our origin.
        'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'self'; sandbox",
        'Cross-Origin-Resource-Policy': 'same-origin',
      });
      res.end(a.body);
      return null;
    },

    // ── Hive control (queen only) ──
    'GET /api/hive/bees': async (req, ctx) => {
      need(ctx, 'admin');
      const online = new Map();
      for (const s of auth.sessions.list()) online.set(s.username, (online.get(s.username) || 0) + 1);
      return auth.store.list().map((u) => ({ ...u, sessions: online.get(u.username) || 0 }));
    },
    'POST /api/hive/bees': async (req, ctx) => {
      need(ctx, 'admin');
      const body = await readJson(req);
      const password = body.password || generatePassword();
      let user;
      try {
        user = await auth.store.create({ username: body.username, password, role: body.role || 'worker', mustChangePassword: true });
      } catch (err) {
        throw new HttpError(400, err.message);
      }
      await files.ensureHome(user.username);
      audit.log('hive.bee-created', { user: ctx.user.username, bee: user.username, role: user.role });
      return { user, password: body.password ? undefined : password };
    },
    'GET /api/hive/sessions': async (req, ctx) => {
      need(ctx, 'admin');
      return auth.sessions.list().map(({ id, username, created, lastSeen, ip, userAgent }) => ({ id, username, created, lastSeen, ip, userAgent }));
    },
    'GET /api/hive/terminals': async (req, ctx) => (need(ctx, 'admin'), terminal.list()),
    'GET /api/hive/audit': async (req, ctx, url) => {
      need(ctx, 'admin');
      const limit = Math.min(1000, Number(url.searchParams.get('limit')) || 200);
      return audit.tail(limit, { user: url.searchParams.get('user') || undefined, level: url.searchParams.get('level') || undefined });
    },
    'GET /api/hive/roles': async (req, ctx) => (need(ctx), ROLES),
  };

  // Parameterised queen routes: /api/hive/bees/:name[/action]
  async function beeRoute(req, ctx, method, name, action) {
    need(ctx, 'admin');
    if (!auth.store.get(name)) throw new HttpError(404, 'No such bee');
    const body = method === 'GET' ? {} : await readJson(req);
    try {
      if (method === 'PATCH' && !action) {
        if (name === ctx.user.username && ((body.role && body.role !== 'queen') || body.disabled)) {
          throw new Error('You cannot demote or disable your own account');
        }
        const user = auth.store.update(name, { role: body.role, disabled: body.disabled });
        if (user.disabled || body.role) {
          auth.sessions.destroyUser(name);
          terminal.killUser(name, 'role-changed');
        }
        audit.log('hive.bee-updated', { user: ctx.user.username, bee: name, role: body.role, disabled: body.disabled }, 'warn');
        return user;
      }
      if (method === 'POST' && action === 'password') {
        const password = generatePassword();
        await auth.store.setPassword(name, password, { mustChangePassword: true });
        auth.sessions.destroyUser(name);
        terminal.killUser(name, 'password-reset');
        audit.log('hive.bee-password-reset', { user: ctx.user.username, bee: name }, 'warn');
        return { password };
      }
      if (method === 'POST' && action === 'kick') {
        const n = auth.sessions.destroyUser(name);
        terminal.killUser(name, 'kicked');
        audit.log('hive.bee-kicked', { user: ctx.user.username, bee: name, sessions: n }, 'warn');
        return { sessions: n };
      }
      if (method === 'DELETE' && !action) {
        if (name === ctx.user.username) throw new Error('You cannot remove your own account');
        auth.store.remove(name);
        auth.sessions.destroyUser(name);
        terminal.killUser(name, 'removed');
        audit.log('hive.bee-removed', { user: ctx.user.username, bee: name }, 'alert');
        return { ok: true };
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, err.message);
    }
    throw new HttpError(404, 'Not found');
  }

  function home(ctx) {
    return files.homeOf(ctx.user.username);
  }

  async function serveStatic(req, res, pathname) {
    let file = VENDOR[pathname];
    if (!file) {
      const rel = pathname === '/' ? '/index.html' : pathname;
      file = path.join(PUBLIC_DIR, path.posix.normalize(rel));
      // Only whitelisted asset types, never anything outside public/.
      if (!files.isInside(PUBLIC_DIR, file) || !MIME[path.extname(file)]) return false;
    }
    try {
      const st = await fsp.stat(file);
      if (!st.isFile()) return false;
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end(), true;
      fs.createReadStream(file).pipe(res);
      return true;
    } catch {
      return false;
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://vortex.local');
    const pathname = url.pathname;
    securityHeaders(res);
    try {
      if (!pathname.startsWith('/api/')) {
        if ((req.method === 'GET' || req.method === 'HEAD') && (await serveStatic(req, res, pathname))) return;
        throw new HttpError(404, 'Not found');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD' && !originAllowed(req)) {
        audit.log('security.bad-origin', { ip: clientIp(req), origin: req.headers.origin || null, path: pathname }, 'warn');
        throw new HttpError(403, 'Cross-site request refused');
      }
      const ctx = authenticate(req);
      let result;
      const handler = routes[`${req.method} ${pathname}`];
      const bee = pathname.match(/^\/api\/hive\/bees\/([a-z][a-z0-9_-]{2,31})(?:\/(password|kick))?$/);
      if (handler) result = await handler(req, ctx, url, res);
      else if (bee) result = await beeRoute(req, ctx, req.method, bee[1], bee[2]);
      else throw new HttpError(404, 'Not found');

      if (result === null) return; // handler streamed its own response
      if (result && result.status && result.body !== undefined) {
        for (const [k, v] of Object.entries(result.headers || {})) res.setHeader(k, v);
        return sendJson(res, result.status, result.body);
      }
      sendJson(res, 200, result ?? { ok: true });
    } catch (err) {
      const status = err.status || (err.code === 'ENOENT' ? 404 : err.code === 'EEXIST' ? 409 : err.code === 'ENOTEMPTY' ? 409 : 500);
      if (status >= 500) console.error('[vortex]', req.method, pathname, err);
      const message = status >= 500 && !err.status ? 'Internal error' : err.code === 'ENOENT' ? 'Not found' : err.code === 'EEXIST' ? 'Already exists' : err.message;
      if (!res.headersSent) sendJson(res, status, { error: message });
      else res.destroy();
    }
  });

  // ── Terminal WebSocket ─────────────────────────────────────────────────────
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const reject = (code, msg) => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    const { pathname } = new URL(req.url, 'http://vortex.local');
    if (pathname !== '/ws/terminal') return reject(404, 'Not Found');
    if (!originAllowed(req)) {
      audit.log('security.bad-origin', { ip: clientIp(req), origin: req.headers.origin || null, path: pathname }, 'warn');
      return reject(403, 'Forbidden');
    }
    const ctx = authenticate(req);
    if (!ctx) return reject(401, 'Unauthorized');
    if (ctx.user.mustChangePassword || !ctx.perms.terminal) {
      audit.log('terminal.denied', { user: ctx.user.username, role: ctx.user.role }, 'warn');
      return reject(403, 'Forbidden');
    }
    wss.handleUpgrade(req, socket, head, (ws) => terminal.attach(ws, ctx));
  });

  const sweeper = setInterval(() => {
    auth.sweep();
    terminal.sweep();
  }, 60_000);
  sweeper.unref();

  return { server, auth };
}

async function main() {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(config.homesDir, { recursive: true, mode: 0o750 });
  const { server, auth } = createServer();
  const founded = await auth.ensureQueen();

  server.listen(config.port, config.host, () => {
    const line = '─'.repeat(60);
    console.log(`\n${line}\n  🐝  Vortex OS ${config.version} — ${config.hiveName}\n  Listening on http://${config.host}:${config.port}\n${line}`);
    if (founded) {
      console.log(`  The hive has been founded. Queen account:`);
      console.log(`    username: ${founded.username}`);
      if (founded.generated) {
        console.log(`    password: ${founded.password}`);
        console.log(`  (one-time password — you will be asked to change it on first login)`);
      } else {
        console.log(`    password: (from VORTEX_ADMIN_PASSWORD)`);
      }
      console.log(line);
    }
    if (config.host !== '127.0.0.1' && !config.secureCookies) {
      console.log('  ⚠  Serving on a non-loopback address without VORTEX_SECURE_COOKIES=1.');
      console.log('     Put Vortex OS behind HTTPS before exposing it to the internet.');
    }
  });

  const shutdown = (sig) => {
    console.log(`\n[vortex] ${sig} — closing the hive`);
    audit.log('hive.shutdown', { signal: sig });
    server.close();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createServer };
