import { z } from 'zod';

/** Ortaq zod sxemləri: id, səhifələmə, mesaj cavabı. */

export const REQUIRED_MESSAGE = 'All fields are required';

/** Boş olmayan, kəsilmiş mətn. Çatışmayanda köhnə API ilə eyni mesaj verilir. */
export const requiredString = (max: number, message = REQUIRED_MESSAGE) =>
  z.string({ error: message }).trim().min(1, message).max(max, `Must be at most ${max} characters`);

export const optionalString = (max: number) =>
  z.string().trim().max(max, `Must be at most ${max} characters`);

export const emailSchema = z
  .string({ error: 'A valid email is required' })
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'A valid email is required' }).max(254));

/** +994 50 123 45 67, 050-123-45-67 və s. kimi formatlara icazə verir. */
export const phoneSchema = z
  .string({ error: 'A valid phone number is required' })
  .trim()
  .regex(/^\+?[0-9 ()-]{6,20}$/, 'A valid phone number is required');

export const MIN_PASSWORD_LENGTH = 6;

export const passwordSchema = z
  .string({ error: 'Password is required' })
  .min(MIN_PASSWORD_LENGTH, `Password must contain at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(128, 'Password is too long');

export const localeSchema = z.enum(['az', 'en', 'ru']);

export const idParams = z.object({
  id: z.coerce.number().int().positive({ error: 'Invalid id' }),
});

export const messageResponse = z.object({ message: z.string() });

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1, 'Page must be a positive integer').default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1, 'Limit must be a positive integer')
    .max(100, 'Limit must be at most 100')
    .default(20),
});

export type PaginationQuery = z.infer<typeof paginationQuery>;

export function paginatedResponse<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    has_next: z.boolean(),
  });
}

export function toPage<T>(items: T[], total: number, { page, limit }: PaginationQuery) {
  return { items, page, limit, total, has_next: (page - 1) * limit + items.length < total };
}

export const offsetOf = ({ page, limit }: PaginationQuery) => (page - 1) * limit;
