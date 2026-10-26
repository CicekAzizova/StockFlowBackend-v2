import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { buildApp } from '../../src/app.js';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { createPool } from '../../src/db/pool.js';
import { MemoryMailer } from '../../src/infra/mail/mailer.js';
import { MemoryStorage } from '../../src/infra/storage/storage.js';
import { TEST_DATABASE_URL } from './global-setup.js';

export interface TestContext {
  app: Awaited<ReturnType<typeof buildApp>>;
  pool: ReturnType<typeof createPool>;
  storage: MemoryStorage;
  mailer: MemoryMailer;
  config: AppConfig;
  close(): Promise<void>;
}

const TABLES =
  'refresh_tokens, one_time_codes, sale_items, sales, products, categories, subscriptions, users, stores';

export async function createContext(env: Record<string, string> = {}): Promise<TestContext> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    JWT_SECRET: 'test-secret-test-secret-test-secret-1234',
    STORAGE_DRIVER: 'memory',
    MAIL_DRIVER: 'memory',
    RATE_LIMIT_ENABLED: 'false',
    LOG_LEVEL: 'silent',
    ...env,
  });
  const pool = createPool(config.databaseUrl, 10);
  const storage = new MemoryStorage(config.storage.publicBaseUrl);
  const mailer = new MemoryMailer();
  const app = await buildApp({ config, pool, storage, mailer });
  await app.ready();
  await pool.query(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`);

  return {
    app,
    pool,
    storage,
    mailer,
    config,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

type Json = Record<string, unknown>;

export interface Session {
  token: string;
  refreshToken: string;
  userId: number;
  storeId: number;
  email: string;
  auth: { authorization: string };
}

export function api(app: FastifyInstance) {
  async function call(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    options: { token?: string; payload?: unknown; headers?: Record<string, string> } = {},
  ) {
    const response = await app.inject({
      method,
      url,
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...options.headers,
      },
      ...(options.payload !== undefined ? { payload: options.payload as Json } : {}),
    });
    let body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      body = response.json();
    } catch {
      body = response.body;
    }
    return { status: response.statusCode, body, headers: response.headers };
  }
  return {
    get: (url: string, token?: string) => call('GET', url, token ? { token } : {}),
    post: (url: string, payload?: unknown, token?: string) =>
      call('POST', url, { payload: payload ?? {}, ...(token ? { token } : {}) }),
    put: (url: string, payload: unknown, token?: string) =>
      call('PUT', url, { payload, ...(token ? { token } : {}) }),
    patch: (url: string, payload: unknown, token?: string) =>
      call('PATCH', url, { payload, ...(token ? { token } : {}) }),
    delete: (url: string, token?: string, payload?: unknown) =>
      call('DELETE', url, {
        ...(token ? { token } : {}),
        ...(payload !== undefined ? { payload } : {}),
      }),
  };
}

let counter = 0;
const unique = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export async function registerOwner(ctx: TestContext, overrides: Json = {}): Promise<Session> {
  const email = (overrides.email as string | undefined) ?? `owner-${unique()}@test.com`;
  const response = await api(ctx.app).post('/auth/register', {
    name: 'Owner',
    email,
    password: 'secret123',
    phone: '+994501234567',
    store_name: 'Test Store',
    store_address: 'Baku',
    store_phone: '+994121234567',
    ...overrides,
  });
  if (response.status !== 201) throw new Error(`register failed: ${JSON.stringify(response.body)}`);
  return {
    token: response.body.token,
    refreshToken: response.body.refresh_token,
    userId: response.body.id,
    storeId: response.body.user.store_id,
    email: response.body.email,
    auth: { authorization: `Bearer ${response.body.token}` },
  };
}

export async function createAssociate(ctx: TestContext, owner: Session, overrides: Json = {}) {
  const email = (overrides.email as string | undefined) ?? `seller-${unique()}@test.com`;
  const response = await api(ctx.app).post(
    '/users/sales-associate',
    {
      name: 'Seller',
      surname: 'One',
      fin: `FIN${unique()}`.toUpperCase().slice(0, 10),
      phone: '+994507654321',
      email,
      password: 'seller123',
      ...overrides,
    },
    owner.token,
  );
  if (response.status !== 201)
    throw new Error(`associate failed: ${JSON.stringify(response.body)}`);
  const login = await api(ctx.app).post('/auth/login', {
    email,
    password: (overrides.password as string | undefined) ?? 'seller123',
  });
  return {
    id: response.body.id as number,
    email,
    token: login.body.token as string,
    refreshToken: login.body.refresh_token as string,
  };
}

export async function createProduct(ctx: TestContext, owner: Session, overrides: Json = {}) {
  const response = await api(ctx.app).post(
    '/products',
    {
      name: `Product ${unique()}`,
      sku: `SKU-${unique()}`,
      price: 10,
      quantity: 10,
      ...overrides,
    },
    owner.token,
  );
  if (response.status !== 201) throw new Error(`product failed: ${JSON.stringify(response.body)}`);
  return response.body as {
    id: number;
    sku: string;
    name: string;
    quantity: number;
    price: number;
  };
}

export async function makeJpeg(width = 800, height = 600): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#336699' } })
    .jpeg()
    .toBuffer();
}

/** multipart/form-data gövdəsi yığır (inject üçün). */
export function multipart(
  fieldName: string,
  filename: string,
  contentType: string,
  content: Buffer,
) {
  const boundary = '----stockflowtest';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, content, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}
