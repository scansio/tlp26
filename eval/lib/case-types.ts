/**
 * Shared types for the eval harness: a frozen "case" is one snapshot of every
 * external input the trade-analysis pipeline consumes (candles, order book,
 * news, on-chain). Everything downstream of these inputs — indicators,
 * top-down bias, SMC, patterns, and the LLM decision — is recomputed at eval
 * time from the fixture, so runs are reproducible without any market-data or
 * news API access.
 */

import { z } from 'zod';
import {
  candleSchema,
  orderbookResultSchema,
  newsResultSchema,
  onchainResultSchema,
} from '@/lib/analysis/market-analysis';

export const evalCaseSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  exchange: z.enum(['binance', 'bybit', 'bingx']),
  recordedAt: z.string(),
  notes: z.string().default(''),
  /** Present only for synthetic variants derived from a recorded case. */
  synthetic: z
    .object({
      derivedFrom: z.string(),
      mutation: z.string(),
    })
    .optional(),
  candles1h: z.array(candleSchema),
  candles4h: z.array(candleSchema),
  candles1d: z.array(candleSchema),
  orderBook: orderbookResultSchema,
  news: newsResultSchema,
  onchain: onchainResultSchema,
});

export type EvalCase = z.infer<typeof evalCaseSchema>;

/** The decision shape both systems (baseline and workflow) must produce. */
export const decisionSchema = z.object({
  bias: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']),
  action: z.enum(['ENTER_LONG', 'ENTER_SHORT', 'HOLD']),
  entryZone: z.object({ low: z.number().nullable(), high: z.number().nullable() }),
  sl: z.number().nullable(),
  tp: z.number().nullable(),
  confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  primarySignalSource: z.string(),
  strategiesTriggered: z.array(z.string()),
  reasoning: z.string(),
});

export type Decision = z.infer<typeof decisionSchema>;
