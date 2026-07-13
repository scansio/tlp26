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
    sl: z.number().positive().optional().describe('Stop-loss price'),
    tp: z.number().positive().optional().describe('Take-profit price'),
    mode: z.enum(['paper', 'live']).describe('Execution mode'),
    slippagePct: z
      .number()
      .min(0)
      .max(5)
      .optional()
      .describe('Slippage % to apply to paper fills (default 0.05)'),
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
    } = inputData as {
      userId: string;
      signalId: string;
      exchange: 'binance' | 'bybit' | 'bingx';
      symbol: string;
      direction: 'LONG' | 'SHORT';
      entryPrice: number;
      positionSizeUsdt: number;
      sl?: number;
      tp?: number;
      mode: 'paper' | 'live';
      slippagePct?: number;
    };

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

    // Amount in base asset units (CCXT always takes base units)
    const amountUnits = positionSizeUsdt / entryPrice;

    // LONG = buy the base asset; SHORT = sell the base asset
    const side = direction === 'LONG' ? 'buy' : 'sell';

    let exchangeOrderId: string | null = null;
    let fillPrice: number | null = null;

    try {
      const order = await client.createOrder(symbol, 'market', side, amountUnits);
      exchangeOrderId = order.id ?? null;
      // Use actual fill price if returned, otherwise fall back to entry price
      fillPrice = order.average ?? order.price ?? entryPrice;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[execute-trade-tool] CCXT createOrder failed for ${exchange}/${symbol}:`, msg);
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
