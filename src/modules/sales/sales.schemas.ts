import { z } from 'zod';
import { paginationQuery } from '../../shared/schemas.js';

const INVALID_SALE = 'Valid product_id and positive quantity are required';

const positiveInt = z
  .number({ error: INVALID_SALE })
  .int(INVALID_SALE)
  .positive(INVALID_SALE)
  .max(1_000_000, INVALID_SALE);

export const PAYMENT_METHODS = ['cash', 'card', 'transfer', 'other'] as const;

const saleItemInput = z.object({ product_id: positiveInt, quantity: positiveInt });

/**
 * İki forma qəbul edilir:
 *  1) köhnə (iOS indi bunu göndərir): { product_id, quantity }
 *  2) səbət: { items: [{ product_id, quantity }, ...] }
 * Hər ikisi eyni daxili formaya (items) çevrilir.
 */
export const createSaleBody = z
  .object({
    product_id: positiveInt.optional(),
    quantity: positiveInt.optional(),
    items: z
      .array(saleItemInput)
      .min(1, INVALID_SALE)
      .max(100, 'At most 100 items per sale')
      .optional(),
    payment_method: z.enum(PAYMENT_METHODS).default('cash'),
    note: z.string().trim().max(500).optional(),
  })
  .transform((body, ctx) => {
    const items =
      body.items ??
      (body.product_id !== undefined && body.quantity !== undefined
        ? [{ product_id: body.product_id, quantity: body.quantity }]
        : null);
    if (!items) {
      ctx.addIssue({ code: 'custom', message: INVALID_SALE });
      return z.NEVER;
    }
    return { items, payment_method: body.payment_method, note: body.note };
  });

export type CreateSaleInput = z.output<typeof createSaleBody>;

const isoDate = z.iso.date({ error: 'Date must look like YYYY-MM-DD' });

export const salesListQuery = paginationQuery.extend({
  seller_id: z.coerce
    .number()
    .int()
    .positive({ error: 'seller_id must be a positive integer' })
    .optional(),
  from: isoDate.optional().describe('First day (inclusive), in the store time zone'),
  to: isoDate.optional().describe('Last day (inclusive), in the store time zone'),
});

export const saleItemDto = z.object({
  product_id: z.number().int(),
  product_name: z.string(),
  sku: z.string(),
  quantity: z.number().int(),
  unit_price: z.number(),
  line_total: z.number(),
  product_image_url: z.string().nullable().describe('Small version of the first product photo'),
});

/**
 * iOS-dakı SaleResponse modeli bu açarlara güvənir.
 * product_id, product_name, quantity və unit_price qəbzdəki ilk sətirdir (tək məhsullu satışda
 * satışın özüdür). Bütün sətirlər items massivindədir.
 */
export const saleDto = z.object({
  id: z.number().int(),
  receipt_no: z.number().int(),
  product_id: z.number().int(),
  product_name: z.string(),
  product_image_url: z.string().nullable(),
  quantity: z.number().int(),
  unit_price: z.number(),
  total_price: z.number(),
  sold_by: z.number().int(),
  seller_name: z.string(),
  payment_method: z.enum(PAYMENT_METHODS),
  created_at: z.string().describe('UTC, format yyyy-MM-dd HH:mm:ss'),
  items: z.array(saleItemDto),
});

export type SaleDto = z.infer<typeof saleDto>;

/** Diqqət: bu cavabda açarlar camelCase-dir, çünki iOS-dakı CreateSaleResponse belə gözləyir. */
export const createSaleResponse = z.object({
  message: z.string(),
  saleId: z.number().int(),
  totalPrice: z.number(),
  receipt_no: z.number().int(),
  sale: saleDto,
});

export const salesSummaryResponse = z.object({
  today_sales: z.number(),
  today_orders: z.number().int(),
  total_sales: z.number().describe('Total for the current month'),
  total_orders: z.number().int().describe('Number of sales in the current month'),
});

export const dailySalesQuery = z.object({
  days: z.coerce
    .number()
    .int()
    .min(1, { error: 'days must be between 1 and 31' })
    .max(31, { error: 'days must be between 1 and 31' })
    .default(7),
});

export const dailySalesResponse = z.object({
  days: z
    .array(
      z.object({
        date: z.string().describe('Day in the store time zone, YYYY-MM-DD'),
        total: z.number(),
        orders: z.number().int(),
      }),
    )
    .describe('Oldest first. The last item is today. Days without sales are included as zeros.'),
  total: z.number().describe('Sum of all returned days'),
  orders: z.number().int().describe('Number of sales in all returned days'),
});
