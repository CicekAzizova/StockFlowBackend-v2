import { buildApp } from './app.js';
import { loadConfig } from './config/env.js';
import { createPool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { createMailer } from './infra/mail/mailer.js';
import { createStorage } from './infra/storage/storage.js';
import * as authRepo from './modules/auth/auth.repository.js';

const HOUSEKEEPING_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl, config.dbPoolMax);

  // Əvvəlcə bazaya və saat qurşağına baxırıq ki, yanlış konfiqurasiya tez məlum olsun.
  await pool.query('SELECT now() AT TIME ZONE $1', [config.defaultTimezone]);
  if (config.runMigrationsOnStart) {
    await runMigrations(pool, (message) => console.log(message));
  }

  const app = await buildApp({
    config,
    pool,
    storage: createStorage(config),
    mailer: createMailer(config),
  });

  const housekeeping = setInterval(() => {
    authRepo
      .deleteExpired(pool)
      .catch((error: unknown) => app.log.warn({ err: error }, 'Housekeeping failed'));
  }, HOUSEKEEPING_INTERVAL_MS);
  housekeeping.unref();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
    force.unref();
    try {
      await app.close();
      await pool.end();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'Error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) =>
    app.log.error({ err: reason }, 'Unhandled rejection'),
  );

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  console.error('Failed to start the server:', error instanceof Error ? error.message : error);
  process.exit(1);
});
