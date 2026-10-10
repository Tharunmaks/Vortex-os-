'use strict';
const path = require('path');

const root = path.resolve(__dirname, '..');
const env = process.env;
const dataDir = path.resolve(env.VORTEX_DATA_DIR || path.join(root, 'data'));

const int = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

module.exports = {
  root,
  version: require('../package.json').version,
  hiveName: env.VORTEX_HIVE_NAME || 'MNX Hive',
  // Bind to loopback by default. The Docker image sets 0.0.0.0 explicitly.
  host: env.VORTEX_HOST || '127.0.0.1',
  port: int(env.VORTEX_PORT, 8420),
  dataDir,
  homesDir: path.resolve(env.VORTEX_HOMES_DIR || path.join(dataDir, 'hive')),
  // Set to 1 when served over HTTPS (directly or behind a TLS proxy).
  secureCookies: env.VORTEX_SECURE_COOKIES === '1',
  // Honour X-Forwarded-For only when running behind a trusted reverse proxy.
  trustProxy: env.VORTEX_TRUST_PROXY === '1',
  // Extra origins allowed for state-changing requests (comma separated).
  allowedOrigins: (env.VORTEX_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),

  sessionIdleMs: int(env.VORTEX_SESSION_IDLE_MIN, 30) * 60_000,
  sessionMaxMs: int(env.VORTEX_SESSION_MAX_HOURS, 12) * 3_600_000,

  login: {
    maxFailuresPerUser: 5,
    maxFailuresPerIp: 20,
    windowMs: 15 * 60_000,
    lockoutMs: 15 * 60_000,
  },
  passwordMinLength: 10,

  terminal: {
    shell: env.VORTEX_SHELL || '/bin/bash',
    // PATH given to bee shells. Override on hosts without /usr/bin (e.g. Termux).
    path: env.VORTEX_SHELL_PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    maxPerBee: int(env.VORTEX_MAX_TERMINALS, 4),
    idleMs: int(env.VORTEX_TERMINAL_IDLE_MIN, 60) * 60_000,
    guard: env.VORTEX_HIVE_GUARD !== '0',
  },

  files: {
    maxUploadBytes: int(env.VORTEX_MAX_UPLOAD_MB, 50) * 1024 * 1024,
    maxEditBytes: 2 * 1024 * 1024,
    quotaBytes: int(env.VORTEX_QUOTA_MB, 1024) * 1024 * 1024,
  },

  browser: {
    enabled: env.VORTEX_BROWSER !== '0',
    maxBytes: 5 * 1024 * 1024,
    timeoutMs: 15_000,
    maxRedirects: 5,
    // Never set this in production: it lets the browser reach internal networks.
    allowPrivate: env.VORTEX_BROWSER_ALLOW_PRIVATE === '1',
  },
};
