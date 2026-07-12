# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This is a **Next.js 16 + Mastra** trading hub platform — a multi-user SaaS where a Mastra AI agent makes trading decisions based on real-time crypto news, OHLCV chart analysis, on-chain signals, and SMC/technical strategies, then executes trades via BingX, Binance, or Bybit.

**CRITICAL:** Before writing any Mastra code or answering Mastra questions, load the Mastra skill first via `/mastra` or the Skill tool. Mastra APIs change frequently and training data is likely outdated.

## Commands

```bash
npm run dev          # Start Next.js dev server at localhost:3000
npm run build        # Production build
npm run start        # Production server
npm run lint         # ESLint
npm run db:generate  # Generate Drizzle migration from schema changes
npm run db:migrate   # Apply pending migrations to the database
```

There are no test scripts configured.

## Architecture

### How the layers connect

```
Next.js pages (src/app/)
  └── API routes (src/app/api/)
        └── Mastra instance (src/mastra/index.ts)
              ├── Agents (src/mastra/agents/)   ← trading-agent, setup-agent
              ├── Tools (src/mastra/tools/)     ← market data, indicators, SMC, news, on-chain, order book
              └── Workflows (src/mastra/workflows/)  ← trade-analysis-workflow (9-step pipeline)

Database layer (src/db/)
  ├── src/db/index.ts     ← shared pg.Pool + Drizzle client singleton (HMR-safe)
  ├── src/db/schema.ts    ← all custom table definitions (pgTable via drizzle-orm)
  └── drizzle/migrations/ ← generated migration files

Mastra storage (src/mastra/storage.ts)
  └── PostgresStore from @mastra/pg — uses shared pg.Pool from src/db/index.ts
```

### Database

**PostgreSQL** managed by **Drizzle ORM**. One `pg.Pool` shared between:
- **Drizzle** (`src/db/index.ts`) — custom application tables
- **Mastra `PostgresStore`** (`src/mastra/storage.ts`) — Mastra's internal tables (`mastra_threads`, `mastra_messages`, `mastra_traces`, etc.)

Custom tables (defined in `src/db/schema.ts`):
- `user_risk_profiles` — strategies, limits, execution mode, kill switch, trading mode
- `user_exchanges` — AES-256-GCM encrypted API keys per exchange
- `user_notifications` — Telegram/Discord webhook config
- `trade_signals` — AI-generated and TradingView signals with status lifecycle
- `trade_executions` — filled orders with P&L, supports paper and live mode
- `signal_publishers` / `signal_subscriptions` — copy trading schema (schema-only, feature post-launch)
- `ohlcv_cache` — cached historical candle data for backtesting
- `backtest_runs` — stored backtest results with equity curve
- `publisher_earnings` — copy trading performance fees

Always use `global` singleton pattern for `pg.Pool` and `PostgresStore` to avoid duplicate connections during Next.js HMR.

### Mastra instance (`src/mastra/index.ts`)

Central singleton that wires together:
- **Storage**: `PostgresStore` from `@mastra/pg` (shared pool from `src/db/index.ts`)
- **Logger**: Pino logger via `@mastra/loggers`
- **Observability**: OpenTelemetry-style traces via `@mastra/observability` with `DefaultExporter` and optional `CloudExporter`

### Agents

Agents are defined with `new Agent()` from `@mastra/core/agent`.

- `trading-agent` — main decision agent; synthesizes tool outputs into ENTER_LONG/ENTER_SHORT/HOLD with full reasoning. Must cite tool data only — never invent price levels.
- `setup-agent` — onboarding agent; parses natural language risk profile descriptions into structured fields.
- `weather-agent` — legacy example agent (keep for reference).

### Tools

Defined with `createTool()` from `@mastra/core/tools`. Input/output schemas use **Zod v4** (`zod`). The `execute` function receives `inputData`.

| Tool | File | Purpose |
|------|------|---------|
| `market-data-tool` | `src/mastra/tools/market-data-tool.ts` | OHLCV via CCXT |
| `indicators-tool` | `src/mastra/tools/indicators-tool.ts` | RSI, EMA, MACD, BB, ADX via `technicalindicators` |
| `news-tool` | `src/mastra/tools/news-tool.ts` | CryptoPanic + CoinGecko sentiment |
| `onchain-tool` | `src/mastra/tools/onchain-tool.ts` | Funding rates + liquidation levels (Coinglass) + netflow (Santiment) |
| `smc-tool` | `src/mastra/tools/smc-tool.ts` | FVG, Order Blocks, BOS/ChoCH, liquidity sweeps |
| `pattern-tool` | `src/mastra/tools/pattern-tool.ts` | H&S, double top/bottom, triangles, flags, wedges |
| `orderbook-tool` | `src/mastra/tools/orderbook-tool.ts` | L2 liquidity walls + bid/ask imbalance via CCXT |
| `risk-tool` | `src/mastra/tools/risk-tool.ts` | Position sizing with fee + slippage model |
| `execute-trade-tool` | `src/mastra/tools/execute-trade-tool.ts` | CCXT order placement (live + paper mode) |

### Workflows

Defined with `createWorkflow()` / `createStep()` from `@mastra/core/workflows`. Steps chain via `.then()`. Each step has `inputSchema`/`outputSchema` (Zod) and `execute({ inputData, mastra })`. Workflows must call `.commit()` before export.

- `trade-analysis-workflow` — 9-step pipeline: market data → indicators → SMC → patterns → order book → news + on-chain (parallel) → agent decision → risk sizing → route signal

### Auth

**Clerk** (`@clerk/nextjs`) handles authentication. `src/middleware.ts` protects all routes except `/` and `/api/webhooks/tradingview`. All API routes read `auth().userId` from Clerk.

### Frontend components

- `src/components/ai-elements/` — Pre-built AI chat UI primitives (Conversation, Message, Tool, PromptInput, etc.)
- `src/components/ui/` — shadcn/ui base components
- Chat pages use `useChat` from `@ai-sdk/react` with `DefaultChatTransport`

### Path alias

`@/*` maps to `./src/*` (configured in `tsconfig.json` and used throughout).

## Key environment variables

```bash
DATABASE_URL                  # PostgreSQL connection string (required)
CLERK_SECRET_KEY              # Clerk backend secret (required)
CLERK_PUBLISHABLE_KEY         # Clerk frontend key (required)
CLERK_WEBHOOK_SECRET          # Clerk webhook signature verification (required)
EXCHANGE_KEY_ENCRYPTION_SECRET # AES-256-GCM key for encrypting exchange API keys (required)
CRYPTOPANIC_API_TOKEN         # CryptoPanic news API (optional, falls back to CoinGecko)
COINGLASS_API_KEY             # Coinglass funding rates + liquidation data (optional)
MASTRA_CLOUD_ACCESS_TOKEN     # Mastra Cloud trace export (optional)
```

## Package manager

This project uses **npm** (`package-lock.json`). Use `npm install`, `npm run`, etc.
