import { z } from 'zod';
import { MAIN_CATEGORY_CODES } from './catalog.data.js';

export const MAX_MAIN_CATEGORIES = 5;

/** Mağazanın əsas kateqoriyaları: 1-dən 5-ə qədər, təkrarsız. */
export const mainCategoriesSchema = z
  .array(z.enum(MAIN_CATEGORY_CODES, { error: 'Unsupported category' }), {
    error: 'Categories must be a list',
  })
  .min(1, 'Choose at least one category')
  .max(MAX_MAIN_CATEGORIES, `Choose at most ${MAX_MAIN_CATEGORIES} categories`)
  .refine((codes) => new Set(codes).size === codes.length, 'Categories must not repeat');

const namesDto = z.object({
  en: z.string(),
  az: z.string(),
  ru: z.string(),
  tr: z.string(),
});

export const catalogResponse = z.object({
  categories: z.array(
    z.object({
      code: z.string(),
      names: namesDto,
      subcategories: z.array(z.object({ code: z.string(), names: namesDto })),
    }),
  ),
});
