/**
 * Deterministic per-decision scoring rubric.
 *
 * No LLM judge — every check is a pure function of (decision, frozen case),
 * so any judge re-running the eval gets identical scores for identical
 * decisions. The checks encode what "a signal a trader could act on" means:
 *
 *  1. schema_valid       — output parses into the required JSON structure
 *  2. hold_nulls         — HOLD carries no dangling price levels
 *  3. entry_complete     — ENTER_* has entry zone + SL + TP (no naked trades)
 *  4. levels_ordered     — SL/entry/TP on the correct sides for the direction
 *  5. rr_ok              — risk:reward ≥ 1.5 (product default minRiskRewardRatio)
 *  6. grounded           — every price level traces to a tool-derived reference
 *                          level (EMA/BB, SMC structure, order-book wall,
 *                          liquidation level, pattern level, or swing point)
 *                          within 0.5%; catches hallucinated levels
 *  7. htf_aligned        — action does not fight the deterministic top-down
 *                          bias computed from the same candles
 *  8. entry_near_market  — entry zone within 5% of current price (stale or
 *                          fantasy entries are unusable)
 */

import { z } from 'zod';
import type {
  candleSchema,
  indicatorsResultSchema,
  topDownBiasSchema,
  smcResultSchema,
  patternSchema,
} from '@/lib/analysis/market-analysis';
import type { EvalCase, Decision } from './case-types';

type Candle = z.infer<typeof candleSchema>;
type Indicators = z.infer<typeof indicatorsResultSchema>;
type TopDownBias = z.infer<typeof topDownBiasSchema>;
type SmcResult = z.infer<typeof smcResultSchema>;
type Pattern = z.infer<typeof patternSchema>;

export const MIN_RISK_REWARD = 1.5; // matches user_risk_profiles.min_risk_reward_ratio default
export const GROUNDING_TOLERANCE = 0.005; // 0.5%
export const ENTRY_PROXIMITY = 0.05; // 5%

export interface ScoringContext {
  currentPrice: number;
  topDownBias: TopDownBias;
  referenceLevels: number[];
}

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

export interface ScoreResult {
  checks: CheckResult[];
  violations: number;
  pass: boolean;
  actionable: boolean;
}

/** Swing highs/lows: local extremes over ±window, last `lookback` candles. */
function swingLevels(candles: Candle[], window = 3, lookback = 80): number[] {
  const slice = candles.slice(-lookback);
  const levels: number[] = [];
  for (let i = window; i < slice.length - window; i++) {
    const highs = slice.slice(i - window, i + window + 1).map((c) => c.high);
    const lows = slice.slice(i - window, i + window + 1).map((c) => c.low);
    if (slice[i].high === Math.max(...highs)) levels.push(slice[i].high);
    if (slice[i].low === Math.min(...lows)) levels.push(slice[i].low);
  }
  return levels;
}

/**
 * Build the set of price levels a decision may legitimately cite. Both
 * systems are held to the same set — everything in it is derivable from the
 * raw candles + frozen tool outputs both systems had access to.
 */
export function buildScoringContext(
  evalCase: EvalCase,
  derived: {
    indicators1h: Indicators;
    indicators4h: Indicators;
    indicators1d: Indicators;
    topDownBias: TopDownBias;
    smcStructures: SmcResult;
    chartPatterns: Pattern[];
  },
): ScoringContext {
  const levels: number[] = [];

  for (const ind of [derived.indicators1h, derived.indicators4h, derived.indicators1d]) {
    levels.push(ind.ema.ema20, ind.ema.ema50, ind.ema.ema200);
    levels.push(ind.bollingerBands.upper, ind.bollingerBands.middle, ind.bollingerBands.lower);
  }

  const smc = derived.smcStructures;
  for (const group of [smc.fvgs, smc.orderBlocks, smc.bos, smc.choch, smc.liquiditySweeps]) {
    for (const d of group) levels.push(d.priceLevel);
  }

  for (const p of derived.chartPatterns) {
    if (p.necklinePrice != null) levels.push(p.necklinePrice);
    if (p.targetPrice != null) levels.push(p.targetPrice);
    if (p.stopLossPrice != null) levels.push(p.stopLossPrice);
  }

  for (const w of evalCase.orderBook.bidWalls) levels.push(w.price);
  for (const w of evalCase.orderBook.askWalls) levels.push(w.price);
  for (const l of evalCase.onchain.liquidationLevels) levels.push(l.price);

  levels.push(...swingLevels(evalCase.candles1h));
  levels.push(...swingLevels(evalCase.candles4h));
  levels.push(...swingLevels(evalCase.candles1d));

  const currentPrice = evalCase.candles1h[evalCase.candles1h.length - 1].close;
  levels.push(currentPrice);

  return {
    currentPrice,
    topDownBias: derived.topDownBias,
    referenceLevels: levels.filter((l) => Number.isFinite(l) && l > 0),
  };
}

function isGrounded(level: number, refs: number[]): boolean {
  return refs.some((r) => Math.abs(level - r) / r <= GROUNDING_TOLERANCE);
}

