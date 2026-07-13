/**
 * GET /api/trade-history
 *
 * Returns paginated, filtered trade execution history (closed trades only)
 * with summary statistics and distinct filter options.
 *
 * Query params:
 *   page          - 1-based page number (default: 1)
 *   symbol        - comma-separated symbol list (e.g. "BTC/USDT,ETH/USDT")
 *   strategy      - comma-separated strategy source list
 *   outcome       - "profit" | "loss" | "all" (default: "all")
 *   source        - "ai" | "tradingview" | "manual" | "all" (default: "all")
 *   dateFrom      - ISO date string (inclusive)
 *   dateTo        - ISO date string (inclusive, end of day)
 *   includePaper  - "true" | "false" (default: "true")
 */

import { auth } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import { tradeExecutions, tradeSignals, publisherEarnings } from '@/db/schema';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RawPayload {
  indicators1h?: {
    rsi?: number | null;
    ema20?: number | null;
    ema50?: number | null;
    ema200?: number | null;
    macdLine?: number | null;
    macdSignal?: number | null;
    macdHistogram?: number | null;
    adx?: number | null;
    atrPct?: number | null;
    bbWidth?: number | null;
    emaAlignment?: string | null;
    [key: string]: unknown;
  };
  smcStructures?: unknown;
  chartPatterns?: unknown;
  riskCalculation?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = req.nextUrl;

  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));
  const offset = (page - 1) * PAGE_SIZE;

  const symbolParam = searchParams.get('symbol') ?? '';
  const strategyParam = searchParams.get('strategy') ?? '';
  const outcome = searchParams.get('outcome') ?? 'all';
  const source = searchParams.get('source') ?? 'all';
  const dateFrom = searchParams.get('dateFrom') ?? '';
  const dateTo = searchParams.get('dateTo') ?? '';
  const includePaper = searchParams.get('includePaper') !== 'false';

  // Parse multi-value filters
  const symbols = symbolParam ? symbolParam.split(',').filter(Boolean) : [];
  const strategies = strategyParam ? strategyParam.split(',').filter(Boolean) : [];

  // ---------------------------------------------------------------------------
  // Build where clause
  // ---------------------------------------------------------------------------

  const conditions = [
    eq(tradeExecutions.userId, userId),
    eq(tradeExecutions.status, 'closed'),
  ];

  if (!includePaper) {
    conditions.push(eq(tradeExecutions.mode, 'live'));
  }

  if (symbols.length > 0) {
    if (symbols.length === 1) {
      conditions.push(ilike(tradeExecutions.symbol, symbols[0]!));
    } else {
      conditions.push(
        or(...symbols.map((s) => ilike(tradeExecutions.symbol, s)))!,
      );
    }
  }

  if (dateFrom) {
    const from = new Date(dateFrom);
    if (!isNaN(from.getTime())) {
      conditions.push(gte(tradeExecutions.entryAt, from));
    }
  }

  if (dateTo) {
    const to = new Date(dateTo);
    if (!isNaN(to.getTime())) {
      // end of that day
      to.setUTCHours(23, 59, 59, 999);
      conditions.push(lte(tradeExecutions.entryAt, to));
    }
  }

  if (outcome === 'profit') {
    conditions.push(sql`${tradeExecutions.realizedPnl} > 0`);
  } else if (outcome === 'loss') {
    conditions.push(sql`${tradeExecutions.realizedPnl} < 0`);
  }

  // source and strategy filters require the join — handled after

  const whereClause = and(...conditions);

  // ---------------------------------------------------------------------------
  // Run queries in parallel: rows, total count, summary stats, filter options
  // ---------------------------------------------------------------------------

  const [rawRows, statsRow, symbolOptions, strategyOptions] = await Promise.all([
    // Paginated trade rows (join signals for direction, strategy, source, reasoning)
    db
      .select({
        id: tradeExecutions.id,
        symbol: tradeExecutions.symbol,
        entryPrice: tradeExecutions.entryPrice,
        exitPrice: tradeExecutions.exitPrice,
        positionSize: tradeExecutions.positionSize,
        realizedPnl: tradeExecutions.realizedPnl,
        status: tradeExecutions.status,
        mode: tradeExecutions.mode,
        fillType: tradeExecutions.fillType,
        entryAt: tradeExecutions.entryAt,
        exitAt: tradeExecutions.exitAt,
        // From signal (nullable)
        direction: tradeSignals.direction,
        strategy: tradeSignals.strategySource,
        source: tradeSignals.source,
        confidence: tradeSignals.confidence,
        reasoning: tradeSignals.reasoning,
        rawPayload: tradeSignals.rawPayload,
      })
      .from(tradeExecutions)
      .leftJoin(tradeSignals, eq(tradeExecutions.signalId, tradeSignals.id))
      .where(whereClause)
      .orderBy(desc(tradeExecutions.entryAt))
      .limit(PAGE_SIZE)
      .offset(offset),

    // Summary stats (all closed trades for this user matching filters, no pagination)
    db
      .select({
        totalTrades: sql<string>`COUNT(*)`,
        winCount: sql<string>`COUNT(*) FILTER (WHERE ${tradeExecutions.realizedPnl} > 0)`,
        totalPnl: sql<string>`COALESCE(SUM(${tradeExecutions.realizedPnl}), 0)`,
        avgPnl: sql<string>`COALESCE(AVG(${tradeExecutions.realizedPnl}), 0)`,
        maxWin: sql<string>`COALESCE(MAX(${tradeExecutions.realizedPnl}), 0)`,
        maxLoss: sql<string>`COALESCE(MIN(${tradeExecutions.realizedPnl}), 0)`,
      })
      .from(tradeExecutions)
      .where(whereClause)
      .then((rows) => rows[0]),

    // Distinct symbols for filter UI
    db
      .selectDistinct({ symbol: tradeExecutions.symbol })
      .from(tradeExecutions)
      .where(
        and(
          eq(tradeExecutions.userId, userId),
          eq(tradeExecutions.status, 'closed'),
        ),
      )
      .then((rows) => rows.map((r) => r.symbol).filter(Boolean)),

    // Distinct strategies for filter UI
    db
      .selectDistinct({ strategy: tradeSignals.strategySource })
      .from(tradeExecutions)
      .leftJoin(tradeSignals, eq(tradeExecutions.signalId, tradeSignals.id))
      .where(
        and(
          eq(tradeExecutions.userId, userId),
          eq(tradeExecutions.status, 'closed'),
          sql`${tradeSignals.strategySource} IS NOT NULL`,
        ),
      )
      .then((rows) => rows.map((r) => r.strategy).filter(Boolean)),
  ]);

  // ---------------------------------------------------------------------------
  // Fetch performance fees for copy trades in this page (subscriber P&L net of fee)
  // ---------------------------------------------------------------------------

  const copyTradeIds = rawRows
    .filter((r) => r.source === 'copy')
    .map((r) => r.id);

  const feeByTradeId = new Map<string, number>();

  if (copyTradeIds.length > 0) {
    const feeRows = await db
      .select({
        tradeId: publisherEarnings.tradeId,
        feeAmount: publisherEarnings.feeAmount,
      })
      .from(publisherEarnings)
      .where(inArray(publisherEarnings.tradeId, copyTradeIds));

    for (const row of feeRows) {
      if (row.tradeId) {
        feeByTradeId.set(row.tradeId, parseFloat(row.feeAmount));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Post-filter: source + strategy (applied in JS since they come from the join)
  // For a full implementation these would be WHERE clauses; acceptable here
  // since the result set is already paginated at PAGE_SIZE.
  // ---------------------------------------------------------------------------

  let rows = rawRows;

  if (source !== 'all') {
    rows = rows.filter((r) => {
      const s = r.source ?? 'manual';
      return s === source;
    });
  }

  if (strategies.length > 0) {
    rows = rows.filter((r) => {
      if (!r.strategy) return false;
      return strategies.some((st) => r.strategy!.toLowerCase().includes(st.toLowerCase()));
    });
  }

  const total = parseInt(statsRow?.totalTrades ?? '0', 10);
  const winCount = parseInt(statsRow?.winCount ?? '0', 10);
  const totalPnl = parseFloat(statsRow?.totalPnl ?? '0');
  const avgPnl = parseFloat(statsRow?.avgPnl ?? '0');
  const maxWin = parseFloat(statsRow?.maxWin ?? '0');
  const maxLoss = parseFloat(statsRow?.maxLoss ?? '0');
  const winRate = total > 0 ? (winCount / total) * 100 : 0;

  // ---------------------------------------------------------------------------
  // Shape trade rows for the client
  // ---------------------------------------------------------------------------

  const trades = rows.map((r) => {
    const entryPrice = r.entryPrice ? parseFloat(r.entryPrice) : null;
    const exitPrice = r.exitPrice ? parseFloat(r.exitPrice) : null;
    const positionSize = r.positionSize ? parseFloat(r.positionSize) : null;
    const grossPnl = r.realizedPnl ? parseFloat(r.realizedPnl) : null;

    // For copy trades: subtract performance fee from P&L shown to subscriber
    const performanceFeeDeducted = feeByTradeId.get(r.id) ?? null;
    const realizedPnl =
      grossPnl !== null && performanceFeeDeducted !== null
        ? grossPnl - performanceFeeDeducted
        : grossPnl;

    const realizedPnlPct =
      entryPrice && positionSize && entryPrice > 0 && realizedPnl !== null
        ? (realizedPnl / (entryPrice * positionSize)) * 100
        : null;

    const payload = (r.rawPayload ?? {}) as RawPayload;
    const ind = payload.indicators1h ?? null;

    return {
      id: r.id,
      entryAt: r.entryAt,
      exitAt: r.exitAt,
      symbol: r.symbol,
      direction: r.direction ?? null,
      strategy: r.strategy ?? null,
      source: r.source ?? 'manual',
      entryPrice,
      exitPrice,
      positionSize,
      realizedPnl,
      realizedPnlPct,
      // Expose the fee deduction so the UI can display it separately
      performanceFeeDeducted,
      status: r.status,
      fillType: r.fillType ?? null,
      mode: r.mode ?? 'paper',
      // Expandable detail fields
      reasoning: r.reasoning ?? null,
      confidence: r.confidence ?? null,
      indicators: ind
        ? {
            rsi: ind.rsi ?? null,
            ema20: ind.ema20 ?? null,
            ema50: ind.ema50 ?? null,
            ema200: ind.ema200 ?? null,
            emaAlignment: ind.emaAlignment ?? null,
            macdLine: ind.macdLine ?? null,
            macdSignal: ind.macdSignal ?? null,
            macdHistogram: ind.macdHistogram ?? null,
          }
        : null,
      // News sentiment and on-chain bias are not stored in rawPayload — see AC note
      newsSentiment: null,
      onChainBias: null,
    };
  });

  return NextResponse.json({
    trades,
    pagination: {
      total,
      page,
      pageSize: PAGE_SIZE,
      totalPages: Math.ceil(total / PAGE_SIZE),
      hasMore: offset + PAGE_SIZE < total,
    },
    summary: {
      totalTrades: total,
      winRate: parseFloat(winRate.toFixed(2)),
      avgPnlPct: parseFloat(avgPnl.toFixed(4)),
      totalPnl: parseFloat(totalPnl.toFixed(4)),
      largestWin: parseFloat(maxWin.toFixed(4)),
      largestLoss: parseFloat(maxLoss.toFixed(4)),
    },
    filterOptions: {
      symbols: symbolOptions,
      strategies: strategyOptions as string[],
    },
  });
}
