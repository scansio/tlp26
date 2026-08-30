/**
 * Record frozen eval cases from live market data.
 *
 * For each symbol this runs ONLY the network-dependent phases of the
 * pipeline (market data, order book, news, on-chain) through the real
 * production tools, then freezes their outputs into eval/cases/<id>.json.
 *
 * Usage:
 *   node --env-file-if-exists=.env --env-file-if-exists=.env.local \
 *     ./node_modules/.bin/tsx eval/record.ts [SYMBOL ...]
 *
 * Defaults to a 12-symbol basket spanning majors, alts, and meme coins so
 * the recorded set naturally covers different market regimes.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fetchMarketDataPhase,
  analyzeOrderBookPhase,
  fetchNewsPhase,
  fetchOnchainSignalsPhase,
} from '@/lib/analysis/market-analysis';
import { createEvalMastra } from './lib/shim';
import type { EvalCase } from './lib/case-types';

const DEFAULT_SYMBOLS = [
  'BTC/USDT',
  'ETH/USDT',
  'SOL/USDT',
  'BNB/USDT',
  'XRP/USDT',
  'DOGE/USDT',
  'ADA/USDT',
  'AVAX/USDT',
  'LINK/USDT',
  'LTC/USDT',
  'DOT/USDT',
  'ATOM/USDT',
];

const CASES_DIR = join(process.cwd(), 'eval', 'cases');

async function recordCase(symbol: string): Promise<void> {
  const mastra = createEvalMastra();
  const exchange = 'binance' as const;
  const base = { symbol, exchange };

  console.log(`[record] ${symbol}: fetching market data…`);
  const withCandles = await fetchMarketDataPhase(base, mastra);

  console.log(`[record] ${symbol}: fetching order book, news, on-chain…`);
  const [withOb, withNews, withOnchain] = await Promise.all([
    analyzeOrderBookPhase(base, mastra),
    fetchNewsPhase(base, mastra),
    fetchOnchainSignalsPhase(base, mastra),
  ]);

  const id = symbol.replace('/', '-').toLowerCase();
  const evalCase: EvalCase = {
    id,
    symbol,
    exchange,
    recordedAt: new Date().toISOString(),
    notes: 'Recorded live from public APIs (Binance via CCXT, CryptoPanic/CoinGecko, Coinglass/Santiment when keys present).',
    candles1h: withCandles.candles1h,
    candles4h: withCandles.candles4h,
    candles1d: withCandles.candles1d,
    orderBook: withOb.orderBook,
    news: withNews.news,
    onchain: withOnchain.onchain,
  };

  const file = join(CASES_DIR, `${id}.json`);
  writeFileSync(file, JSON.stringify(evalCase, null, 1));
  console.log(`[record] ${symbol}: saved → ${file}`);
}

async function main(): Promise<void> {
  mkdirSync(CASES_DIR, { recursive: true });
  const symbols = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_SYMBOLS;

  const failures: string[] = [];
  for (const symbol of symbols) {
    try {
      await recordCase(symbol);
    } catch (err) {
      failures.push(symbol);
      console.error(`[record] ${symbol}: FAILED —`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`\n[record] done: ${symbols.length - failures.length}/${symbols.length} cases recorded.`);
  if (failures.length > 0) {
    console.log(`[record] failed symbols: ${failures.join(', ')}`);
    process.exitCode = 1;
  }
}

main();
