import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { userRiskProfiles, userExchanges, tradeSignals } from '@/db/schema';
import { tvWebhookSchema, normaliseSymbol, actionToDirection } from '@/lib/tradingview';
import { checkCircuitBreaker } from '@/lib/circuit-breaker';
import { propagatePublisherSignal } from '@/lib/copy-mirror-engine';
import { deriveTradingContext } from '@/lib/user-trading-context';
import { resolveAccountBalance } from '@/lib/analysis/finalize-for-user';
import { riskTool } from '@/mastra/tools/risk-tool';
import { noopObserve } from '@mastra/core/tools';

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
  const { symbol: normalisedSymbol, marketType } = normaliseSymbol(symbol);
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
      const [exchangeRow] = await db
        .select({ exchangeName: userExchanges.exchangeName })
        .from(userExchanges)
        .where(and(eq(userExchanges.userId, userId), eq(userExchanges.status, 'active')))
        .limit(1);
      // The alert's ".P"/".PERP" ticker suffix is a stronger marketType signal
      // than the profile default (see comment below), so it overrides the
      // context's own marketType; exchange still comes from the shared resolver.
      const { exchange } = deriveTradingContext(profile, exchangeRow);

      const { mastra } = await import('@/mastra');
      const workflow = mastra.getWorkflow('tradeAnalysisWorkflow');
      if (workflow) {
        const run = await workflow.createRun();
        run
          .start({
            inputData: {
              userId,
              symbol: normalisedSymbol,
              triggeredBy: 'tradingview',
              exchange,
              marketType,
            },
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
  //
  // Risk sizing computed once here (best-effort — a failure leaves the
  // signal without a computed position size rather than blocking creation,
  // same fail-open pattern as every other signal-creation path) so Approve
  // later executes against this exact stored calculation, not a fresh
  // recompute — see risk_calculation column comment in src/db/schema.ts.
  let riskCalculation: Record<string, unknown> | null = null;
  if (price != null) {
    try {
      const [exchangeRow] = await db
        .select({ exchangeName: userExchanges.exchangeName })
        .from(userExchanges)
        .where(and(eq(userExchanges.userId, userId), eq(userExchanges.status, 'active')))
        .limit(1);
      const { exchange } = deriveTradingContext(profile, exchangeRow);
      const accountBalance = await resolveAccountBalance(
        userId,
        profile.executionMode ?? 'paper',
        profile.paperBalanceUsd,
        marketType,
      );
      if (accountBalance !== null) {
        riskCalculation = (await riskTool.execute!(
          {
            exchange,
            symbol: normalisedSymbol,
            marketType,
            accountBalance,
            riskPerTradePct: profile.riskPerTradePct ? Number(profile.riskPerTradePct) : 1,
            entryPrice: price,
            stopLossPrice: sl,
            takeProfitPrice: tp,
            direction,
            slippagePct: profile.slippagePct ? Number(profile.slippagePct) : 0.05,
          },
          { observe: noopObserve },
        )) as Record<string, unknown>;
      }
    } catch (err) {
      console.warn('[tradingview-webhook] riskTool failed, creating signal without a computed position size', err);
    }
  }

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
      // The ".P"/".PERP" ticker suffix is a stronger signal than the profile
      // default for this specific alert; leverage/margin still come from profile.
      marketType,
      leverage: (riskCalculation?.leverage as number | undefined) ?? profile.defaultLeverage ?? 1,
      marginMode: profile.marginMode ?? 'cross',
      source: 'tradingview',
      status: 'pending',
      rawPayload: body as Record<string, unknown>,
      riskCalculation: riskCalculation ?? undefined,
      riskCapitalUsdt:
        riskCalculation?.accountBalance != null ? String(riskCalculation.accountBalance) : null,
      riskCalculatedAt: riskCalculation ? new Date() : null,
    })
    .returning();

  // Fire-and-forget: propagate to copy-trading subscribers asynchronously
  void propagatePublisherSignal(signal.id, userId);

  return Response.json({ ok: true, signalId: signal.id }, { status: 201 });
}
