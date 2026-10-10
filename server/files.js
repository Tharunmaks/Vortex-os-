'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('./config');

class PathError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function homeOf(username) {
  return path.join(config.homesDir, username);
}

const WELCOME = `Welcome to Vortex OS, bee!

This is your private cell in the hive. Everything under your home folder is yours.

  * Terminal  — a real bash shell, watched over by the Hive Guard
  * Files     — browse, upload and download
  * Editor    — edit text and code
  * Browser   — a sandboxed web browser (no scripts, no internal networks)
  * Monitor   — live CPU, memory, disks and processes

Buzz responsibly. 🐝
`;

async function ensureHome(username) {
  const home = homeOf(username);
  await fsp.mkdir(home, { recursive: true, mode: 0o750 });
  for (const dir of ['Documents', 'Downloads', 'Projects', 'Honey']) {
    await fsp.mkdir(path.join(home, dir), { recursive: true });
  }
  const readme = path.join(home, 'README.txt');
  if (!fs.existsSync(readme)) await fsp.writeFile(readme, WELCOME);
  return home;
}

/**
 * Resolve a user supplied path into an absolute path inside the bee's home.
 * Rejects traversal (..), NUL bytes, and symlinks that escape the home dir.
 */
async function resolveSafe(home, userPath = '/') {
  home = path.resolve(home);
  if (typeof userPath !== 'string' || userPath.includes('\0')) throw new PathError('Invalid path');
  if (userPath.length > 4096) throw new PathError('Path too long');
  const rel = path.posix.normalize('/' + userPath.replace(/\\/g, '/'));
  const abs = path.resolve(home, '.' + rel); // resolve() drops trailing slashes so `abs === home` checks hold
  const homeReal = await fsp.realpath(home);
  if (!isInside(homeReal, abs) && !isInside(home, abs)) throw new PathError('Path escapes your home', 403);

  // Walk up to the deepest existing ancestor and make sure its real location is inside home.
  let probe = abs;
  for (;;) {
    try {
      const real = await fsp.realpath(probe);
      if (!isInside(homeReal, real)) throw new PathError('Path escapes your home', 403);
      break;
    } catch (err) {
      if (err instanceof PathError) throw err;
      if (err.code !== 'ENOENT') throw err;
      const parent = path.dirname(probe);
      if (parent === probe) throw new PathError('Invalid path');
      probe = parent;
    }
  }
  return abs;
}

function isInside(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function toUserPath(home, abs) {
  const rel = path.relative(home, abs).split(path.sep).join('/');
  return '/' + rel;
}

function validName(name) {
  if (typeof name !== 'string' || !name || name.length > 255) return false;
  if (name === '.' || name === '..' || /[\/\\\0]/.test(name)) return false;
  return true;
}

async function list(home, userPath) {
  const dir = await resolveSafe(home, userPath);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    try {
      const st = await fsp.lstat(full);
      out.push({
        name: e.name,
        type: st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file',
        size: st.size,
        mtime: st.mtime.toISOString(),
        mode: (st.mode & 0o777).toString(8),
      });
    } catch {
      /* raced with deletion */
    }
  }
  const rank = (e) => (e.type === 'dir' ? 0 : 1);
  out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return { path: toUserPath(home, dir), entries: out };
}

async function readText(home, userPath) {
  const file = await resolveSafe(home, userPath);
  const st = await fsp.stat(file);
  if (!st.isFile()) throw new PathError('Not a file');
  if (st.size > config.files.maxEditBytes) throw new PathError('File too large for the editor', 413);
  const buf = await fsp.readFile(file);
  if (buf.includes(0)) throw new PathError('Binary file — download it instead', 415);
  return { path: toUserPath(home, file), content: buf.toString('utf8'), mtime: st.mtime.toISOString() };
}

async function usage(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        try {
          total += (await fsp.stat(full)).size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return total;
}

async function checkQuota(home, incoming) {
  const used = await usage(home);
  if (used + incoming > config.files.quotaBytes) {
    throw new PathError(`Hive quota exceeded (${Math.round(config.files.quotaBytes / 1048576)} MB)`, 507);
  }
}

async function writeText(home, userPath, content) {
  if (typeof content !== 'string') throw new PathError('Content must be text');
  const bytes = Buffer.byteLength(content);
  if (bytes > config.files.maxEditBytes) throw new PathError('File too large', 413);
  const file = await resolveSafe(home, userPath);
  if (file === home) throw new PathError('Invalid file path');
  await checkQuota(home, bytes);
  const tmp = `${file}.vortex-${process.pid}.tmp`;
  await fsp.writeFile(tmp, content, { mode: 0o640 });
  await fsp.rename(tmp, file);
  return { path: toUserPath(home, file) };
}

async function mkdir(home, parent, name) {
  if (!validName(name)) throw new PathError('Invalid folder name');
  const dir = await resolveSafe(home, path.posix.join(parent || '/', name));
  await fsp.mkdir(dir);
  return { path: toUserPath(home, dir) };
}

async function rename(home, from, toName) {
  if (!validName(toName)) throw new PathError('Invalid name');
  const src = await resolveSafe(home, from);
  if (src === home) throw new PathError('Cannot rename your home');
  const dest = await resolveSafe(home, path.posix.join(path.posix.dirname(toUserPath(home, src)), toName));
  if (fs.existsSync(dest)) throw new PathError('Something with that name already exists', 409);
  await fsp.rename(src, dest);
  return { path: toUserPath(home, dest) };
}

async function remove(home, userPath) {
  const target = await resolveSafe(home, userPath);
  if (target === home) throw new PathError('Refusing to delete your home', 403);
  await fsp.rm(target, { recursive: true, force: false });
}

/** Stream an upload into the bee's home, enforcing size and quota. */
async function upload(home, dirPath, name, req) {
  if (!validName(name)) throw new PathError('Invalid file name');
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > config.files.maxUploadBytes) throw new PathError('Upload too large', 413);
  await checkQuota(home, declared);
  const dest = await resolveSafe(home, path.posix.join(dirPath || '/', name));
  const tmp = `${dest}.vortex-upload-${process.pid}.tmp`;
  await new Promise((resolve, reject) => {
    let size = 0;
    const out = fs.createWriteStream(tmp, { mode: 0o640 });
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > config.files.maxUploadBytes) {
        req.destroy();
        out.destroy();
        reject(new PathError('Upload too large', 413));
      }
    });
    req.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    req.on('error', reject);
  }).catch(async (err) => {
    await fsp.rm(tmp, { force: true });
    throw err;
  });
  await fsp.rename(tmp, dest);
  return { path: toUserPath(home, dest) };
}

async function openDownload(home, userPath) {
  const file = await resolveSafe(home, userPath);
  const st = await fsp.stat(file);
  if (!st.isFile()) throw new PathError('Not a file');
  return { file, size: st.size, name: path.basename(file) };
}

module.exports = {
  PathError,
  homeOf,
  ensureHome,
  resolveSafe,
  isInside,
  list,
  readText,
  writeText,
  mkdir,
  rename,
  remove,
  upload,
  openDownload,
  usage,
  validName,
};
