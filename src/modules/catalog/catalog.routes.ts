import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { CATALOG } from './catalog.data.js';
import { catalogResponse } from './catalog.schemas.js';

/** Ümumi kataloq: mağaza yaradılmamışdan əvvəl də lazımdır, ona görə giriş tələb olunmur. */
export const catalogRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/categories',
    {
      schema: {
        tags: ['Catalog'],
        summary: 'Main categories with their subcategories (names in en, az, ru, tr)',
        response: { 200: catalogResponse },
      },
    },
    async (_request, reply) => {
      reply.header('Cache-Control', 'public, max-age=3600');
      return { categories: CATALOG };
    },
  );
};
