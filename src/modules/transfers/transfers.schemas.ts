import { z } from 'zod';
import { paginationQuery } from '../../shared/schemas.js';

const INVALID = 'Valid product_id and positive quantity are required';

const positiveInt = z
  .number({ error: INVALID })
  .int(INVALID)
  .positive(INVALID)
  .max(1_000_000, INVALID);

const idSchema = z.number({ error: 'Invalid location' }).int().positive('Invalid location');

export const createTransferBody = z.object({
  from_location_id: idSchema,
  to_location_id: idSchema,
  items: z
    .array(z.object({ product_id: positiveInt, quantity: positiveInt }))
    .min(1, INVALID)
    .max(100, 'At most 100 items per transfer'),
  note: z.string().trim().max(500).optional(),
});

export type CreateTransferInput = z.output<typeof createTransferBody>;

export const transferListQuery = paginationQuery.extend({
  location_id: z.coerce
    .number()
    .int()
    .positive({ error: 'location_id must be a positive integer' })
    .optional()
    .describe('Only transfers that leave from or arrive at this location'),
});

export const transferItemDto = z.object({
  product_id: z.number().int().nullable().describe('null if the product was deleted later'),
  product_name: z.string(),
  sku: z.string(),
  quantity: z.number().int(),
});

export const transferDto = z.object({
  id: z.number().int(),
  from_location_id: z.number().int(),
  from_location_name: z.string(),
  to_location_id: z.number().int(),
  to_location_name: z.string(),
  created_by: z.number().int(),
  created_by_name: z.string(),
  note: z.string().nullable(),
  created_at: z.string().describe('UTC, format yyyy-MM-dd HH:mm:ss'),
  items: z.array(transferItemDto),
});

export type TransferDto = z.infer<typeof transferDto>;
