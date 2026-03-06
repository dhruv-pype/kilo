import pg from 'pg';
import { DatabaseError } from '../common/errors/index.js';
import { getCurrentUserId } from './request-context.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    throw new DatabaseError('Database pool not initialized. Call initPool() first.');
  }
  return pool;
}

export function initPool(databaseUrl: string, poolSize: number = 20): pg.Pool {
  if (pool) {
    return pool;
  }

  pool = new Pool({
    connectionString: databaseUrl,
    max: poolSize,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on('error', (err) => {
    console.error('Unexpected database pool error:', err);
  });

  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Execute a query with automatic client acquisition and release.
 * Use this for single queries. For transactions, use `withTransaction`.
 *
 * When a request context is active (API request with authenticated user),
 * acquires a dedicated client and sets `app.current_user_id` for Postgres
 * Row-Level Security before running the query.
 *
 * When no context is active (CLI, migrations, scheduler startup),
 * runs directly on the pool — the table owner bypasses RLS.
 */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  const p = getPool();
  const currentUserId = getCurrentUserId();

  if (currentUserId) {
    // RLS-enabled path: set session variable so Postgres policies apply
    const client = await p.connect();
    try {
      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [currentUserId]);
      return await client.query<T>(text, params);
    } catch (err) {
      throw new DatabaseError(`Query failed: ${(err as Error).message}`, err);
    } finally {
      client.release();
    }
  }

  // No user context — bypass RLS (table owner is exempt)
  try {
    return await p.query<T>(text, params);
  } catch (err) {
    throw new DatabaseError(`Query failed: ${(err as Error).message}`, err);
  }
}

/**
 * Execute multiple queries within a single transaction.
 * Automatically rolls back on error.
 *
 * Sets `app.current_user_id` for RLS when a request context is active.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');

    // Set RLS context if an authenticated user is active
    const currentUserId = getCurrentUserId();
    if (currentUserId) {
      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [currentUserId]);
    }

    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw new DatabaseError(`Transaction failed: ${(err as Error).message}`, err);
  } finally {
    client.release();
  }
}
