import pg from 'pg';
import { runMigrations } from '../../src/db/migrate.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://stockflow:stockflow@127.0.0.1:5432/stockflow_test';

/** Testlər başlamazdan əvvəl test bazasını sıfırlayıb bütün migrasiyaları tətbiq edir. */
export default async function setup(): Promise<void> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  try {
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await runMigrations(pool);
  } catch (error) {
    throw new Error(
      `Cannot prepare the test database at ${TEST_DATABASE_URL}.\n` +
        'Start PostgreSQL and create the database, or set TEST_DATABASE_URL.\n' +
        `Reason: ${(error as Error).message}`,
      { cause: error },
    );
  } finally {
    await pool.end();
  }
}
