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

/**
 * Təqvim ilinin 12 ayı (yanvar-dekabr), mağaza vaxtı ilə. Hələ gəlməmiş aylar sıfırdır.
 * Hesablama `salesBuckets` ilə eynidir, yalnız dövr "son N ay" yox, verilmiş ildir.
 */
export function salesBucketsForYear(
  db: Queryable,
  input: {
    storeId: number;
    timezone: string;
    year: number;
    locationId?: number | undefined;
  },
): Promise<BucketRow[]> {
  return queryMany<BucketRow>(
    db,
    `WITH series AS (
       SELECT generate_series(make_date($3::int, 1, 1), make_date($3::int, 12, 1), interval '1 month')::date
         AS bucket
     )
     SELECT to_char(series.bucket, 'YYYY-MM') AS label,
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
      AND s.created_at >= make_date($3::int, 1, 1)::timestamp AT TIME ZONE $2
      AND s.created_at < make_date($3::int + 1, 1, 1)::timestamp AT TIME ZONE $2
      AND date_trunc('month', s.created_at AT TIME ZONE $2)::date = series.bucket
      AND ($4::bigint IS NULL OR s.location_id = $4)
     LEFT JOIN sale_items si ON si.sale_id = s.id
     GROUP BY series.bucket
     ORDER BY series.bucket`,
    [input.storeId, input.timezone, input.year, input.locationId ?? null],
  );
}

/** İlk satışın ili və bu gün (mağaza vaxtı ilə). Satış yoxdursa ilk il = cari il. */
export async function reportYears(
  db: Queryable,
  input: { storeId: number; timezone: string; locationId?: number | undefined },
): Promise<{ first_year: number; current_year: number; current_month: number }> {
  const rows = await queryMany<{ first_year: number; current_year: number; current_month: number }>(
    db,
    `SELECT COALESCE(EXTRACT(YEAR FROM MIN(s.created_at AT TIME ZONE $2))::int,
                     EXTRACT(YEAR FROM now() AT TIME ZONE $2)::int) AS first_year,
            EXTRACT(YEAR FROM now() AT TIME ZONE $2)::int AS current_year,
            EXTRACT(MONTH FROM now() AT TIME ZONE $2)::int AS current_month
     FROM (SELECT 1) AS one
     LEFT JOIN sales s
       ON s.store_id = $1 AND ($3::bigint IS NULL OR s.location_id = $3)`,
    [input.storeId, input.timezone, input.locationId ?? null],
  );
  const row = rows[0];
  return {
    first_year: Number(row?.first_year),
    current_year: Number(row?.current_year),
    current_month: Number(row?.current_month),
  };
}

/** `salesByLocation` kimi, amma dövr verilmiş təqvim ilidir. */
export function salesByLocationForYear(
  db: Queryable,
  input: { storeId: number; timezone: string; year: number },
): Promise<LocationRow[]> {
  return queryMany<LocationRow>(
    db,
    `SELECT l.id AS location_id,
            l.name,
            COALESCE(SUM(si.line_total), 0) AS revenue,
            COALESCE(SUM(CASE WHEN si.unit_cost IS NOT NULL
                              THEN si.line_total - si.unit_cost * si.quantity END), 0) AS profit,
            COUNT(DISTINCT s.id) AS orders
     FROM locations l
     LEFT JOIN sales s
       ON s.location_id = l.id
      AND s.store_id = $1
      AND s.created_at >= make_date($3::int, 1, 1)::timestamp AT TIME ZONE $2
      AND s.created_at < make_date($3::int + 1, 1, 1)::timestamp AT TIME ZONE $2
     LEFT JOIN sale_items si ON si.sale_id = s.id
     WHERE l.store_id = $1
     GROUP BY l.id, l.name, l.kind
     HAVING l.kind = 'store' OR COUNT(s.id) > 0
     ORDER BY revenue DESC, l.id`,
    [input.storeId, input.timezone, input.year],
  );
}
