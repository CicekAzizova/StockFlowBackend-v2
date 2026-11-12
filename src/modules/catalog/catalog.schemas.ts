import { z } from 'zod';
import { MAIN_CATEGORY_CODES } from './catalog.data.js';

/** Mağazanın əsas kateqoriyaları: ən azı biri, təkrarsız (yuxarı limit yoxdur, hamısı seçilə bilər). */
export const mainCategoriesSchema = z
  .array(z.enum(MAIN_CATEGORY_CODES, { error: 'Unsupported category' }), {
    error: 'Categories must be a list',
  })
  .min(1, 'Choose at least one category')
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
