import { z } from 'zod';
import { paginationQuery } from '../../shared/schemas.js';

const INVALID_SALE = 'Valid product_id and positive quantity are required';

const positiveInt = z
  .number({ error: INVALID_SALE })
  .int(INVALID_SALE)
  .positive(INVALID_SALE)
  .max(1_000_000, INVALID_SALE);

export const PAYMENT_METHODS = ['cash', 'card', 'transfer', 'other'] as const;
/** Satışın özündə: bir neçə üsulla ödənibsə 'mixed'. */
export const SALE_PAYMENT_METHODS = [...PAYMENT_METHODS, 'mixed'] as const;

const paymentInput = z.object({
  method: z.enum(PAYMENT_METHODS),
  amount: z
    .number({ error: 'Payment amount must be a positive number' })
    .positive('Payment amount must be a positive number')
    .max(1_000_000_000, 'Payment amount is too large'),
});

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
    payments: z
      .array(paymentInput)
      .min(1)
      .max(PAYMENT_METHODS.length)
      .refine((list) => new Set(list.map((p) => p.method)).size === list.length, {
        message: 'Each payment method can appear only once',
      })
      .optional()
      .describe('Split payment. The amounts must add up to the final total.'),
    discount: z
      .number({ error: 'Discount must be a non-negative number' })
      .min(0, 'Discount must be a non-negative number')
      .max(1_000_000_000, 'Discount is too large')
      .optional()
      .describe('Cashier discount for the whole sale, as an amount (not a percentage)'),
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
    return {
      items,
      payment_method: body.payment_method,
      payments: body.payments,
      discount: body.discount ?? 0,
      note: body.note,
    };
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
  location_id: z.coerce
    .number({ error: 'location_id must be a positive integer' })
    .int({ error: 'location_id must be a positive integer' })
    .positive({ error: 'location_id must be a positive integer' })
    .optional(),
  payment_method: z
    .enum(PAYMENT_METHODS)
    .optional()
    .describe('Keeps sales paid with this method, split payments included'),
});

export const RETURN_REASONS = ['damaged', 'customer_declined', 'wrong_item', 'other'] as const;

export const createReturnBody = z.object({
  items: z
    .array(z.object({ sale_item_id: positiveInt, quantity: positiveInt }))
    .min(1, 'At least one item is required')
    .max(100, 'At most 100 items per return')
    .refine((list) => new Set(list.map((i) => i.sale_item_id)).size === list.length, {
      message: 'Each sale item can appear only once',
    }),
  reason: z.enum(RETURN_REASONS).default('other'),
  refund_method: z
    .enum(PAYMENT_METHODS)
    .default('cash')
    .describe('How the money was given back. Keeps the cash drawer total correct.'),
  restock: z
    .boolean()
    .default(true)
    .describe('Put the goods back on the shelf. Off for damaged goods.'),
  note: z.string().trim().max(500).optional(),
});

export type CreateReturnInput = z.output<typeof createReturnBody>;

export const saleReturnDto = z.object({
  id: z.number().int(),
  sale_id: z.number().int(),
  reason: z.enum(RETURN_REASONS),
  refund_method: z.enum(PAYMENT_METHODS),
  restocked: z.boolean(),
  total_amount: z.number(),
  created_at: z.string().describe('UTC, format yyyy-MM-dd HH:mm:ss'),
  items: z.array(
    z.object({
      sale_item_id: z.number().int(),
      product_id: z.number().int(),
      product_name: z.string(),
      quantity: z.number().int(),
      line_total: z.number(),
    }),
  ),
});

export const saleItemDto = z.object({
  id: z.number().int(),
  product_id: z.number().int(),
  product_name: z.string(),
  sku: z.string(),
  quantity: z.number().int(),
  unit_price: z.number(),
  line_total: z.number(),
  returned_quantity: z.number().int().describe('How many of this line were returned'),
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
  total_price: z.number().describe('Final amount after the cashier discount'),
  discount: z.number().describe('Cashier discount amount (0 when none)'),
  returned_amount: z.number().describe('How much of this sale was refunded (0 when none)'),
  sold_by: z.number().int(),
  seller_name: z.string(),
  seller_avatar_url: z.string().nullable(),
  location_id: z.number().int(),
  location_name: z.string(),
  payment_method: z.enum(SALE_PAYMENT_METHODS),
  payments: z.array(z.object({ method: z.enum(PAYMENT_METHODS), amount: z.number() })),
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

export const salesTotalsQuery = z.object({
  from: isoDate.describe('First day (inclusive), in the store time zone'),
  to: isoDate.describe('Last day (inclusive), in the store time zone'),
  seller_id: z.coerce
    .number({ error: 'seller_id must be a positive integer' })
    .int({ error: 'seller_id must be a positive integer' })
    .positive({ error: 'seller_id must be a positive integer' })
    .optional(),
  location_id: z.coerce
    .number({ error: 'location_id must be a positive integer' })
    .int({ error: 'location_id must be a positive integer' })
    .positive({ error: 'location_id must be a positive integer' })
    .optional(),
  payment_method: z
    .enum(PAYMENT_METHODS)
    .optional()
    .describe('Keeps sales paid with this method, split payments included'),
});

const salesTotals = {
  revenue: z.number().describe('Sum of sale totals'),
  orders: z.number().int().describe('Number of sales'),
  average_check: z.number().describe('Revenue divided by orders, 0 when there are no sales'),
};

export const salesTotalsResponse = z.object({
  from: z.string(),
  to: z.string(),
  ...salesTotals,
  items_sold: z.number().int().describe('Units sold, returns subtracted'),
  returned: z.number().describe('How much was refunded in this period'),
  previous: z
    .object(salesTotals)
    .describe('The same totals for the period of equal length right before `from`'),
  by_seller: z
    .array(
      z.object({
        seller_id: z.number().int(),
        seller_name: z.string(),
        revenue: z.number(),
        orders: z.number().int(),
      }),
    )
    .describe('Revenue per seller, biggest first. Associates only see themselves.'),
  by_payment: z
    .array(
      z.object({
        method: z.enum(PAYMENT_METHODS),
        received: z.number().describe('Taken in from sales'),
        refunded: z.number().describe('Given back by returns'),
        amount: z.number().describe('received - refunded'),
      }),
    )
    .describe('Money per payment method, biggest first'),
});
