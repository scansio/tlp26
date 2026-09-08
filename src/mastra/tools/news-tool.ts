import { createTool } from '@mastra/core/tools';
import { ApifyClient } from 'apify-client';
import { z } from 'zod';

// ─── Types ───────────────────────────────────────────────────────────────────

type Sentiment = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

interface NewsItem {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
  sentiment: Sentiment;
  sentimentScore: number;
}

interface NewsResult {
  items: NewsItem[];
  overallSentiment: Sentiment;
}

interface CryptoPanicPost {
  title: string;
  url: string;
  published_at: string;
  source: { title: string };
  votes: {
    positive?: number;
    negative?: number;
  };
}

interface CryptoPanicResponse {
  results: CryptoPanicPost[];
}

interface CoinGeckoNewsArticle {
  title: string;
  news_site?: string;
  url: string;
  updated_at?: number;
  created_at?: number;
}

interface CoinGeckoNewsResponse {
  data: CoinGeckoNewsArticle[];
}

interface ApifyNewsItem {
  title: string;
  url: string;
  publishedAt: string;
  votes?: {
    total_count?: number;
    positive_count?: number;
    like_count?: number;
  };
}

// ─── Cache ────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  data: NewsResult;
  expiresAt: number;
}

const newsCache = new Map<string, CacheEntry>();

function getCacheKey(currencies: string[]): string {
  return [...currencies].sort().join(',').toUpperCase();
}

function getCached(key: string): NewsResult | null {
  const entry = newsCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    newsCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key: string, data: NewsResult): void {
  newsCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─── Sentiment helpers ────────────────────────────────────────────────────────

function deriveSentiment(score: number): Sentiment {
  if (score > 0.6) return 'BULLISH';
  if (score < 0.4) return 'BEARISH';
  return 'NEUTRAL';
}

function computeOverallSentiment(items: NewsItem[]): Sentiment {
  if (items.length === 0) return 'NEUTRAL';
  const counts: Record<Sentiment, number> = { BULLISH: 0, BEARISH: 0, NEUTRAL: 0 };
  for (const item of items) {
    counts[item.sentiment]++;
  }
  const max = Math.max(counts.BULLISH, counts.BEARISH, counts.NEUTRAL);
  // On tie, prefer NEUTRAL
  if (counts.BULLISH === max && counts.BULLISH > counts.BEARISH && counts.BULLISH > counts.NEUTRAL) {
    return 'BULLISH';
  }
  if (counts.BEARISH === max && counts.BEARISH > counts.BULLISH && counts.BEARISH > counts.NEUTRAL) {
    return 'BEARISH';
  }
  return 'NEUTRAL';
}

// ─── Apify CryptoPanic scraper (primary) ──────────────────────────────────────

let apifyClient: ApifyClient | null = null;

function getApifyClient(): ApifyClient {
  if (!apifyClient) {
    const token = process.env.APIFY_API_TOKEN;
    if (!token) throw new Error('APIFY_API_TOKEN not set');
    apifyClient = new ApifyClient({ token });
  }
  return apifyClient;
}

async function fetchFromApify(currencies: string[]): Promise<NewsItem[]> {
  const client = getApifyClient();

  const run = await client.actor('getascraper/cryptopanic-news-scraper').call({
    currencies: currencies.map(c => c.toUpperCase()),
    newsFilter: 'Hot',
    maxItems: 5,
  });

  const { items } = await client.dataset(run.defaultDatasetId).listItems({ limit: 5 });
  const posts = items as unknown as ApifyNewsItem[];

  return posts.slice(0, 5).map((post): NewsItem => {
    const positive = post.votes?.positive_count ?? 0;
    const total = post.votes?.total_count ?? 0;
    const score = total > 0 ? positive / total : 0.5;
    return {
      title: post.title,
      source: 'CryptoPanic',
      url: post.url,
      publishedAt: post.publishedAt,
      sentiment: deriveSentiment(score),
      sentimentScore: Math.round(score * 1000) / 1000,
    };
  });
}

// ─── CryptoPanic direct API fetch ─────────────────────────────────────────────

async function fetchFromCryptoPanic(currencies: string[]): Promise<NewsItem[]> {
  const token = process.env.CRYPTOPANIC_API_TOKEN;
  if (!token) throw new Error('CRYPTOPANIC_API_TOKEN not set');

  const currencyParam = currencies.map(c => c.toUpperCase()).join(',');
  const url = `https://cryptopanic.com/api/v1/posts/?auth_token=${token}&currencies=${encodeURIComponent(currencyParam)}&filter=hot&public=true`;

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    throw new Error(`CryptoPanic responded with HTTP ${res.status}`);
  }

  const json = (await res.json()) as CryptoPanicResponse;
  const posts = json?.results ?? [];

  return posts.slice(0, 5).map((post): NewsItem => {
    const bullish = post.votes?.positive ?? 0;
    const bearish = post.votes?.negative ?? 0;
    const total = bullish + bearish;
    const score = total > 0 ? bullish / total : 0.5;
    return {
      title: post.title,
      source: post.source?.title ?? 'CryptoPanic',
      url: post.url,
      publishedAt: post.published_at,
      sentiment: deriveSentiment(score),
      sentimentScore: Math.round(score * 1000) / 1000,
    };
  });
}

