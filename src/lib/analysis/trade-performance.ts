/**
 * Trade performance recall — Phase 6.
 *
 * Pure retrieval/aggregation layer over the existing `trade_executions` +
 * `trade_signals` tables (the source of truth for outcomes; see CLAUDE.md).
 * No new outcome-store table is introduced here.
 *
 * This is deliberately NOT wired through Mastra's vector-based
 * `semanticRecall` — that primitive does similarity search over past *chat
 * messages* using embeddings, which is the wrong shape for "what's my win
 * rate at this R:R". The data here is fully structured and already lives in
 * Postgres, so a plain SQL aggregation is the correct (and much cheaper)
 * form of "recall" for this use case. See trade-performance-tool.ts and
 * src/app/api/chat/route.ts for how this gets surfaced to agents/users.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { tradeExecutions, tradeSignals, userRiskProfiles } from '@/db/schema';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RRBucketStat {
  /** Human-readable planned Risk:Reward range, e.g. "1.5–2.0". */
  label: string;
  minRR: number;
  maxRR: number;
  trades: number;
  wins: number;
  winRatePct: number;
  avgPlannedRR: number;
  /** Expectancy in R-multiples: (winRate * avgRR) - (1 - winRate). */
  expectancy: number;
}

export interface GroupStat {
  key: string;
  trades: number;
  wins: number;
  winRatePct: number;
}

export interface PerformanceSuggestion {
  type: 'raise_min_rr';
  message: string;
  currentMinRR: number;
  recommendedMinRR: number;
}

