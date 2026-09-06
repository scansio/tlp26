import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOrderAmount, isLevelInProfit, hasLevelImproved } from './position-monitor';

// ---------------------------------------------------------------------------
// resolveOrderAmount
// ---------------------------------------------------------------------------

test('resolveOrderAmount: spot always uses positionSize directly', () => {
  assert.equal(resolveOrderAmount('spot', 1.5, 1, null), 1.5);
  assert.equal(resolveOrderAmount('spot', 1.5, 5, 3), 1.5); // contractSize/orderContracts ignored for spot
});

test('resolveOrderAmount: swap without orderContracts falls back to positionSize/contractSize', () => {
  assert.equal(resolveOrderAmount('swap', 10, 5, null), 2);
});

test('resolveOrderAmount: swap ratio within slippage band (>=0.995) uses orderContracts unscaled', () => {
  const orderContracts = 2;
  const contractSize = 5;
  const positionSize = orderContracts * contractSize * 0.999; // entry/fill slippage dust, not a real partial close
  assert.equal(resolveOrderAmount('swap', positionSize, contractSize, orderContracts), orderContracts);
});

test('resolveOrderAmount: swap ratio from a real partial close scales down proportionally', () => {
  const orderContracts = 2;
  const contractSize = 5;
  const positionSize = orderContracts * contractSize * 0.5; // a genuine 50% partial close
  const result = resolveOrderAmount('swap', positionSize, contractSize, orderContracts);
  assert.ok(Math.abs(result - orderContracts * 0.5) < 1e-9, `expected ~${orderContracts * 0.5}, got ${result}`);
});

test('resolveOrderAmount: swap ratio slightly above 1 (SHORT adverse slippage) stays unscaled', () => {
  const orderContracts = 2;
  const contractSize = 5;
  const positionSize = orderContracts * contractSize * 1.0005;
  assert.equal(resolveOrderAmount('swap', positionSize, contractSize, orderContracts), orderContracts);
});

// ---------------------------------------------------------------------------
// isLevelInProfit
// ---------------------------------------------------------------------------

test('isLevelInProfit: LONG is only in profit strictly above entry', () => {
  assert.equal(isLevelInProfit(110, 100, 'LONG'), true);
  assert.equal(isLevelInProfit(100, 100, 'LONG'), false);
  assert.equal(isLevelInProfit(90, 100, 'LONG'), false);
});

test('isLevelInProfit: SHORT is only in profit strictly below entry', () => {
  assert.equal(isLevelInProfit(90, 100, 'SHORT'), true);
  assert.equal(isLevelInProfit(100, 100, 'SHORT'), false);
  assert.equal(isLevelInProfit(110, 100, 'SHORT'), false);
});

// ---------------------------------------------------------------------------
// hasLevelImproved
// ---------------------------------------------------------------------------

test('hasLevelImproved: no prior sync always counts as improved', () => {
  assert.equal(hasLevelImproved(105, null, 'LONG'), true);
  assert.equal(hasLevelImproved(95, null, 'SHORT'), true);
});

test('hasLevelImproved: LONG only improves upward', () => {
  assert.equal(hasLevelImproved(106, 105, 'LONG'), true);
  assert.equal(hasLevelImproved(105, 105, 'LONG'), false);
  assert.equal(hasLevelImproved(104, 105, 'LONG'), false);
});

test('hasLevelImproved: SHORT only improves downward', () => {
  assert.equal(hasLevelImproved(94, 95, 'SHORT'), true);
  assert.equal(hasLevelImproved(95, 95, 'SHORT'), false);
  assert.equal(hasLevelImproved(96, 95, 'SHORT'), false);
});
