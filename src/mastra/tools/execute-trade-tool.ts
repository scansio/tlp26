/**
 * execute-trade-tool
 *
 * Places a trade order on a CEX exchange via CCXT (live mode) or simulates a
 * paper fill (paper mode).
 *
 * Live mode:
 *  - Decrypts user exchange credentials from user_exchanges
 *  - Places a market buy/sell order via CCXT createOrder
 *  - Records the exchange order ID in trade_executions
 *  - Updates the trade signal status to 'executed'
 *
 * Paper mode:
 *  - Applies a configurable slippage to the signal entry price
 *  - Inserts a paper trade_execution record (no exchange API call)
 *  - Updates the trade signal status to 'executed'
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import ccxt, { type Exchange } from 'ccxt';
import { db } from '@/db';
import { tradeSignals, tradeExecutions, userExchanges } from '@/db/schema';
import { decrypt } from '@/lib/crypto';
import { and, eq } from 'drizzle-orm';
import { toExchangeSymbol, type MarketType } from './market-symbol';

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

/** Apply slippage to the simulated fill price. */
function applySlippage(price: number, direction: string, slippagePct: number): number {
  const factor = slippagePct / 100;
  return direction === 'LONG' ? price * (1 + factor) : price * (1 - factor);
}

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
    'In live mode the tool places a market order via CCXT and records the exchange order ID. ' +
    'In paper mode the tool simulates a fill with slippage and records a virtual execution.',

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
    // PAPER MODE — simulate fill, no exchange API call
    // -------------------------------------------------------------------------
    if (mode === 'paper') {
      const fillPrice = applySlippage(entryPrice, direction, slippagePct);

      // Compute position size in base asset units for record-keeping
      const positionSizeUnits = positionSizeUsdt / fillPrice;

      const [execution] = await db
        .insert(tradeExecutions)
        .values({
          signalId,
          userId,
          exchangeName: exchange,
          symbol,
          entryPrice: String(fillPrice),
          positionSize: String(positionSizeUnits),
          mode: 'paper',
          status: 'open',
          marketType: effMarketType,
          leverage: effLeverage,
          marginMode: effMarginMode,
          entryAt: new Date(),
        })
        .returning({ id: tradeExecutions.id });

      await db
        .update(tradeSignals)
        .set({ status: 'executed', updatedAt: new Date() })
        .where(eq(tradeSignals.id, signalId));

      return {
        success: true,
        executionId: execution.id,
        exchangeOrderId: null,
        fillPrice,
        mode: 'paper' as const,
        signalStatus: 'executed',
        message: `Paper trade opened at simulated fill price $${fillPrice.toFixed(4)} (slippage: ${slippagePct}%).`,
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
    let fillPrice: number | null = null;
    let contractSize: number | null = null;
    let orderContracts: number | null = null;

    if (effMarketType === 'swap') {
      // setLeverage/setMarginMode are real account mutations — only ever
      // called for live swap orders, never in paper mode.
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

    try {
      const order = await client.createOrder(exchangeSymbol, 'market', side, orderAmount);
      exchangeOrderId = order.id ?? null;
      // Use actual fill price if returned, otherwise fall back to entry price
      fillPrice = order.average ?? order.price ?? entryPrice;
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

    // Record execution in trade_executions
    const positionSizeUnits = positionSizeUsdt / (fillPrice ?? entryPrice);
    const [execution] = await db
      .insert(tradeExecutions)
      .values({
        signalId,
        userId,
        exchangeName: exchange,
        symbol,
        exchangeOrderId: exchangeOrderId ?? undefined,
        entryPrice: String(fillPrice ?? entryPrice),
        positionSize: String(positionSizeUnits),
        mode: 'live',
        status: 'open',
        marketType: effMarketType,
        leverage: effLeverage,
        marginMode: effMarginMode,
        contractSize: contractSize != null ? String(contractSize) : null,
        orderContracts: orderContracts != null ? String(orderContracts) : null,
        entryAt: new Date(),
      })
      .returning({ id: tradeExecutions.id });

    // Update signal status to executed
    await db
      .update(tradeSignals)
      .set({ status: 'executed', updatedAt: new Date() })
      .where(eq(tradeSignals.id, signalId));

    return {
      success: true,
      executionId: execution.id,
      exchangeOrderId,
      fillPrice: fillPrice ?? entryPrice,
      mode: 'live' as const,
      signalStatus: 'executed',
      message: `Live order placed on ${exchange}: orderId=${exchangeOrderId}, fill=$${(fillPrice ?? entryPrice).toFixed(4)}.`,
    };
  },
});