export function scoreDecision(decision: Decision | null, ctx: ScoringContext): ScoreResult {
  const checks: CheckResult[] = [];
  const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

  if (!decision) {
    add('schema_valid', false, 'output did not parse into the required JSON structure');
    for (const name of [
      'hold_nulls',
      'entry_complete',
      'levels_ordered',
      'rr_ok',
      'grounded',
      'htf_aligned',
      'entry_near_market',
    ]) {
      add(name, false, 'not evaluable — invalid output');
    }
    return { checks, violations: checks.length, pass: false, actionable: false };
  }

  add('schema_valid', true, 'parsed and validated');

  const { action, entryZone, sl, tp, confidence } = decision;
  const actionable = action === 'ENTER_LONG' || action === 'ENTER_SHORT';

  // 2. HOLD must not carry price levels
  if (action === 'HOLD') {
    const clean = entryZone.low === null && entryZone.high === null && sl === null && tp === null;
    add('hold_nulls', clean, clean ? 'HOLD with null levels' : 'HOLD carries non-null price levels');
  } else {
    add('hold_nulls', true, 'n/a (actionable)');
  }

  // 3. ENTER_* must be complete
  if (actionable) {
    const complete = entryZone.low !== null && entryZone.high !== null && sl !== null && tp !== null;
    add(
      'entry_complete',
      complete,
      complete ? 'entry zone, SL, TP all present' : `missing levels: entry=${JSON.stringify(entryZone)} sl=${sl} tp=${tp}`,
    );

    if (complete) {
      const lo = entryZone.low as number;
      const hi = entryZone.high as number;
      const stop = sl as number;
      const target = tp as number;
      const mid = (lo + hi) / 2;

      // 4. ordering
      const ordered =
        action === 'ENTER_LONG' ? stop < lo && lo <= hi && hi < target : target < lo && lo <= hi && hi < stop;
      add(
        'levels_ordered',
        ordered,
        `${action}: sl=${stop} entry=[${lo}, ${hi}] tp=${target}`,
      );

      // 5. risk:reward
      const risk = Math.abs(mid - stop);
      const reward = Math.abs(target - mid);
      const rr = risk > 0 ? reward / risk : 0;
      add(
        'rr_ok',
        rr >= MIN_RISK_REWARD,
        `R:R = ${rr.toFixed(2)} (min ${MIN_RISK_REWARD})`,
      );

      // 6. grounding — every cited level must trace to a reference level
      const ungrounded = [
        ['entry.low', lo],
        ['entry.high', hi],
        ['sl', stop],
        ['tp', target],
      ].filter(([, v]) => !isGrounded(v as number, ctx.referenceLevels));
      add(
        'grounded',
        ungrounded.length === 0,
        ungrounded.length === 0
          ? 'all levels within 0.5% of a tool-derived reference level'
          : `hallucinated levels (no tool source within 0.5%): ${ungrounded.map(([n, v]) => `${n}=${v}`).join(', ')}`,
      );

      // 8. entry proximity
      const proximity = Math.abs(mid - ctx.currentPrice) / ctx.currentPrice;
      add(
        'entry_near_market',
        proximity <= ENTRY_PROXIMITY,
        `entry mid ${mid} is ${(proximity * 100).toFixed(2)}% from current price ${ctx.currentPrice}`,
      );
    } else {
      add('levels_ordered', false, 'not evaluable — incomplete levels');
      add('rr_ok', false, 'not evaluable — incomplete levels');
      add('grounded', false, 'not evaluable — incomplete levels');
      add('entry_near_market', false, 'not evaluable — incomplete levels');
    }
  } else {
    add('entry_complete', true, 'n/a (HOLD)');
    add('levels_ordered', true, 'n/a (HOLD)');
    add('rr_ok', true, 'n/a (HOLD)');
    add('grounded', true, 'n/a (HOLD)');
    add('entry_near_market', true, 'n/a (HOLD)');
  }

  // 7. HTF alignment (applies to every decision)
  const bias = ctx.topDownBias.tradeBias;
  let htfPass = true;
  let htfDetail = `tradeBias=${bias}, action=${action}`;
  if (bias === 'BULLISH' && action === 'ENTER_SHORT') {
    htfPass = false;
    htfDetail += ' — counter-trend SHORT against BULLISH HTF bias';
  } else if (bias === 'BEARISH' && action === 'ENTER_LONG') {
    htfPass = false;
    htfDetail += ' — counter-trend LONG against BEARISH HTF bias';
  } else if (bias === 'NEUTRAL' && actionable && confidence === 'HIGH') {
    htfPass = false;
    htfDetail += ' — HIGH confidence entry in a NEUTRAL/range-bound regime';
  }
  // Order checks canonically: insert htf_aligned before entry_near_market for readability
  add('htf_aligned', htfPass, htfDetail);

  const violations = checks.filter((c) => !c.pass).length;
  return { checks, violations, pass: violations === 0, actionable };
}
