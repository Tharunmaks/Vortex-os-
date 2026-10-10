'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Point Vortex at a throwaway data dir. Must run before requiring server modules. */
function tempHive() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vortex-test-'));
  process.env.VORTEX_DATA_DIR = dir;
  process.env.VORTEX_HOMES_DIR = path.join(dir, 'hive');
  fs.mkdirSync(process.env.VORTEX_HOMES_DIR, { recursive: true });
  return dir;
}

module.exports = { tempHive };
