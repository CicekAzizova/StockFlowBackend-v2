import { execute, queryMany, queryOne, type Queryable } from '../../db/pool.js';
import type { PAYMENT_METHODS, SALE_PAYMENT_METHODS } from './sales.schemas.js';

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type SalePaymentMethod = (typeof SALE_PAYMENT_METHODS)[number];

export interface SalePaymentRow {
  method: PaymentMethod;
  amount: number;
}

export interface SaleItemRow {
  id?: number;
  product_id: number;
  product_name: string;
  sku: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  returned_quantity?: number;
  /** Satış anındakı alış qiyməti (bir vahid), məlum deyilsə null. */
  unit_cost?: number | null;
  /** Yalnız oxuma zamanı doldurulur: məhsulun ilk şəkli (məhsul silinibsə null). */
  product_image_url?: string | null;
}

export interface SaleRow {
  id: number;
  receipt_no: number;
  total_price: number;
  discount_amount: number;
  returned_amount: number;
  payment_method: SalePaymentMethod;
  payments: SalePaymentRow[];
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
  locationId?: number | undefined;
  /** Bu üsulla ödənilmiş satışlar (qarışıq ödənişin bir hissəsi olsa da sayılır). */
  paymentMethod?: PaymentMethod | undefined;
}

/** Satışın ödənişlərindən birinin bu üsulla olduğunu yoxlayır. */
function paidWith(bind: (value: unknown) => string, method: PaymentMethod): string {
  return `EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.sale_id = s.id AND sp.method = ${bind(method)})`;
}

