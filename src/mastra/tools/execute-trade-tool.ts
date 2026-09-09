/**
 * execute-trade-tool
 *
 * Places a trade order on a CEX exchange via CCXT (live mode) or simulates a
 * paper fill (paper mode). entryPrice is treated as an actual entry target
 * (often an SMC retest/order-block zone away from current price — see
 * trading-agent.ts), not a live snapshot: orders are LIMIT orders at
 * entryPrice, not market orders.
 *
 * Live mode:
 *  - Decrypts user exchange credentials from user_exchanges
 *  - Places a limit buy/sell order via CCXT createOrder at entryPrice
 *  - If it fills immediately: records the exchange order ID + fill in
 *    trade_executions and marks the signal 'executed'
 *  - If it doesn't fill immediately: leaves it resting on the exchange and
 *    marks the signal 'approved' (entryOrderId set) — /api/cron/reconcile-entries
 *    polls it to completion; /api/cron/expire-signals cancels it on expiry
 *
 * Paper mode:
 *  - Fills at entryPrice exactly (no slippage — that's what a limit order
 *    does) once the current price has reached entryPrice; otherwise the
 *    signal is left 'approved' for the same reconcile-entries cron to fill
 *  - Inserts a paper trade_execution record (no exchange API call)
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import ccxt, { type Exchange } from 'ccxt';
import { db } from '@/db';
import { tradeSignals, userExchanges } from '@/db/schema';
import { decrypt } from '@/lib/crypto';
import { and, eq } from 'drizzle-orm';
import { toExchangeSymbol, resolveHedgeMode, type MarketType } from './market-symbol';
import {
  fetchTickerPrice,
  isLimitMarketable,
  applySlippage,
  finalizeLiveFill,
  finalizePaperFill,
} from '@/lib/entry-fill';

// Idempotency: setting margin mode to what it already is throws on most
// exchanges (e.g. binance -4046 "No need to change margin type") — swallow
// only that class of error; anything else must abort order placement rather
// than silently proceed at whatever margin mode the account happens to have.
function isAlreadySetError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no need to change|already.*(margin|leverage)|not modified/i.test(msg);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SLIPPAGE_PCT = 0.05; // 0.05%

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Retrieve and decrypt exchange credentials for a user.
 * Returns null when no active credentials are found.
 */
