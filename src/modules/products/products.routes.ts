import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { idParams, messageResponse, paginatedResponse } from '../../shared/schemas.js';
import {
  lowStockQuery,
  productBody,
  productDto,
  productListQuery,
  restockBody,
  skuQuery,
  stockBody,
} from './products.schemas.js';
import { createProductsService } from './products.service.js';

const secured = [{ bearerAuth: [] }];

export const productRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = createProductsService(app.deps, app.log);
  const ownerOnly = app.requireRole('OWNER');
  app.addHook('onRequest', app.authenticate);

  app.get(
    '',
    {
      schema: {
        tags: ['Products'],
        summary: 'List products of the current store (paginated, newest first)',
        security: secured,
        querystring: productListQuery,
        response: { 200: paginatedResponse(productDto) },
      },
    },
    async (request) => service.list(request.auth, request.query),
  );

  app.get(
    '/low-stock',
    {
      schema: {
        tags: ['Products'],
        summary: 'Products at or below their low-stock limit (lowest stock first)',
        security: secured,
        querystring: lowStockQuery,
        response: { 200: paginatedResponse(productDto) },
      },
    },
    async (request) => service.lowStock(request.auth, request.query),
  );

  app.get(
    '/by-sku',
    {
      schema: {
        tags: ['Products'],
        summary: 'Find a product by SKU or barcode (case-insensitive)',
        security: secured,
        querystring: skuQuery,
        response: { 200: productDto },
      },
    },
    async (request) => service.getBySku(request.auth, request.query.sku),
  );

  app.get(
    '/:id',
    {
      schema: {
        tags: ['Products'],
        summary: 'Get one product',
        security: secured,
        params: idParams,
        response: { 200: productDto },
      },
    },
    async (request) => service.getById(request.auth, request.params.id),
  );

  app.post(
    '',
    {
      onRequest: [ownerOnly],
      schema: {
        tags: ['Products'],
        summary: 'Create a product (owner only)',
        security: secured,
        body: productBody,
        response: { 201: productDto },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await service.create(request.auth, request.body)),
  );

  app.put(
    '/:id',
    {
      onRequest: [ownerOnly],
      schema: {
        tags: ['Products'],
        summary: 'Update a product (owner only)',
        description:
          'name, sku and price are required. Other fields keep their current value when omitted. ' +
          'Send null to clear weight, weight_unit or size.',
        security: secured,
        params: idParams,
        body: productBody,
        response: { 200: productDto },
      },
    },
    async (request) => service.update(request.auth, request.params.id, request.body),
  );

  app.delete(
    '/:id',
    {
      onRequest: [ownerOnly],
      schema: {
        tags: ['Products'],
        summary: 'Delete a product (owner only). Sales history is kept.',
        security: secured,
        params: idParams,
        response: { 200: messageResponse },
      },
    },
    async (request) => {
      await service.remove(request.auth, request.params.id);
      return { message: 'Product deleted successfully' };
    },
  );

  app.patch(
    '/:id/stock',
    {
      onRequest: [ownerOnly],
      schema: {
        tags: ['Products'],
        summary: 'Set the stock quantity (owner only)',
        security: secured,
        params: idParams,
        body: stockBody,
        response: { 200: messageResponse },
      },
    },
    async (request) => {
      await service.setStock(request.auth, request.params.id, request.body.quantity);
      return { message: 'Stock updated successfully' };
    },
  );

  app.post(
    '/:id/restock',
    {
      onRequest: [ownerOnly],
      schema: {
        tags: ['Products'],
        summary: 'Add units to the stock quantity (owner only)',
        description: 'The quantity is added to the current stock, not set.',
        security: secured,
        params: idParams,
        body: restockBody,
        response: { 200: productDto },
      },
    },
    async (request) => service.restock(request.auth, request.params.id, request.body.quantity),
  );
};
