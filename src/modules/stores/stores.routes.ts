import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { badRequest, notFound } from '../../shared/errors.js';
import { isSubcategoryOfAny } from '../catalog/catalog.data.js';
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
    subcategories: store.subcategories,
    country: store.country,
    city: store.city,
    onboarding_completed: store.onboarding_completed,
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
      const storeId = requireStoreId(request.auth);
      const current = await repo.findStoreById(pool, storeId);
      if (!current) throw notFound('STORE_NOT_FOUND', 'Store not found');

      const fields = { ...request.body };
      const mains = fields.main_categories ?? current.main_categories;
      if (fields.subcategories !== undefined) {
        if (!fields.subcategories.every((code) => isSubcategoryOfAny(code, mains))) {
          throw badRequest(
            'INVALID_SUBCATEGORY',
            'Subcategory does not belong to the categories of this store',
          );
        }
      } else if (fields.main_categories !== undefined) {
        // Əsas kateqoriya götürüləndə ona aid alt kateqoriyalar da siyahıdan çıxır.
        const kept = current.subcategories.filter((code) => isSubcategoryOfAny(code, mains));
        if (kept.length !== current.subcategories.length) fields.subcategories = kept;
      }

      const store = await repo.updateStore(pool, storeId, fields);
      if (!store) throw notFound('STORE_NOT_FOUND', 'Store not found');
      return toDto(store);
    },
  );
};
