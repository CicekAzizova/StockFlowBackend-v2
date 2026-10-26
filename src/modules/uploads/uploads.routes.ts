import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { saveImage } from '../../infra/images.js';
import { badRequest } from '../../shared/errors.js';
import { requireStoreId } from '../../shared/auth-helpers.js';

const secured = [{ bearerAuth: [] }];

/** iOS-dakı ImageUploadResponse yalnız imageUrl oxuyur. */
const uploadResponse = z.object({
  imageUrl: z.string().describe('Full-size image, put this into image_urls'),
  thumbnailUrl: z.string().describe('Small version for lists'),
});

export const uploadRoutes: FastifyPluginAsyncZod = async (app) => {
  const { storage } = app.deps;
  app.addHook('onRequest', app.authenticate);

  app.post(
    '/images',
    {
      onRequest: [app.requireRole('OWNER')],
      config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
      schema: {
        tags: ['Uploads'],
        summary: 'Upload a product image (owner only)',
        description:
          'multipart/form-data with the image in the field "image" (JPEG, PNG or WebP, max 5 MB). ' +
          'The server resizes it, strips location data and creates a thumbnail.',
        consumes: ['multipart/form-data'],
        security: secured,
        response: { 201: uploadResponse },
      },
    },
    async (request, reply) => {
      const storeId = requireStoreId(request.auth);
      const file = await request.file();
      if (!file || file.fieldname !== 'image') {
        throw badRequest('IMAGE_REQUIRED', 'Image file is required');
      }
      const stored = await saveImage(
        storage,
        await file.toBuffer(),
        'product',
        `products/${storeId}`,
      );
      return reply.code(201).send({ imageUrl: stored.url, thumbnailUrl: stored.thumbnailUrl });
    },
  );
};
