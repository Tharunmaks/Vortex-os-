#!/usr/bin/env node
'use strict';
/**
 * Vortex OS hive administration from the host shell.
 *
 *   vortex-admin list
 *   vortex-admin add <name> [queen|worker|drone]
 *   vortex-admin reset <name>
 *   vortex-admin role <name> <queen|worker|drone>
 *   vortex-admin disable|enable <name>
 *   vortex-admin remove <name>
 *
 * Changes are picked up by a running server after restart.
 */
const { UserStore, generatePassword } = require('../server/auth');
const files = require('../server/files');

async function main() {
  const [cmd, name, arg] = process.argv.slice(2);
  const store = new UserStore();
  switch (cmd) {
    case 'list': {
      const rows = store.list();
      if (!rows.length) return console.log('The hive is empty. Start the server to found it.');
      for (const u of rows) {
        console.log(`${u.disabled ? '✗' : '🐝'} ${u.username.padEnd(20)} ${u.roleLabel.padEnd(11)} last login: ${u.lastLogin || 'never'}`);
      }
      return;
    }
    case 'add': {
      const password = generatePassword();
      const u = await store.create({ username: name, password, role: arg || 'worker', mustChangePassword: true });
      await files.ensureHome(u.username);
      console.log(`🐝 ${u.username} (${u.roleLabel}) joined the hive.\n   one-time password: ${password}`);
      return;
    }
    case 'reset': {
      const password = generatePassword();
      await store.setPassword(name, password, { mustChangePassword: true });
      console.log(`🔑 ${name}'s one-time password: ${password}`);
      return;
    }
    case 'role':
      console.log(store.update(name, { role: arg }));
      return;
    case 'disable':
    case 'enable':
      console.log(store.update(name, { disabled: cmd === 'disable' }));
      return;
    case 'remove':
      store.remove(name);
      console.log(`Removed ${name}.`);
      return;
    default:
      console.log('usage: vortex-admin <list|add|reset|role|disable|enable|remove> [name] [role]');
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('error:', err.message);
  process.exit(1);
});
