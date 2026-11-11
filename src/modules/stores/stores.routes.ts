import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { notFound } from '../../shared/errors.js';
import { requireStoreId } from '../../shared/auth-helpers.js';
import { storeDto, updateStoreBody } from '../users/users.schemas.js';
import * as repo from './stores.repository.js';

const secured = [{ bearerAuth: [] }];

export const storeRoutes: FastifyPluginAsyncZod = async (app) => {
  const { pool } = app.deps;
  app.addHook('onRequest', app.authenticate);

  const toDto = (store: repo.StoreRecord) => ({
    id: store.id,
    name: store.name,
    address: store.address,
    phone: store.phone,
    timezone: store.timezone,
    currency: store.currency,
    main_categories: store.main_categories,
  });

  app.get(
    '/current',
    {
      schema: {
        tags: ['Store'],
        summary: 'The store of the signed-in user',
        security: secured,
        response: { 200: storeDto },
      },
    },
    async (request) => {
      const store = await repo.findStoreById(pool, requireStoreId(request.auth));
      if (!store) throw notFound('STORE_NOT_FOUND', 'Store not found');
      return toDto(store);
    },
  );

  app.patch(
    '/current',
    {
      onRequest: [app.requireRole('OWNER')],
      schema: {
        tags: ['Store'],
        summary: 'Edit the store name, address, phone, currency or categories (owner only)',
        security: secured,
        body: updateStoreBody,
        response: { 200: storeDto },
      },
    },
    async (request) => {
      const store = await repo.updateStore(pool, requireStoreId(request.auth), request.body);
      if (!store) throw notFound('STORE_NOT_FOUND', 'Store not found');
      return toDto(store);
    },
  );
};
