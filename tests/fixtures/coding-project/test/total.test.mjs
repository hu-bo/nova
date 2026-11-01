import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateTotal } from '../src/total.mjs';

test('3 件每件 1900 分，总价为 5700 分', () => {
  assert.equal(calculateTotal(3, 1900), 5700);
});

test('零件商品总价为零', () => {
  assert.equal(calculateTotal(0, 1900), 0);
});

test('单件商品保持整数分金额', () => {
  assert.equal(calculateTotal(1, 1999), 1999);
});
