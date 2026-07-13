import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { eq, and, count } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import ccxt, { type Exchange } from 'ccxt';
import { db } from '@/db';
import { userExchanges, userRiskProfiles, tradeExecutions } from '@/db/schema';
import { encrypt } from '@/lib/crypto';

// ---------------------------------------------------------------------------
// Supported exchanges (lowercase CCXT IDs)
// ---------------------------------------------------------------------------
const SUPPORTED_EXCHANGES = ['binance', 'bingx', 'bybit'] as const;
type SupportedExchange = (typeof SUPPORTED_EXCHANGES)[number];

// Map of exchange → typical spot market pairs for display
const EXCHANGE_PAIRS: Record<SupportedExchange, string[]> = {
  binance: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT'],
  bingx:   ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
  bybit:   ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT'],
};

// ---------------------------------------------------------------------------
// Helper — instantiate and test CCXT exchange
// ---------------------------------------------------------------------------
async function validateExchangeKeys(
  exchangeName: SupportedExchange,
  apiKey: string,
  apiSecret: string,
  passphrase?: string,
): Promise<void> {
  const ExchangeClass = ccxt[exchangeName as keyof typeof ccxt] as new (
    config?: object,
  ) => Exchange;

  if (!ExchangeClass) {
    throw new Error(`Exchange "${exchangeName}" is not supported by CCXT`);
  }

  const config: Record<string, string> = {
    apiKey,
    secret: apiSecret,
  };
  if (passphrase) {
    config.password = passphrase;
  }

  const exchange = new ExchangeClass(config);

  // fetchBalance() confirms the keys are valid and have at least read-level permission.
  // No orders are placed.
  await exchange.fetchBalance();
}

// ---------------------------------------------------------------------------
// POST /api/exchanges — connect a new exchange
// ---------------------------------------------------------------------------
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { exchangeName, apiKey, apiSecret, passphrase } = body as {
    exchangeName?: string;
    apiKey?: string;
    apiSecret?: string;
    passphrase?: string;
  };

  // --- Input validation ---
  if (!exchangeName || typeof exchangeName !== 'string') {
    return NextResponse.json({ error: 'exchangeName is required' }, { status: 400 });
  }
  const normalizedExchange = exchangeName.toLowerCase() as SupportedExchange;
  if (!SUPPORTED_EXCHANGES.includes(normalizedExchange)) {
    return NextResponse.json(
      { error: `Unsupported exchange. Supported: ${SUPPORTED_EXCHANGES.join(', ')}` },
      { status: 400 },
    );
  }
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
    return NextResponse.json({ error: 'apiKey is required' }, { status: 400 });
  }
  if (!apiSecret || typeof apiSecret !== 'string' || apiSecret.trim() === '') {
    return NextResponse.json({ error: 'apiSecret is required' }, { status: 400 });
  }

  // --- Validate keys against the exchange (no orders placed) ---
  try {
    await validateExchangeKeys(
      normalizedExchange,
      apiKey.trim(),
      apiSecret.trim(),
      passphrase?.trim(),
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unknown error during key validation';

    // Surface actionable errors — avoid leaking raw stack traces
    if (
      message.toLowerCase().includes('invalid') ||
      message.toLowerCase().includes('unauthorized') ||
      message.toLowerCase().includes('authentication') ||
      message.toLowerCase().includes('signature') ||
      message.toLowerCase().includes('permission') ||
      message.toLowerCase().includes('api-key')
    ) {
      return NextResponse.json(
        {
          error: 'API key validation failed: keys are invalid or have insufficient permissions.',
          detail: message,
        },
        { status: 400 },
      );
    }

    // Network/timeout — likely a transient issue
    return NextResponse.json(
      {
        error: 'Could not reach the exchange to validate keys. Please try again.',
        detail: message,
      },
      { status: 400 },
    );
  }

  // --- Encrypt and persist ---
  const encryptedApiKey = encrypt(apiKey.trim());
  const encryptedApiSecret = encrypt(apiSecret.trim());
  const encryptedPassphrase = passphrase?.trim() ? encrypt(passphrase.trim()) : null;

  const [row] = await db
    .insert(userExchanges)
    .values({
      userId,
      exchangeName: normalizedExchange,
      encryptedApiKey,
      encryptedApiSecret,
      encryptedPassphrase: encryptedPassphrase ?? undefined,
      status: 'active',
    })
    .returning({
      id: userExchanges.id,
      exchangeName: userExchanges.exchangeName,
      status: userExchanges.status,
      connectedAt: userExchanges.connectedAt,
    });

  return NextResponse.json(
    {
      id: row.id,
      exchangeName: row.exchangeName,
      status: row.status,
      connectedAt: row.connectedAt,
      supportedPairs: EXCHANGE_PAIRS[normalizedExchange] ?? [],
    },
    { status: 201 },
  );
}

// ---------------------------------------------------------------------------
// GET /api/exchanges — list connected exchanges + webhook config (never returns keys)
// ---------------------------------------------------------------------------
export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  // Fetch connected exchanges
  const rows = await db
    .select({
      id: userExchanges.id,
      exchangeName: userExchanges.exchangeName,
      status: userExchanges.status,
      connectedAt: userExchanges.connectedAt,
    })
    .from(userExchanges)
    .where(eq(userExchanges.userId, userId));

  // Fetch open position counts per exchange for pre-delete warning
  const openCounts = await db
    .select({
      exchangeName: tradeExecutions.exchangeName,
      openCount: count(tradeExecutions.id),
    })
    .from(tradeExecutions)
    .where(
      and(
        eq(tradeExecutions.userId, userId),
        eq(tradeExecutions.status, 'open'),
      ),
    )
    .groupBy(tradeExecutions.exchangeName);

  const openCountMap = Object.fromEntries(
    openCounts.map((r) => [r.exchangeName, Number(r.openCount)]),
  );

  const exchanges = rows.map((row) => ({
    ...row,
    supportedPairs: EXCHANGE_PAIRS[(row.exchangeName as SupportedExchange)] ?? [],
    openPositions: openCountMap[row.exchangeName] ?? 0,
  }));

  // Fetch or provision webhook token (upsert-on-read)
  const profiles = await db
    .select({ webhookToken: userRiskProfiles.webhookToken })
    .from(userRiskProfiles)
    .where(eq(userRiskProfiles.userId, userId))
    .limit(1);

  let webhookToken: string;
  if (profiles.length === 0 || profiles[0].webhookToken == null) {
    webhookToken = nanoid(32);
    await db
      .insert(userRiskProfiles)
      .values({ userId, webhookToken })
      .onConflictDoUpdate({
        target: userRiskProfiles.userId,
        set: { webhookToken, updatedAt: new Date() },
      });
  } else {
    webhookToken = profiles[0].webhookToken;
  }

  const origin = new URL(req.url).origin;
  const webhookUrl = `${origin}/api/webhooks/tradingview`;

  return NextResponse.json({ exchanges, webhookUrl, webhookToken });
}
