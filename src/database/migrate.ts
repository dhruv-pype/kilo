import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { initPool, query, closePool, withTransaction } from './pool.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureMigrationsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT now()
    )
  `);
}

async function getAppliedVersions(): Promise<Set<number>> {
  const result = await query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version');
  return new Set(result.rows.map((r) => r.version));
}

async function getMigrationFiles(): Promise<{ version: number; name: string; path: string }[]> {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  return files.map((f) => {
    const match = f.match(/^(\d+)[-_](.+)\.sql$/);
    if (!match) {
      throw new Error(`Invalid migration filename: ${f}. Expected format: 001-description.sql`);
    }
    return {
      version: parseInt(match[1], 10),
      name: match[2],
      path: path.join(MIGRATIONS_DIR, f),
    };
  });
}

/**
 * Run all pending migrations. Can be called from the CLI chat or other entry points.
 * Assumes the database pool is already initialized.
 */
export async function runMigrations(): Promise<void> {
  await ensureMigrationsTable();
  const applied = await getAppliedVersions();
  const migrations = await getMigrationFiles();
  const pending = migrations.filter((m) => !applied.has(m.version));

  if (pending.length === 0) {
    console.log('No pending migrations.');
    return;
  }

  console.log(`Running ${pending.length} migration(s)...`);

  for (const migration of pending) {
    const sql = fs.readFileSync(migration.path, 'utf-8');
    console.log(`  Applying ${migration.version}-${migration.name}...`);

    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
        [migration.version, migration.name],
      );
    });

    console.log(`  Done.`);
  }

  console.log('All migrations applied.');
}

// Run as a standalone script when executed directly
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }

  initPool(databaseUrl);

  try {
    await runMigrations();
  } finally {
    await closePool();
  }
}

// Only run main() when this file is executed directly, not when imported
const isDirectExecution = process.argv[1]?.includes('migrate');
if (isDirectExecution) {
  main().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
