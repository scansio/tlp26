import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { userRiskProfiles, tradeSignals } from '@/db/schema';
import { tvWebhookSchema, normaliseSymbol, actionToDirection } from '@/lib/tradingview';
import { checkCircuitBreaker } from '@/lib/circuit-breaker';
import { propagatePublisherSignal } from '@/lib/copy-mirror-engine';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  // Parse JSON body
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Validate payload
  const parsed = tvWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: 'Malformed payload', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { token, symbol, action, price, sl, tp } = parsed.data;

  // Look up user by webhook token (constant-time-ish: DB lookup, not in-memory compare)
  const profiles = await db
    .select()
    .from(userRiskProfiles)
    .where(eq(userRiskProfiles.webhookToken, token))
    .limit(1);

  if (profiles.length === 0) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const profile = profiles[0];
  const userId = profile.userId;
  const normalisedSymbol = normaliseSymbol(symbol);
  const direction = actionToDirection(action);

  // --- Circuit breaker check ---
  const cbResult = await checkCircuitBreaker(userId, {
    signalSymbol: normalisedSymbol,
    signalDirection: direction,
  });
  if (!cbResult.allowed) {
    return Response.json(
      { error: 'Trade blocked by circuit breaker', reason: cbResult.reason, state: cbResult.state },
      { status: 403 },
    );
  }

  // tradingMode ('auto' | 'manual') controls whether the AI pipeline runs
  // autonomously; executionMode ('paper' | 'live') only selects the venue —
  // it must never be used to gate auto-execution (see trade-analysis-workflow).
  const tradingMode = profile.tradingMode ?? 'manual';

  // Auto mode: let trade-analysis-workflow produce the AI-derived signal
  // (entry/SL/TP from real analysis) instead of the raw TradingView values,
  // so we don't end up with two trade_signals rows for one alert.
  if (tradingMode === 'auto') {
    try {
      const { mastra } = await import('@/mastra');
      const workflow = mastra.getWorkflow('tradeAnalysisWorkflow');
      if (workflow) {
        const run = await workflow.createRun();
        run
          .start({
            inputData: { userId, symbol: normalisedSymbol, triggeredBy: 'tradingview', exchange: 'binance' },
          })
          .catch((err: unknown) => {
            console.error('[tradingview-webhook] workflow run error:', err);
          });

        return Response.json(
          { ok: true, signalId: null, message: 'Auto mode: analysis in progress' },
          { status: 202 },
        );
      }
      console.warn(
        '[tradingview-webhook] tradeAnalysisWorkflow not registered — falling back to raw signal',
      );
    } catch (err) {
      console.warn('[tradingview-webhook] failed to start workflow, falling back to raw signal:', err);
    }
  }

  // Manual mode (or auto-mode workflow start failure): save the raw
  // TradingView values for manual review/approval.
  const [signal] = await db
    .insert(tradeSignals)
    .values({
      userId,
      symbol: normalisedSymbol,
      timeframe: '1h', // TV alerts don't include timeframe; default to 1h
      direction,
      entryPrice: price != null ? String(price) : null,
      stopLoss: String(sl),
      takeProfit: String(tp),
      source: 'tradingview',
      status: 'pending',
      rawPayload: body as Record<string, unknown>,
    })
    .returning();

  // Fire-and-forget: propagate to copy-trading subscribers asynchronously
  void propagatePublisherSignal(signal.id, userId);

  return Response.json({ ok: true, signalId: signal.id }, { status: 201 });
}
