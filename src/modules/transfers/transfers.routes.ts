import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { idParams, paginatedResponse } from '../../shared/schemas.js';
import { createTransferBody, transferDto, transferListQuery } from './transfers.schemas.js';
import { createTransfersService } from './transfers.service.js';

const secured = [{ bearerAuth: [] }];

export const transferRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = createTransfersService(app.deps);
  app.addHook('onRequest', app.authenticate);
  app.addHook('onRequest', app.requireRole('OWNER'));

  app.post(
    '',
    {
      schema: {
        tags: ['Transfers'],
        summary: 'Move stock from one location to another (owner only)',
        description:
          'For example from a warehouse to a store. Everything happens in one transaction: ' +
          '400 INSUFFICIENT_STOCK if the source does not have enough of any product, and nothing changes.',
        security: secured,
        body: createTransferBody,
        response: { 201: transferDto },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await service.create(request.auth, request.body)),
  );

  app.get(
    '',
    {
      schema: {
        tags: ['Transfers'],
        summary: 'Transfer history (newest first)',
        security: secured,
        querystring: transferListQuery,
        response: { 200: paginatedResponse(transferDto) },
      },
    },
    async (request) => service.list(request.auth, request.query),
  );

  app.get(
    '/:id',
    {
      schema: {
        tags: ['Transfers'],
        summary: 'Get one transfer',
        security: secured,
        params: idParams,
        response: { 200: transferDto },
      },
    },
    async (request) => service.getById(request.auth, request.params.id),
  );
};
