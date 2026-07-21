import { handleChatStream } from '@mastra/ai-sdk'
import { toAISdkV5Messages } from '@mastra/ai-sdk/ui'
import { createUIMessageStreamResponse } from 'ai'
import { auth } from '@clerk/nextjs/server'
import ccxt, { type Exchange } from 'ccxt'
import { and, eq } from 'drizzle-orm'
import { mastra } from '@/mastra'
import { db } from '@/db'
import { userRiskProfiles, userExchanges } from '@/db/schema'
import { decrypt } from '@/lib/crypto'
import { NextResponse } from 'next/server'

// ---------------------------------------------------------------------------
// Build a human-readable risk context block injected into the agent's system prompt
// ---------------------------------------------------------------------------

async function buildRiskContext(userId: string): Promise<string> {
  // Fetch risk profile
  const [profile] = await db
    .select()
    .from(userRiskProfiles)
    .where(eq(userRiskProfiles.userId, userId))
    .limit(1);

  if (!profile || !profile.isActive) {
    return 'RISK PROFILE: not set — user has not completed onboarding.';
  }

  const isPaper = (profile.executionMode ?? 'paper') === 'paper';
  const paperBalance = Number(profile.paperBalanceUsd ?? '10000.00');

  // Resolve account balance
  let balance: number | null = isPaper ? paperBalance : null;
  let balanceNote = isPaper ? '(paper mode — virtual balance)' : '';

  if (!isPaper) {
    // Try fetching live balance with a 2s timeout
    try {
      const [exchangeRow] = await db
        .select({
          exchangeName: userExchanges.exchangeName,
          encryptedApiKey: userExchanges.encryptedApiKey,
          encryptedApiSecret: userExchanges.encryptedApiSecret,
          encryptedPassphrase: userExchanges.encryptedPassphrase,
        })
        .from(userExchanges)
        .where(
          and(
            eq(userExchanges.userId, userId),
            eq(userExchanges.status, 'active'),
          ),
        )
        .limit(1);

      if (exchangeRow) {
        const apiKey = decrypt(exchangeRow.encryptedApiKey);
        const secret = decrypt(exchangeRow.encryptedApiSecret);
        const password = exchangeRow.encryptedPassphrase
          ? decrypt(exchangeRow.encryptedPassphrase)
          : undefined;

        const ExchangeClass = (ccxt as unknown as Record<string, new (c: object) => Exchange>)[
          exchangeRow.exchangeName
        ];

        if (ExchangeClass) {
          const client = new ExchangeClass({
            apiKey,
            secret,
            ...(password ? { password } : {}),
          });

          const fetchWithTimeout = Promise.race([
            client.fetchBalance(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('timeout')), 2000),
            ),
          ]);

          const bal = await fetchWithTimeout;
          const total =
            (bal['USDT']?.total ?? 0) +
            (bal['USDC']?.total ?? 0) +
            (bal['USD']?.total ?? 0);
          if (total > 0) {
            balance = total;
            balanceNote = `(live — ${exchangeRow.exchangeName})`;
          }
        }
      }
    } catch {
      balanceNote = '(unavailable — exchange fetch failed; ask user to reconnect exchange)';
    }
  }

  const balanceLine =
    balance !== null
      ? `$${balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${balanceNote}`
      : `unknown ${balanceNote}`;

  const strategies = (profile.strategies as string[] | null)?.join(', ') || 'not specified';
  const timeframes = (profile.preferredTimeframes as string[] | null)?.join(', ') || 'all';
  const symbols = (profile.allowedSymbols as string[] | null)?.length
    ? (profile.allowedSymbols as string[]).join(', ')
    : 'all symbols';

  return `=== USER RISK PROFILE ===
Account Balance: ${balanceLine}
Risk per Trade: ${profile.riskPerTradePct}%
Min Risk:Reward Ratio: ${profile.minRiskRewardRatio ?? '1.50'}:1
Max Daily Loss: ${profile.maxDailyLossPct}%
Max Trades/Day: ${profile.maxTradesPerDay}
Slippage Estimate: ${profile.slippagePct ?? '0.050'}%
Strategies: ${strategies}
Preferred Timeframes: ${timeframes}
Allowed Symbols: ${symbols}
Execution Mode: ${profile.tradingMode ?? 'manual'} (${isPaper ? 'paper' : 'live'} trading)
===`;
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const params = await req.json()
  const THREAD_ID = params.threadId ?? userId
  const RESOURCE_ID = `chat-${userId}`

  // Build risk context — fetch profile + balance in parallel with the rest of request handling
  const riskContext = await buildRiskContext(userId).catch(() => 'RISK PROFILE: unavailable');

  const stream = await handleChatStream({
    mastra,
    agentId: 'market-chat-agent',
    // Cache the system prompt at the provider level (Anthropic ephemeral cache).
    // This is a no-op for Groq/OpenAI/Cerebras — safe to leave on regardless of AI_PROVIDER.
    defaultOptions: {
      providerOptions: {
        anthropic: {
          cacheControl: { type: 'ephemeral' },
        },
      },
    },
    params: {
      ...params,
      context: [
        {
          role: 'system',
          content: `userId:${userId}\n\n${riskContext}`,
        },
      ],
      memory: {
        ...params.memory,
        thread: THREAD_ID,
        resource: RESOURCE_ID,
      },
    },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createUIMessageStreamResponse({ stream: stream as any })
}

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const url = new URL(req.url)
  const THREAD_ID = url.searchParams.get('threadId') ?? userId
  const RESOURCE_ID = `chat-${userId}`

  const memory = await mastra.getAgentById('market-chat-agent').getMemory()
  let response = null

  try {
    response = await memory?.recall({
      threadId: THREAD_ID,
      resourceId: RESOURCE_ID,
    })
  } catch {
    console.log('No previous messages found.')
  }

  const uiMessages = toAISdkV5Messages(response?.messages || [])

  return NextResponse.json(uiMessages)
}
