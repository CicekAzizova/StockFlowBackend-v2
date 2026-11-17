import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { isUniqueViolation, withTransaction } from '../../db/pool.js';
import { badRequest, conflict, notFound } from '../../shared/errors.js';
import { requireStoreId } from '../../shared/auth-helpers.js';
import { idParams, messageResponse, optionalString, requiredString } from '../../shared/schemas.js';
import * as repo from './locations.repository.js';

/** Bir mağazada ən çox məkan sayı (sui-istifadədən qorunmaq üçün). */
export const MAX_LOCATIONS = 20;

const kindSchema = z.enum(['store', 'warehouse'], { error: 'Kind must be store or warehouse' });

const locationDto = z.object({
  id: z.number().int(),
  name: z.string(),
  kind: kindSchema,
  address: z.string(),
  is_main: z.boolean().describe('The main location is where sales go by default (always a store)'),
});

const createBody = z.object({
  name: requiredString(80, 'Location name is required'),
  kind: kindSchema.default('store'),
  address: optionalString(250).default(''),
  is_main: z.boolean().default(false),
});

const updateBody = z.object({
  name: requiredString(80, 'Location name is required').optional(),
  address: optionalString(250).optional(),
  is_main: z
    .literal(true, { error: 'Pick another location as main instead' })
    .optional()
    .describe('Only true: it makes this location the main one'),
});

const secured = [{ bearerAuth: [] }];
const ALREADY_EXISTS = [
  'LOCATION_ALREADY_EXISTS',
  'A location with this name already exists',
] as const;

export const locationRoutes: FastifyPluginAsyncZod = async (app) => {
  const { pool } = app.deps;
  app.addHook('onRequest', app.authenticate);
  app.addHook('onRequest', app.requireRole('OWNER'));

  app.get(
    '',
    {
      schema: {
        tags: ['Locations'],
        summary: 'List the stores and warehouses of the current store (main one first)',
        security: secured,
        response: { 200: z.array(locationDto) },
      },
    },
    async (request) => repo.listLocations(pool, requireStoreId(request.auth)),
  );

  app.post(
    '',
    {
      schema: {
        tags: ['Locations'],
        summary: 'Add a store or a warehouse',
        description:
          'The main location must be a store. Making a new location main replaces the previous main one.',
        security: secured,
        body: createBody,
        response: { 201: locationDto },
      },
    },
    async (request, reply) => {
      const storeId = requireStoreId(request.auth);
      const body = request.body;
      if (body.is_main && body.kind !== 'store') {
        throw badRequest('MAIN_MUST_BE_STORE', 'A warehouse cannot be the main location');
      }
      try {
        const created = await withTransaction(pool, async (tx) => {
          if ((await repo.countLocations(tx, storeId)) >= MAX_LOCATIONS) {
            throw badRequest(
              'LOCATION_LIMIT',
              `A store can have at most ${MAX_LOCATIONS} locations`,
            );
          }
          if (body.is_main) await repo.clearMain(tx, storeId);
          return repo.insertLocation(tx, {
            storeId,
            name: body.name,
            kind: body.kind,
            address: body.address,
            isMain: body.is_main,
          });
        });
        return reply.code(201).send(created);
      } catch (error) {
        if (isUniqueViolation(error, 'locations_store_name_uq')) throw conflict(...ALREADY_EXISTS);
        throw error;
      }
    },
  );

  app.patch(
    '/:id',
    {
      schema: {
        tags: ['Locations'],
        summary: 'Rename a location, change its address or make it the main one',
        security: secured,
        params: idParams,
        body: updateBody,
        response: { 200: locationDto },
      },
    },
    async (request) => {
      const storeId = requireStoreId(request.auth);
      const { id } = request.params;
      const { is_main: makeMain, ...fields } = request.body;
      try {
        return await withTransaction(pool, async (tx) => {
          const existing = await repo.findLocation(tx, storeId, id);
          if (!existing) throw notFound('LOCATION_NOT_FOUND', 'Location not found');
          if (makeMain && existing.kind !== 'store') {
            throw badRequest('MAIN_MUST_BE_STORE', 'A warehouse cannot be the main location');
          }
          const updated = await repo.updateLocation(tx, storeId, id, fields);
          if (!updated) throw notFound('LOCATION_NOT_FOUND', 'Location not found');
          if (makeMain && !existing.is_main) {
            await repo.clearMain(tx, storeId);
            await repo.setMain(tx, storeId, id);
            return { ...updated, is_main: true };
          }
          return updated;
        });
      } catch (error) {
        if (isUniqueViolation(error, 'locations_store_name_uq')) throw conflict(...ALREADY_EXISTS);
        throw error;
      }
    },
  );

  app.delete(
    '/:id',
    {
      schema: {
        tags: ['Locations'],
        summary: 'Delete a location',
        description:
          'The main location cannot be deleted: make another store the main one first. ' +
          'A location that still has stock, sales or transfer history, or assigned sales associates cannot be deleted.',
        security: secured,
        params: idParams,
        response: { 200: messageResponse },
      },
    },
    async (request) => {
      const storeId = requireStoreId(request.auth);
      const { id } = request.params;
      const existing = await repo.findLocation(pool, storeId, id);
      if (!existing) throw notFound('LOCATION_NOT_FOUND', 'Location not found');
      if (existing.is_main) {
        throw badRequest(
          'CANNOT_DELETE_MAIN_LOCATION',
          'The main location cannot be deleted. Make another store the main one first',
        );
      }
      const usage = await repo.usageOf(pool, id);
      if (usage.has_sales) {
        throw conflict(
          'LOCATION_HAS_SALES',
          'This location has sales history and cannot be deleted',
        );
      }
      if (usage.has_transfers) {
        throw conflict(
          'LOCATION_HAS_TRANSFERS',
          'This location has stock transfer history and cannot be deleted',
        );
      }
      if (usage.has_sellers) {
        throw conflict(
          'LOCATION_HAS_SELLERS',
          'Sales associates work at this location. Move them to another store first',
        );
      }
      if (usage.has_stock) {
        throw conflict(
          'LOCATION_HAS_STOCK',
          'This location still has stock. Move or remove it first',
        );
      }
      await repo.deleteLocation(pool, storeId, id);
      return { message: 'Location deleted successfully' };
    },
  );
};
