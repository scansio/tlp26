import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Exchange, Order } from 'ccxt';
import { placeProtectiveOrders, cancelProtectiveOrders } from './protective-orders';

function makeOrder(id: string): Order {
  return { id } as Order;
}

type FakeOverrides = Partial<{
  createStopLossOrder: (...args: unknown[]) => Promise<Order>;
  createTakeProfitOrder: (...args: unknown[]) => Promise<Order>;
  cancelOrder: (id: string, ...rest: unknown[]) => Promise<Order>;
}>;

function fakeClient(overrides: FakeOverrides = {}): Exchange {
  return {
    createStopLossOrder: overrides.createStopLossOrder ?? (async () => makeOrder('sl-order-1')),
    createTakeProfitOrder: overrides.createTakeProfitOrder ?? (async () => makeOrder('tp-order-1')),
    cancelOrder: overrides.cancelOrder ?? (async (id: string) => makeOrder(id)),
  } as unknown as Exchange;
}

test('placeProtectiveOrders places both SL and TP and returns their order ids', async () => {
  const result = await placeProtectiveOrders({
    client: fakeClient(),
    symbol: 'BTC/USDT',
    marketType: 'swap',
    direction: 'LONG',
    amount: 1,
    stopLossPrice: 90,
    takeProfitPrice: 110,
  });
  assert.equal(result.slOrderId, 'sl-order-1');
  assert.equal(result.tpOrderId, 'tp-order-1');
  assert.deepEqual(result.errors, []);
});

test('placeProtectiveOrders skips SL when stopLossPrice is null', async () => {
  const result = await placeProtectiveOrders({
    client: fakeClient(),
    symbol: 'BTC/USDT',
    marketType: 'swap',
    direction: 'LONG',
    amount: 1,
    stopLossPrice: null,
    takeProfitPrice: 110,
  });
  assert.equal(result.slOrderId, null);
  assert.equal(result.tpOrderId, 'tp-order-1');
});

test('placeProtectiveOrders captures a thrown error without throwing itself', async () => {
  const client = fakeClient({
    createStopLossOrder: async () => {
      throw new Error('exchange rejected order');
    },
  });
  const result = await placeProtectiveOrders({
    client,
    symbol: 'BTC/USDT',
    marketType: 'swap',
    direction: 'LONG',
    amount: 1,
    stopLossPrice: 90,
    takeProfitPrice: 110,
  });
  assert.equal(result.slOrderId, null);
  assert.equal(result.tpOrderId, 'tp-order-1'); // TP is independent — SL failing must not block it
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /stop-loss order failed/);
});

test('placeProtectiveOrders passes reduceOnly for swap but an empty params object for spot', async () => {
  const calls: unknown[][] = [];
  const client = fakeClient({
    createStopLossOrder: async (...args: unknown[]) => {
      calls.push(args);
      return makeOrder('sl-1');
    },
  });

  await placeProtectiveOrders({
    client, symbol: 'BTC/USDT', marketType: 'swap', direction: 'LONG', amount: 1,
    stopLossPrice: 90, takeProfitPrice: null,
  });
  assert.deepEqual(calls[0][6], { reduceOnly: true });

  calls.length = 0;
  await placeProtectiveOrders({
    client, symbol: 'BTC/USDT', marketType: 'spot', direction: 'LONG', amount: 1,
    stopLossPrice: 90, takeProfitPrice: null,
  });
  assert.deepEqual(calls[0][6], {});
});

test('placeProtectiveOrders adds hedged when the account is in dual-side position mode', async () => {
  const calls: unknown[][] = [];
  const client = fakeClient({
    createStopLossOrder: async (...args: unknown[]) => {
      calls.push(args);
      return makeOrder('sl-1');
    },
  });

  await placeProtectiveOrders({
    client, symbol: 'BTC/USDT', marketType: 'swap', direction: 'LONG', amount: 1,
    stopLossPrice: 90, takeProfitPrice: null, hedged: true,
  });
  assert.deepEqual(calls[0][6], { reduceOnly: true, hedged: true });
});

test('placeProtectiveOrders flips side for SHORT vs LONG', async () => {
  const calls: unknown[][] = [];
  const client = fakeClient({
    createStopLossOrder: async (...args: unknown[]) => {
      calls.push(args);
      return makeOrder('sl-1');
    },
  });

  await placeProtectiveOrders({
    client, symbol: 'BTC/USDT', marketType: 'swap', direction: 'LONG', amount: 1,
    stopLossPrice: 90, takeProfitPrice: null,
  });
  assert.equal(calls[0][2], 'sell'); // closing a LONG = sell

  calls.length = 0;
  await placeProtectiveOrders({
    client, symbol: 'BTC/USDT', marketType: 'swap', direction: 'SHORT', amount: 1,
    stopLossPrice: 90, takeProfitPrice: null,
  });
  assert.equal(calls[0][2], 'buy'); // closing a SHORT = buy
});

test('cancelProtectiveOrders calls cancelOrder for each non-null/undefined id and skips the rest', async () => {
  const calledIds: string[] = [];
  const client = fakeClient({
    cancelOrder: async (id: string) => {
      calledIds.push(id);
      return makeOrder(id);
    },
  });
  await cancelProtectiveOrders(client, 'BTC/USDT', 'swap', ['a', null, 'b', undefined]);
  assert.deepEqual(calledIds, ['a', 'b']);
});

test('cancelProtectiveOrders swallows "already filled"-style errors without throwing', async () => {
  const client = fakeClient({
    cancelOrder: async () => {
      throw new Error('Order already filled or cancelled');
    },
  });
  await assert.doesNotReject(cancelProtectiveOrders(client, 'BTC/USDT', 'swap', ['a']));
});

test('cancelProtectiveOrders does not throw on an unexpected error either (best-effort, logs only)', async () => {
  const client = fakeClient({
    cancelOrder: async () => {
      throw new Error('rate limited');
    },
  });
  await assert.doesNotReject(cancelProtectiveOrders(client, 'BTC/USDT', 'swap', ['a']));
});
