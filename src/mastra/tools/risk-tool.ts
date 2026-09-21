import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import ccxt, { type Exchange } from 'ccxt';
import { applyPublicDataMirror } from './exchange-public-client';
import { toExchangeSymbol, type MarketType } from './market-symbol';

// ---------------------------------------------------------------------------
// Per-exchange taker fee rates (as decimals)
// ---------------------------------------------------------------------------
const TAKER_FEES: Record<string, number> = {
  binance: 0.0004,  // 0.04%
  bybit: 0.00055,   // 0.055%
  bingx: 0.0005,    // 0.05%
};

const DEFAULT_SLIPPAGE = 0.0005; // 0.05%

// ---------------------------------------------------------------------------
// Market cache — loadMarkets() is a heavy multi-hundred-KB network call and
// this tool is invoked once per pending signal on every queue-page poll, not
// just once per worker tick. Cache the whole per-exchange market map (not
// per-symbol) since loadMarkets() fetches everything in one call anyway.
// ---------------------------------------------------------------------------
const MARKETS_CACHE_TTL_MS = 10 * 60 * 1000;
const marketsCache = new Map<string, { markets: Exchange['markets']; expiresAt: number }>();

async function getSwapMarkets(exchangeId: 'binance' | 'bybit' | 'bingx'): Promise<Exchange['markets']> {
  const cached = marketsCache.get(exchangeId);
  if (cached && cached.expiresAt > Date.now()) return cached.markets;

  const ExchangeClass = ccxt[exchangeId as keyof typeof ccxt] as new (config?: object) => Exchange;
  if (!ExchangeClass) throw new Error(`Exchange '${exchangeId}' is not supported by CCXT.`);

  const client = new ExchangeClass({ enableRateLimit: true });
  applyPublicDataMirror(client, exchangeId, 'swap');
  await client.loadMarkets();

  marketsCache.set(exchangeId, { markets: client.markets, expiresAt: Date.now() + MARKETS_CACHE_TTL_MS });
  return client.markets;
}

/**
 * Minimum order size the exchange allows for this symbol, from CCXT's
 * unified market.limits/precision. Throws (fails closed, same pattern as
 * resolveAccountBalance returning null) if the market can't be loaded or the
 * symbol isn't found.
 *
 * This deliberately does NOT look up a leverage cap. CCXT's unified
 * `limits.leverage.max` is left `undefined` by BingX/Binance for every
 * market (only Bybit populates it), and BingX's raw, un-normalized
 * `maxLongLeverage`/`maxShortLeverage` fields — tried in an earlier version
 * of this function — turned out to reflect a public/no-auth baseline, not
 * the real account-specific max (confirmed in production: BingX reported
 * 20x for ADA/USDT via this field while the BingX app itself allows 300x).
 * There is no reliable way to know an exchange's real leverage cap in
 * advance without an authenticated, account-specific call. Instead, sizing
 * always solves for the ideal (uncapped) leverage, and execute-trade-tool.ts
 * discovers the real cap the only reliable way — by attempting to set it on
 * the exchange and reacting to an actual rejection.
 *
 * minAmountUnits is the largest of limits.amount.min and precision.amount —
 * either one can independently cause CCXT's own amountToPrecision() to round
 * an order down to zero and throw "amount ... must be greater than minimum
 * amount precision" (a client-side guard, before the order ever reaches the
 * exchange). Checking this before placing an order turns that cryptic,
 * always-fails-identically error into a clear "position size below exchange
 * minimum" one the retry loop can recognize and stop retrying.
 */
async function fetchSwapMinAmount(
  exchangeId: 'binance' | 'bybit' | 'bingx',
  symbol: string,
  marketType: MarketType,
): Promise<{ minAmountUnits: number }> {
  if (marketType !== 'swap') return { minAmountUnits: 0 };

  const markets = await getSwapMarkets(exchangeId);
  const exchangeSymbol = toExchangeSymbol(symbol, marketType);
  const market = markets[exchangeSymbol];
  if (!market) {
    throw new Error(`Swap market '${exchangeSymbol}' not found on ${exchangeId} — cannot determine order-size limits.`);
  }

  const minLimit = market.limits?.amount?.min;
  const minPrecision = market.precision?.amount;
  const minAmountUnits = Math.max(
    typeof minLimit === 'number' && minLimit > 0 ? minLimit : 0,
    typeof minPrecision === 'number' && minPrecision > 0 ? minPrecision : 0,
  );

  return { minAmountUnits };
}

