'use strict';
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const config = require('./config');

let lastCpu = null;

function readCpuTimes() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const nums = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = nums[3] + (nums[4] || 0);
    const total = nums.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch {
    // Non-Linux fallback.
    let idle = 0;
    let total = 0;
    for (const c of os.cpus()) {
      for (const [k, v] of Object.entries(c.times)) {
        total += v;
        if (k === 'idle') idle += v;
      }
    }
    return { idle, total };
  }
}

function cpuPercent() {
  const now = readCpuTimes();
  let pct = 0;
  if (lastCpu) {
    const dt = now.total - lastCpu.total;
    const di = now.idle - lastCpu.idle;
    pct = dt > 0 ? Math.max(0, Math.min(100, (1 - di / dt) * 100)) : 0;
  }
  lastCpu = now;
  return Math.round(pct * 10) / 10;
}

function memInfo() {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (k) => Number((txt.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [])[1] || 0) * 1024;
    const total = get('MemTotal');
    const available = get('MemAvailable') || get('MemFree');
    return { total, used: total - available, available, swapTotal: get('SwapTotal'), swapFree: get('SwapFree') };
  } catch {
    return { total: os.totalmem(), used: os.totalmem() - os.freemem(), available: os.freemem(), swapTotal: 0, swapFree: 0 };
  }
}

async function diskInfo() {
  const out = [];
  for (const [label, p] of [['Hive storage', config.homesDir], ['System', '/']]) {
    try {
      const s = await fsp.statfs(p);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      out.push({ label, path: p === config.homesDir ? '~' : p, total, used: total - free, free });
    } catch {
      /* statfs unsupported */
    }
  }
  return out;
}

function osRelease() {
  try {
    const txt = fs.readFileSync('/etc/os-release', 'utf8');
    return (txt.match(/^PRETTY_NAME="?([^"\n]+)"?/m) || [])[1] || os.type();
  } catch {
    return `${os.type()} ${os.release()}`;
  }
}

async function stats() {
  return {
    hostname: os.hostname(),
    os: osRelease(),
    kernel: os.release(),
    arch: os.arch(),
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model || 'unknown',
    cpu: cpuPercent(),
    load: os.loadavg().map((n) => Math.round(n * 100) / 100),
    uptime: os.uptime(),
    memory: memInfo(),
    disks: await diskInfo(),
    vortex: { version: config.version, node: process.version, pid: process.pid, uptime: Math.round(process.uptime()) },
    time: new Date().toISOString(),
  };
}

const CLK_TCK = 100;
const PAGE = 4096;

async function processes() {
  let dirs;
  try {
    dirs = (await fsp.readdir('/proc')).filter((d) => /^\d+$/.test(d));
  } catch {
    return [];
  }
  const uptime = os.uptime();
  const out = [];
  await Promise.all(
    dirs.map(async (pid) => {
      try {
        const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8');
        const close = stat.lastIndexOf(')');
        const name = stat.slice(stat.indexOf('(') + 1, close);
        const f = stat.slice(close + 2).split(' ');
        // Fields after "(comm) ": state=0 ppid=1 ... utime=11 stime=12 ... starttime=19 vsize=20 rss=21
        const cpuSecs = (Number(f[11]) + Number(f[12])) / CLK_TCK;
        const age = Math.max(1, uptime - Number(f[19]) / CLK_TCK);
        let cmd = '';
        try {
          cmd = (await fsp.readFile(`/proc/${pid}/cmdline`, 'utf8')).replace(/\0/g, ' ').trim();
        } catch {
          /* gone */
        }
        out.push({
          pid: Number(pid),
          ppid: Number(f[1]),
          name,
          state: f[0],
          cpu: Math.round((cpuSecs / age) * 1000) / 10,
          rss: Number(f[21]) * PAGE,
          threads: Number(f[17]),
          cmd: (cmd || `[${name}]`).slice(0, 300),
        });
      } catch {
        /* process exited while reading */
      }
    }),
  );
  return out.sort((a, b) => b.cpu - a.cpu || b.rss - a.rss);
}

/** True when `pid` descends from one of `roots`. */
function descendsFrom(pid, roots, procs) {
  const parent = new Map(procs.map((p) => [p.pid, p.ppid]));
  const set = new Set(roots);
  let cur = pid;
  for (let i = 0; i < 64 && cur > 1; i++) {
    if (set.has(cur)) return true;
    cur = parent.get(cur);
    if (cur === undefined) return false;
  }
  return false;
}

module.exports = { stats, processes, descendsFrom };
