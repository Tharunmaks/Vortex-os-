'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');

const MAX_MEMORY = 1000;
const recent = [];
let stream = null;

function open() {
  if (stream) return;
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  stream = fs.createWriteStream(path.join(config.dataDir, 'audit.log'), { flags: 'a', mode: 0o600 });
}

/**
 * Append an entry to the hive audit trail.
 * level: info | warn | alert
 */
function log(event, details = {}, level = 'info') {
  const entry = { ts: new Date().toISOString(), level, event, ...details };
  recent.push(entry);
  if (recent.length > MAX_MEMORY) recent.shift();
  try {
    open();
    stream.write(JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('[audit] write failed:', err.message);
  }
  if (level !== 'info') console.warn(`[audit:${level}] ${event}`, JSON.stringify(details));
  return entry;
}

function tail(limit = 200, filter = {}) {
  let rows = recent;
  if (filter.user) rows = rows.filter((r) => r.user === filter.user);
  if (filter.level) rows = rows.filter((r) => r.level === filter.level);
  return rows.slice(-limit).reverse();
}

module.exports = { log, tail };
