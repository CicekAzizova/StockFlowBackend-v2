import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { z } from 'zod';
import type { AppDeps } from './app-types.js';
import type { AppConfig } from './config/env.js';
import { authPlugin } from './plugins/auth.js';
import { registerErrorHandling } from './plugins/error-handler.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { catalogRoutes } from './modules/catalog/catalog.routes.js';
import { categoryRoutes } from './modules/categories/categories.routes.js';
import { productRoutes } from './modules/products/products.routes.js';
import { salesRoutes } from './modules/sales/sales.routes.js';
import { storeRoutes } from './modules/stores/stores.routes.js';
import { uploadRoutes } from './modules/uploads/uploads.routes.js';
import { userRoutes } from './modules/users/users.routes.js';
import { AppError } from './shared/errors.js';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** pino-pretty yalnız inkişaf asılılığıdır; serverdə quraşdırılmayıbsa JSON log istifadə olunur. */
function hasPinoPretty(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

function loggerOptions(config: AppConfig) {
  if (config.env === 'test') return false;
  return {
    level: config.logLevel,
    redact: ['req.headers.authorization', 'req.headers.cookie'],
    ...(config.env === 'development' && hasPinoPretty()
      ? {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  };
}

/** Bütün asılılıqlar (baza, saxlama, mail) kənardan verilir, ona görə testlərdə əvəz etmək asandır. */
export async function buildApp(deps: AppDeps) {
  const { config, pool } = deps;

  const app = Fastify({
    logger: loggerOptions(config),
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    routerOptions: { ignoreTrailingSlash: true },
    genReqId: (request) => {
      const incoming = request.headers['x-request-id'];
      return typeof incoming === 'string' && /^[\w-]{1,64}$/.test(incoming)
        ? incoming
        : randomUUID();
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('deps', deps);
  registerErrorHandling(app);

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  // ------------------------------------------------------------------ təhlükəsizlik
  await app.register(helmet, { contentSecurityPolicy: false });
  if (config.corsOrigins.length > 0) {
    await app.register(cors, { origin: config.corsOrigins });
  }
  if (config.rateLimitEnabled) {
    await app.register(rateLimit, {
      global: true,
      max: 600,
      timeWindow: '1 minute',
      errorResponseBuilder: () =>
        new AppError(429, 'RATE_LIMITED', 'Too many requests, please slow down'),
    });
  }
  await app.register(multipart, {
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 5, parts: 10 },
  });
  await app.register(authPlugin);

  // ------------------------------------------------------------------ sənədləşmə (OpenAPI)
  if (config.docsEnabled) {
    await app.register(swagger, {
      openapi: {
        openapi: '3.0.3',
        info: {
          title: 'StockFlow API',
          version: '2.0.0',
          description:
            'Inventory and sales API for the StockFlow iOS app. Errors always look like ' +
            '{ "message": "...", "code": "SOME_CODE", "details": ... }.',
        },
        servers: config.publicBaseUrl ? [{ url: config.publicBaseUrl }] : [],
        components: {
          securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
        },
      },
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, { routePrefix: '/api-docs' });
  }

  // ------------------------------------------------------------------ sağlamlıq yoxlaması
  const healthBody = z.object({ status: z.string(), message: z.string().optional() });

  app.get(
    '/health',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['Health'],
        summary: 'Is the server running?',
        response: { 200: healthBody },
      },
    },
    async () => ({ status: 'OK', message: 'StockFlow backend is running' }),
  );

  app.get(
    '/health/ready',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['Health'],
        summary: 'Is the server able to reach its database?',
        response: { 200: healthBody, 503: healthBody },
      },
    },
    async (_request, reply) => {
      try {
        await pool.query('SELECT 1');
        return { status: 'OK' };
      } catch {
        return reply
          .code(503)
          .send({ status: 'UNAVAILABLE', message: 'Database is not reachable' });
      }
    },
  );

  // ------------------------------------------------------------------ route-lar
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(userRoutes, { prefix: '/users' });
  await app.register(storeRoutes, { prefix: '/stores' });
  await app.register(catalogRoutes, { prefix: '/catalog' });
  await app.register(categoryRoutes, { prefix: '/categories' });
  await app.register(productRoutes, { prefix: '/products' });
  await app.register(salesRoutes, { prefix: '/sales' });
  await app.register(uploadRoutes, { prefix: '/uploads' });

  return app;
}
