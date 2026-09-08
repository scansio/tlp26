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

import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { userRiskProfiles } from '@/db/schema';
import { propagatePublisherSignal } from '@/lib/copy-mirror-engine';
import { fetchLiveUsdtBalance } from '@/lib/exchange-account';
import { createSignalTool } from '@/mastra/tools/create-signal-tool';
import { executeTradeTool } from '@/mastra/tools/execute-trade-tool';
import type { MarketType } from '@/mastra/tools/market-symbol';
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

/**
 * Resolves the balance to size a position against. In paper mode this is
 * always the configured paper balance. In live mode it must be the real
 * exchange balance (via the shared exchange-account resolver, which is
 * market-type-aware) — returns null (never a guessed/paper number) if that
 * can't be determined, so callers can skip sizing/execution rather than
 * computing against an unknown balance.
 */
export async function resolveAccountBalance(
  userId: string,
  executionMode: string,
  paperBalanceUsd: string | null,
  marketType: MarketType,
): Promise<number | null> {
  if (executionMode !== 'live') {
    return Number(paperBalanceUsd ?? '10000.00');
  }

  const balance = await fetchLiveUsdtBalance(userId, marketType);
  if (balance === null) {
    console.warn(`finalizeForUser: could not determine live account balance for userId=${userId}`);
  }
  return balance;
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
  let marketType: 'spot' | 'swap' = 'spot';
  let leverage = 1;
  let marginMode: 'cross' | 'isolated' = 'cross';
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
      marketType = (profile.marketType as 'spot' | 'swap') ?? 'spot';
      leverage = profile.defaultLeverage ?? 1;
      marginMode = (profile.marginMode as 'cross' | 'isolated') ?? 'cross';
    }
  } catch (err) {
    console.warn('finalizeForUser: could not load risk profile, using defaults', err);
  }

  const executionExchange = input.executionExchange ?? analysis.exchange;
  const accountBalance = await resolveAccountBalance(userId, executionMode, paperBalanceUsd, marketType);

  // --- Risk sizing ---
  // accountBalance is null only when live mode couldn't determine a real
  // balance — skip sizing entirely rather than computing against a guess.
  let riskCalculation: Record<string, unknown> | null = null;
  const riskTool = mastra?.getTool('riskTool');
  if (!riskTool) throw new Error('riskTool not found in Mastra instance');
  if (accountBalance !== null) {
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
  } else {
    console.warn(
      `finalizeForUser: live account balance unavailable for userId=${userId} — creating signal without a computed position size.`,
    );
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
      marketType,
      leverage,
      marginMode,
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
        indicators15m: analysis.indicators15m,
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
  const positionSizeUsdt = riskCalculation?.positionSizeUsdt as number | undefined;

  if (shouldAutoExecute && signalId && typeof positionSizeUsdt === 'number' && positionSizeUsdt > 0) {
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
          marketType,
          leverage,
          marginMode,
        },
        { observe: noopObserve },
      )) as FinalizeForUserResult['executionResult'];
    } catch (err) {
      console.error('finalizeForUser: execute-trade-tool threw unexpectedly', err);
    }
  } else if (shouldAutoExecute && signalId) {
    console.error(
      `finalizeForUser: skipping auto-execution for userId=${userId} — no valid computed position size (unknown balance or invalid risk sizing); signal ${signalId} left pending for manual approval.`,
    );
  }

  return { signalId, action, symbol, userId, executionMode, executionResult };
}
