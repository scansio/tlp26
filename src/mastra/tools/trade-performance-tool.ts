import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getUserTradePerformance } from '@/lib/analysis/trade-performance';

// ---------------------------------------------------------------------------
// Trade Performance Tool — Phase 6
//
// Lets the chat agent pull the user's own closed-trade history on demand
// (e.g. "how's my win rate on ETH", "am I doing better with SMC or trend
// following"), beyond the summary already injected into system context by
// buildPerformanceContext() in src/app/api/chat/route.ts.
// ---------------------------------------------------------------------------
export const tradePerformanceTool = createTool({
  id: 'trade-performance-tool',
  description:
    "Look up the user's own historical trade performance (win rate) broken down by planned " +
    'Risk:Reward bucket, strategy source, and symbol, computed from their closed trade_executions. ' +
    'Use this when the user asks about their track record, win rate, or whether they should adjust ' +
    'their risk settings (e.g. minRiskRewardRatio). Requires userId from system context.',
  inputSchema: z.object({
    userId: z.string().describe('Clerk user ID — read from the system context message, do not invent'),
  }),
  outputSchema: z.object({
    hasEnoughData: z.boolean(),
    totalClosedTrades: z.number(),
    overallWinRatePct: z.number(),
    byRRBucket: z.array(
      z.object({
        label: z.string(),
        trades: z.number(),
        wins: z.number(),
        winRatePct: z.number(),
        avgPlannedRR: z.number(),
        expectancy: z.number(),
      }),
    ),
    byStrategy: z.array(
      z.object({ key: z.string(), trades: z.number(), wins: z.number(), winRatePct: z.number() }),
    ),
    bySymbol: z.array(
      z.object({ key: z.string(), trades: z.number(), wins: z.number(), winRatePct: z.number() }),
    ),
    suggestion: z
      .object({
        type: z.literal('raise_min_rr'),
        message: z.string(),
        currentMinRR: z.number(),
        recommendedMinRR: z.number(),
      })
      .nullable(),
  }),
  execute: async (inputData) => {
    const summary = await getUserTradePerformance(inputData.userId);
    return {
      hasEnoughData: summary.hasEnoughData,
      totalClosedTrades: summary.totalClosedTrades,
      overallWinRatePct: summary.overallWinRatePct,
      byRRBucket: summary.byRRBucket.map(({ label, trades, wins, winRatePct, avgPlannedRR, expectancy }) => ({
        label,
        trades,
        wins,
        winRatePct,
        avgPlannedRR,
        expectancy,
      })),
      byStrategy: summary.byStrategy,
      bySymbol: summary.bySymbol,
      suggestion: summary.suggestion,
    };
  },
});
