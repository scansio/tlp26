# Main Next.js app — self-hosted (Namecheap/Dokploy via Docker), not Vercel.
# Migrations run once on container start, then the standalone server boots.
# The confluence-group trading worker (scheduled ticks, SL/TP monitor, price
# watches, signal expiry, auto-execute retries) runs in this same process via
# src/instrumentation.ts's register() hook — see that file for the
# WORKER_ENABLED gating. There is no separate worker image/container anymore.

# ---- deps ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder ----
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Next.js's "collect page data" / static-export build steps import every
# route module and prerender static pages, which executes module-scope env
# reads that throw if unset (src/db/index.ts's pg.Pool constructor;
# src/mastra/model.ts's AI provider/model check; Clerk's publishable key).
#
# DATABASE_URL / AI_PROVIDER / GROQ_MODEL are server-only and re-read at
# container runtime — these placeholders only need to be non-empty strings
# to satisfy the build, and are never baked into any shipped code.
#
# NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is different: NEXT_PUBLIC_* vars are
# inlined into the client JS bundle AT BUILD TIME and cannot be overridden by
# container env vars afterward. For a real deployment, pass the REAL
# publishable key via --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...
# — the placeholder below only unblocks a local/CI build without real keys.
ARG DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder
ARG AI_PROVIDER=groq
ARG GROQ_MODEL=placeholder
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_cGxhY2Vob2xkZXIuY2xlcmsuYWNjb3VudHMuZGV2JA
ARG NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
ARG NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
ARG NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/
ARG NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/
ENV DATABASE_URL=$DATABASE_URL
ENV AI_PROVIDER=$AI_PROVIDER
ENV GROQ_MODEL=$GROQ_MODEL
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_CLERK_SIGN_IN_URL=$NEXT_PUBLIC_CLERK_SIGN_IN_URL
ENV NEXT_PUBLIC_CLERK_SIGN_UP_URL=$NEXT_PUBLIC_CLERK_SIGN_UP_URL
ENV NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=$NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL
ENV NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=$NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL

RUN npm run build

# ---- runner ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Next.js standalone output only traces modules reachable from the server
# bundle — scripts/migrate.mjs and drizzle/migrations/*.sql are invoked as a
# separate process / read as flat files, so they must be copied explicitly.
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/drizzle ./drizzle

# The standalone tracer only bundles the specific drizzle-orm/pg subpaths the
# server bundle imports (e.g. drizzle-orm/node-postgres), not the migrator
# submodule migrate.mjs needs (drizzle-orm/node-postgres/migrator) — overwrite
# with the full packages from the builder stage so migrations can run.
COPY --from=builder /app/node_modules/drizzle-orm ./node_modules/drizzle-orm
COPY --from=builder /app/node_modules/pg ./node_modules/pg

EXPOSE 3000
CMD ["sh", "-c", "node scripts/migrate.mjs && node server.js"]
