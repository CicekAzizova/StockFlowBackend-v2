import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { badRequest } from '../../shared/errors.js';
import { idParams, messageResponse } from '../../shared/schemas.js';
import { associateDtoSchema, userDtoSchema } from './users.dto.js';
import {
  createAssociateBody,
  deleteAccountBody,
  updateAssociateBody,
  updateMeBody,
} from './users.schemas.js';
import { createUsersService } from './users.service.js';

const secured = [{ bearerAuth: [] }];

export const userRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = createUsersService(app.deps, app.log);
  const ownerOnly = app.requireRole('OWNER');
  app.addHook('onRequest', app.authenticate);

  // ---------------------------------------------------------------- öz profili

  app.get(
    '/me',
    {
      config: { allowUnverified: true },
      schema: {
        tags: ['Profile'],
        summary: 'Profile of the signed-in user',
        security: secured,
        response: { 200: userDtoSchema },
      },
    },
    async (request) => service.getMe(request.auth.userId),
  );

  app.patch(
    '/me',
    {
      config: { allowUnverified: true },
      schema: {
        tags: ['Profile'],
        summary: 'Edit own name, surname, phone or language',
        description: 'Sales associates may only change the language.',
        security: secured,
        body: updateMeBody,
        response: { 200: userDtoSchema },
      },
    },
    async (request) => service.updateMe(request.auth.userId, request.body),
  );

  app.post(
    '/me/avatar',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
      schema: {
        tags: ['Profile'],
        summary: 'Upload a profile photo',
        description:
          'multipart/form-data with the image in the field "image" (JPEG, PNG or WebP, max 5 MB).',
        consumes: ['multipart/form-data'],
        security: secured,
        response: { 200: userDtoSchema },
      },
    },
    async (request) => {
      const file = await request.file();
      if (!file || file.fieldname !== 'image') {
        throw badRequest('IMAGE_REQUIRED', 'Image file is required');
      }
      return service.setAvatar(request.auth.userId, await file.toBuffer());
    },
  );

  app.delete(
    '/me/avatar',
    {
      schema: {
        tags: ['Profile'],
        summary: 'Remove the profile photo',
        security: secured,
        response: { 200: userDtoSchema },
      },
    },
    async (request) => service.removeAvatar(request.auth.userId),
  );

  app.delete(
    '/me',
    {
      onRequest: [ownerOnly],
      config: { allowUnverified: true, rateLimit: { max: 5, timeWindow: '10 minutes' } },
      schema: {
        tags: ['Profile'],
        summary: 'Delete the owner account permanently',
        description:
          'Owner only (required by the App Store). All stores, products, sales and sales ' +
          'associates are deleted. Associates cannot delete themselves; the owner removes them ' +
          'with DELETE /users/{id}.',
        security: secured,
        body: deleteAccountBody,
        response: { 200: messageResponse },
      },
    },
    async (request) => {
      await service.deleteAccount(request.auth.userId, request.body.password);
      return { message: 'Account deleted successfully' };
    },
  );

  // ---------------------------------------------------------------- komanda (yalnız sahib)

  app.get(
    '',
    {
      onRequest: [ownerOnly],
      schema: {
        tags: ['Team'],
        summary: "Sales associates of the current store with today's sales",
        security: secured,
        response: { 200: z.array(associateDtoSchema) },
      },
    },
    async (request) => service.listAssociates(request.auth),
  );

  app.post(
    '/sales-associate',
    {
      onRequest: [ownerOnly],
      schema: {
        tags: ['Team'],
        summary: 'Create a sales associate',
        security: secured,
        body: createAssociateBody,
        response: { 201: associateDtoSchema },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await service.createAssociate(request.auth, request.body)),
  );

  app.patch(
    '/sales-associate/:id',
    {
      onRequest: [ownerOnly],
      schema: {
        tags: ['Team'],
        summary: 'Edit a sales associate',
        security: secured,
        params: idParams,
        body: updateAssociateBody,
        response: { 200: associateDtoSchema },
      },
    },
    async (request) => service.updateAssociate(request.auth, request.params.id, request.body),
  );

  app.delete(
    '/:id',
    {
      onRequest: [ownerOnly],
      schema: {
        tags: ['Team'],
        summary: 'Remove a sales associate (login is blocked, sales history is kept)',
        security: secured,
        params: idParams,
        response: { 200: messageResponse },
      },
    },
    async (request) => {
      await service.deleteAssociate(request.auth, request.params.id);
      return { message: 'Sales associate deleted successfully' };
    },
  );
};
