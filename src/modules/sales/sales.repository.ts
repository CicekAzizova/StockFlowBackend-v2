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
         COALESCE((
           SELECT json_agg(json_build_object(
                    'product_id', i.product_id, 'product_name', i.product_name, 'sku', i.sku,
                    'quantity', i.quantity, 'unit_price', i.unit_price, 'line_total', i.line_total,
                    'product_image_url', (SELECT p.image_urls[1] FROM products p WHERE p.id = i.product_id)
                  ) ORDER BY i.id)
           FROM sale_items i WHERE i.sale_id = s.id
         ), '[]'::json) AS items
  FROM sales s
  JOIN users u ON u.id = s.sold_by`;

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
}

/**
 * Stoku atomik azaldır: yalnız kifayət qədər qalıq varsa sətir yenilənir.
 * İki satıcı eyni anda son ədədi almağa çalışsa yalnız biri uğur qazanır.
 */
export function decrementStock(
  tx: Queryable,
  storeId: number,
  productId: number,
  quantity: number,
): Promise<ProductForSale | null> {
  return queryOne<ProductForSale>(
    tx,
    `UPDATE products
     SET quantity = quantity - $3, updated_at = now()
     WHERE id = $1 AND store_id = $2 AND deleted_at IS NULL AND quantity >= $3
     RETURNING id, name, sku, price, discount`,
    [productId, storeId, quantity],
  );
}

export async function productExists(
  tx: Queryable,
  storeId: number,
  productId: number,
): Promise<{ quantity: number } | null> {
  return queryOne<{ quantity: number }>(
    tx,
    'SELECT quantity FROM products WHERE id = $1 AND store_id = $2 AND deleted_at IS NULL',
    [productId, storeId],
  );
}

export async function insertSale(
  tx: Queryable,
  input: {
    storeId: number;
    receiptNo: number;
    soldBy: number;
    paymentMethod: PaymentMethod;
    totalPrice: number;
    note: string | undefined;
  },
): Promise<{ id: number; created_at: Date }> {
  const row = await queryOne<{ id: number; created_at: Date }>(
    tx,
    `INSERT INTO sales (store_id, receipt_no, sold_by, payment_method, total_price, note)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
    [
      input.storeId,
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
    `INSERT INTO sale_items (sale_id, product_id, product_name, sku, quantity, unit_price, line_total)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      saleId,
      item.product_id,
      item.product_name,
      item.sku,
      item.quantity,
      item.unit_price,
      item.line_total,
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
