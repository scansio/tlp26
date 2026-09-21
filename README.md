# TLP26 — AI Trading Hub

A multi-user SaaS platform where a Mastra AI agent makes trading decisions based on real-time crypto news, OHLCV chart analysis, on-chain signals, and SMC/technical strategies, then executes trades via BingX, Binance, or Bybit.

> **🏆 Hackathon submission:** see **[HACKATHON.md](./HACKATHON.md)** for the problem
> statement, the Improvement Changelog, the measured baseline-vs-workflow evaluation,
> the reproduction guide (one LLM key, no other infrastructure), and agent trajectories.

## Who this is for, and the bottleneck it removes

The intended user is a **retail crypto trader**. A disciplined trade decision requires
reconciling seven heterogeneous sources — multi-timeframe OHLCV, technical indicators,
smart-money-concept structures, chart patterns, order-book liquidity, news sentiment, and
derivatives/on-chain data. Doing that by hand takes 30–60 minutes per symbol and the
result decays within the hour. Doing it with a single LLM prompt produces confident but
unsafe output: invented price levels, entries without stop-losses, counter-trend gambles.

TLP26 replaces both with a 9-step agentic pipeline: deterministic code fetches and
computes the evidence, a constrained decision agent synthesizes it under hard risk rules
(no entry without SL/TP, no counter-trend entries, minimum 1.5 risk:reward), and every
resulting signal is risk-sized and executed in **paper mode by default** — live trading
requires the user's own exchange keys and explicit opt-in, and manual mode gates every
trade behind human approval.

## Prerequisites

- [Node.js](https://nodejs.org/) v22+ (the eval scripts use `--env-file-if-exists`, added in v22.9)
- [Docker](https://docs.docker.com/get-docker/) + [Docker Compose](https://docs.docker.com/compose/install/) v2+
- npm (comes with Node.js)

## Local Development Setup

### 1. Clone and install dependencies

```bash
git clone <repo-url>
cd tlp26
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env.local
```

Edit `.env.local` and fill in the required values. The `DATABASE_URL` is pre-configured for the Docker service below.

**Generate the encryption secret** (required for storing exchange API keys):

```bash
openssl rand -hex 32
```

Copy the output and set it as `EXCHANGE_KEY_ENCRYPTION_SECRET` in `.env.local`. Keep this value secret and consistent — changing it will invalidate all stored exchange API keys.

### 3. Start dev services (PostgreSQL)

```bash
docker compose up -d
```

This starts a PostgreSQL 16 container on port `5432`. Data is persisted in a named Docker volume (`postgres_data`).

Verify the container is healthy:

```bash
docker compose ps
```

### 4. Run database migrations

```bash
npm run db:migrate
```

### 5. Start the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Docker Compose reference

| Command | Description |
|---|---|
| `docker compose up -d` | Start services in the background |
| `docker compose down` | Stop and remove containers (data volume is preserved) |
| `docker compose down -v` | Stop containers **and delete all data** |
| `docker compose logs -f postgres` | Tail PostgreSQL logs |
| `docker compose ps` | Check container status and health |

---

## Database workflow

```bash
# After editing src/db/schema.ts — generate a new migration
npm run db:generate

# Apply pending migrations
npm run db:migrate
```

---

## Available scripts

```bash
npm run dev          # Start Next.js dev server (localhost:3000)
npm run build        # Production build
npm run start        # Production server
npm run lint         # ESLint
npm run db:generate  # Generate Drizzle migration from schema changes
npm run db:migrate   # Apply pending migrations to the database

# Evaluation harness (no DB/Clerk needed — one LLM API key only; see HACKATHON.md)
npm run eval           # baseline + enriched + workflow (3 runs each) + report
npm run eval:baseline  # direct prompt, raw candles only
npm run eval:enriched  # direct prompt + tool data, no constraint rules
npm run eval:solution  # full production pipeline on the frozen fixtures
npm run eval:report    # aggregate results into eval/results/REPORT.md
npm run eval:record    # (optional) re-record fixtures from live APIs
npm run eval:challenge # (optional) derive the synthetic conflict case
```

---

## Key environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `CLERK_SECRET_KEY` | Yes | Clerk backend secret |
| `CLERK_PUBLISHABLE_KEY` | Yes | Clerk frontend key |
| `CLERK_WEBHOOK_SECRET` | Yes | Clerk webhook signature verification |
| `EXCHANGE_KEY_ENCRYPTION_SECRET` | Yes | AES-256-GCM key for encrypting exchange API keys |
| `CRYPTOPANIC_API_TOKEN` | No | CryptoPanic news API (falls back to CoinGecko) |
| `COINGLASS_API_KEY` | No | Coinglass funding rates + liquidation data |
| `MASTRA_CLOUD_ACCESS_TOKEN` | No | Mastra Cloud trace export |
