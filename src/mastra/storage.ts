import { PostgresStore } from '@mastra/pg';
import { pool } from '@/db';

// ---------------------------------------------------------------------------
// HMR-safe singleton — reuse the same PostgresStore instance across Next.js
// hot reloads to prevent pool exhaustion.
// ---------------------------------------------------------------------------
declare global {
   
  var __mastraStorage: PostgresStore | undefined;
}

function createStorage(): PostgresStore {
  return new PostgresStore({
    id: 'mastra-storage',
    pool,
  });
}

export const mastraStorage: PostgresStore =
  globalThis.__mastraStorage ?? (globalThis.__mastraStorage = createStorage());

if (process.env.NODE_ENV !== 'production') {
  globalThis.__mastraStorage = mastraStorage;
}