async function getExchangeCredentials(
  userId: string,
  exchangeName: string,
): Promise<{ apiKey: string; secret: string; password?: string } | null> {
  const rows = await db
    .select({
      encryptedApiKey: userExchanges.encryptedApiKey,
      encryptedApiSecret: userExchanges.encryptedApiSecret,
      encryptedPassphrase: userExchanges.encryptedPassphrase,
    })
    .from(userExchanges)
    .where(
      and(
        eq(userExchanges.userId, userId),
        eq(userExchanges.exchangeName, exchangeName),
        eq(userExchanges.status, 'active'),
      ),
    )
    .limit(1);

  if (!rows[0]) return null;

  const { encryptedApiKey, encryptedApiSecret, encryptedPassphrase } = rows[0];
  return {
    apiKey: decrypt(encryptedApiKey),
    secret: decrypt(encryptedApiSecret),
    password: encryptedPassphrase ? decrypt(encryptedPassphrase) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const executeTradeTool = createTool({
  id: 'execute-trade-tool',
  description:
    'Execute a trade on a CEX exchange (live mode) or simulate a paper fill (paper mode). ' +
    'Always call this after risk sizing has produced a positionSizeUsdt value. ' +
    'Places a LIMIT order at entryPrice (not a market order) — entryPrice may be away from the ' +
    'current price by design. If it does not fill immediately the signal is left "approved" ' +
    '(resting order) rather than "executed"; check the returned signalStatus. ' +
    'In paper mode the tool simulates the same limit-fill behavior without calling the exchange.',

  inputSchema: z.object({
    userId: z.string().describe('Clerk user ID'),
    signalId: z.string().describe('UUID of the trade_signals row to execute'),
    exchange: z
      .enum(['binance', 'bybit', 'bingx'])
      .describe('Exchange to execute on'),
    symbol: z.string().describe('Trading pair, e.g. BTC/USDT'),
    direction: z.enum(['LONG', 'SHORT']).describe('Trade direction'),
    entryPrice: z
      .number()
      .positive()
      .describe('Signal entry price in quote currency (USDT)'),
    positionSizeUsdt: z
      .number()
      .positive()
      .describe('Notional position size in USDT from risk-tool output'),
    sl: z.number().positive().describe('Stop-loss price — required'),
    tp: z.number().positive().describe('Take-profit price — required'),
    mode: z.enum(['paper', 'live']).describe('Execution mode'),
    slippagePct: z
      .number()
      .min(0)
      .max(5)
      .optional()
      .describe('Slippage % to apply to paper fills (default 0.05)'),
    marketType: z.enum(['spot', 'swap']).default('spot').describe("'swap' = USDT-M perpetual futures"),
    leverage: z.number().int().positive().optional().describe('Leverage to set before placing a swap order'),
    marginMode: z.enum(['cross', 'isolated']).optional(),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    executionId: z.string().nullable(),
    exchangeOrderId: z.string().nullable(),
    fillPrice: z.number().nullable(),
    mode: z.enum(['paper', 'live']),
    signalStatus: z.string(),
    message: z.string(),
  }),

  execute: async (inputData) => {
    const {
      userId,
      signalId,
      exchange,
      symbol,
      direction,
      entryPrice,
      positionSizeUsdt,
      sl,
      tp,
      mode,
      slippagePct: inputSlippage,
      marketType,
      leverage,
      marginMode,
    } = inputData as {
      userId: string;
      signalId: string;
      exchange: 'binance' | 'bybit' | 'bingx';
      symbol: string;
      direction: 'LONG' | 'SHORT';
      entryPrice: number;
      positionSizeUsdt: number;
      sl: number;
      tp: number;
      mode: 'paper' | 'live';
      slippagePct?: number;
      marketType: MarketType;
      leverage?: number;
      marginMode?: 'cross' | 'isolated';
    };

    const effMarketType: MarketType = marketType ?? 'spot';
    const effLeverage = leverage ?? 1;
    const effMarginMode = marginMode ?? 'cross';

    const slippagePct = inputSlippage ?? DEFAULT_SLIPPAGE_PCT;

    // -------------------------------------------------------------------------
    // PAPER MODE — simulate a limit fill at entryPrice, no exchange API call.
    // Entry is a target, not a live snapshot (see market-symbol.ts / trading
    // agent's entryZone) — only fill immediately if the current price has
    // actually reached it; otherwise the signal rests as 'approved' and the
    // reconcile-entries cron fills it once price gets there.
    // -------------------------------------------------------------------------
    if (mode === 'paper') {
      const currentPrice = await fetchTickerPrice(symbol, exchange, effMarketType);

      // Ticker unavailable — fall back to an immediate market-style fill with
      // slippage rather than leaving the signal stuck with no way to reconcile.
      const marketable = currentPrice === null || isLimitMarketable(direction, entryPrice, currentPrice);

      if (!marketable) {
        await db
          .update(tradeSignals)
          .set({ status: 'approved', updatedAt: new Date() })
          .where(eq(tradeSignals.id, signalId));

        return {
          success: true,
          executionId: null,
          exchangeOrderId: null,
          fillPrice: null,
          mode: 'paper' as const,
          signalStatus: 'approved',
          message: `Paper limit order resting at $${entryPrice.toFixed(4)} (current price $${currentPrice!.toFixed(4)}) — will fill once price is reached.`,
        };
      }

      // Limit fills exactly at entryPrice (no adverse slippage) once
      // marketable; the ticker-unavailable fallback still applies slippage
      // since that path can't distinguish a limit fill from a market one.
      const fillPrice = currentPrice === null ? applySlippage(entryPrice, direction, slippagePct) : entryPrice;
      const positionSizeUnits = positionSizeUsdt / fillPrice;

      const { executionId } = await finalizePaperFill({
        signalId,
        userId,
        exchange,
        symbol,
        marketType: effMarketType,
        fillPrice,
        positionSizeUnits,
        leverage: effLeverage,
        marginMode: effMarginMode,
      });

      return {
        success: true,
        executionId,
        exchangeOrderId: null,
        fillPrice,
        mode: 'paper' as const,
        signalStatus: 'executed',
        message: `Paper trade filled at $${fillPrice.toFixed(4)} (${positionSizeUnits.toFixed(6)} units).`,
      };
    }

    // -------------------------------------------------------------------------
    // LIVE MODE — decrypt credentials and place order via CCXT
    // -------------------------------------------------------------------------
    const creds = await getExchangeCredentials(userId, exchange);
    if (!creds) {
      return {
        success: false,
        executionId: null,
        exchangeOrderId: null,
        fillPrice: null,
        mode: 'live' as const,
        signalStatus: 'pending',
        message: `No active ${exchange} credentials found for user. Signal left as pending.`,
      };
    }

    const ExchangeClass = (ccxt as unknown as Record<string, new (c: object) => Exchange>)[exchange];
    if (!ExchangeClass) {
      return {
        success: false,
        executionId: null,
        exchangeOrderId: null,
        fillPrice: null,
        mode: 'live' as const,
        signalStatus: 'pending',
        message: `Exchange "${exchange}" is not supported by CCXT. Signal left as pending.`,
      };
    }

    const client = new ExchangeClass({
      apiKey: creds.apiKey,
      secret: creds.secret,
      ...(creds.password ? { password: creds.password } : {}),
    });

    const exchangeSymbol = toExchangeSymbol(symbol, effMarketType);

    // Amount in base asset units (CCXT always takes base units)
    const amountUnits = positionSizeUsdt / entryPrice;

    // LONG = buy the base asset; SHORT = sell the base asset
    const side = direction === 'LONG' ? 'buy' : 'sell';

    let exchangeOrderId: string | null = null;
    let contractSize: number | null = null;
    let orderContracts: number | null = null;
    let hedged = false;

    // Needed for priceToPrecision/amountToPrecision below regardless of
    // market type — previously only loaded for swap.
    try {
      await client.loadMarkets();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        executionId: null,
        exchangeOrderId: null,
        fillPrice: null,
        mode: 'live' as const,
        signalStatus: 'pending',
        message: `Failed to load ${exchange} markets: ${msg}`,
      };
    }

    if (effMarketType === 'swap') {
      // setLeverage/setMarginMode are real account mutations — only ever
      // called for live swap orders, never in paper mode.
      const market = client.markets[exchangeSymbol];
      if (!market) {
        return {
          success: false,
          executionId: null,
          exchangeOrderId: null,
          fillPrice: null,
          mode: 'live' as const,
          signalStatus: 'pending',
          message: `Swap market '${exchangeSymbol}' not found on ${exchange}. Signal left as pending.`,
        };
      }

      // CCXT's unified createOrder takes amount in CONTRACTS for markets with
      // a contractSize != 1 — it does not divide this for you.
      const resolvedContractSize =
        typeof market.contractSize === 'number' && market.contractSize > 0 ? market.contractSize : 1;
      contractSize = resolvedContractSize;
      orderContracts = amountUnits / resolvedContractSize;
      hedged = await resolveHedgeMode(client, exchangeSymbol);

      try {
        await client.setMarginMode(effMarginMode, exchangeSymbol);
      } catch (err) {
        if (!isAlreadySetError(err)) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            success: false,
            executionId: null,
            exchangeOrderId: null,
            fillPrice: null,
            mode: 'live' as const,
            signalStatus: 'pending',
            message: `Failed to set margin mode on ${exchange}: ${msg}`,
          };
        }
      }

      try {
        // BingX uniquely requires an explicit side ('LONG'/'SHORT') for setLeverage.
        const leverageParams = exchange === 'bingx' ? { side: direction === 'LONG' ? 'LONG' : 'SHORT' } : {};
        await client.setLeverage(effLeverage, exchangeSymbol, leverageParams);
      } catch (err) {
        if (!isAlreadySetError(err)) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            success: false,
            executionId: null,
            exchangeOrderId: null,
            fillPrice: null,
            mode: 'live' as const,
            signalStatus: 'pending',
            message: `Failed to set leverage on ${exchange}: ${msg}`,
          };
        }
      }
    }

    const orderAmount = orderContracts ?? amountUnits;
    const orderParams = effMarketType === 'swap' && hedged ? { hedged: true } : undefined;

    // A resting LIMIT order at entryPrice, not a market order — entryPrice is
    // frequently an SMC retest/order-block zone away from the current price
    // (see trading-agent.ts), and a market order would fill immediately at
    // whatever price the market happens to be, ignoring that target entirely.
    let order;
    try {
      const preciseAmount = Number(client.amountToPrecision(exchangeSymbol, orderAmount));
      const precisePrice = Number(client.priceToPrecision(exchangeSymbol, entryPrice));
      order = await client.createOrder(exchangeSymbol, 'limit', side, preciseAmount, precisePrice, orderParams);
      exchangeOrderId = order.id ?? null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[execute-trade-tool] CCXT createOrder failed for ${exchange}/${exchangeSymbol}:`, msg);
      return {
        success: false,
        executionId: null,
        exchangeOrderId: null,
        fillPrice: null,
        mode: 'live' as const,
        signalStatus: 'pending',
        message: `Order placement failed on ${exchange}: ${msg}`,
      };
    }

    const isFilled = order.status === 'closed' && (order.filled ?? 0) > 0;

    if (!isFilled) {
      // Order is resting on the exchange, not filled — reconcile-entries cron
      // polls it to completion (fill or expiry-driven cancel).
      await db
        .update(tradeSignals)
        .set({ status: 'approved', entryOrderId: exchangeOrderId, updatedAt: new Date() })
        .where(eq(tradeSignals.id, signalId));

      return {
        success: true,
        executionId: null,
        exchangeOrderId,
        fillPrice: null,
        mode: 'live' as const,
        signalStatus: 'approved',
        message: `Limit order placed on ${exchange} at $${entryPrice.toFixed(4)} (orderId=${exchangeOrderId}) — resting, awaiting fill.`,
      };
    }

    const result = await finalizeLiveFill({
      client,
      order,
      signalId,
      userId,
      exchange,
      symbol,
      direction,
      marketType: effMarketType,
      leverage: effLeverage,
      marginMode: effMarginMode,
      sl,
      tp,
      contractSize,
      hedged,
    });

    const protectiveWarning = !result.slOrderId
      ? ' WARNING: the protective stop-loss order failed to place — the software monitor is the only protection on this position until corrected.'
      : result.exitMode !== 'trailing' && !result.tpOrderId
        ? ' WARNING: the protective take-profit order failed to place — the software monitor is the only protection on this position until corrected.'
        : '';

    return {
      success: true,
      executionId: result.executionId,
      exchangeOrderId,
      fillPrice: result.fillPrice,
      mode: 'live' as const,
      signalStatus: 'executed',
      message: `Live order filled on ${exchange}: orderId=${exchangeOrderId}, fill=$${result.fillPrice.toFixed(4)}.${protectiveWarning}`,
    };
  },
});
