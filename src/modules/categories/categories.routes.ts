import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { isUniqueViolation } from '../../db/pool.js';
import { conflict, notFound } from '../../shared/errors.js';
import { requireStoreId } from '../../shared/auth-helpers.js';
import { idParams, messageResponse, requiredString } from '../../shared/schemas.js';
import * as repo from './categories.repository.js';

const categoryDto = z.object({
  id: z.number().int(),
  name: z.string(),
  product_count: z.number().int(),
});

const nameBody = z.object({ name: requiredString(80, 'Category name is required') });
const secured = [{ bearerAuth: [] }];

export const categoryRoutes: FastifyPluginAsyncZod = async (app) => {
  const { pool } = app.deps;
  app.addHook('onRequest', app.authenticate);

  app.get(
    '',
    {
      schema: {
        tags: ['Categories'],
        summary: 'List the categories of the current store',
        security: secured,
        response: { 200: z.array(categoryDto) },
      },
    },
    async (request) => repo.listCategories(pool, requireStoreId(request.auth)),
  );

  app.post(
    '',
    {
      onRequest: [app.requireRole('OWNER')],
      schema: {
        tags: ['Categories'],
        summary: 'Create a category (returns the existing one if the name is taken)',
        security: secured,
        body: nameBody,
        response: { 201: categoryDto },
      },
    },
    async (request, reply) => {
      const storeId = requireStoreId(request.auth);
      const id = await repo.upsertByName(pool, storeId, request.body.name);
      const category = await repo.findCategory(pool, storeId, id);
      return reply.code(201).send(category ?? { id, name: request.body.name, product_count: 0 });
    },
  );

  app.patch(
    '/:id',
    {
      onRequest: [app.requireRole('OWNER')],
      schema: {
        tags: ['Categories'],
        summary: 'Rename a category',
        security: secured,
        params: idParams,
        body: nameBody,
        response: { 200: categoryDto },
      },
    },
    async (request) => {
      const storeId = requireStoreId(request.auth);
      try {
        const changed = await repo.renameCategory(
          pool,
          storeId,
          request.params.id,
          request.body.name,
        );
        if (!changed) throw notFound('CATEGORY_NOT_FOUND', 'Category not found');
      } catch (error) {
        if (isUniqueViolation(error, 'categories_store_name_uq')) {
          throw conflict('CATEGORY_ALREADY_EXISTS', 'Category already exists');
        }
        throw error;
      }
      const category = await repo.findCategory(pool, storeId, request.params.id);
      if (!category) throw notFound('CATEGORY_NOT_FOUND', 'Category not found');
      return category;
    },
  );

  app.delete(
    '/:id',
    {
      onRequest: [app.requireRole('OWNER')],
      schema: {
        tags: ['Categories'],
        summary: 'Delete a category (its products become uncategorized)',
        security: secured,
        params: idParams,
        response: { 200: messageResponse },
      },
    },
    async (request) => {
      const deleted = await repo.deleteCategory(
        pool,
        requireStoreId(request.auth),
        request.params.id,
      );
      if (!deleted) throw notFound('CATEGORY_NOT_FOUND', 'Category not found');
      return { message: 'Category deleted successfully' };
    },
  );
};
