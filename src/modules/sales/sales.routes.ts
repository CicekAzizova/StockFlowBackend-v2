import { locationHeader } from '../../shared/location-context.js';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { idParams, paginatedResponse } from '../../shared/schemas.js';
import {
  createReturnBody,
  createSaleBody,
  createSaleResponse,
  dailySalesQuery,
  dailySalesResponse,
  saleDto,
  saleReturnDto,
  salesListQuery,
  salesSummaryResponse,
  salesTotalsQuery,
  salesTotalsResponse,
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
      const sale = await service.create(request.auth, locationHeader(request), request.body);
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
    '/daily',
    {
      schema: {
        tags: ['Sales'],
        summary:
          'Sales per day for the last N days (default 7, store time zone). Associates see only their own.',
        security: secured,
        querystring: dailySalesQuery,
        response: { 200: dailySalesResponse },
      },
    },
    async (request) => service.daily(request.auth, request.query.days),
  );

  app.get(
    '/totals',
    {
      schema: {
        tags: ['Sales'],
        summary:
          'Totals for a date range, compared with the period of equal length right before it',
        description:
          'Revenue, number of sales and average check between `from` and `to` (both included, ' +
          'store time zone, at most 400 days), plus the same for the period right before `from` ' +
          'and a per-seller breakdown. Owners can filter by `seller_id`, `location_id` and ' +
          '`payment_method`; ' +
          'associates only see their own sales.',
        security: secured,
        querystring: salesTotalsQuery,
        response: { 200: salesTotalsResponse },
      },
    },
    async (request) => service.totals(request.auth, request.query),
  );

  app.get(
    '',
    {
      schema: {
        tags: ['Sales'],
        summary: 'List sales (newest first). Owners see the store, associates only their own.',
        description:
          'Filters: `from`, `to`, `seller_id` (owners), `location_id`, `payment_method`. ' +
          'A split payment matches every method it was paid with.',
        security: secured,
        querystring: salesListQuery,
        response: { 200: paginatedResponse(saleDto) },
      },
    },
    async (request) => service.list(request.auth, request.query),
  );

  app.post(
    '/:id/returns',
    {
      onRequest: [app.requireRole('OWNER')],
      schema: {
        tags: ['Sales'],
        summary: 'Return part or all of a sale (owner only)',
        description:
          'Each line can be returned once in full across several returns. The refunded amount ' +
          'is subtracted from revenue and profit. With `restock` the goods go back to the ' +
          "location's stock and appear in the product history as a return.",
        security: secured,
        params: idParams,
        body: createReturnBody,
        response: { 201: saleReturnDto },
      },
    },
    async (request, reply) => {
      const created = await service.createReturn(request.auth, request.params.id, request.body);
      return reply.code(201).send(created);
    },
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
