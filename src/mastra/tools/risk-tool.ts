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
 * Max leverage + minimum order size the exchange allows for this symbol, from
 * CCXT's unified market.limits. Throws (fails closed, same pattern as
 * resolveAccountBalance returning null) if the market can't be loaded or the
 * symbol isn't found — margin sizing must never silently proceed against an
 * unknown leverage cap.
 *
 * CCXT's unified `limits.leverage.max` is left `undefined` by its BingX and
 * Binance adapters for every market (verified against ccxt/js/src/bingx.js
 * and binance.js) — only Bybit actually populates it. Previously that meant
 * every BingX/Binance swap signal silently collapsed to 1x leverage, which
 * commits ~98% of the account balance as margin on a single trade and can
 * drop below the exchange's minimum order size on smaller accounts. BingX's
 * real per-symbol cap is available for free in the raw (un-normalized)
 * market response as side-dependent `maxLongLeverage`/`maxShortLeverage`
 * fields, so that's checked next. Binance's real cap requires an
 * authenticated, per-user fetchLeverageTiers() call this shared/public
 * market cache has no way to make — callers pass their own
 * fallbackMaxLeverage (the user's configured defaultLeverage) instead of
 * silently defaulting to 1.
 *
 * minAmountUnits is the largest of limits.amount.min and precision.amount —
 * either one can independently cause CCXT's own amountToPrecision() to round
 * an order down to zero and throw "amount ... must be greater than minimum
 * amount precision" (a client-side guard, before the order ever reaches the
 * exchange). Checking this before placing an order turns that cryptic,
 * always-fails-identically error into a clear "position size below exchange
 * minimum" one the retry loop can recognize and stop retrying.
 */
async function fetchSwapMarketConstraints(
  exchangeId: 'binance' | 'bybit' | 'bingx',
  symbol: string,
  marketType: MarketType,
  direction: 'LONG' | 'SHORT',
  fallbackMaxLeverage?: number,
): Promise<{ maxLeverage: number; minAmountUnits: number }> {
  if (marketType !== 'swap') return { maxLeverage: 1, minAmountUnits: 0 };

  const markets = await getSwapMarkets(exchangeId);
  const exchangeSymbol = toExchangeSymbol(symbol, marketType);
  const market = markets[exchangeSymbol];
  if (!market) {
    throw new Error(`Swap market '${exchangeSymbol}' not found on ${exchangeId} — cannot determine leverage cap.`);
  }

  let maxLev = market.limits?.leverage?.max;

  if ((typeof maxLev !== 'number' || maxLev <= 0) && exchangeId === 'bingx') {
    const info = market.info as Record<string, unknown> | undefined;
    const raw = direction === 'LONG' ? info?.maxLongLeverage : info?.maxShortLeverage;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) maxLev = parsed;
  }

  if (typeof maxLev !== 'number' || maxLev <= 0) {
    maxLev =
      typeof fallbackMaxLeverage === 'number' && fallbackMaxLeverage > 0 ? fallbackMaxLeverage : 1;
  }

  const maxLeverage = Math.floor(maxLev);

  const minLimit = market.limits?.amount?.min;
  const minPrecision = market.precision?.amount;
  const minAmountUnits = Math.max(
    typeof minLimit === 'number' && minLimit > 0 ? minLimit : 0,
    typeof minPrecision === 'number' && minPrecision > 0 ? minPrecision : 0,
  );

  return { maxLeverage, minAmountUnits };
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
// If that derived leverage exceeds what the exchange allows for this symbol,
// leverage is capped at the exchange's max and margin is increased instead
// (never leverage beyond the cap) so the position still uses the full
// riskPerTrade% budget — capped again at the account balance itself as a
// last-resort safety net so this can never ask for more margin than exists.
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
    fallbackMaxLeverage: z
      .number()
      .positive()
      .optional()
      .describe(
        "User's configured default leverage (user_risk_profiles.defaultLeverage), used as the " +
          "leverage cap when the exchange doesn't report one for this symbol (e.g. Binance, whose " +
          'real per-symbol cap requires an authenticated leverage-tiers call this tool cannot make). ' +
          'Falls back to 1 if omitted.',
      ),
  }),
  outputSchema: z.object({
    exchange: z.string(),
    direction: z.string(),
    entryPrice: z.number(),
    stopLossPrice: z.number(),
    takeProfitPrice: z.number(),
    accountBalance: z.number().describe('Account balance this position was sized against, in USDT'),
    // Margin + leverage
    marginUsdt: z.number().describe('Capital committed as margin, in USDT'),
    leverage: z.number().describe('Derived leverage — set on the exchange account before order placement'),
    maxSymbolLeverage: z.number().describe("Exchange's max leverage for this symbol (1 for spot)"),
    leverageCapped: z
      .boolean()
      .describe('True when the exchange leverage cap was below the ideal derived leverage'),
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
      fallbackMaxLeverage,
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
      fallbackMaxLeverage?: number;
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
    // Margin + leverage — derived, not rigid.
    //
    //   loss = leverage × margin × effectiveLossRate = maxRiskUsdt
    //
    // Ideal case: margin := maxRiskUsdt, leverage := 1 / effectiveLossRate.
    // If that leverage exceeds the exchange's cap for this symbol, cap
    // leverage there and solve margin upward instead, so the full risk
    // budget is still used rather than silently under-risking — capped
    // again at the account balance itself as a last-resort safety net.
    // ---------------------------------------------------------------------------
    const { maxLeverage: maxSymbolLeverage, minAmountUnits } = await fetchSwapMarketConstraints(
      exchange,
      symbol,
      marketType,
      direction,
      fallbackMaxLeverage,
    );

    let leverage: number;
    let marginUsdt: number;
    let leverageCapped = false;

    if (marketType === 'swap') {
      const idealLeverage = Math.max(1, Math.floor(1 / effectiveLossRate));
      leverage = Math.min(idealLeverage, maxSymbolLeverage);
      leverageCapped = leverage < idealLeverage;

      if (!leverageCapped) {
        marginUsdt = maxRiskUsdt;
      } else {
        // Safety net: never require more margin than the account has. A 2%
        // haircut leaves headroom for the entry taker fee and margin dust —
        // committing exactly 100% of free balance as margin still bounces
        // on the exchange.
        marginUsdt = Math.min(maxRiskUsdt / (leverage * effectiveLossRate), accountBalance * 0.98);
      }
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
      marginUsdt: round(marginUsdt, 4),
      leverage,
      maxSymbolLeverage,
      leverageCapped,
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