export interface TradePerformanceSummary {
  hasEnoughData: boolean;
  totalClosedTrades: number;
  overallWinRatePct: number;
  byRRBucket: RRBucketStat[];
  byStrategy: GroupStat[];
  bySymbol: GroupStat[];
  suggestion: PerformanceSuggestion | null;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** How many recent closed trades (per user) to pull for aggregation. */
const RECENT_TRADE_LIMIT = 200;
/** Minimum trades in a bucket/group before we trust its win rate for a suggestion. */
const MIN_SAMPLE_SIZE = 5;

const RR_BUCKETS: Array<{ label: string; minRR: number; maxRR: number }> = [
  { label: '< 1.5', minRR: 0, maxRR: 1.5 },
  { label: '1.5 – 2.0', minRR: 1.5, maxRR: 2.0 },
  { label: '2.0 – 3.0', minRR: 2.0, maxRR: 3.0 },
  { label: '3.0+', minRR: 3.0, maxRR: Infinity },
];

// ---------------------------------------------------------------------------
// Core aggregation
// ---------------------------------------------------------------------------

interface RawRow {
  realizedPnl: string | null;
  strategySource: string | null;
  symbol: string;
  entryPrice: string | null;
  stopLoss: string | null;
  takeProfit: string | null;
}

function computePlannedRR(row: RawRow): number | null {
  if (!row.entryPrice || !row.stopLoss || !row.takeProfit) return null;
  const entry = parseFloat(row.entryPrice);
  const sl = parseFloat(row.stopLoss);
  const tp = parseFloat(row.takeProfit);
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  if (!(risk > 0)) return null;
  return reward / risk;
}

function bucketFor(rr: number) {
  return RR_BUCKETS.find((b) => rr >= b.minRR && rr < b.maxRR) ?? RR_BUCKETS[RR_BUCKETS.length - 1];
}

/**
 * Aggregate a user's closed-trade history into win-rate breakdowns by
 * planned R:R bucket, strategy source, and symbol, plus a simple actionable
 * suggestion (raise minRiskRewardRatio) when the data supports one.
 */
export async function getUserTradePerformance(userId: string): Promise<TradePerformanceSummary> {
  const [rows, profileRow] = await Promise.all([
    db
      .select({
        realizedPnl: tradeExecutions.realizedPnl,
        strategySource: tradeSignals.strategySource,
        symbol: tradeExecutions.symbol,
        entryPrice: tradeSignals.entryPrice,
        stopLoss: tradeSignals.stopLoss,
        takeProfit: tradeSignals.takeProfit,
      })
      .from(tradeExecutions)
      .leftJoin(tradeSignals, eq(tradeExecutions.signalId, tradeSignals.id))
      .where(and(eq(tradeExecutions.userId, userId), eq(tradeExecutions.status, 'closed')))
      .orderBy(sql`${tradeExecutions.exitAt} DESC NULLS LAST`)
      .limit(RECENT_TRADE_LIMIT) as Promise<RawRow[]>,
    db
      .select({ minRiskRewardRatio: userRiskProfiles.minRiskRewardRatio })
      .from(userRiskProfiles)
      .where(eq(userRiskProfiles.userId, userId))
      .limit(1)
      .then((r) => r[0]),
  ]);

  const profileMinRR = profileRow?.minRiskRewardRatio ? parseFloat(profileRow.minRiskRewardRatio) : 1.5;

  const totalClosedTrades = rows.length;
  const totalWins = rows.filter((r) => r.realizedPnl != null && parseFloat(r.realizedPnl) > 0).length;
  const overallWinRatePct = totalClosedTrades > 0 ? (totalWins / totalClosedTrades) * 100 : 0;

  // --- By R:R bucket ---
  const bucketAccum = new Map<string, { trades: number; wins: number; rrSum: number }>();
  for (const b of RR_BUCKETS) bucketAccum.set(b.label, { trades: 0, wins: 0, rrSum: 0 });

  for (const row of rows) {
    const rr = computePlannedRR(row);
    if (rr === null) continue;
    const bucket = bucketFor(rr);
    const acc = bucketAccum.get(bucket.label)!;
    acc.trades += 1;
    acc.rrSum += rr;
    if (row.realizedPnl != null && parseFloat(row.realizedPnl) > 0) acc.wins += 1;
  }

  const byRRBucket: RRBucketStat[] = RR_BUCKETS.map((b) => {
    const acc = bucketAccum.get(b.label)!;
    const winRatePct = acc.trades > 0 ? (acc.wins / acc.trades) * 100 : 0;
    const avgPlannedRR = acc.trades > 0 ? acc.rrSum / acc.trades : (b.minRR + Math.min(b.maxRR, b.minRR + 1)) / 2;
    const winRateFrac = winRatePct / 100;
    const expectancy = acc.trades > 0 ? winRateFrac * avgPlannedRR - (1 - winRateFrac) : 0;
    return {
      label: b.label,
      minRR: b.minRR,
      maxRR: b.maxRR,
      trades: acc.trades,
      wins: acc.wins,
      winRatePct: Math.round(winRatePct * 10) / 10,
      avgPlannedRR: Math.round(avgPlannedRR * 100) / 100,
      expectancy: Math.round(expectancy * 100) / 100,
    };
  });

  // --- By strategy source / by symbol ---
  const byStrategy = groupWinRate(rows, (r) => r.strategySource ?? 'unspecified');
  const bySymbol = groupWinRate(rows, (r) => r.symbol ?? 'unknown');

  // --- Suggestion: should the user raise minRiskRewardRatio? ---
  const suggestion = buildSuggestion(byRRBucket, profileMinRR);

  return {
    hasEnoughData: totalClosedTrades >= MIN_SAMPLE_SIZE,
    totalClosedTrades,
    overallWinRatePct: Math.round(overallWinRatePct * 10) / 10,
    byRRBucket,
    byStrategy,
    bySymbol,
    suggestion,
  };
}

function groupWinRate(rows: RawRow[], keyFn: (row: RawRow) => string): GroupStat[] {
  const accum = new Map<string, { trades: number; wins: number }>();
  for (const row of rows) {
    const key = keyFn(row);
    const acc = accum.get(key) ?? { trades: 0, wins: 0 };
    acc.trades += 1;
    if (row.realizedPnl != null && parseFloat(row.realizedPnl) > 0) acc.wins += 1;
    accum.set(key, acc);
  }
  return Array.from(accum.entries())
    .map(([key, acc]) => ({
      key,
      trades: acc.trades,
      wins: acc.wins,
      winRatePct: acc.trades > 0 ? Math.round((acc.wins / acc.trades) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.trades - a.trades);
}

/**
 * Compare expectancy across R:R buckets against the user's *actual* current
 * minRiskRewardRatio (from user_risk_profiles), not just whichever bucket
 * happens to have the most data. minRiskRewardRatio is a floor — trades
 * planned right around that floor are "current behavior" under the user's
 * setting today. Only suggests raising the threshold when:
 *   - the bucket containing profileMinRR is losing money in expectancy terms
 *     (with enough samples), and
 *   - some strictly higher bucket (minRR > profileMinRR) is breakeven-or-
 *     better (also with enough samples).
 * This guarantees recommendedMinRR is always > the value the user already has.
 */
function buildSuggestion(buckets: RRBucketStat[], profileMinRR: number): PerformanceSuggestion | null {
  const current =
    buckets.find((b) => profileMinRR >= b.minRR && profileMinRR < b.maxRR) ??
    buckets[buckets.length - 1]!;
  if (current.trades < MIN_SAMPLE_SIZE) return null;
  if (current.expectancy >= 0) return null; // already profitable at the current threshold

  const better = buckets.find(
    (b) => b.minRR > current.minRR && b.trades >= MIN_SAMPLE_SIZE && b.expectancy >= 0,
  );
  if (!better || better.minRR <= profileMinRR) return null;

  return {
    type: 'raise_min_rr',
    currentMinRR: profileMinRR,
    recommendedMinRR: better.minRR,
    message:
      `Your ${current.trades} most recent trades planned around your current ${profileMinRR} minimum R:R had a ` +
      `${current.winRatePct}% win rate (expectancy ${current.expectancy >= 0 ? '+' : ''}${current.expectancy}R), ` +
      `while ${better.trades} trades planned at ${better.label} R:R had a ${better.winRatePct}% win rate ` +
      `(expectancy ${better.expectancy >= 0 ? '+' : ''}${better.expectancy}R). ` +
      `Consider raising your minimum Risk:Reward ratio to ${better.minRR}.`,
  };
}
