import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const COINGLASS_BASE = 'https://open-api-v4.coinglass.com/api';
const SANTIMENT_GRAPHQL = 'https://api.santiment.net/graphql';

function deriveFundingBias(rate: number): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
  if (rate > 0.05) return 'BEARISH';
  if (rate < -0.01) return 'BULLISH';
  return 'NEUTRAL';
}

async function fetchCoinglassFundingRate(symbol: string, apiKey: string): Promise<number> {
  // symbol like BTC/USDT → BTC_USDT for Coinglass
  const cgSymbol = symbol.replace('/', '_');
  const url = `${COINGLASS_BASE}/futures/funding-rate/current?symbol=${encodeURIComponent(cgSymbol)}`;
  const res = await fetch(url, { headers: { 'CG-API-KEY': apiKey } });
  if (!res.ok) return 0;
  const data = (await res.json()) as {
    code: string;
    data?: { fundingRate?: number };
  };
  if (data.code !== '0' || !data.data) return 0;
  // API returns percentage already (e.g. 0.01 = 0.01%)
  return data.data.fundingRate ?? 0;
}

async function fetchCoinglassOI(
  symbol: string,
  apiKey: string,
): Promise<{ openInterest: number; oiChange24h: number }> {
  const cgSymbol = symbol.replace('/', '_');
  const url = `${COINGLASS_BASE}/futures/open-interest/exchange-list?symbol=${encodeURIComponent(cgSymbol)}`;
  const res = await fetch(url, { headers: { 'CG-API-KEY': apiKey } });
  if (!res.ok) return { openInterest: 0, oiChange24h: 0 };
  const data = (await res.json()) as {
    code: string;
    data?: { openInterest?: number; openInterestChange24h?: number };
  };
  if (data.code !== '0' || !data.data) return { openInterest: 0, oiChange24h: 0 };
  return {
    openInterest: data.data.openInterest ?? 0,
    oiChange24h: data.data.openInterestChange24h ?? 0,
  };
}

async function fetchCoinglassLiquidations(
  symbol: string,
  apiKey: string,
): Promise<Array<{ price: number; totalLiquidationUsd: number; side: 'LONG' | 'SHORT' }>> {
  const cgSymbol = symbol.replace('/', '_');
  const url = `${COINGLASS_BASE}/futures/liquidation/heatmap/model2?symbol=${encodeURIComponent(cgSymbol)}`;
  const res = await fetch(url, { headers: { 'CG-API-KEY': apiKey } });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    code: string;
    data?: Array<{
      price?: number;
      longLiquidationUsd?: number;
      shortLiquidationUsd?: number;
    }>;
  };
  if (data.code !== '0' || !Array.isArray(data.data)) return [];

  // Each entry has both long and short liquidation amounts at a price level
  const levels: Array<{ price: number; totalLiquidationUsd: number; side: 'LONG' | 'SHORT' }> = [];
  for (const entry of data.data) {
    const price = entry.price ?? 0;
    if (entry.longLiquidationUsd && entry.longLiquidationUsd > 0) {
      levels.push({ price, totalLiquidationUsd: entry.longLiquidationUsd, side: 'LONG' });
    }
    if (entry.shortLiquidationUsd && entry.shortLiquidationUsd > 0) {
      levels.push({ price, totalLiquidationUsd: entry.shortLiquidationUsd, side: 'SHORT' });
    }
  }
  // Return top 20 by total liquidation USD descending
  return levels.sort((a, b) => b.totalLiquidationUsd - a.totalLiquidationUsd).slice(0, 20);
}

async function fetchSantimentNetflow(baseCurrency: string, apiKey: string): Promise<number> {
  // baseCurrency like "BTC"
  const slug = baseCurrency.toLowerCase();
  const now = new Date();
  const to = now.toISOString().split('T')[0];
  const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const query = `{
    getMetric(metric: "exchange_balance") {
      timeseriesDataJson(
        slug: "${slug}"
        from: "${from}T00:00:00Z"
        to: "${to}T23:59:59Z"
        interval: "1d"
      )
    }
  }`;

  const res = await fetch(SANTIMENT_GRAPHQL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Apikey ${apiKey}`,
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) return 0;

  const data = (await res.json()) as {
    data?: {
      getMetric?: {
        timeseriesDataJson?: string;
      };
    };
    errors?: unknown[];
  };

  if (data.errors || !data.data?.getMetric?.timeseriesDataJson) return 0;

  try {
    const parsed = JSON.parse(data.data.getMetric.timeseriesDataJson) as Array<{
      datetime?: string;
      value?: number;
    }>;
    if (!parsed.length) return 0;
    // exchange_balance delta: last value minus previous value = net inflow
    if (parsed.length < 2) return 0;
    const latest = parsed[parsed.length - 1].value ?? 0;
    const prev = parsed[parsed.length - 2].value ?? 0;
    // positive = coins moved TO exchange (sell pressure), negative = coins moved OUT
    return latest - prev;
  } catch {
    return 0;
  }
}

export const onchainTool = createTool({
  id: 'onchain-data',
  description:
    'Fetches on-chain metrics and derivatives data including funding rates, open interest, liquidation levels (Coinglass), and exchange netflow (Santiment) to identify market positioning and upcoming liquidation cascades.',
  inputSchema: z.object({
    symbol: z.string().describe('Trading pair symbol, e.g. BTC/USDT'),
    baseCurrency: z.string().describe('Base currency symbol, e.g. BTC'),
  }),
  outputSchema: z.object({
    fundingRate: z.number().describe('Current funding rate as a percentage'),
    fundingBias: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']).describe(
      'BULLISH if funding rate < -0.01%, BEARISH if > 0.05%, else NEUTRAL',
    ),
    openInterest: z.number().describe('Total open interest in USD'),
    oiChange24h: z.number().describe('Open interest change over 24h as a percentage'),
    exchangeNetflow: z.number().describe(
      'Exchange netflow for the base currency; positive = inflow (sell pressure), negative = outflow',
    ),
    liquidationLevels: z
      .array(
        z.object({
          price: z.number(),
          totalLiquidationUsd: z.number(),
          side: z.enum(['LONG', 'SHORT']),
        }),
      )
      .describe('Top liquidation price levels sorted by total liquidation USD'),
  }),
  execute: async (inputData) => {
    const { symbol, baseCurrency } = inputData;

    const coinglassKey = process.env.COINGLASS_API_KEY ?? '';
    const santimentKey = process.env.SANTIMENT_API_KEY ?? '';

    // Fetch all data; degrade gracefully on missing keys or API errors
    const [fundingRate, { openInterest, oiChange24h }, liquidationLevels, exchangeNetflow] =
      await Promise.all([
        coinglassKey
          ? fetchCoinglassFundingRate(symbol, coinglassKey).catch(() => 0)
          : Promise.resolve(0),
        coinglassKey
          ? fetchCoinglassOI(symbol, coinglassKey).catch(() => ({
              openInterest: 0,
              oiChange24h: 0,
            }))
          : Promise.resolve({ openInterest: 0, oiChange24h: 0 }),
        coinglassKey
          ? fetchCoinglassLiquidations(symbol, coinglassKey).catch(() => [])
          : Promise.resolve([]),
        santimentKey
          ? fetchSantimentNetflow(baseCurrency, santimentKey).catch(() => 0)
          : Promise.resolve(0),
      ]);

    const fundingBias = deriveFundingBias(fundingRate);

    return {
      fundingRate,
      fundingBias,
      openInterest,
      oiChange24h,
      exchangeNetflow,
      liquidationLevels,
    };
  },
});