const SELECT = `
  SELECT s.id, s.receipt_no, s.total_price, s.discount_amount, s.returned_amount, s.payment_method, s.sold_by, s.created_at,
         trim(u.name || ' ' || u.surname) AS seller_name,
         u.avatar_url AS seller_avatar_url,
         s.location_id, l.name AS location_name,
         COALESCE((
           SELECT json_agg(json_build_object('method', p.method, 'amount', p.amount) ORDER BY p.amount DESC, p.method)
           FROM sale_payments p WHERE p.sale_id = s.id
         ), '[]'::json) AS payments,
         COALESCE((
           SELECT json_agg(json_build_object(
                    'product_id', i.product_id, 'product_name', i.product_name, 'sku', i.sku,
                    'id', i.id, 'quantity', i.quantity, 'unit_price', i.unit_price,
                    'line_total', i.line_total, 'returned_quantity', i.returned_quantity,
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
  if (filters.locationId !== undefined) {
    conditions.push(`s.location_id = ${bind(filters.locationId)}`);
  }
  if (filters.paymentMethod !== undefined) {
    conditions.push(paidWith(bind, filters.paymentMethod));
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
    paymentMethod: SalePaymentMethod;
    totalPrice: number;
    discountAmount: number;
    note: string | undefined;
  },
): Promise<{ id: number; created_at: Date }> {
  const row = await queryOne<{ id: number; created_at: Date }>(
    tx,
    `INSERT INTO sales (store_id, location_id, receipt_no, sold_by, payment_method, total_price, discount_amount, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at`,
    [
      input.storeId,
      input.locationId,
      input.receiptNo,
      input.soldBy,
      input.paymentMethod,
      input.totalPrice,
      input.discountAmount,
      input.note ?? null,
    ],
  );
  if (!row) throw new Error('Failed to insert sale');
  return row;
}

export async function insertSalePayment(
  tx: Queryable,
  saleId: number,
  payment: SalePaymentRow,
): Promise<void> {
  await tx.query('INSERT INTO sale_payments (sale_id, method, amount) VALUES ($1, $2, $3)', [
    saleId,
    payment.method,
    payment.amount,
  ]);
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
       COALESCE(SUM(s.total_price - s.returned_amount)
         FILTER (WHERE s.created_at >= b.day_start), 0) AS today_sales,
       COUNT(s.id) FILTER (WHERE s.created_at >= b.day_start) AS today_orders,
       COALESCE(SUM(s.total_price - s.returned_amount), 0) AS total_sales,
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
            COALESCE(SUM(s.total_price - s.returned_amount), 0) AS total,
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
  /** Bu üsulla ödənilmiş satışlar (qarışıq ödənişin bir hissəsi olsa da sayılır). */
  paymentMethod?: PaymentMethod | undefined;
}

/** salesTotals, salesBySeller və paymentsByMethod eyni sıra ilə parametr göndərir. */
function rangeParams(
  storeId: number,
  timezone: string,
  range: { from: string; to: string },
  filters: TotalsFilters,
): unknown[] {
  return [
    storeId,
    timezone,
    range.from,
    range.to,
    filters.soldBy ?? null,
    filters.locationId ?? null,
    filters.paymentMethod ?? null,
  ];
}

export interface TotalsRow {
  revenue: number;
  orders: number;
  returned: number;
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
  AND ($6::bigint IS NULL OR s.location_id = $6)
  AND (
    $7::text IS NULL
    OR EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.sale_id = s.id AND sp.method = $7)
  )`;

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
    `SELECT COALESCE(SUM(s.total_price - s.returned_amount), 0) AS revenue,
            COUNT(s.id) AS orders,
            COALESCE(SUM(s.returned_amount), 0) AS returned
     FROM sales s WHERE ${RANGE}`,
    rangeParams(storeId, timezone, range, filters),
  );
  return row ?? { revenue: 0, orders: 0, returned: 0 };
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
            SUM(s.total_price - s.returned_amount) AS revenue,
            COUNT(s.id) AS orders
     FROM sales s
     JOIN users u ON u.id = s.sold_by
     WHERE ${RANGE}
     GROUP BY s.sold_by, u.name, u.surname
     ORDER BY revenue DESC, s.sold_by`,
    rangeParams(storeId, timezone, range, filters),
  );
}

/** Verilmiş tarix aralığında ödəniş üsulları üzrə daxil olan pul, ən çoxu birinci. */
export function paymentsByMethod(
  db: Queryable,
  storeId: number,
  timezone: string,
  range: { from: string; to: string },
  filters: TotalsFilters,
): Promise<SalePaymentRow[]> {
  return queryMany<SalePaymentRow>(
    db,
    `SELECT p.method, SUM(p.amount) AS amount
     FROM sale_payments p
     JOIN sales s ON s.id = p.sale_id
     WHERE ${RANGE}
     GROUP BY p.method
     ORDER BY amount DESC, p.method`,
    rangeParams(storeId, timezone, range, filters),
  );
}

// =====================================================================
// Qaytarmalar
// =====================================================================

export interface SaleItemForReturn {
  id: number;
  product_id: number;
  product_name: string;
  quantity: number;
  line_total: number;
  returned_quantity: number;
  returned_amount: number;
}

/** Qəbzin sətirləri, artıq qaytarılmış miqdarla birlikdə (qaytarma üçün kilidlənir). */
export function saleItemsForReturn(tx: Queryable, saleId: number): Promise<SaleItemForReturn[]> {
  return queryMany<SaleItemForReturn>(
    tx,
    `SELECT id, product_id, product_name, quantity, line_total, returned_quantity, returned_amount
     FROM sale_items WHERE sale_id = $1 ORDER BY id FOR UPDATE`,
    [saleId],
  );
}

export async function insertReturn(
  tx: Queryable,
  input: {
    storeId: number;
    saleId: number;
    locationId: number;
    createdBy: number;
    reason: string;
    restocked: boolean;
    totalAmount: number;
    note: string | undefined;
  },
): Promise<{ id: number; created_at: Date }> {
  const row = await queryOne<{ id: number; created_at: Date }>(
    tx,
    `INSERT INTO sale_returns (store_id, sale_id, location_id, created_by, reason, restocked,
                               total_amount, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at`,
    [
      input.storeId,
      input.saleId,
      input.locationId,
      input.createdBy,
      input.reason,
      input.restocked,
      input.totalAmount,
      input.note ?? null,
    ],
  );
  if (!row) throw new Error('Failed to insert return');
  return row;
}

export async function insertReturnItem(
  tx: Queryable,
  returnId: number,
  item: { saleItemId: number; productId: number; quantity: number; lineTotal: number },
): Promise<void> {
  await execute(
    tx,
    `INSERT INTO sale_return_items (return_id, sale_item_id, product_id, quantity, line_total)
     VALUES ($1, $2, $3, $4, $5)`,
    [returnId, item.saleItemId, item.productId, item.quantity, item.lineTotal],
  );
}

/** Sətrin və satışın qaytarılmış cəmlərini artırır: hesabatlar bunlardan oxuyur. */
export async function addReturnedToSaleItem(
  tx: Queryable,
  saleItemId: number,
  quantity: number,
  amount: number,
): Promise<void> {
  await execute(
    tx,
    `UPDATE sale_items
     SET returned_quantity = returned_quantity + $2, returned_amount = returned_amount + $3
     WHERE id = $1`,
    [saleItemId, quantity, amount],
  );
}

export async function addReturnedToSale(
  tx: Queryable,
  saleId: number,
  amount: number,
): Promise<void> {
  await execute(tx, 'UPDATE sales SET returned_amount = returned_amount + $2 WHERE id = $1', [
    saleId,
    amount,
  ]);
}

/** Verilmiş aralıqda satılan ədəd sayı (qaytarılanlar çıxılmaqla). */
export async function itemsSold(
  db: Queryable,
  storeId: number,
  timezone: string,
  range: { from: string; to: string },
  filters: TotalsFilters,
): Promise<number> {
  const row = await queryOne<{ items_sold: number }>(
    db,
    `SELECT COALESCE(SUM(si.quantity - si.returned_quantity), 0) AS items_sold
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id
     WHERE ${RANGE}`,
    rangeParams(storeId, timezone, range, filters),
  );
  return row?.items_sold ?? 0;
}
