import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { salesReportQuery, salesReportResponse } from './reports.schemas.js';
import { createReportsService } from './reports.service.js';

const secured = [{ bearerAuth: [] }];

export const reportRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = createReportsService(app.deps);
  app.addHook('onRequest', app.authenticate);
  app.addHook('onRequest', app.requireRole('OWNER'));

  app.get(
    '/sales',
    {
      schema: {
        tags: ['Reports'],
        summary: 'Revenue and profit for the last week, month or year (owner only)',
        description:
          'week = last 7 days, month = last 30 days (both per day), year = last 12 months ' +
          '(per month), in the store time zone. `previous` holds the period right before it ' +
          'for comparison. Whole store by default, or one place with `location_id`. ' +
          'Profit only counts items whose cost price was known at the time of sale.',
        security: secured,
        querystring: salesReportQuery,
        response: { 200: salesReportResponse },
      },
    },
    async (request) => service.sales(request.auth, request.query),
  );
};
