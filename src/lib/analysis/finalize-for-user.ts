/**
 * Per-user risk sizing + signal creation + auto-execution.
 *
 * Extracted from trade-analysis-workflow steps 8 (calculateRisk) + 9
 * (routeSignal), consolidated into a single function so the worker can fan
 * this out cheaply to every user in a confluence group after the shared
 * market analysis (src/lib/analysis/market-analysis.ts) has run once.
 *
 * The market analysis always runs against one canonical reference exchange
 * (analysis.exchange), decoupled from each user's own connected execution
 * exchange — risk sizing and order placement here use `executionExchange`
 * (the user's own exchange), falling back to `analysis.exchange` for the
 * single-user webhook/manual path where there is no separate reference
 * exchange concept.
 */

import ccxt, { type Exchange } from 'ccxt';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { userExchanges, userRiskProfiles } from '@/db/schema';
import { decrypt } from '@/lib/crypto';
import { propagatePublisherSignal } from '@/lib/copy-mirror-engine';
import { createSignalTool } from '@/mastra/tools/create-signal-tool';
import { executeTradeTool } from '@/mastra/tools/execute-trade-tool';
import { noopObserve } from '@mastra/core/tools';
import type { MarketAnalysisResult } from './market-analysis';

export interface FinalizeForUserInput {
  userId: string;
  analysis: MarketAnalysisResult;
  /** Shared across every user in the same confluence group; null for the single-user path. */
  analysisRunId: string | null;
  /** The user's own exchange for risk-sizing/execution; defaults to analysis.exchange when omitted. */
  executionExchange?: 'binance' | 'bybit' | 'bingx';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mastra: any;
}

export interface FinalizeForUserResult {
  signalId: string | null;
  action: 'ENTER_LONG' | 'ENTER_SHORT' | 'HOLD';
  symbol: string;
  userId: string;
  executionMode: string;
  executionResult: {
    success: boolean;
    executionId: string | null;
    exchangeOrderId: string | null;
    fillPrice: number | null;
    mode: 'paper' | 'live';
    signalStatus: string;
    message: string;
  } | null;
}

// ---------------------------------------------------------------------------
// Live-balance resolution (mirrors the getExchangeClient pattern duplicated
// across src/app/api/dashboard/route.ts and src/app/api/positions/route.ts)
// ---------------------------------------------------------------------------

export async function getUserActiveExchangeClient(userId: string): Promise<Exchange | null> {
  const [row] = await db
    .select({
      exchangeName: userExchanges.exchangeName,
      encryptedApiKey: userExchanges.encryptedApiKey,
      encryptedApiSecret: userExchanges.encryptedApiSecret,
      encryptedPassphrase: userExchanges.encryptedPassphrase,
    })
    .from(userExchanges)
    .where(and(eq(userExchanges.userId, userId), eq(userExchanges.status, 'active')))
    .limit(1);

  if (!row) return null;

  try {
    const apiKey = decrypt(row.encryptedApiKey);
    const secret = decrypt(row.encryptedApiSecret);
    const password = row.encryptedPassphrase ? decrypt(row.encryptedPassphrase) : undefined;

    const ExchangeClass = (ccxt as unknown as Record<string, new (config: object) => Exchange>)[
      row.exchangeName
    ];
    if (!ExchangeClass) return null;

    return new ExchangeClass({ apiKey, secret, ...(password ? { password } : {}) });
  } catch {
    return null;
  }
}

