import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import ccxt, { type Exchange, NetworkError, ExchangeError } from 'ccxt';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { userExchanges } from '@/db/schema';
import { toExchangeSymbol, type MarketType } from '@/mastra/tools/market-symbol';
import { applyPublicDataMirror } from '@/mastra/tools/exchange-public-client';

const SUPPORTED_TF = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w'] as const;
type TF = (typeof SUPPORTED_TF)[number];

const SUPPORTED_EXCHANGES = ['binance', 'bingx', 'bybit'] as const;
type SupportedExchange = (typeof SUPPORTED_EXCHANGES)[number];

async function resolveExchangeId(userId: string | null, requested: string | null): Promise<SupportedExchange> {
  if (requested && (SUPPORTED_EXCHANGES as readonly string[]).includes(requested)) {
    return requested as SupportedExchange;
  }
  if (!userId) return 'binance';

  const [row] = await db
    .select({ exchangeName: userExchanges.exchangeName })
    .from(userExchanges)
    .where(and(eq(userExchanges.userId, userId), eq(userExchanges.status, 'active')))
    .limit(1);

  if (row && (SUPPORTED_EXCHANGES as readonly string[]).includes(row.exchangeName)) {
    return row.exchangeName as SupportedExchange;
  }
  return 'binance';
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const symbol = searchParams.get('symbol');
  const timeframe = (searchParams.get('timeframe') ?? '1h') as TF;
  const limit = Math.min(Number(searchParams.get('limit') ?? 300), 1000);
  const marketType: MarketType = searchParams.get('marketType') === 'swap' ? 'swap' : 'spot';

  if (!symbol) {
    return NextResponse.json({ error: 'symbol is required' }, { status: 400 });
  }
  if (!SUPPORTED_TF.includes(timeframe)) {
    return NextResponse.json({ error: `unsupported timeframe: ${timeframe}` }, { status: 400 });
  }

  const { userId } = await auth();
  const exchangeId = await resolveExchangeId(userId, searchParams.get('exchange'));
  const exchangeSymbol = toExchangeSymbol(symbol, marketType);

  try {
    const ExchangeClass = ccxt[exchangeId] as new (config?: object) => Exchange;
    const client = new ExchangeClass({ enableRateLimit: true });
    applyPublicDataMirror(client, exchangeId, marketType);

    await client.loadMarkets();
    if (!client.markets[exchangeSymbol]) {
      return NextResponse.json(
        { error: `Symbol '${symbol}' not found on ${exchangeId} (${marketType} market).` },
        { status: 400 },
      );
    }

    const raw = await client.fetchOHLCV(exchangeSymbol, timeframe, undefined, limit);

    const candles = raw
      .filter(Array.isArray)
      .map((c) => ({
        timestamp: c[0] as number,
        open: c[1] as number,
        high: c[2] as number,
        low: c[3] as number,
        close: c[4] as number,
        volume: c[5] as number,
      }));

    return NextResponse.json({ candles, symbol, timeframe, exchange: exchangeId });
  } catch (err) {
    if (err instanceof NetworkError) {
      return NextResponse.json({ error: 'Exchange unreachable' }, { status: 503 });
    }
    if (err instanceof ExchangeError) {
      return NextResponse.json({ error: (err as Error).message }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to fetch OHLCV data' }, { status: 500 });
  }
}
