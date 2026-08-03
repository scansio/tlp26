/**
 * Global advisory lock so only one worker instance runs a given tick, even if
 * the worker container is ever scaled to multiple replicas. Uses a single
 * dedicated connection (pool.connect()) for both the lock and unlock calls —
 * session-scoped advisory locks silently break if lock/unlock land on
 * different pooled connections.
 */

import { pool } from '@/db';

// Arbitrary fixed bigint identifying this lock. Document collision risk if
// another pg_advisory_lock user is ever added to this database.
const LOCK_KEY = 918_273_645;

// Belt-and-suspenders: node-cron does not wait for a previous callback to
// resolve before firing the next one, so guard against overlapping ticks
// within the same process before even taking a pool connection.
let tickRunning = false;

export async function withGlobalTickLock<T>(fn: () => Promise<T>): Promise<T | 'skipped'> {
  if (tickRunning) {
    console.log('[worker] tick skipped — another tick already running in this process');
    return 'skipped';
  }

  tickRunning = true;
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [LOCK_KEY],
    );
    if (!rows[0]?.locked) {
      console.log('[worker] tick skipped — advisory lock held by another instance');
      return 'skipped';
    }

    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    client.release();
    tickRunning = false;
  }
}
