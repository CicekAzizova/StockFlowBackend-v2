import fastifyJwt from '@fastify/jwt';
import fp from 'fastify-plugin';
import type { AuthContext, Role } from '../app-types.js';
import { queryOne } from '../db/pool.js';
import { forbidden, unauthorized } from '../shared/errors.js';

/**
 * JWT yoxlaması və rol yoxlaması.
 *  app.authenticate  - tokeni yoxlayıb request.auth doldurur
 *  app.requireRole   - rolu yoxlayır (authenticate-dən sonra işlədilir)
 */
export const authPlugin = fp(async (app) => {
  const { config } = app.deps;

  await app.register(fastifyJwt, {
    secret: config.auth.jwtSecret,
    sign: { algorithm: 'HS256', expiresIn: config.auth.accessTokenTtl },
    verify: { algorithms: ['HS256'] },
  });

  app.decorateRequest('auth', undefined as unknown as AuthContext);

  app.decorate('authenticate', async (request) => {
    if (!request.headers.authorization?.startsWith('Bearer ')) {
      throw unauthorized('ACCESS_TOKEN_REQUIRED', 'Access token is required');
    }
    try {
      await request.jwtVerify();
    } catch (error) {
      const code = (error as { code?: string }).code ?? '';
      const expired = code === 'FAST_JWT_EXPIRED' || code === 'FST_JWT_AUTHORIZATION_TOKEN_EXPIRED';
      throw unauthorized(expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN', 'Invalid or expired token');
    }

    const { sub, role, storeId, ev } = request.user;
    request.auth = { userId: Number(sub), role, storeId, emailVerified: ev };

    // Satıcı silinibsə və ya deaktiv edilibsə, köhnə access token də dərhal işləməsin.
    if (role === 'SALES_ASSOCIATE') {
      const row = await queryOne<{ is_active: boolean }>(
        app.deps.pool,
        'SELECT is_active FROM users WHERE id = $1 AND deleted_at IS NULL',
        [request.auth.userId],
      );
      if (!row?.is_active) {
        throw unauthorized('ACCOUNT_DEACTIVATED', 'This account is no longer active');
      }
    }

    if (config.auth.requireVerifiedEmail && !ev && !request.routeOptions.config.allowUnverified) {
      throw forbidden('EMAIL_NOT_VERIFIED', 'Please verify your email address');
    }
  });

  app.decorate('requireRole', (...roles: Role[]) => async (request) => {
    if (!roles.includes(request.auth.role)) {
      throw forbidden('FORBIDDEN', 'You do not have permission');
    }
  });
});
