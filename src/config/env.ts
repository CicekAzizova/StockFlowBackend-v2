import { z } from 'zod';

/**
 * Bütün mühit dəyişənləri bir yerdə oxunur və yoxlanılır.
 * Səhv və ya çatışmayan dəyişən olsa server işə düşmür (fail fast).
 */

const duration = z.string().regex(/^\d+[smhd]$/, 'must look like 15m, 12h or 7d');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Render, Railway, Fly kimi platformalar proxy arxasındadır. */
  TRUST_PROXY: z.stringbool().default(true),
  PUBLIC_BASE_URL: z.url().optional(),
  DOCS_ENABLED: z.stringbool().default(true),
  RATE_LIMIT_ENABLED: z.stringbool().default(true),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /** Server işə düşəndə gözləyən migrasiyaları avtomatik tətbiq edir. */
  RUN_MIGRATIONS_ON_START: z.stringbool().default(true),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: duration.default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  REQUIRE_VERIFIED_EMAIL: z.stringbool().default(false),

  CORS_ORIGINS: z.string().default(''),

  STORAGE_DRIVER: z.enum(['s3', 'memory']).default('s3'),
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.stringbool().default(false),
  /** Şəkillərin oxunduğu açıq ünvan (məs. https://cdn.example.com). */
  S3_PUBLIC_URL: z.url().optional(),

  MAIL_DRIVER: z.enum(['console', 'resend', 'memory']).default('console'),
  MAIL_FROM: z.string().default('StockFlow <no-reply@stockflow.app>'),
  RESEND_API_KEY: z.string().optional(),

  /** Pulsuz planda maksimum məhsul sayı. Boşdursa limit yoxdur. */
  FREE_PRODUCT_LIMIT: z.coerce.number().int().min(1).optional(),
  DEFAULT_TIMEZONE: z.string().default('Asia/Baku'),
});

export type Locale = 'az' | 'en' | 'ru';

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  host: string;
  port: number;
  logLevel: string;
  trustProxy: boolean;
  publicBaseUrl: string | undefined;
  docsEnabled: boolean;
  rateLimitEnabled: boolean;
  databaseUrl: string;
  dbPoolMax: number;
  runMigrationsOnStart: boolean;
  auth: {
    jwtSecret: string;
    accessTokenTtl: string;
    refreshTokenTtlDays: number;
    requireVerifiedEmail: boolean;
  };
  corsOrigins: string[];
  storage: {
    driver: 's3' | 'memory';
    publicBaseUrl: string;
    s3: {
      endpoint: string | undefined;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle: boolean;
    } | null;
  };
  mail: { driver: 'console' | 'resend' | 'memory'; from: string; resendApiKey: string | undefined };
  freeProductLimit: number | null;
  defaultTimezone: string;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const env = parsed.data;
  const isProduction = env.NODE_ENV === 'production';
  const problems: string[] = [];

  let s3: AppConfig['storage']['s3'] = null;
  let storagePublicUrl = 'https://cdn.stockflow.test';

  if (env.STORAGE_DRIVER === 's3') {
    if (!env.S3_BUCKET) problems.push('S3_BUCKET is required when STORAGE_DRIVER=s3');
    if (!env.S3_ACCESS_KEY_ID) problems.push('S3_ACCESS_KEY_ID is required when STORAGE_DRIVER=s3');
    if (!env.S3_SECRET_ACCESS_KEY) {
      problems.push('S3_SECRET_ACCESS_KEY is required when STORAGE_DRIVER=s3');
    }
    if (!env.S3_PUBLIC_URL) problems.push('S3_PUBLIC_URL is required when STORAGE_DRIVER=s3');
    if (env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY && env.S3_PUBLIC_URL) {
      s3 = {
        endpoint: env.S3_ENDPOINT,
        region: env.S3_REGION,
        bucket: env.S3_BUCKET,
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
      };
      storagePublicUrl = env.S3_PUBLIC_URL.replace(/\/+$/, '');
    }
  } else if (isProduction) {
    problems.push('STORAGE_DRIVER=memory is not allowed in production');
  }

  if (env.MAIL_DRIVER === 'resend' && !env.RESEND_API_KEY) {
    problems.push('RESEND_API_KEY is required when MAIL_DRIVER=resend');
  }
  if (isProduction && env.MAIL_DRIVER !== 'resend') {
    problems.push(
      'MAIL_DRIVER must be "resend" in production (users cannot receive codes otherwise)',
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }

  return {
    env: env.NODE_ENV,
    isProduction,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    trustProxy: env.TRUST_PROXY,
    publicBaseUrl: env.PUBLIC_BASE_URL?.replace(/\/+$/, ''),
    docsEnabled: env.DOCS_ENABLED,
    rateLimitEnabled: env.RATE_LIMIT_ENABLED,
    databaseUrl: env.DATABASE_URL,
    dbPoolMax: env.DB_POOL_MAX,
    runMigrationsOnStart: env.RUN_MIGRATIONS_ON_START,
    auth: {
      jwtSecret: env.JWT_SECRET,
      accessTokenTtl: env.ACCESS_TOKEN_TTL,
      refreshTokenTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
      requireVerifiedEmail: env.REQUIRE_VERIFIED_EMAIL,
    },
    corsOrigins: env.CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    storage: { driver: env.STORAGE_DRIVER, publicBaseUrl: storagePublicUrl, s3 },
    mail: { driver: env.MAIL_DRIVER, from: env.MAIL_FROM, resendApiKey: env.RESEND_API_KEY },
    freeProductLimit: env.FREE_PRODUCT_LIMIT ?? null,
    defaultTimezone: env.DEFAULT_TIMEZONE,
  };
}
