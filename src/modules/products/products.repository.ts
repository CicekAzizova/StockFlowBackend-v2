import { buildSetClause, execute, queryMany, queryOne, type Queryable } from '../../db/pool.js';
import { escapeLike } from '../../shared/formatting.js';

export interface ProductStockRow {
  location_id: number;
  location_name: string;
  quantity: number;
}

export interface ProductRow {
  id: number;
  store_id: number;
  name: string;
  sku: string;
  category: string;
  description: string;
  price: number;
  discount: number;
  cost_price: number;
  /** Seçilmiş məkandakı qalıq. */
  quantity: number;
  /** Mağazanın bütün məkanlarındakı qalıq. */
  stocks: ProductStockRow[];
  low_stock_limit: number;
  image_urls: string[];
  weight: number | null;
  weight_unit: 'mg' | 'g' | 'kg' | 'ml' | 'l' | null;
  size: string | null;
  /** Kataloq kodu (məs. food.dairy) və ya null. */
  subcategory: string | null;
  /** Bu ay (mağazanın saat qurşağı ilə) satılan ədəd sayı. */
  sold_this_month: number;
  created_at: Date;
  updated_at: Date;
}

export interface ProductFilters {
  q?: string | undefined;
  category?: string | undefined;
  stock?: 'in' | 'low' | 'out' | undefined;
  /** true: seçilmiş məkandakı qalıq <= low_stock_limit (0 da daxildir) */
  lowStockOnly?: boolean;
}

const QTY = 'COALESCE(ps.quantity, 0)';

/** locParam: seçilmiş məkanın ID-si üçün SQL parametri (məs. "$3"). */
const select = (locParam: string) => `
  SELECT p.id, p.store_id, p.name, p.sku, COALESCE(c.name, '') AS category, p.description,
         p.price, p.discount, p.cost_price, ${QTY} AS quantity, p.low_stock_limit, p.image_urls,
         p.weight, p.weight_unit, p.size, p.subcategory, p.created_at, p.updated_at,
         COALESCE((
           SELECT json_agg(json_build_object(
                    'location_id', l.id, 'location_name', l.name,
                    'quantity', COALESCE(s2.quantity, 0)
                  ) ORDER BY l.is_main DESC, l.id)
           FROM locations l
           LEFT JOIN product_stock s2 ON s2.product_id = p.id AND s2.location_id = l.id
           WHERE l.store_id = p.store_id
         ), '[]'::json) AS stocks,
         COALESCE((
           SELECT SUM(si.quantity)
           FROM sale_items si
           JOIN sales s ON s.id = si.sale_id
           WHERE si.product_id = p.id
             AND s.created_at >= date_trunc('month', now() AT TIME ZONE st.timezone)
                                 AT TIME ZONE st.timezone
         ), 0)::int AS sold_this_month
  FROM products p
  JOIN stores st ON st.id = p.store_id
  LEFT JOIN product_stock ps ON ps.product_id = p.id AND ps.location_id = ${locParam}
  LEFT JOIN categories c ON c.id = p.category_id`;

function buildWhere(storeId: number, locationId: number, filters: ProductFilters) {
  const conditions = ['p.store_id = $1', 'p.deleted_at IS NULL'];
  const params: unknown[] = [storeId, locationId];
  const bind = (value: unknown) => `$${params.push(value)}`;

  if (filters.q) {
    const pattern = bind(`%${escapeLike(filters.q)}%`);
    conditions.push(`(p.name ILIKE ${pattern} OR p.sku ILIKE ${pattern})`);
  }
  if (filters.category) conditions.push(`lower(c.name) = lower(${bind(filters.category)})`);
  if (filters.stock === 'out') conditions.push(`${QTY} = 0`);
  if (filters.stock === 'low') conditions.push(`${QTY} > 0 AND ${QTY} <= p.low_stock_limit`);
  if (filters.stock === 'in') conditions.push(`${QTY} > p.low_stock_limit`);
  if (filters.lowStockOnly) conditions.push(`${QTY} <= p.low_stock_limit`);

  return { where: conditions.join(' AND '), params };
}

export async function listProducts(
  db: Queryable,
  storeId: number,
  locationId: number,
  filters: ProductFilters,
  page: { limit: number; offset: number },
): Promise<{ rows: ProductRow[]; total: number }> {
  const { where, params } = buildWhere(storeId, locationId, filters);
  const order = filters.lowStockOnly ? `${QTY} ASC, p.id DESC` : 'p.id DESC';
  const limitParam = `$${params.length + 1}`;
  const offsetParam = `$${params.length + 2}`;

  const [rows, count] = await Promise.all([
    queryMany<ProductRow>(
      db,
      `${select('$2')} WHERE ${where} ORDER BY ${order} LIMIT ${limitParam} OFFSET ${offsetParam}`,
      [...params, page.limit, page.offset],
    ),
    queryOne<{ count: number }>(
      db,
      `SELECT COUNT(*) AS count FROM products p
       LEFT JOIN product_stock ps ON ps.product_id = p.id AND ps.location_id = $2
       LEFT JOIN categories c ON c.id = p.category_id WHERE ${where}`,
      params,
    ),
  ]);
  return { rows, total: count?.count ?? 0 };
}

export function findProductById(
  db: Queryable,
  storeId: number,
  locationId: number,
  id: number,
): Promise<ProductRow | null> {
  return queryOne<ProductRow>(
    db,
    `${select('$3')} WHERE p.id = $1 AND p.store_id = $2 AND p.deleted_at IS NULL`,
    [id, storeId, locationId],
  );
}

