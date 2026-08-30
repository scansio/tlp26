/**
 * Derive a synthetic "conflict" challenge case from a recorded fixture.
 *
 * It flips the news feed to strongly contradict the technical trend implied
 * by the candles (computed via the same deterministic top-down bias the
 * pipeline uses) and pushes the funding rate to an extreme in the news
 * direction. A well-behaved decision engine should recognize the conflict:
 * per the trading-agent conflict rules it must downgrade confidence (or
 * HOLD) — it must NOT flip to a counter-trend entry on headlines alone.
 *
 * The mutation is fully disclosed in the case's `synthetic` field.
 *
 * Usage:
 *   node --env-file-if-exists=.env ./node_modules/.bin/tsx eval/derive-challenge.ts [sourceCaseId]
 *   (defaults to btc-usdt)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeIndicatorsPhase, deriveTopDownBiasPhase } from '@/lib/analysis/market-analysis';
import { createEvalMastra } from './lib/shim';
import { evalCaseSchema, type EvalCase } from './lib/case-types';

const CASES_DIR = join(process.cwd(), 'eval', 'cases');

const BEARISH_HEADLINES = [
  'SEC announces sweeping enforcement action against major crypto exchanges',
  'Large fund files for bankruptcy, on-chain data shows massive outflows',
  'Regulators propose ban on retail crypto derivatives trading',
  'Exchange hack drains hundreds of millions, withdrawals frozen',
  'Macro shock: risk assets sell off as rate-hike odds spike',
];
const BULLISH_HEADLINES = [
  'Spot ETF inflows hit record highs as institutions accumulate',
  'Major payments network announces native crypto settlement support',
  'Sovereign wealth fund discloses large digital-asset allocation',
  'Regulatory clarity bill passes committee with bipartisan support',
  'Exchange reserves hit multi-year lows as supply squeeze builds',
];

async function main(): Promise<void> {
  const sourceId = process.argv[2] ?? 'btc-usdt';
  const source: EvalCase = evalCaseSchema.parse(
    JSON.parse(readFileSync(join(CASES_DIR, `${sourceId}.json`), 'utf8')),
  );

  // Determine the technical trend so we can contradict it.
  const shim = createEvalMastra();
  const withIndicators = await computeIndicatorsPhase(
    {
      candles1h: source.candles1h,
      candles4h: source.candles4h,
      candles1d: source.candles1d,
    },
    shim,
  );
  const { topDownBias } = deriveTopDownBiasPhase(withIndicators);
  // If the technical bias is NEUTRAL, contradiction is ill-defined — inject bearish shock.
  const newsSide: 'BULLISH' | 'BEARISH' = topDownBias.tradeBias === 'BEARISH' ? 'BULLISH' : 'BEARISH';
  const headlines = newsSide === 'BEARISH' ? BEARISH_HEADLINES : BULLISH_HEADLINES;

  const challenge: EvalCase = {
    ...source,
    id: `challenge-news-conflict-${sourceId}`,
    notes:
      `SYNTHETIC CHALLENGE CASE derived from ${sourceId}. News sentiment and funding rate were ` +
      `replaced to strongly contradict the technical top-down bias (${topDownBias.tradeBias}). ` +
      'Tests the conflict rules: the decision engine should downgrade confidence or HOLD, not flip counter-trend.',
    synthetic: {
      derivedFrom: sourceId,
      mutation: `news replaced with 5 strongly ${newsSide} synthetic headlines (sentimentScore ±0.9); fundingRate set to extreme ${newsSide === 'BEARISH' ? '-0.15%' : '+0.15%'}; all other data unchanged`,
    },
    news: {
      overallSentiment: newsSide,
      items: headlines.map((title, i) => ({
        title: `[synthetic] ${title}`,
        source: 'synthetic-eval-fixture',
        url: 'https://example.invalid/synthetic',
        publishedAt: source.recordedAt,
        sentiment: newsSide,
        sentimentScore: newsSide === 'BEARISH' ? -0.9 + i * 0.01 : 0.9 - i * 0.01,
      })),
    },
    onchain: {
      ...source.onchain,
      fundingRate: newsSide === 'BEARISH' ? -0.0015 : 0.0015,
      fundingBias: newsSide,
    },
  };

  const file = join(CASES_DIR, `${challenge.id}.json`);
  writeFileSync(file, JSON.stringify(challenge, null, 1));
  console.log(`[challenge] technical tradeBias=${topDownBias.tradeBias}, injected ${newsSide} news+funding`);
  console.log(`[challenge] saved → ${file}`);
}

main();