export async function resolveAccountBalance(
  userId: string,
  executionMode: string,
  paperBalanceUsd: string | null,
): Promise<number> {
  const fallback = Number(paperBalanceUsd ?? '10000.00');

  if (executionMode !== 'live') {
    return fallback;
  }

  try {
    const client = await getUserActiveExchangeClient(userId);
    if (!client) {
      console.warn(
        `finalizeForUser: live mode but no active exchange connected for userId=${userId}, falling back to paper balance`,
      );
      return fallback;
    }

    const balance = await client.fetchBalance();
    const totals = balance?.total as unknown as Record<string, number> | undefined;
    const free = balance?.free as unknown as Record<string, number> | undefined;
    const usdt = totals?.USDT ?? free?.USDT;
    if (typeof usdt === 'number' && usdt > 0) return usdt;

    console.warn(
      `finalizeForUser: live balance fetch returned no USDT for userId=${userId}, falling back to paper balance`,
    );
    return fallback;
  } catch (err) {
    console.warn(`finalizeForUser: fetchBalance failed for userId=${userId}, falling back to paper balance`, err);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// finalizeForUser
// ---------------------------------------------------------------------------

export async function finalizeForUser(input: FinalizeForUserInput): Promise<FinalizeForUserResult> {
  const { userId, analysis, analysisRunId, mastra } = input;
  const { symbol, action, confidence, reasoning, strategiesTriggered } = analysis;

  if (action === 'HOLD') {
    return { signalId: null, action, symbol, userId, executionMode: 'n/a', executionResult: null };
  }

  const entryPrice = analysis.entryZone.low ?? analysis.entryZone.high;
  const direction = action === 'ENTER_LONG' ? 'LONG' : 'SHORT';

  // Enforce SL/TP/entryPrice requirement — never create a signal without all three.
  if (!analysis.sl || !analysis.tp || !entryPrice) {
    console.warn('finalizeForUser: agent returned non-HOLD action without entryPrice/SL/TP — aborting signal creation');
    return { signalId: null, action: 'HOLD', symbol, userId, executionMode: 'n/a', executionResult: null };
  }

  // Load the user's risk profile once (previously loaded twice — once for risk
  // sizing, once for routing — collapsed into a single query here).
  let riskPerTradePct = 1.0;
  let slippagePct = 0.05;
  let executionMode = 'paper'; // 'paper' | 'live'
  let tradingMode = 'manual'; // 'auto' | 'manual'
  let paperBalanceUsd: string | null = null;
  try {
    const [profile] = await db
      .select()
      .from(userRiskProfiles)
      .where(eq(userRiskProfiles.userId, userId))
      .limit(1);
    if (profile) {
      riskPerTradePct = parseFloat(profile.riskPerTradePct ?? '1.0');
      slippagePct = profile.slippagePct ? parseFloat(profile.slippagePct) : 0.05;
      executionMode = profile.executionMode ?? 'paper';
      tradingMode = profile.tradingMode ?? 'manual';
      paperBalanceUsd = profile.paperBalanceUsd ?? null;
    }
  } catch (err) {
    console.warn('finalizeForUser: could not load risk profile, using defaults', err);
  }

  const executionExchange = input.executionExchange ?? analysis.exchange;
  const accountBalance = await resolveAccountBalance(userId, executionMode, paperBalanceUsd);

  // --- Risk sizing ---
  let riskCalculation: Record<string, unknown> | null = null;
  const riskTool = mastra?.getTool('riskTool');
  if (!riskTool) throw new Error('riskTool not found in Mastra instance');
  try {
    riskCalculation = (await riskTool.execute!(
      {
        exchange: executionExchange,
        accountBalance,
        riskPerTradePct,
        entryPrice,
        stopLossPrice: analysis.sl,
        takeProfitPrice: analysis.tp,
        direction,
        slippagePct,
      },
      {},
    )) as Record<string, unknown>;
  } catch (err) {
    console.warn('finalizeForUser: riskTool failed', err);
  }

  // --- News/on-chain snapshot for persistence ---
  const newsItems = analysis.news?.items ?? [];
  const avgSentimentScore =
    newsItems.length > 0
      ? newsItems.reduce((sum, item) => sum + item.sentimentScore, 0) / newsItems.length
      : undefined;

  // --- Persist signal (single insert path shared with the single-user flow) ---
  const created = (await createSignalTool.execute!(
    {
      userId,
      symbol,
      timeframe: '1h',
      direction,
      entryPrice,
      sl: analysis.sl,
      tp: analysis.tp,
      confidence,
      reasoning,
      strategySource: strategiesTriggered.join(', '),
      exchange: executionExchange,
      analysisRunId: analysisRunId ?? undefined,
      newsSentiment: analysis.news?.overallSentiment,
      newsSentimentScore: avgSentimentScore,
      onChainFundingRate: analysis.onchain?.fundingRate,
      onChainFundingBias: analysis.onchain?.fundingBias,
      onChainNetflow: analysis.onchain?.exchangeNetflow,
      rawPayloadExtraJson: JSON.stringify({
        triggeredBy: analysis.triggeredBy,
        analysisExchange: analysis.exchange,
        topDownBias: analysis.topDownBias,
        riskCalculation,
        smcStructures: analysis.smcStructures,
        chartPatterns: analysis.chartPatterns,
        indicators1h: analysis.indicators1h,
      }),
    },
    { observe: noopObserve },
  )) as { signalId: string };

  const signalId = created?.signalId ?? null;

  if (signalId) {
    void propagatePublisherSignal(signalId, userId);
  }

  // --- Auto-execution: gated on the user's actual auto/manual preference,
  // not on executionMode (which only ever selects paper vs live venue). ---
  let executionResult: FinalizeForUserResult['executionResult'] = null;
  const shouldAutoExecute = tradingMode === 'auto';

  if (shouldAutoExecute && signalId) {
    const positionSizeUsdt = (riskCalculation?.positionSizeUsdt as number | undefined) ?? 100;
    const toolMode = executionMode === 'live' ? 'live' : 'paper';

    try {
      executionResult = (await executeTradeTool.execute!(
        {
          userId,
          signalId,
          exchange: executionExchange,
          symbol,
          direction,
          entryPrice,
          positionSizeUsdt,
          sl: analysis.sl,
          tp: analysis.tp,
          mode: toolMode,
          slippagePct,
        },
        { observe: noopObserve },
      )) as FinalizeForUserResult['executionResult'];
    } catch (err) {
      console.error('finalizeForUser: execute-trade-tool threw unexpectedly', err);
    }
  }

  return { signalId, action, symbol, userId, executionMode, executionResult };
}
