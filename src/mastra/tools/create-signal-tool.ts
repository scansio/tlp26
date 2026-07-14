import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { db } from '@/db';
import { tradeSignals } from '@/db/schema';

export const createSignalTool = createTool({
  id: 'create-signal-tool',
  description:
    'Save an AI-generated trade signal to the database so the user can review and execute it. ' +
    'Call this when analysis produces a clear ENTER_LONG or ENTER_SHORT recommendation. ' +
    'Do NOT call for HOLD decisions. Requires userId from system context.',
  inputSchema: z.object({
    userId: z.string().describe('Clerk user ID — read from the system context message, do not invent'),
    symbol: z.string().describe('Trading pair, e.g. BTC/USDT'),
    timeframe: z.string().describe('Chart timeframe, e.g. 1h'),
    direction: z.enum(['LONG', 'SHORT']),
    entryPrice: z.number().positive().describe('Recommended entry price from market-data-tool output'),
    sl: z.number().positive().optional().describe('Stop-loss price from tool data'),
    tp: z.number().positive().optional().describe('Take-profit price from tool data'),
    confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    reasoning: z.string().describe('Plain-English rationale citing specific tool output numbers'),
    strategySource: z.string().optional().describe('Primary signal source, e.g. SMC BOS, RSI divergence'),
    exchange: z.string().optional().describe('Exchange name, e.g. binance'),
  }),
  outputSchema: z.object({
    signalId: z.string(),
    symbol: z.string(),
    direction: z.string(),
    entryPrice: z.number().nullable(),
    sl: z.number().nullable(),
    tp: z.number().nullable(),
    confidence: z.string(),
    status: z.string(),
    message: z.string(),
  }),
  execute: async (inputData) => {
    const {
      userId,
      symbol,
      timeframe,
      direction,
      entryPrice,
      sl,
      tp,
      confidence,
      reasoning,
      strategySource,
      exchange,
    } = inputData as {
      userId: string;
      symbol: string;
      timeframe: string;
      direction: 'LONG' | 'SHORT';
      entryPrice: number;
      sl?: number;
      tp?: number;
      confidence: 'LOW' | 'MEDIUM' | 'HIGH';
      reasoning: string;
      strategySource?: string;
      exchange?: string;
    };

    const [signal] = await db
      .insert(tradeSignals)
      .values({
        userId,
        symbol,
        timeframe,
        direction,
        entryPrice: String(entryPrice),
        stopLoss: sl != null ? String(sl) : null,
        takeProfit: tp != null ? String(tp) : null,
        confidence,
        reasoning,
        strategySource: strategySource ?? null,
        source: 'ai',
        status: 'pending',
        rawPayload: { exchange: exchange ?? 'binance' },
        expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
      })
      .returning({
        id: tradeSignals.id,
        symbol: tradeSignals.symbol,
        direction: tradeSignals.direction,
        entryPrice: tradeSignals.entryPrice,
        stopLoss: tradeSignals.stopLoss,
        takeProfit: tradeSignals.takeProfit,
        confidence: tradeSignals.confidence,
        status: tradeSignals.status,
      });

    return {
      signalId: signal.id,
      symbol: signal.symbol,
      direction: signal.direction,
      entryPrice: signal.entryPrice ? Number(signal.entryPrice) : null,
      sl: signal.stopLoss ? Number(signal.stopLoss) : null,
      tp: signal.takeProfit ? Number(signal.takeProfit) : null,
      confidence: signal.confidence ?? 'MEDIUM',
      status: signal.status ?? 'pending',
      message: `Signal created: ${direction} ${symbol} at $${entryPrice.toFixed(2)}. Review and confirm below.`,
    };
  },
});
