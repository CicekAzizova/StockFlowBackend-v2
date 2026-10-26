import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { idParams, paginatedResponse } from '../../shared/schemas.js';
import {
  createSaleBody,
  createSaleResponse,
  saleDto,
  salesListQuery,
  salesSummaryResponse,
} from './sales.schemas.js';
import { createSalesService } from './sales.service.js';

const secured = [{ bearerAuth: [] }];

export const salesRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = createSalesService(app.deps);
  app.addHook('onRequest', app.authenticate);

  app.post(
    '',
    {
      schema: {
        tags: ['Sales'],
        summary: 'Record a sale',
        description:
          'Send { product_id, quantity } for one product or { items: [...] } for a cart. ' +
          'Stock is reduced atomically; 400 INSUFFICIENT_STOCK if there is not enough.',
        security: secured,
        body: createSaleBody,
        response: { 201: createSaleResponse },
      },
    },
    async (request, reply) => {
      const sale = await service.create(request.auth, request.body);
      return reply.code(201).send({
        message: 'Sale completed successfully',
        saleId: sale.id,
        totalPrice: sale.total_price,
        receipt_no: sale.receipt_no,
        sale,
      });
    },
  );

  app.get(
    '/summary',
    {
      schema: {
        tags: ['Sales'],
        summary: "This month's and today's totals (associates see only their own)",
        security: secured,
        response: { 200: salesSummaryResponse },
      },
    },
    async (request) => service.summary(request.auth),
  );

  app.get(
    '',
    {
      schema: {
        tags: ['Sales'],
        summary: 'List sales (newest first). Owners see the store, associates only their own.',
        security: secured,
        querystring: salesListQuery,
        response: { 200: paginatedResponse(saleDto) },
      },
    },
    async (request) => service.list(request.auth, request.query),
  );

  app.get(
    '/:id',
    {
      schema: {
        tags: ['Sales'],
        summary: 'Get one sale with all its items (for the receipt)',
        security: secured,
        params: idParams,
        response: { 200: saleDto },
      },
    },
    async (request) => service.getById(request.auth, request.params.id),
  );
};
