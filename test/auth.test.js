'use strict';
const { tempHive } = require('./helpers');
tempHive();
const test = require('node:test');
const assert = require('node:assert');
const { Auth, UserStore, RateLimiter, validatePassword, hashPassword, verifyPassword, generatePassword } = require('../server/auth');

test('password policy', () => {
  assert.match(validatePassword('short'), /at least 10/);
  assert.match(validatePassword('alllowercaseletters'), /3 of/);
  assert.match(validatePassword('Buzz-buzz-2026', 'buzz'), /username/);
  assert.equal(validatePassword('Honey-Comb-2026'), null);
  assert.equal(validatePassword(generatePassword()), null);
});

test('scrypt hashing round-trips and rejects wrong passwords', async () => {
  const rec = await hashPassword('Honey-Comb-2026');
  assert.ok(await verifyPassword('Honey-Comb-2026', rec));
  assert.ok(!(await verifyPassword('Honey-Comb-2027', rec)));
  assert.notEqual((await hashPassword('Honey-Comb-2026')).salt, rec.salt);
});

test('rate limiter locks out after max failures', () => {
  const rl = new RateLimiter({ max: 3, windowMs: 1000, lockoutMs: 5000 });
  rl.fail('k', 0);
  rl.fail('k', 1);
  assert.equal(rl.locked('k', 2), 0);
  rl.fail('k', 3);
  assert.ok(rl.locked('k', 4) > 0);
  assert.equal(rl.locked('k', 6000), 0);
});

test('login, lockout, disabled bees and last-queen protection', async () => {
  const auth = new Auth(new UserStore());
  await auth.store.create({ username: 'queen', password: 'Royal-Jelly-99', role: 'queen' });
  await auth.store.create({ username: 'buzz', password: 'Pollen-Path-77', role: 'worker' });

  const ok = await auth.login('queen', 'Royal-Jelly-99', '1.1.1.1');
  assert.ok(ok.token);
  assert.equal(auth.resolve(ok.token).user.username, 'queen');

  for (let i = 0; i < 5; i++) await assert.rejects(auth.login('buzz', 'wrong', '2.2.2.2'), { status: 401 });
  await assert.rejects(auth.login('buzz', 'Pollen-Path-77', '2.2.2.2'), { status: 429 });

  assert.throws(() => auth.store.update('queen', { role: 'worker' }), /at least one active queen/);
  assert.throws(() => auth.store.remove('queen'), /at least one active queen/);

  auth.store.update('queen', {});
  await auth.store.create({ username: 'drone1', password: 'Waggle-Dance-5', role: 'drone' });
  const d = await auth.login('drone1', 'Waggle-Dance-5', '3.3.3.3');
  auth.store.update('drone1', { disabled: true });
  assert.equal(auth.resolve(d.token), null, 'disabled bee sessions stop resolving');
  await assert.rejects(auth.login('drone1', 'Waggle-Dance-5', '3.3.3.3'), { status: 401 });
});

test('usernames are validated', async () => {
  const store = new UserStore();
  await assert.rejects(store.create({ username: '../etc', password: 'Honey-Comb-2026' }), /Username/);
  await assert.rejects(store.create({ username: 'ab', password: 'Honey-Comb-2026' }), /Username/);
});
