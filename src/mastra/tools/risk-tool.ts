import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

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
// Risk Tool
// Sizes positions so that net loss (after round-trip fees + slippage) stays
// within the user's riskPerTrade% of account balance. Returns both gross and
// net P&L figures and a break-even distance.
// ---------------------------------------------------------------------------
export const riskTool = createTool({
  id: 'risk-tool',
  description:
    'Calculate position size and realistic P&L for a trade, accounting for ' +
    'round-trip exchange fees and slippage. Always call this after a trade ' +
    'decision to size the position correctly and report net figures.',
  inputSchema: z.object({
    exchange: z
      .enum(['binance', 'bybit', 'bingx'])
      .describe('Exchange the trade will be executed on'),
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
    // Position sizing
    positionSizeUsdt: z.number().describe('Notional position size in USDT'),
    positionSizeUnits: z.number().describe('Position size in base asset units'),
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
      accountBalance,
      riskPerTradePct,
      entryPrice,
      stopLossPrice,
      takeProfitPrice,
      direction,
      slippagePct: inputSlippage,
    } = inputData as {
      exchange: 'binance' | 'bybit' | 'bingx';
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
    // We apply slippage once (entry) since it's a market impact cost.
    const totalDragRate = roundTripFeeRate + slippageRate;

    // ---------------------------------------------------------------------------
    // Position sizing — net loss must stay within riskPerTrade%
    //
    // Gross SL distance as fraction of entry price:
    //   LONG:  (entry - sl) / entry
    //   SHORT: (sl - entry) / entry
    //
    // Net loss on $N position = N × slDistanceRate + N × totalDragRate
    //   => N × (slDistanceRate + totalDragRate) ≤ balance × riskPerTradePct%
    //   => N = (balance × riskPerTradePct%) / (slDistanceRate + totalDragRate)
    // ---------------------------------------------------------------------------
    const slDistanceRate =
      direction === 'LONG'
        ? (entryPrice - stopLossPrice) / entryPrice
        : (stopLossPrice - entryPrice) / entryPrice;

    const maxRiskUsdt = accountBalance * (riskPerTradePct / 100);
    const positionSizeUsdt = maxRiskUsdt / (slDistanceRate + totalDragRate);
    const positionSizeUnits = positionSizeUsdt / entryPrice;

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
    // Net risk as % of account (sanity check — should equal riskPerTradePct)
    // ---------------------------------------------------------------------------
    const netRiskPct = (netExpectedLoss / accountBalance) * 100;

    return {
      exchange,
      direction,
      entryPrice,
      stopLossPrice,
      takeProfitPrice,
      positionSizeUsdt: round(positionSizeUsdt, 2),
      positionSizeUnits: round(positionSizeUnits, 6),
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
