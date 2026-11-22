import { z } from 'zod';

export const REPORT_PERIODS = ['week', 'month', 'year'] as const;

export const salesReportQuery = z.object({
  period: z.enum(REPORT_PERIODS, { error: 'period must be week, month or year' }).default('week'),
  location_id: z.coerce
    .number({ error: 'location_id must be a positive integer' })
    .int({ error: 'location_id must be a positive integer' })
    .positive({ error: 'location_id must be a positive integer' })
    .optional(),
});

const totals = {
  revenue: z.number().describe('Sum of sold items (what customers paid)'),
  profit: z
    .number()
    .describe('Revenue minus cost, counted only for items whose cost price was known when sold'),
  orders: z.number().int(),
  items_sold: z.number().int().describe('Total quantity sold'),
};

export const salesReportResponse = z.object({
  period: z.enum(REPORT_PERIODS),
  from: z.string().describe('First bucket: YYYY-MM-DD (week, month) or YYYY-MM (year)'),
  to: z.string().describe('Last bucket, the current day or month'),
  ...totals,
  unknown_cost_revenue: z
    .number()
    .describe('Revenue from items whose cost price was unknown. It is NOT part of profit.'),
  previous: z
    .object(totals)
    .describe('The same totals for the period of equal length right before this one'),
  by_location: z
    .array(
      z.object({
        location_id: z.number().int(),
        name: z.string(),
        revenue: totals.revenue,
        profit: totals.profit,
        orders: z.number().int(),
      }),
    )
    .describe(
      'Revenue per place, biggest first. Only when no `location_id` filter is set, otherwise empty.',
    ),
  buckets: z
    .array(
      z.object({
        label: z.string().describe('YYYY-MM-DD (week, month) or YYYY-MM (year)'),
        ...totals,
      }),
    )
    .describe('Oldest first. Empty buckets are included as zeros.'),
});

export type SalesReportQuery = z.infer<typeof salesReportQuery>;
