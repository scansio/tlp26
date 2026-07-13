import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { db } from '@/db';

// ---------------------------------------------------------------------------
// GET /api/copy/leaderboard — publicly accessible, no auth required
//
// Returns signal publishers ranked by Sharpe ratio (primary) + win rate
// (secondary) computed over the last 90 days (rolling window).
//
// Eligibility: >= 20 closed trades AND first trade >= 30 days ago.
// ---------------------------------------------------------------------------

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  // Filter/sort query params
  const timeframeFocus = searchParams.get('timeframeFocus'); // scalp | swing | position
  const strategyType   = searchParams.get('strategyType');   // SMC | technical | pattern
  const maxDrawdownMax = searchParams.get('maxDrawdownMax'); // e.g. "20" means max drawdown <= 20%
  const sortBy         = searchParams.get('sortBy') ?? 'sharpe'; // sharpe | winRate | totalReturn | subscribers

  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - 90);
  const windowStartISO = windowStart.toISOString();

  // Build dynamic WHERE clauses for publisher-level filters
  const publisherFilters: string[] = [`sp.is_public = true`];
  if (timeframeFocus) {
    publisherFilters.push(`sp.timeframe_focus = '${timeframeFocus.replace(/'/g, "''")}'`);
  }
  if (strategyType) {
    publisherFilters.push(`sp.strategy_type = '${strategyType.replace(/'/g, "''")}'`);
  }
  if (maxDrawdownMax) {
    const val = parseFloat(maxDrawdownMax);
    if (!isNaN(val)) {
      publisherFilters.push(`(sp.max_drawdown IS NULL OR sp.max_drawdown <= ${val})`);
    }
  }

  const whereClause = publisherFilters.join(' AND ');

  // Determine ORDER BY
  const sortMap: Record<string, string> = {
    sharpe:      'sharpe_90d DESC NULLS LAST, win_rate_90d DESC NULLS LAST',
    winRate:     'win_rate_90d DESC NULLS LAST, sharpe_90d DESC NULLS LAST',
    totalReturn: 'total_return_90d DESC NULLS LAST, sharpe_90d DESC NULLS LAST',
    subscribers: 'sp.subscriber_count DESC, sharpe_90d DESC NULLS LAST',
  };
  const orderClause = sortMap[sortBy] ?? sortMap['sharpe'];

  // Raw SQL query: compute 90-day rolling stats per publisher from trade_executions
  // Sharpe = avg(return) / stddev(return) * sqrt(N) — simplified signal-level Sharpe
  // Max drawdown comes from stored column (updated by publisher profile flow TLP-31).
  const query = sql.raw(`
    WITH exec_stats AS (
      SELECT
        ts.publisher_id,
        COUNT(*)                                                        AS trade_count,
        MIN(te.entry_at)                                                AS first_trade_at,
        SUM(CASE WHEN te.realized_pnl > 0 THEN 1 ELSE 0 END)::float
          / NULLIF(COUNT(*), 0) * 100                                   AS win_rate_90d,
        AVG(te.realized_pnl::numeric)                                   AS avg_pnl,
        STDDEV(te.realized_pnl::numeric)                                AS stddev_pnl,
        SUM(te.realized_pnl::numeric)                                   AS total_return_90d,
        AVG(
          CASE
            WHEN ts.stop_loss IS NOT NULL AND ts.entry_price IS NOT NULL
              AND ts.stop_loss != ts.entry_price
            THEN ABS(
              (ts.take_profit::numeric - ts.entry_price::numeric)
              / NULLIF(ABS(ts.entry_price::numeric - ts.stop_loss::numeric), 0)
            )
            ELSE NULL
          END
        )                                                               AS avg_rr_90d,
        COUNT(ts.id)                                                    AS signals_90d
      FROM trade_executions te
      JOIN trade_signals ts ON ts.id = te.signal_id
      WHERE te.status = 'closed'
        AND te.entry_at >= '${windowStartISO}'
        AND ts.publisher_id IS NOT NULL
      GROUP BY ts.publisher_id
      HAVING COUNT(*) >= 20
        AND MIN(te.entry_at) <= NOW() - INTERVAL '30 days'
    ),
    ranked AS (
      SELECT
        sp.id,
        sp.display_name,
        sp.strategy_description,
        sp.timeframe_focus,
        sp.strategy_type,
        sp.max_drawdown,
        sp.subscriber_count,
        sp.fee_percent,
        es.win_rate_90d,
        es.avg_rr_90d,
        es.signals_90d,
        es.total_return_90d,
        CASE
          WHEN es.stddev_pnl IS NOT NULL AND es.stddev_pnl > 0
          THEN (es.avg_pnl / es.stddev_pnl) * SQRT(es.trade_count)
          ELSE NULL
        END AS sharpe_90d
      FROM signal_publishers sp
      JOIN exec_stats es ON es.publisher_id = sp.id
      WHERE ${whereClause}
    )
    SELECT
      ROW_NUMBER() OVER (ORDER BY ${orderClause}) AS rank,
      id,
      display_name,
      strategy_description,
      timeframe_focus,
      strategy_type,
      max_drawdown,
      subscriber_count,
      fee_percent,
      win_rate_90d,
      avg_rr_90d,
      signals_90d,
      total_return_90d,
      sharpe_90d
    FROM ranked
    ORDER BY ${orderClause}
    LIMIT 100
  `);

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (db as any).execute(query);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = result.rows ?? result;

    const publishers = rows.map((row) => ({
      rank:                Number(row.rank),
      id:                  row.id as string,
      displayName:         row.display_name as string | null,
      strategyDescription: row.strategy_description as string | null,
      timeframeFocus:      row.timeframe_focus as string | null,
      strategyType:        row.strategy_type as string | null,
      maxDrawdown:         row.max_drawdown != null ? Number(row.max_drawdown) : null,
      subscriberCount:     Number(row.subscriber_count ?? 0),
      feePercent:          Number(row.fee_percent ?? 0),
      winRate:             row.win_rate_90d != null ? Number(row.win_rate_90d) : null,
      avgRR:               row.avg_rr_90d  != null ? Number(row.avg_rr_90d)   : null,
      totalSignals90d:     Number(row.signals_90d ?? 0),
      totalReturn90d:      row.total_return_90d != null ? Number(row.total_return_90d) : null,
      sharpeRatio:         row.sharpe_90d  != null ? Number(row.sharpe_90d)    : null,
    }));

    return NextResponse.json({
      publishers,
      windowDays: 90,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[/api/copy/leaderboard] query error:', err);
    return NextResponse.json({ error: 'Failed to load leaderboard' }, { status: 500 });
  }
}