export function findProductBySku(
  db: Queryable,
  storeId: number,
  locationId: number,
  sku: string,
): Promise<ProductRow | null> {
  return queryOne<ProductRow>(
    db,
    `${select('$3')} WHERE p.store_id = $1 AND lower(p.sku) = lower($2) AND p.deleted_at IS NULL`,
    [storeId, sku, locationId],
  );
}

export interface ProductWrite {
  name: string;
  sku: string;
  category_id: number | null;
  description: string;
  price: number;
  discount: number;
  cost_price: number;
  low_stock_limit: number;
  image_urls: string[];
  weight: number | null;
  weight_unit: string | null;
  size: string | null;
  subcategory: string | null;
}

export async function insertProduct(
  db: Queryable,
  storeId: number,
  createdBy: number,
  input: ProductWrite,
): Promise<number> {
  const row = await queryOne<{ id: number }>(
    db,
    `INSERT INTO products (store_id, created_by, name, sku, category_id, description, price,
                           discount, cost_price, low_stock_limit, image_urls,
                           weight, weight_unit, size, subcategory)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id`,
    [
      storeId,
      createdBy,
      input.name,
      input.sku,
      input.category_id,
      input.description,
      input.price,
      input.discount,
      input.cost_price,
      input.low_stock_limit,
      input.image_urls,
      input.weight,
      input.weight_unit,
      input.size,
      input.subcategory,
    ],
  );
  if (!row) throw new Error('Failed to insert product');
  return row.id;
}

export async function updateProduct(
  db: Queryable,
  storeId: number,
  id: number,
  fields: Partial<ProductWrite>,
): Promise<number> {
  const set = buildSetClause(fields, 3);
  if (set.sql === '') return 1;
  return execute(
    db,
    `UPDATE products SET ${set.sql}, updated_at = now()
     WHERE id = $1 AND store_id = $2 AND deleted_at IS NULL`,
    [id, storeId, ...set.params],
  );
}

/** Məhsulun seçilmiş məkandakı qalığını təyin edir (sətir yoxdursa yaradır). */
export function setQuantity(
  db: Queryable,
  productId: number,
  locationId: number,
  quantity: number,
): Promise<number> {
  return execute(
    db,
    `INSERT INTO product_stock (product_id, location_id, quantity) VALUES ($1, $2, $3)
     ON CONFLICT (product_id, location_id)
     DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`,
    [productId, locationId, quantity],
  );
}

/** Qalığa ədəd əlavə edir (təhlükəsiz: server toplayır, iki sorğu bir-birini silmir). */
export function addQuantity(
  db: Queryable,
  productId: number,
  locationId: number,
  amount: number,
): Promise<number> {
  return execute(
    db,
    `INSERT INTO product_stock (product_id, location_id, quantity) VALUES ($1, $2, $3)
     ON CONFLICT (product_id, location_id)
     DO UPDATE SET quantity = product_stock.quantity + EXCLUDED.quantity, updated_at = now()`,
    [productId, locationId, amount],
  );
}

/** Məhsulun mağazaya aid və silinməmiş olduğunu yoxlayır. */
export async function productIsActive(
  db: Queryable,
  storeId: number,
  id: number,
): Promise<boolean> {
  const row = await queryOne<{ id: number }>(
    db,
    'SELECT id FROM products WHERE id = $1 AND store_id = $2 AND deleted_at IS NULL',
    [id, storeId],
  );
  return row !== null;
}

/** Yumşaq silmə: satış tarixçəsi bütöv qalır, SKU təkrar istifadə oluna bilər. */
export function softDeleteProduct(db: Queryable, storeId: number, id: number): Promise<number> {
  return execute(
    db,
    `UPDATE products SET deleted_at = now(), updated_at = now()
     WHERE id = $1 AND store_id = $2 AND deleted_at IS NULL`,
    [id, storeId],
  );
}

/** Sahibin bütün mağazalarındakı aktiv məhsul sayı (plan limiti üçün). */
export async function countActiveProductsOfOwner(db: Queryable, ownerId: number): Promise<number> {
  const row = await queryOne<{ count: number }>(
    db,
    `SELECT COUNT(*) AS count FROM products p
     JOIN stores s ON s.id = p.store_id
     WHERE s.owner_id = $1 AND p.deleted_at IS NULL`,
    [ownerId],
  );
  return row?.count ?? 0;
}

export interface StockCounts {
  total: number;
  in_stock: number;
  low_stock: number;
  out_of_stock: number;
}

/** Seçilmiş məkanda məhsulların qalıq vəziyyətinə görə sayı (siyahıdakı süzgəclərlə eyni qaydalar). */
export async function countByStock(
  db: Queryable,
  storeId: number,
  locationId: number,
): Promise<StockCounts> {
  const row = await queryOne<StockCounts>(
    db,
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE ${QTY} > p.low_stock_limit)::int AS in_stock,
            COUNT(*) FILTER (WHERE ${QTY} > 0 AND ${QTY} <= p.low_stock_limit)::int AS low_stock,
            COUNT(*) FILTER (WHERE ${QTY} = 0)::int AS out_of_stock
     FROM products p
     LEFT JOIN product_stock ps ON ps.product_id = p.id AND ps.location_id = $2
     WHERE p.store_id = $1 AND p.deleted_at IS NULL`,
    [storeId, locationId],
  );
  return row ?? { total: 0, in_stock: 0, low_stock: 0, out_of_stock: 0 };
}
