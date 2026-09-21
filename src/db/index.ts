import "dotenv/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

// ---------------------------------------------------------------------------
// HMR-safe singleton — Next.js hot-reloads modules but preserves the
// `global` object, so we attach the pool there to avoid duplicate connections.
// ---------------------------------------------------------------------------
declare global {
  var __pgPool: Pool | undefined;
}

function createPool(): Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable is not set");
  }
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    // 15s, not the pg default 5s — at boot, the worker's several loops each
    // open a fresh connection within the same instant as Mastra's storage
    // init, and a brief burst of simultaneous new connections (plus whatever
    // else is running on the host) can push a handful of them past a tight
    // ceiling, surfacing as MASTRA_STORAGE_PG_INIT_FAILED even though the DB
    // itself is healthy.
    connectionTimeoutMillis: 15_000,
  });
}

const pool: Pool = globalThis.__pgPool ?? (globalThis.__pgPool = createPool());

if (process.env.NODE_ENV !== "production") {
  // In development the module may be re-evaluated; always point global to the
  // same instance so we never create a second pool.
  globalThis.__pgPool = pool;
}

const db = drizzle(pool, { schema });

export { db, pool };
export type { Pool };
