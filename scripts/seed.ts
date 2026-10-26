/**
 * Lokal sınaq üçün nümunə məlumat yaradır. YALNIZ əl ilə işlədilir: npm run seed
 * Real API-dən (app.inject) istifadə edir, ona görə bütün qaydalar tətbiq olunur.
 * İstehsal bazasında işləmir.
 */
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';
import { createMailer } from '../src/infra/mail/mailer.js';
import { createStorage } from '../src/infra/storage/storage.js';

process.env.LOG_LEVEL ??= 'warn';
const config = loadConfig(process.env);
if (config.env === 'production') {
  console.error('Seed is disabled in production.');
  process.exit(1);
}

const pool = createPool(config.databaseUrl, 5);
await runMigrations(pool);
const app = await buildApp({
  config,
  pool,
  storage: createStorage(config),
  mailer: createMailer(config),
});
await app.ready();

async function call(method: 'POST', url: string, payload: unknown, token?: string) {
  const res = await app.inject({
    method,
    url,
    payload: payload as Record<string, unknown>,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (res.statusCode >= 400) throw new Error(`${method} ${url} -> ${res.statusCode} ${res.body}`);
  return res.json();
}

const OWNER_EMAIL = 'demo@stockflow.app';
const exists = await pool.query('SELECT 1 FROM users WHERE email = $1', [OWNER_EMAIL]);
if (exists.rowCount) {
  console.log(`Demo data already exists (${OWNER_EMAIL}). Nothing to do.`);
} else {
  const owner = await call('POST', '/auth/register', {
    name: 'Demo',
    surname: 'Owner',
    email: OWNER_EMAIL,
    password: 'demo1234',
    phone: '+994501112233',
    store_name: 'Demo Market',
    store_address: 'Baku, Nizami street 1',
    store_phone: '+994125556677',
  });

  await call(
    'POST',
    '/users/sales-associate',
    {
      name: 'Aysel',
      surname: 'Mammadova',
      fin: 'DEMO123',
      phone: '+994502223344',
      email: 'seller@stockflow.app',
      password: 'seller123',
    },
    owner.token,
  );

  const catalog = [
    ['Coca-Cola 0.5L', 'COLA-05', 1.5, 0.9, 'Drinks', 48],
    ['Still water 1L', 'WATER-1', 0.8, 0.4, 'Drinks', 120],
    ['Bread', 'BREAD-1', 0.7, 0.4, 'Bakery', 30],
    ['Milk 1L', 'MILK-1', 2.2, 1.5, 'Dairy', 4],
    ['Cheese 200g', 'CHEESE-200', 4.5, 3, 'Dairy', 15],
    ['Apple 1kg', 'APPLE-1', 2.9, 1.8, 'Fruit', 0],
  ] as const;
  for (const [name, sku, price, cost, category, quantity] of catalog) {
    await call(
      'POST',
      '/products',
      { name, sku, price, cost_price: cost, category, quantity, low_stock_limit: 5 },
      owner.token,
    );
  }
  console.log('Demo data created.');
  console.log(`  owner:  ${OWNER_EMAIL} / demo1234`);
  console.log('  seller: seller@stockflow.app / seller123');
}

await app.close();
await pool.end();
