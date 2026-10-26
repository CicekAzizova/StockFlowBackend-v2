import { loadConfig } from '../config/env.js';
import { createPool } from './pool.js';
import { runMigrations } from './migrate.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl, 2);

try {
  const { applied, skipped } = await runMigrations(pool, console.log);
  console.log(`Migrations done. Applied: ${applied.length}, already applied: ${skipped.length}`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
