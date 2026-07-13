import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { userRiskProfiles, tradeSignals } from '@/db/schema';
import { tvWebhookSchema, normaliseSymbol, actionToDirection } from '@/lib/tradingview';
import { checkCircuitBreaker } from '@/lib/circuit-breaker';

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

  // Determine initial status based on execution mode
  const executionMode = profile.executionMode ?? 'manual';
  const signalStatus = executionMode === 'auto' ? 'pending' : 'pending';

  // Save signal to trade_signals
  const [signal] = await db
    .insert(tradeSignals)
    .values({
      userId,
      symbol: normalisedSymbol,
      timeframe: '1h', // TV alerts don't include timeframe; default to 1h
      direction,
      entryPrice: price != null ? String(price) : null,
      stopLoss: sl != null ? String(sl) : null,
      takeProfit: tp != null ? String(tp) : null,
      source: 'tradingview',
      status: signalStatus,
      rawPayload: body as Record<string, unknown>,
    })
    .returning();

  // If execution mode is auto, attempt to trigger trade-analysis-workflow.
  // The workflow is not yet registered — this block is defensive and fire-and-forget.
  if (executionMode === 'auto') {
    try {
      const { mastra } = await import('@/mastra');
      // Cast to any so this compiles even before tradeAnalysisWorkflow is wired in
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mastraAny = mastra as any;
      const workflow =
        typeof mastraAny.getWorkflow === 'function'
          ? mastraAny.getWorkflow('tradeAnalysisWorkflow')
          : undefined;

      if (workflow) {
        const run = await workflow.createRun();
        run
          .start({
            inputData: { symbol: normalisedSymbol, signalId: signal.id, userId },
          })
          .catch((err: unknown) => {
            console.error('[tradingview-webhook] workflow run error:', err);
          });
      } else {
        console.warn(
          '[tradingview-webhook] tradeAnalysisWorkflow not registered — signal queued for manual approval',
        );
      }
    } catch (err) {
      console.warn('[tradingview-webhook] failed to start workflow:', err);
    }
  }

  return Response.json({ ok: true, signalId: signal.id }, { status: 201 });
}
