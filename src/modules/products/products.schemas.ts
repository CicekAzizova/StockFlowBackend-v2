import { z } from 'zod';
import { optionalString, paginationQuery, requiredString } from '../../shared/schemas.js';

const REQUIRED = 'Name, SKU and price are required';

/** Pul məbləği: mənfi olmayan, ən çoxu iki onluq. */
const money = (message: string) =>
  z
    .number({ error: message })
    .min(0, message)
    .max(1_000_000_000, message)
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, message);

export const WEIGHT_UNITS = ['mg', 'g', 'kg', 'ml', 'l'] as const;

/**
 * Yaratma və yeniləmə eyni sxemdən istifadə edir.
 * Yeniləmədə göndərilməyən (undefined) sahə dəyişmir, null isə sahəni təmizləyir.
 */
export const productBody = z.object({
  name: requiredString(200, REQUIRED),
  sku: requiredString(64, REQUIRED),
  price: money('Price must be a valid non-negative number'),
  category: optionalString(80).optional(),
  description: optionalString(2000).optional(),
  discount: z
    .number({ error: 'Discount must be between 0 and 100' })
    .min(0, 'Discount must be between 0 and 100')
    .max(100, 'Discount must be between 0 and 100')
    .optional(),
  cost_price: money('Cost price must be a valid non-negative number').optional(),
  quantity: z
    .number({ error: 'Quantity must be a non-negative integer' })
    .int('Quantity must be a non-negative integer')
    .min(0, 'Quantity must be a non-negative integer')
    .optional(),
  low_stock_limit: z
    .number({ error: 'Low-stock threshold must be a non-negative integer' })
    .int('Low-stock threshold must be a non-negative integer')
    .min(0, 'Low-stock threshold must be a non-negative integer')
    .optional(),
  image_urls: z
    .array(z.url({ error: 'Image URLs must be valid URLs' }).max(500))
    .max(10, 'At most 10 images are allowed')
    .optional(),
  weight: z.number().min(0).max(10_000_000).nullable().optional(),
  weight_unit: z.enum(WEIGHT_UNITS).nullable().optional(),
  size: optionalString(80).nullable().optional(),
});

export type ProductBody = z.infer<typeof productBody>;

export const productListQuery = paginationQuery.extend({
  q: z.string().trim().max(100).optional().describe('Search in name and SKU'),
  category: z.string().trim().max(80).optional().describe('Exact category name'),
  stock: z.enum(['in', 'low', 'out']).optional().describe('Filter by stock status'),
});

export const lowStockQuery = paginationQuery;

export const skuQuery = z.object({
  sku: z.string({ error: 'SKU is required' }).trim().min(1, 'SKU is required').max(64),
});

export const stockBody = z.object({
  quantity: z
    .number({ error: 'Quantity must be a non-negative integer' })
    .int('Quantity must be a non-negative integer')
    .min(0, 'Quantity must be a non-negative integer'),
});

/** iOS-dakı ProductsResponse modeli bu açarlara güvənir. Silməyin, yalnız əlavə edin. */
export const productDto = z.object({
  id: z.number().int(),
  name: z.string(),
  sku: z.string(),
  category: z.string(),
  description: z.string(),
  price: z.number(),
  discount: z.number(),
  cost_price: z.number().describe('Always 0 for sales associates'),
  quantity: z.number().int(),
  low_stock_limit: z.number().int(),
  image_url: z.string().nullable().describe('First image, kept for old clients'),
  image_urls: z.array(z.string()),
  thumbnail_urls: z.array(z.string()).describe('Small versions of image_urls, same order'),
  weight: z.number().nullable(),
  weight_unit: z.enum(WEIGHT_UNITS).nullable(),
  size: z.string().nullable(),
  created_at: z.string().describe('UTC, format yyyy-MM-dd HH:mm:ss'),
  updated_at: z.string().describe('UTC, format yyyy-MM-dd HH:mm:ss'),
});

export type ProductDto = z.infer<typeof productDto>;