// ─── CoinGecko fallback ───────────────────────────────────────────────────────

async function fetchFromCoinGecko(currencies: string[]): Promise<NewsItem[]> {
  const url = 'https://api.coingecko.com/api/v3/news';
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    throw new Error(`CoinGecko responded with HTTP ${res.status}`);
  }

  const json = (await res.json()) as CoinGeckoNewsResponse;
  const articles = json?.data ?? [];

  const upperCurrencies = currencies.map(c => c.toUpperCase());

  // Client-side filter: keep articles whose title mentions at least one currency symbol
  const filtered = upperCurrencies.length > 0
    ? articles.filter(a =>
        upperCurrencies.some(sym => a.title?.toUpperCase().includes(sym))
      )
    : articles;

  const source = filtered.length > 0 ? filtered : articles;

  return source.slice(0, 5).map((article): NewsItem => {
    const ts = article.updated_at ?? article.created_at;
    const publishedAt = ts ? new Date(ts * 1000).toISOString() : new Date().toISOString();
    return {
      title: article.title ?? '',
      source: article.news_site ?? 'CoinGecko',
      url: article.url ?? '',
      publishedAt,
      sentiment: 'NEUTRAL',
      sentimentScore: 0.5,
    };
  });
}

// ─── Core fetch logic ─────────────────────────────────────────────────────────

async function fetchNews(currencies: string[]): Promise<NewsResult> {
  const cacheKey = getCacheKey(currencies);
  const cached = getCached(cacheKey);
  if (cached) return cached;

  let items: NewsItem[] = [];

  try {
    items = await fetchFromApify(currencies);
  } catch {
    // Apify scraper unavailable or token missing — fall back to CryptoPanic direct API
    try {
      items = await fetchFromCryptoPanic(currencies);
    } catch {
      // CryptoPanic unavailable or token missing — fall back to CoinGecko
      try {
        items = await fetchFromCoinGecko(currencies);
      } catch {
        // All sources failed — return empty result gracefully
        items = [];
      }
    }
  }

  // Sort by publishedAt descending, take top 5
  items.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  const top5 = items.slice(0, 5);

  const result: NewsResult = {
    items: top5,
    overallSentiment: computeOverallSentiment(top5),
  };

  setCache(cacheKey, result);
  return result;
}

// ─── Tool definition ──────────────────────────────────────────────────────────

export const newsTool = createTool({
  id: 'crypto-news',
  description:
    'Fetches top 5 real-time crypto news items with sentiment scores for given currencies. ' +
    'Primary source: Apify CryptoPanic News Scraper actor (requires APIFY_API_TOKEN). ' +
    'Fallbacks: direct CryptoPanic API (requires CRYPTOPANIC_API_TOKEN), then CoinGecko /api/v3/news. ' +
    'Results cached for 5 minutes.',
  inputSchema: z.object({
    currencies: z
      .array(z.string())
      .describe('List of currency symbols to filter news, e.g. ["BTC", "ETH"]'),
  }),
  outputSchema: z.object({
    items: z.array(
      z.object({
        title: z.string(),
        source: z.string(),
        url: z.string(),
        publishedAt: z.string(),
        sentiment: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']),
        sentimentScore: z.number().min(0).max(1),
      })
    ),
    overallSentiment: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']),
  }),
  execute: async (inputData) => {
    return await fetchNews(inputData.currencies);
  },
});
