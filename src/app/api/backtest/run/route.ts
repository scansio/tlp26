/**
 * POST /api/backtest/run
 *
 * Accepts a BacktestInput JSON body and runs the backtester.
 * Streams progress back to the client as Server-Sent Events (SSE).
 *
 * SSE event format:
 *   data: {"type":"progress","percentComplete":42}
 *   data: {"type":"result","data":{...BacktestResult}}
 *   data: {"type":"error","message":"..."}
 *
 * The result is also persisted to backtest_runs by runBacktest internally.
 */

import { auth } from '@clerk/nextjs/server';
import { runBacktest, type BacktestInput, type StrategyName } from '@/lib/backtester';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes max for long backtests

export async function POST(req: Request): Promise<Response> {
  const { userId } = await auth();
  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }

  let body: Partial<BacktestInput & { exchange?: string; initialBalance?: number; strategies?: string[] }>;
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON body', { status: 400 });
  }

  const { symbol, timeframe, startDate, endDate, exchange, initialBalance, strategies } = body;

  if (!symbol || !timeframe || !startDate || !endDate) {
    return new Response('Missing required fields: symbol, timeframe, startDate, endDate', {
      status: 400,
    });
  }

  const VALID_STRATEGIES: StrategyName[] = ['SMC', 'Technical Indicators', 'Chart Patterns', 'Trend Following'];
  const parsedStrategies: StrategyName[] | undefined =
    Array.isArray(strategies) && strategies.length > 0
      ? (strategies.filter((s) => VALID_STRATEGIES.includes(s as StrategyName)) as StrategyName[])
      : undefined;

  const input: BacktestInput = {
    userId,
    symbol: String(symbol),
    timeframe: String(timeframe),
    startDate: new Date(String(startDate)),
    endDate: new Date(String(endDate)),
    exchange: exchange ? String(exchange) : undefined,
    initialBalance: initialBalance ? Number(initialBalance) : undefined,
    strategies: parsedStrategies,
  };

  // SSE stream
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        send({ type: 'progress', percentComplete: 0 });

        const result = await runBacktest(input, (pct) => {
          send({ type: 'progress', percentComplete: pct });
        });

        send({ type: 'result', data: result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send({ type: 'error', message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
