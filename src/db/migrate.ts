import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/**
 * Sadə və şəffaf migrasiya sistemi:
 *  - migrations/*.sql faylları ada görə sıra ilə işlədilir
 *  - tətbiq olunanlar schema_migrations cədvəlində saxlanılır
 *  - eyni anda iki server işə düşsə advisory lock biri gözləməyə məcbur edir
 * Fayl bir dəfə tətbiq olunduqdan sonra dəyişdirilmir, yeni dəyişiklik yeni fayl olur.
 */

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);
const LOCK_ID = 727_274;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(
  pool: pg.Pool,
  log: (message: string) => void = () => undefined,
): Promise<MigrationResult> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], skipped: [] };

  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
        (row) => row.name,
      ),
    );

    for (const file of files) {
      if (done.has(file)) {
        result.skipped.push(file);
        continue;
      }
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
      }
      log(`Applied migration ${file}`);
      result.applied.push(file);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    client.release();
  }
  return result;
}
