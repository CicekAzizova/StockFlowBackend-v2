import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { badRequest, notFound } from '../../shared/errors.js';
import { requireStoreId } from '../../shared/auth-helpers.js';
import { storeDto, updateStoreBody } from '../users/users.schemas.js';
import * as repo from './stores.repository.js';
import { isAllowedSubcategory, resolveCustomSubcategories } from './store-subcategories.js';

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
    custom_subcategories: store.custom_subcategories,
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

      const { custom_subcategories: customInput, ...rest } = request.body;
      const mains = rest.main_categories ?? current.main_categories;
      const update: Parameters<typeof repo.updateStore>[2] = { ...rest };

      let customs = current.custom_subcategories;
      let created: string[] = [];
      if (customInput !== undefined) {
        ({ items: customs, created } = resolveCustomSubcategories(
          customInput,
          current.custom_subcategories,
          mains,
        ));
      } else if (rest.main_categories !== undefined) {
        // Əsas kateqoriya götürüləndə ona aid öz alt kateqoriyalar da çıxır.
        customs = customs.filter((item) => mains.includes(item.main));
      }
      const customsChanged = customInput !== undefined || rest.main_categories !== undefined;
      if (customsChanged) update.custom_subcategories = JSON.stringify(customs);

      const allowed = (code: string) => isAllowedSubcategory(code, mains, customs);
      if (rest.subcategories !== undefined) {
        if (!rest.subcategories.every(allowed)) {
          throw badRequest(
            'INVALID_SUBCATEGORY',
            'Subcategory does not belong to the categories of this store',
          );
        }
      } else if (customsChanged) {
        update.subcategories = current.subcategories.filter(allowed);
      }
      // Yeni yaradılan öz kateqoriya seçilmişlərə düşür (siyahı boşdursa "hamısı" qalır).
      const selected = update.subcategories ?? current.subcategories;
      if (created.length > 0 && selected.length > 0) {
        update.subcategories = [...selected, ...created];
      }

      const store = await repo.updateStore(pool, storeId, update);
      if (!store) throw notFound('STORE_NOT_FOUND', 'Store not found');
      return toDto(store);
    },
  );
};
