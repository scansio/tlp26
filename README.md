# TLP26 — AI Trading Hub

A multi-user SaaS platform where a Mastra AI agent makes trading decisions based on real-time crypto news, OHLCV chart analysis, on-chain signals, and SMC/technical strategies, then executes trades via BingX, Binance, or Bybit.

## Prerequisites

- [Node.js](https://nodejs.org/) v20+
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
