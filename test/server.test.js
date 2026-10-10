'use strict';
const { tempHive } = require('./helpers');
tempHive();
const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { createServer } = require('../server/index');
const files = require('../server/files');

let base;
let server;
let auth;

test.before(async () => {
  ({ server, auth } = createServer());
  await auth.store.create({ username: 'queen', password: 'Royal-Jelly-99', role: 'queen' });
  await auth.store.create({ username: 'worker', password: 'Pollen-Path-77', role: 'worker' });
  await auth.store.create({ username: 'drone', password: 'Waggle-Dance-5', role: 'drone' });
  for (const u of ['queen', 'worker', 'drone']) await files.ensureHome(u);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.closeAllConnections?.();
  server.close();
});

async function call(path, { method = 'GET', body, cookie, origin = base } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  const res = await fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data, headers: res.headers };
}

async function login(username, password) {
  const res = await call('/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  return setCookie.split(';')[0];
}

test('static shell is served with strict security headers', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(base + '/package.json')).status, 404);
  const raw = await new Promise((resolve) => {
    require('http').get({ host: '127.0.0.1', port: server.address().port, path: '/../../server/config.js' }, (r) => {
      r.resume();
      resolve(r.statusCode);
    });
  });
  assert.equal(raw, 404, 'raw path traversal is refused');
  assert.equal((await fetch(base + '/vendor/xterm.js')).status, 200);
});

test('cross-site and anonymous requests are refused', async () => {
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { username: 'queen', password: 'Royal-Jelly-99' }, origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { username: 'queen', password: 'Royal-Jelly-99' }, origin: null })).status, 403);
  assert.equal((await call('/api/fs/list')).status, 401);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { username: 'queen', password: 'nope' } })).status, 401);
});

test('roles are enforced on the server', async () => {
  const worker = await login('worker', 'Pollen-Path-77');
  const drone = await login('drone', 'Waggle-Dance-5');

  assert.equal((await call('/api/fs/write', { method: 'PUT', cookie: worker, body: { path: '/hello.txt', content: 'hi' } })).status, 200);
  assert.equal((await call('/api/fs/read?path=/hello.txt', { cookie: worker })).data.content, 'hi');
  assert.equal((await call('/api/fs/write', { method: 'PUT', cookie: drone, body: { path: '/x.txt', content: 'x' } })).status, 403);
  assert.equal((await call('/api/fs/list?path=/', { cookie: drone })).status, 200);
  assert.equal((await call('/api/hive/bees', { cookie: worker })).status, 403);
  assert.equal((await call('/api/hive/audit', { cookie: drone })).status, 403);
  assert.equal((await call('/api/system/kill', { method: 'POST', cookie: worker, body: { pid: 1 } })).status, 400);
  assert.equal((await call('/api/system/kill', { method: 'POST', cookie: worker, body: { pid: process.pid } })).status, 400);
});

test('queens manage the hive; new bees must change their password', async () => {
  const queen = await login('queen', 'Royal-Jelly-99');
  const created = await call('/api/hive/bees', { method: 'POST', cookie: queen, body: { username: 'newbee', role: 'worker' } });
  assert.equal(created.status, 200);
  assert.ok(created.data.password);

  const nb = await login('newbee', created.data.password);
  assert.equal((await call('/api/fs/list', { cookie: nb })).status, 403, 'blocked until password changed');
  assert.equal((await call('/api/auth/password', { method: 'POST', cookie: nb, body: { current: created.data.password, next: 'Fresh-Nectar-42' } })).status, 200);
  assert.equal((await call('/api/fs/list', { cookie: nb })).status, 200);

  assert.equal((await call('/api/hive/bees/queen', { method: 'PATCH', cookie: queen, body: { role: 'worker' } })).status, 400);
  assert.equal((await call('/api/hive/bees/newbee', { method: 'PATCH', cookie: queen, body: { disabled: true } })).status, 200);
  assert.equal((await call('/api/fs/list', { cookie: nb })).status, 401, 'disabled bee is signed out');

  const log = await call('/api/hive/audit', { cookie: queen });
  assert.ok(log.data.some((e) => e.event === 'hive.bee-created'));
});

test('browser proxy refuses internal targets', async () => {
  const worker = await login('worker', 'Pollen-Path-77');
  for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd', `${base}/api/hive`]) {
    const res = await call(`/api/browser/page?url=${encodeURIComponent(url)}`, { cookie: worker });
    assert.ok(res.status === 403 || res.status === 400, `${url} → ${res.status}`);
  }
});

function openTerminal(cookie, origin = base) {
  return new WebSocket(base.replace('http', 'ws') + '/ws/terminal', { headers: { Cookie: cookie, Origin: origin } });
}

test('terminal: real bash for workers, guarded, and refused for drones/cross-site', async () => {
  const worker = await login('worker', 'Pollen-Path-77');
  const drone = await login('drone', 'Waggle-Dance-5');

  await new Promise((resolve) => {
    const ws = openTerminal(drone);
    ws.on('unexpected-response', (req, res) => {
      assert.equal(res.statusCode, 403);
      resolve();
    });
  });
  await new Promise((resolve) => {
    const ws = openTerminal(worker, 'https://evil.example');
    ws.on('unexpected-response', (req, res) => {
      assert.equal(res.statusCode, 403);
      resolve();
    });
  });

  const output = await new Promise((resolve, reject) => {
    const ws = openTerminal(worker);
    let out = '';
    const timer = setTimeout(() => reject(new Error('timeout; got: ' + out)), 8000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.t === 'o') out += msg.d;
      if (out.includes('BUZZ=42') && out.includes('Hive Guard')) {
        clearTimeout(timer);
        ws.close();
        resolve(out);
      }
    });
    ws.on('open', () => {
      setTimeout(() => ws.send(JSON.stringify({ t: 'i', d: 'echo BUZZ=$((6*7)) $HIVE_ROLE $PWD\r' })), 300);
      setTimeout(() => ws.send(JSON.stringify({ t: 'i', d: 'shutdown -h now\r' })), 600);
    });
  });
  assert.match(output, /BUZZ=42 worker .*\/worker/);
  assert.match(output, /Hive Guard.*blocked/);
  assert.doesNotMatch(output, /\x1b\]7771/, 'guard OSC marker is stripped before reaching the client');
});
