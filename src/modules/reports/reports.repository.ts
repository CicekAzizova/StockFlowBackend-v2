import { queryMany, type Queryable } from '../../db/pool.js';

export type Granularity = 'day' | 'month';

export interface BucketRow {
  label: string;
  revenue: number;
  profit: number;
  unknown_cost_revenue: number;
  orders: number;
  items_sold: number;
}

/**
 * `count` ədəd gün və ya ay üzrə satış cəmləri (mağaza vaxtı ilə).
 * `window` 0 olsa cari dövr, 1 olsa ondan dərhal əvvəlki eyni uzunluqlu dövr.
 * Gəlir satış sətirlərinin cəmidir. Qazanc yalnız alış qiyməti satış anında məlum olan
 * sətirlər üçün hesablanır, qalanının gəliri `unknown_cost_revenue`-da ayrıca verilir.
 * Satışsız günlər və aylar sıfırla qaytarılır.
 */
export function salesBuckets(
  db: Queryable,
  input: {
    storeId: number;
    timezone: string;
    granularity: Granularity;
    count: number;
    window: 0 | 1;
    locationId?: number | undefined;
  },
): Promise<BucketRow[]> {
  return queryMany<BucketRow>(
    db,
    `WITH today AS (SELECT (now() AT TIME ZONE $2)::date AS day),
          step AS (
            SELECT CASE WHEN $3 = 'month' THEN interval '1 month' ELSE interval '1 day' END AS size
          ),
          base AS (
            SELECT CASE WHEN $3 = 'month' THEN date_trunc('month', day)::date ELSE day END AS cur
            FROM today
          ),
          series AS (
            SELECT (base.cur - (g + $5::int * $4::int) * step.size)::date AS bucket
            FROM base, step, generate_series(0, $4::int - 1) AS g
          )
     SELECT to_char(series.bucket, CASE WHEN $3 = 'month' THEN 'YYYY-MM' ELSE 'YYYY-MM-DD' END) AS label,
            COALESCE(SUM(si.line_total), 0) AS revenue,
            COALESCE(SUM(CASE WHEN si.unit_cost IS NOT NULL
                              THEN si.line_total - si.unit_cost * si.quantity END), 0) AS profit,
            COALESCE(SUM(CASE WHEN si.unit_cost IS NULL THEN si.line_total END), 0)
              AS unknown_cost_revenue,
            COUNT(DISTINCT s.id) AS orders,
            COALESCE(SUM(si.quantity), 0) AS items_sold
     FROM series
     LEFT JOIN sales s
       ON s.store_id = $1
      AND s.created_at >= (SELECT MIN(bucket) FROM series)::timestamp AT TIME ZONE $2
      AND date_trunc($3, s.created_at AT TIME ZONE $2)::date = series.bucket
      AND ($6::bigint IS NULL OR s.location_id = $6)
     LEFT JOIN sale_items si ON si.sale_id = s.id
     GROUP BY series.bucket
     ORDER BY series.bucket`,
    [
      input.storeId,
      input.timezone,
      input.granularity,
      input.count,
      input.window,
      input.locationId ?? null,
    ],
  );
}

export interface LocationRow {
  location_id: number;
  name: string;
  revenue: number;
  profit: number;
  orders: number;
}

/**
 * Cari dövr üçün hər məkanın gəliri, qazancı və satış sayı (mağaza vaxtı ilə).
 * Satışı olmayan mağaza növlü məkanlar da sıfırla qaytarılır. Ən çox gəlirli birinci.
 */
export function salesByLocation(
  db: Queryable,
  input: { storeId: number; timezone: string; granularity: Granularity; count: number },
): Promise<LocationRow[]> {
  return queryMany<LocationRow>(
    db,
    `WITH today AS (SELECT (now() AT TIME ZONE $2)::date AS day),
          step AS (
            SELECT CASE WHEN $3 = 'month' THEN interval '1 month' ELSE interval '1 day' END AS size
          ),
          base AS (
            SELECT CASE WHEN $3 = 'month' THEN date_trunc('month', day)::date ELSE day END AS cur
            FROM today
          ),
          bounds AS (
            SELECT (base.cur - ($4::int - 1) * step.size)::date AS first_day FROM base, step
          )
     SELECT l.id AS location_id,
            l.name,
            COALESCE(SUM(si.line_total), 0) AS revenue,
            COALESCE(SUM(CASE WHEN si.unit_cost IS NOT NULL
                              THEN si.line_total - si.unit_cost * si.quantity END), 0) AS profit,
            COUNT(DISTINCT s.id) AS orders
     FROM locations l
     LEFT JOIN sales s
       ON s.location_id = l.id
      AND s.store_id = $1
      AND s.created_at >= (SELECT first_day FROM bounds)::timestamp AT TIME ZONE $2
     LEFT JOIN sale_items si ON si.sale_id = s.id
     WHERE l.store_id = $1
     GROUP BY l.id, l.name, l.kind
     HAVING l.kind = 'store' OR COUNT(s.id) > 0
     ORDER BY revenue DESC, l.id`,
    [input.storeId, input.timezone, input.granularity, input.count],
  );
}
