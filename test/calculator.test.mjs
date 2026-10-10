import test from 'node:test';
import assert from 'node:assert';
import { evaluate } from '../public/js/apps/calculator.js';

test('calculator evaluates safely without eval', () => {
  assert.equal(evaluate('1+2×3'), 7);
  assert.equal(evaluate('(1+2)×3'), 9);
  assert.equal(evaluate('-2^2'), -4);
  assert.equal(evaluate('2^3^2'), 512);
  assert.equal(evaluate('10÷4'), 2.5);
  assert.equal(evaluate('0.1+0.2'), 0.3);
  assert.throws(() => evaluate('alert(1)'));
  assert.throws(() => evaluate('1/0'));
  assert.throws(() => evaluate('(1+2'));
});
