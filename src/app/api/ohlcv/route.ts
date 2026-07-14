import { NextRequest, NextResponse } from 'next/server';
import ccxt, { type Exchange, NetworkError, ExchangeError } from 'ccxt';

const SUPPORTED_TF = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w'] as const;
type TF = (typeof SUPPORTED_TF)[number];

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const symbol = searchParams.get('symbol');
  const timeframe = (searchParams.get('timeframe') ?? '1h') as TF;
  const limit = Math.min(Number(searchParams.get('limit') ?? 300), 1000);

  if (!symbol) {
    return NextResponse.json({ error: 'symbol is required' }, { status: 400 });
  }
  if (!SUPPORTED_TF.includes(timeframe)) {
    return NextResponse.json({ error: `unsupported timeframe: ${timeframe}` }, { status: 400 });
  }

  try {
    const client = new (ccxt.binance as new (config?: object) => Exchange)({ enableRateLimit: true });
    await client.loadMarkets();
    const raw = await client.fetchOHLCV(symbol, timeframe, undefined, limit);

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

    return NextResponse.json({ candles, symbol, timeframe });
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
