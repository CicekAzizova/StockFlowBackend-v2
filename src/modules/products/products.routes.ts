import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { locationHeader } from '../../shared/location-context.js';
import { idParams, messageResponse, paginatedResponse } from '../../shared/schemas.js';
import {
  forSaleBody,
  historyQuery,
  lowStockQuery,
  productBody,
  productDto,
  productListQuery,
  restockBody,
  skuQuery,
  stockBody,
  stockCountsDto,
  stockMovementDto,
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
        summary: 'List products of the current store (paginated)',
        description:
          'Filters: `q`, `category`, `subcategory`, `stock`, `for_sale`. `sort` orders the list ' +
          '(newest, name, price_asc, price_desc, stock_asc, stock_desc, best_selling).',
        security: secured,
        querystring: productListQuery,
        response: { 200: paginatedResponse(productDto) },
      },
    },
    async (request) => service.list(request.auth, locationHeader(request), request.query),
  );

  app.get(
    '/stats',
    {
      schema: {
        tags: ['Products'],
        summary: 'Product counts by stock status at the selected location',
        description: 'Numbers for the filter chips: all, in stock, low stock and out of stock.',
        security: secured,
        response: { 200: stockCountsDto },
      },
    },
    async (request) => service.stats(request.auth, locationHeader(request)),
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
    async (request) => service.lowStock(request.auth, locationHeader(request), request.query),
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
    async (request) => service.getBySku(request.auth, locationHeader(request), request.query.sku),
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
    async (request) => service.getById(request.auth, locationHeader(request), request.params.id),
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
      reply
        .code(201)
        .send(await service.create(request.auth, locationHeader(request), request.body)),
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
    async (request) =>
      service.update(request.auth, locationHeader(request), request.params.id, request.body),
  );

  app.patch(
    '/:id/for-sale',
    {
      onRequest: [ownerOnly],
      schema: {
        tags: ['Products'],
        summary: 'Hide a product from sales or put it back (owner only)',
        description:
          'A product that is not for sale cannot be sold (400 PRODUCT_NOT_FOR_SALE). ' +
          'Its stock and history are kept, and it can still be transferred.',
        security: secured,
        params: idParams,
        body: forSaleBody,
        response: { 200: productDto },
      },
    },
    async (request) =>
      service.setForSale(
        request.auth,
        locationHeader(request),
        request.params.id,
        request.body.for_sale,
      ),
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
      await service.setStock(
        request.auth,
        locationHeader(request),
        request.params.id,
        request.body.quantity,
        request.body.note,
      );
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
    async (request) =>
      service.restock(
        request.auth,
        locationHeader(request),
        request.params.id,
        request.body.quantity,
        request.body.note,
      ),
  );

  app.get(
    '/:id/history',
    {
      onRequest: [ownerOnly],
      schema: {
        tags: ['Products'],
        summary: 'Stock history of a product (owner only, newest first)',
        description:
          'Sales, restocks, transfers and manual corrections. Use location_id to see one location.',
        security: secured,
        params: idParams,
        querystring: historyQuery,
        response: { 200: paginatedResponse(stockMovementDto) },
      },
    },
    async (request) => service.history(request.auth, request.params.id, request.query),
  );
};
