'use strict';
const { tempHive } = require('./helpers');
tempHive();
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const files = require('../server/files');

test('bees are confined to their home cell', async () => {
  const home = await files.ensureHome('buzz');
  const other = await files.ensureHome('honey');
  fs.writeFileSync(path.join(other, 'secret.txt'), 'top secret');

  // ".." is clamped to the home root rather than escaping it.
  assert.equal(await files.resolveSafe(home, '/../../honey/secret.txt'), path.join(home, 'honey/secret.txt'));
  await assert.rejects(files.readText(home, '/../honey/secret.txt'), { code: 'ENOENT' });
  await assert.rejects(files.resolveSafe(home, 'a\0b'), /Invalid path/);

  // Symlinks planted from the terminal cannot be followed out of the cell.
  fs.symlinkSync(other, path.join(home, 'escape'));
  await assert.rejects(files.readText(home, '/escape/secret.txt'), { status: 403 });
  await assert.rejects(files.writeText(home, '/escape/pwned.txt', 'x'), { status: 403 });
  fs.symlinkSync('/etc', path.join(home, 'etc'));
  await assert.rejects(files.list(home, '/etc'), { status: 403 });
});

test('file operations work inside the cell', async () => {
  const home = await files.ensureHome('worker1');
  await files.writeText(home, '/Documents/note.md', '# hi');
  assert.equal((await files.readText(home, '/Documents/note.md')).content, '# hi');
  await files.mkdir(home, '/', 'Wax');
  await files.rename(home, '/Documents/note.md', 'renamed.md');
  const listing = await files.list(home, '/Documents');
  assert.deepEqual(listing.entries.map((e) => e.name), ['renamed.md']);
  await assert.rejects(files.rename(home, '/Documents/renamed.md', '../x'), /Invalid name/);
  await assert.rejects(files.remove(home, '/'), /home/);
  await files.remove(home, '/Wax');
  assert.ok(!fs.existsSync(path.join(home, 'Wax')));
});

test('binary files are refused by the editor', async () => {
  const home = await files.ensureHome('worker2');
  fs.writeFileSync(path.join(home, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
  await assert.rejects(files.readText(home, '/blob.bin'), { status: 415 });
});