// ---------------------------------------------------------------------------
// Risk Tool
//
// Margin is always sized to riskPerTrade% of account balance, and leverage is
// derived (never a rigid, separately-configured number) so that a loss at the
// stop-loss price exactly consumes that margin:
//
//   loss = leverage × margin × (slDistanceRate + fees + slippage)
//   margin := riskPerTrade% of balance  =>  leverage = 1 / (slDistanceRate + fees + slippage)
//
// This is always the uncapped/"ideal" solve — no exchange leverage limit is
// looked up or applied here (see fetchSwapMinAmount's comment for why). If
// the exchange rejects this leverage at order-placement time,
// execute-trade-tool.ts falls back to the account's own default leverage and
// re-solves margin there — but by then positionSizeUsdt is already fixed:
// since loss = positionSizeUsdt × effectiveLossRate = maxRiskUsdt regardless
// of the leverage/margin split, a leverage fallback only changes how much
// margin is committed, never the notional or the dollar risk.
// ---------------------------------------------------------------------------
export const riskTool = createTool({
  id: 'risk-tool',
  description:
    'Calculate position size, margin, and leverage for a trade, accounting for ' +
    'round-trip exchange fees and slippage. Always call this after a trade ' +
    'decision to size the position correctly and report net figures.',
  inputSchema: z.object({
    exchange: z
      .enum(['binance', 'bybit', 'bingx'])
      .describe('Exchange the trade will be executed on'),
    symbol: z.string().describe('Trading pair symbol, e.g. BTC/USDT — used to look up the exchange leverage cap'),
    marketType: z
      .enum(['spot', 'swap'])
      .default('spot')
      .describe("'swap' = USDT-M perpetual futures; leverage is only derived for swap, always 1 for spot"),
    accountBalance: z
      .number()
      .positive()
      .describe('Available account balance in USDT'),
    riskPerTradePct: z
      .number()
      .positive()
      .max(10)
      .describe('Maximum risk per trade as a percentage of account balance (e.g. 1.0 = 1%)'),
    entryPrice: z
      .number()
      .positive()
      .describe('Proposed entry price from the trading signal'),
    stopLossPrice: z
      .number()
      .positive()
      .describe('Stop-loss price from the trading signal'),
    takeProfitPrice: z
      .number()
      .positive()
      .describe('Take-profit price from the trading signal'),
    direction: z
      .enum(['LONG', 'SHORT'])
      .describe('Trade direction'),
    slippagePct: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        'Slippage estimate as a percentage (e.g. 0.05 = 0.05%). Defaults to 0.05% if not provided.',
      ),
  }),
  outputSchema: z.object({
    exchange: z.string(),
    direction: z.string(),
    entryPrice: z.number(),
    stopLossPrice: z.number(),
    takeProfitPrice: z.number(),
    accountBalance: z.number().describe('Account balance this position was sized against, in USDT ("RISK CAPITAL")'),
    maxRiskUsdt: z
      .number()
      .describe('riskPerTradePct% of accountBalance, in USDT ("RISK PER TRADE = riskPerTradePct% of RISK CAPITAL")'),
    slDistancePct: z.number().describe('Raw stop-loss distance from entry, as a % ("SL%")'),
    tpDistancePct: z.number().describe('Raw take-profit distance from entry, as a % ("TP%")'),
    effectiveLossPct: z
      .number()
      .describe('SL% + round-trip fee% + slippage% — the rate leverage is actually solved against'),
    leverageRaw: z
      .number()
      .describe('Unfloored 1 / (effectiveLossPct/100), before flooring to a whole number'),
    // Margin + leverage
    marginUsdt: z.number().describe('Capital committed as margin, in USDT'),
    leverage: z
      .number()
      .describe(
        'Derived leverage to attempt on the exchange before order placement. Not pre-capped to any ' +
          'exchange limit — execute-trade-tool.ts falls back to the account default leverage if the ' +
          'exchange rejects this value, and updates trade_signals with what actually got used.',
      ),
    // Position sizing
    positionSizeUsdt: z.number().describe('Notional position size in USDT (leverage × margin)'),
    positionSizeUnits: z.number().describe('Position size in base asset units'),
    minOrderSizeUnits: z
      .number()
      .describe("Exchange's minimum order size in base-asset units for this symbol (0 for spot)"),
    belowExchangeMinimum: z
      .boolean()
      .describe('True when positionSizeUnits is below minOrderSizeUnits — this order would be rejected by the exchange'),
    // Fee & slippage model
    takerFeePct: z.number().describe('Per-side taker fee as a percentage'),
    slippagePct: z.number().describe('Slippage estimate as a percentage'),
    roundTripFeePct: z.number().describe('Total round-trip fee cost as a percentage of notional'),
    // P&L — gross (before fees)
    grossExpectedLoss: z.number().describe('Loss amount if SL is hit (before fees), in USDT'),
    grossExpectedProfit: z.number().describe('Profit amount if TP is hit (before fees), in USDT'),
    // P&L — net (after round-trip fees + slippage)
    netExpectedLoss: z.number().describe('Net loss if SL is hit (after fees + slippage), in USDT'),
    netExpectedProfit: z.number().describe('Net profit if TP is hit (after fees + slippage), in USDT'),
    // Fee cost in dollar terms
    totalFeeCost: z.number().describe('Total round-trip fee dollar amount for this trade size'),
    // Break-even
    breakEvenDistance: z
      .number()
      .describe('% price move required just to cover fees + slippage (break-even threshold)'),
    // Risk check
    riskPerTradePct: z.number().describe('Input risk-per-trade percentage'),
    netRiskPct: z
      .number()
      .describe('Actual net risk as % of account after fees + slippage (should ≤ riskPerTradePct)'),
  }),
  execute: async (inputData) => {
    const {
      exchange,
      symbol,
      marketType,
      accountBalance,
      riskPerTradePct,
      entryPrice,
      stopLossPrice,
      takeProfitPrice,
      direction,
      slippagePct: inputSlippage,
    } = inputData as {
      exchange: 'binance' | 'bybit' | 'bingx';
      symbol: string;
      marketType: MarketType;
      accountBalance: number;
      riskPerTradePct: number;
      entryPrice: number;
      stopLossPrice: number;
      takeProfitPrice: number;
      direction: 'LONG' | 'SHORT';
      slippagePct?: number;
    };

    const takerFeeRate = TAKER_FEES[exchange] ?? TAKER_FEES['binance'];
    const slippageRate = (inputSlippage ?? DEFAULT_SLIPPAGE * 100) / 100;

    // Round-trip cost = 2 × taker fee (entry + exit) expressed as a fraction
    const roundTripFeeRate = 2 * takerFeeRate;

    // Total drag on notional per unit of position: fees + one-way slippage on entry
    const totalDragRate = roundTripFeeRate + slippageRate;

    const slDistanceRate =
      direction === 'LONG'
        ? (entryPrice - stopLossPrice) / entryPrice
        : (stopLossPrice - entryPrice) / entryPrice;

    // Effective loss rate on notional, including fees/slippage drag.
    const effectiveLossRate = slDistanceRate + totalDragRate;

    const maxRiskUsdt = accountBalance * (riskPerTradePct / 100);

    // ---------------------------------------------------------------------------
    // Margin + leverage — always the uncapped/"ideal" solve:
    //
    //   loss = leverage × margin × effectiveLossRate = maxRiskUsdt
    //   margin := maxRiskUsdt, leverage := 1 / effectiveLossRate (floored)
    //
    // No exchange leverage cap is looked up or applied — see
    // fetchSwapMinAmount's comment for why. maxRiskUsdt is inherently ≤ 10%
    // of accountBalance (riskPerTradePct is schema-capped at 10), so margin
    // never needs a balance safety clamp here.
    // ---------------------------------------------------------------------------
    const { minAmountUnits } = await fetchSwapMinAmount(exchange, symbol, marketType);

    let leverage: number;
    let marginUsdt: number;
    // Unfloored 1/effectiveLossRate — kept for display so the "LEVERAGE = ?"
    // solve step can be shown before it's floored to a whole number, same as
    // the manual risk-management worksheet this calculation follows.
    let leverageRaw = 1;

    if (marketType === 'swap') {
      leverageRaw = 1 / effectiveLossRate;
      leverage = Math.max(1, Math.floor(leverageRaw));
      marginUsdt = maxRiskUsdt;
    } else {
      leverage = 1;
      marginUsdt = maxRiskUsdt / effectiveLossRate;
    }

    const positionSizeUsdt = leverage * marginUsdt;
    const positionSizeUnits = positionSizeUsdt / entryPrice;

    // Spot never enforces this (minAmountUnits is always 0 there — see
    // fetchSwapMarketConstraints) since sizing there isn't leverage-amplified
    // the same way and this codebase hasn't hit a spot minimum-size failure.
    const belowExchangeMinimum = minAmountUnits > 0 && positionSizeUnits < minAmountUnits;

    // ---------------------------------------------------------------------------
    // Gross P&L (no fees)
    // ---------------------------------------------------------------------------
    const tpDistanceRate =
      direction === 'LONG'
        ? (takeProfitPrice - entryPrice) / entryPrice
        : (entryPrice - takeProfitPrice) / entryPrice;

    const grossExpectedLoss = positionSizeUsdt * slDistanceRate;
    const grossExpectedProfit = positionSizeUsdt * tpDistanceRate;

    // ---------------------------------------------------------------------------
    // Fee & slippage costs in dollar terms
    // ---------------------------------------------------------------------------
    const totalFeeCost = positionSizeUsdt * roundTripFeeRate;
    const slippageCostUsdt = positionSizeUsdt * slippageRate;

    // ---------------------------------------------------------------------------
    // Net P&L — subtract round-trip fees and slippage from both sides
    // ---------------------------------------------------------------------------
    const netExpectedLoss = grossExpectedLoss + totalFeeCost + slippageCostUsdt;
    const netExpectedProfit = grossExpectedProfit - totalFeeCost - slippageCostUsdt;

    // ---------------------------------------------------------------------------
    // Break-even distance = round-trip fees + slippage expressed as a % of price
    // ---------------------------------------------------------------------------
    const breakEvenDistance = (roundTripFeeRate + slippageRate) * 100;

    // ---------------------------------------------------------------------------
    // Net risk as % of account (sanity check — should equal riskPerTradePct
    // unless the account-balance safety clamp above kicked in)
    // ---------------------------------------------------------------------------
    const netRiskPct = (netExpectedLoss / accountBalance) * 100;

    return {
      exchange,
      direction,
      entryPrice,
      stopLossPrice,
      takeProfitPrice,
      // Echoed back so a caller that only has the stored risk-calculation
      // JSON (not the original request) can still display what balance this
      // was sized against, without a live balance re-fetch.
      accountBalance,
      // "RISK PER TRADE" dollar amount — riskPerTradePct% of accountBalance,
      // before any exchange-leverage-cap adjustment. Echoed back so the UI
      // can show the exact worked equation (RISK PER TRADE = riskPerTradePct%
      // of RISK CAPITAL = maxRiskUsdt) for manual verification.
      maxRiskUsdt: round(maxRiskUsdt, 4),
      // Raw SL/TP distance from entry, as a %, before leverage is applied —
      // the "SL%"/"TP%" terms in the manual risk-management worksheet this
      // mirrors. Distinct from breakEvenDistance (fee/slippage-only).
      slDistancePct: round(slDistanceRate * 100, 4),
      tpDistancePct: round(tpDistanceRate * 100, 4),
      // Effective loss rate used to solve for leverage — SL% plus round-trip
      // fee% and slippage% (fees are deliberately kept in this solve; see
      // roundTripFeePct/slippagePct below for the two components added to
      // slDistancePct to get here).
      effectiveLossPct: round(effectiveLossRate * 100, 4),
      // Unfloored "LEVERAGE = 1 / effectiveLossRate" before flooring — shown
      // so the solve step is fully auditable, not just the final leverage.
      leverageRaw: round(leverageRaw, 4),
      marginUsdt: round(marginUsdt, 4),
      leverage,
      positionSizeUsdt: round(positionSizeUsdt, 2),
      positionSizeUnits: round(positionSizeUnits, 6),
      minOrderSizeUnits: round(minAmountUnits, 6),
      belowExchangeMinimum,
      takerFeePct: round(takerFeeRate * 100, 4),
      slippagePct: round(slippageRate * 100, 4),
      roundTripFeePct: round(roundTripFeeRate * 100, 4),
      grossExpectedLoss: round(grossExpectedLoss, 4),
      grossExpectedProfit: round(grossExpectedProfit, 4),
      netExpectedLoss: round(netExpectedLoss, 4),
      netExpectedProfit: round(netExpectedProfit, 4),
      totalFeeCost: round(totalFeeCost, 4),
      breakEvenDistance: round(breakEvenDistance, 4),
      riskPerTradePct,
      netRiskPct: round(netRiskPct, 4),
    };
  },
});

function round(n: number, dp: number): number {
  const factor = Math.pow(10, dp);
  return Math.round(n * factor) / factor;
}
