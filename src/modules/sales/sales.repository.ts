import { queryMany, queryOne, type Queryable } from '../../db/pool.js';
import type { PAYMENT_METHODS } from './sales.schemas.js';

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface SaleItemRow {
  product_id: number;
  product_name: string;
  sku: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  /** Satış anındakı alış qiyməti (bir vahid), məlum deyilsə null. */
  unit_cost?: number | null;
  /** Yalnız oxuma zamanı doldurulur: məhsulun ilk şəkli (məhsul silinibsə null). */
  product_image_url?: string | null;
}

export interface SaleRow {
  id: number;
  receipt_no: number;
  total_price: number;
  payment_method: PaymentMethod;
  sold_by: number;
  seller_name: string;
  seller_avatar_url: string | null;
  location_id: number;
  location_name: string;
  created_at: Date;
  items: SaleItemRow[];
}

export interface SaleListFilters {
  /** Satıcı yalnız öz satışlarını görür */
  soldBy?: number | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

const SELECT = `
  SELECT s.id, s.receipt_no, s.total_price, s.payment_method, s.sold_by, s.created_at,
         trim(u.name || ' ' || u.surname) AS seller_name,
         u.avatar_url AS seller_avatar_url,
         s.location_id, l.name AS location_name,
         COALESCE((
           SELECT json_agg(json_build_object(
                    'product_id', i.product_id, 'product_name', i.product_name, 'sku', i.sku,
                    'quantity', i.quantity, 'unit_price', i.unit_price, 'line_total', i.line_total,
                    'product_image_url', (SELECT p.image_urls[1] FROM products p WHERE p.id = i.product_id)
                  ) ORDER BY i.id)
           FROM sale_items i WHERE i.sale_id = s.id
         ), '[]'::json) AS items
  FROM sales s
  JOIN users u ON u.id = s.sold_by
  JOIN locations l ON l.id = s.location_id`;

function buildWhere(storeId: number, timezone: string, filters: SaleListFilters) {
  const conditions = ['s.store_id = $1'];
  const params: unknown[] = [storeId];
  const bind = (value: unknown) => `$${params.push(value)}`;

  if (filters.soldBy !== undefined) conditions.push(`s.sold_by = ${bind(filters.soldBy)}`);
  // Tarixlər mağazanın saat qurşağında gün sərhədləri kimi şərh olunur.
  if (filters.from) {
    conditions.push(
      `s.created_at >= (${bind(filters.from)}::date::timestamp AT TIME ZONE ${bind(timezone)})`,
    );
  }
  if (filters.to) {
    conditions.push(
      `s.created_at < ((${bind(filters.to)}::date + 1)::timestamp AT TIME ZONE ${bind(timezone)})`,
    );
  }
  return { where: conditions.join(' AND '), params };
}

export async function listSales(
  db: Queryable,
  storeId: number,
  timezone: string,
  filters: SaleListFilters,
  page: { limit: number; offset: number },
): Promise<{ rows: SaleRow[]; total: number }> {
  const { where, params } = buildWhere(storeId, timezone, filters);
  const [rows, count] = await Promise.all([
    queryMany<SaleRow>(
      db,
      `${SELECT} WHERE ${where} ORDER BY s.created_at DESC, s.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, page.limit, page.offset],
    ),
    queryOne<{ count: number }>(db, `SELECT COUNT(*) AS count FROM sales s WHERE ${where}`, params),
  ]);
  return { rows, total: count?.count ?? 0 };
}

export function findSale(
  db: Queryable,
  storeId: number,
  id: number,
  soldBy?: number,
): Promise<SaleRow | null> {
  return queryOne<SaleRow>(
    db,
    `${SELECT} WHERE s.id = $1 AND s.store_id = $2 AND ($3::bigint IS NULL OR s.sold_by = $3)`,
    [id, storeId, soldBy ?? null],
  );
}

export interface ProductForSale {
  id: number;
  name: string;
  sku: string;
  price: number;
  discount: number;
  cost_price: number | null;
  for_sale: boolean;
}

/** Satıla bilən (silinməmiş) məhsul məlumatı. */
export function findProductForSale(
  tx: Queryable,
  storeId: number,
  productId: number,
): Promise<ProductForSale | null> {
  return queryOne<ProductForSale>(
    tx,
    `SELECT id, name, sku, price, discount, cost_price, for_sale FROM products
     WHERE id = $1 AND store_id = $2 AND deleted_at IS NULL`,
    [productId, storeId],
  );
}

/**
 * Məkandakı qalığı atomik azaldır: yalnız kifayət qədər qalıq varsa sətir yenilənir.
 * İki satıcı eyni anda son ədədi almağa çalışsa yalnız biri uğur qazanır.
 * Yeni qalığı qaytarır, kifayət qədər qalıq yoxdursa null.
 */
export async function decrementStock(
  tx: Queryable,
  productId: number,
  locationId: number,
  quantity: number,
): Promise<number | null> {
  const row = await queryOne<{ quantity: number }>(
    tx,
    `UPDATE product_stock SET quantity = quantity - $3, updated_at = now()
     WHERE product_id = $1 AND location_id = $2 AND quantity >= $3
     RETURNING quantity`,
    [productId, locationId, quantity],
  );
  return row?.quantity ?? null;
}

export async function stockAt(
  tx: Queryable,
  productId: number,
  locationId: number,
): Promise<number> {
  const row = await queryOne<{ quantity: number }>(
    tx,
    'SELECT quantity FROM product_stock WHERE product_id = $1 AND location_id = $2',
    [productId, locationId],
  );
  return row?.quantity ?? 0;
}

export async function insertSale(
  tx: Queryable,
  input: {
    storeId: number;
    locationId: number;
    receiptNo: number;
    soldBy: number;
    paymentMethod: PaymentMethod;
    totalPrice: number;
    note: string | undefined;
  },
): Promise<{ id: number; created_at: Date }> {
  const row = await queryOne<{ id: number; created_at: Date }>(
    tx,
    `INSERT INTO sales (store_id, location_id, receipt_no, sold_by, payment_method, total_price, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at`,
    [
      input.storeId,
      input.locationId,
      input.receiptNo,
      input.soldBy,
      input.paymentMethod,
      input.totalPrice,
      input.note ?? null,
    ],
  );
  if (!row) throw new Error('Failed to insert sale');
  return row;
}

export async function insertSaleItem(
  tx: Queryable,
  saleId: number,
  item: SaleItemRow,
): Promise<void> {
  await tx.query(
    `INSERT INTO sale_items (sale_id, product_id, product_name, sku, quantity, unit_price, line_total, unit_cost)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      saleId,
      item.product_id,
      item.product_name,
      item.sku,
      item.quantity,
      item.unit_price,
      item.line_total,
      item.unit_cost ?? null,
    ],
  );
}

export interface SummaryRow {
  today_sales: number;
  today_orders: number;
  total_sales: number;
  total_orders: number;
}

/** Bu ayın və bu günün cəmi (mağazanın saat qurşağında). Satıcı üçün yalnız öz satışları. */
export async function monthSummary(
  db: Queryable,
  storeId: number,
  timezone: string,
  soldBy?: number,
): Promise<SummaryRow> {
  const row = await queryOne<SummaryRow>(
    db,
    `WITH bounds AS (
       SELECT (date_trunc('month', now() AT TIME ZONE $2) AT TIME ZONE $2) AS month_start,
              (date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2) AS day_start
     )
     SELECT
       COALESCE(SUM(s.total_price) FILTER (WHERE s.created_at >= b.day_start), 0) AS today_sales,
       COUNT(s.id) FILTER (WHERE s.created_at >= b.day_start) AS today_orders,
       COALESCE(SUM(s.total_price), 0) AS total_sales,
       COUNT(s.id) AS total_orders
     FROM bounds b
     LEFT JOIN sales s
       ON s.store_id = $1 AND s.created_at >= b.month_start
      AND ($3::bigint IS NULL OR s.sold_by = $3)
     GROUP BY b.month_start, b.day_start`,
    [storeId, timezone, soldBy ?? null],
  );
  return row ?? { today_sales: 0, today_orders: 0, total_sales: 0, total_orders: 0 };
}

/** Mağazanın bu ayki ümumi satışı (komanda ekranının başlığı üçün). */
export async function storeMonthTotal(
  db: Queryable,
  storeId: number,
  timezone: string,
): Promise<number> {
  const row = await queryOne<{ total: number }>(
    db,
    `SELECT COALESCE(SUM(total_price), 0) AS total FROM sales
     WHERE store_id = $1
       AND created_at >= (date_trunc('month', now() AT TIME ZONE $2) AT TIME ZONE $2)`,
    [storeId, timezone],
  );
  return row?.total ?? 0;
}

export interface DailySalesRow {
  date: string;
  total: number;
  orders: number;
}

/** Son N günün hər günü üçün satış cəmi (mağazanın saat qurşağında), satışsız günlər sıfırla. */
export function dailySales(
  db: Queryable,
  storeId: number,
  timezone: string,
  days: number,
  soldBy?: number,
): Promise<DailySalesRow[]> {
  return queryMany<DailySalesRow>(
    db,
    `WITH today AS (SELECT (now() AT TIME ZONE $2)::date AS day),
          series AS (
            SELECT (t.day - g)::date AS day
            FROM today t, generate_series(0, $3::int - 1) AS g
          )
     SELECT to_char(series.day, 'YYYY-MM-DD') AS date,
            COALESCE(SUM(s.total_price), 0) AS total,
            COUNT(s.id) AS orders
     FROM series
     LEFT JOIN sales s
       ON s.store_id = $1
      AND s.created_at >= ((SELECT day FROM today) - ($3::int - 1))::timestamp AT TIME ZONE $2
      AND (s.created_at AT TIME ZONE $2)::date = series.day
      AND ($4::bigint IS NULL OR s.sold_by = $4)
     GROUP BY series.day
     ORDER BY series.day`,
    [storeId, timezone, days, soldBy ?? null],
  );
}

export interface TotalsFilters {
  /** Satıcı yalnız öz satışlarını görür */
  soldBy?: number | undefined;
  locationId?: number | undefined;
}

export interface TotalsRow {
  revenue: number;
  orders: number;
}

export interface SellerTotalsRow {
  seller_id: number;
  seller_name: string;
  revenue: number;
  orders: number;
}

/** Tarixlər mağazanın saat qurşağında gün sərhədləridir, hər iki gün daxildir. */
const RANGE = `s.store_id = $1
  AND s.created_at >= ($3::date::timestamp AT TIME ZONE $2)
  AND s.created_at < (($4::date + 1)::timestamp AT TIME ZONE $2)
  AND ($5::bigint IS NULL OR s.sold_by = $5)
  AND ($6::bigint IS NULL OR s.location_id = $6)`;

/** Verilmiş tarix aralığı üçün satış cəmi. */
export async function salesTotals(
  db: Queryable,
  storeId: number,
  timezone: string,
  range: { from: string; to: string },
  filters: TotalsFilters,
): Promise<TotalsRow> {
  const row = await queryOne<TotalsRow>(
    db,
    `SELECT COALESCE(SUM(s.total_price), 0) AS revenue, COUNT(s.id) AS orders
     FROM sales s WHERE ${RANGE}`,
    [storeId, timezone, range.from, range.to, filters.soldBy ?? null, filters.locationId ?? null],
  );
  return row ?? { revenue: 0, orders: 0 };
}

/** Verilmiş tarix aralığı üçün satıcılar üzrə cəm, ən çox gəlirli birinci. */
export function salesBySeller(
  db: Queryable,
  storeId: number,
  timezone: string,
  range: { from: string; to: string },
  filters: TotalsFilters,
): Promise<SellerTotalsRow[]> {
  return queryMany<SellerTotalsRow>(
    db,
    `SELECT s.sold_by AS seller_id,
            trim(u.name || ' ' || u.surname) AS seller_name,
            SUM(s.total_price) AS revenue,
            COUNT(s.id) AS orders
     FROM sales s
     JOIN users u ON u.id = s.sold_by
     WHERE ${RANGE}
     GROUP BY s.sold_by, u.name, u.surname
     ORDER BY revenue DESC, s.sold_by`,
    [storeId, timezone, range.from, range.to, filters.soldBy ?? null, filters.locationId ?? null],
  );
}
