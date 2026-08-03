// Applies pending Drizzle migrations before the server starts.
//
// Bypasses the `drizzle-kit migrate` CLI on purpose: that CLI has been
// observed to swallow the underlying Postgres error and exit non-zero with
// no message at all, which is silent and undiagnosable on a production boot.
// Calling drizzle-orm's migrator directly gets us the real error.
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

if (!process.env.DATABASE_URL) {
  console.error('[migrate] DATABASE_URL is not set');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

try {
  console.log('[migrate] applying pending migrations...');
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
  console.log('[migrate] up to date');
} catch (err) {
  console.error('[migrate] failed:', err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
