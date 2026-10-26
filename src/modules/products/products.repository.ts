import { buildSetClause, execute, queryMany, queryOne, type Queryable } from '../../db/pool.js';
import { escapeLike } from '../../shared/formatting.js';

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
  quantity: number;
  low_stock_limit: number;
  image_urls: string[];
  weight: number | null;
  weight_unit: 'mg' | 'g' | 'kg' | 'ml' | 'l' | null;
  size: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ProductFilters {
  q?: string | undefined;
  category?: string | undefined;
  stock?: 'in' | 'low' | 'out' | undefined;
  /** true: quantity <= low_stock_limit (0 da daxildir) */
  lowStockOnly?: boolean;
}

const SELECT = `
  SELECT p.id, p.store_id, p.name, p.sku, COALESCE(c.name, '') AS category, p.description,
         p.price, p.discount, p.cost_price, p.quantity, p.low_stock_limit, p.image_urls,
         p.weight, p.weight_unit, p.size, p.created_at, p.updated_at
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id`;

function buildWhere(storeId: number, filters: ProductFilters) {
  const conditions = ['p.store_id = $1', 'p.deleted_at IS NULL'];
  const params: unknown[] = [storeId];
  const bind = (value: unknown) => `$${params.push(value)}`;

  if (filters.q) {
    const pattern = bind(`%${escapeLike(filters.q)}%`);
    conditions.push(`(p.name ILIKE ${pattern} OR p.sku ILIKE ${pattern})`);
  }
  if (filters.category) conditions.push(`lower(c.name) = lower(${bind(filters.category)})`);
  if (filters.stock === 'out') conditions.push('p.quantity = 0');
  if (filters.stock === 'low')
    conditions.push('p.quantity > 0 AND p.quantity <= p.low_stock_limit');
  if (filters.stock === 'in') conditions.push('p.quantity > p.low_stock_limit');
  if (filters.lowStockOnly) conditions.push('p.quantity <= p.low_stock_limit');

  return { where: conditions.join(' AND '), params };
}

export async function listProducts(
  db: Queryable,
  storeId: number,
  filters: ProductFilters,
  page: { limit: number; offset: number },
): Promise<{ rows: ProductRow[]; total: number }> {
  const { where, params } = buildWhere(storeId, filters);
  const order = filters.lowStockOnly ? 'p.quantity ASC, p.id DESC' : 'p.id DESC';
  const limitParam = `$${params.length + 1}`;
  const offsetParam = `$${params.length + 2}`;

  const [rows, count] = await Promise.all([
    queryMany<ProductRow>(
      db,
      `${SELECT} WHERE ${where} ORDER BY ${order} LIMIT ${limitParam} OFFSET ${offsetParam}`,
      [...params, page.limit, page.offset],
    ),
    queryOne<{ count: number }>(
      db,
      `SELECT COUNT(*) AS count FROM products p
       LEFT JOIN categories c ON c.id = p.category_id WHERE ${where}`,
      params,
    ),
  ]);
  return { rows, total: count?.count ?? 0 };
}

export function findProductById(
  db: Queryable,
  storeId: number,
  id: number,
): Promise<ProductRow | null> {
  return queryOne<ProductRow>(
    db,
    `${SELECT} WHERE p.id = $1 AND p.store_id = $2 AND p.deleted_at IS NULL`,
    [id, storeId],
  );
}

export function findProductBySku(
  db: Queryable,
  storeId: number,
  sku: string,
): Promise<ProductRow | null> {
  return queryOne<ProductRow>(
    db,
    `${SELECT} WHERE p.store_id = $1 AND lower(p.sku) = lower($2) AND p.deleted_at IS NULL`,
    [storeId, sku],
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
  quantity: number;
  low_stock_limit: number;
  image_urls: string[];
  weight: number | null;
  weight_unit: string | null;
  size: string | null;
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
                           discount, cost_price, quantity, low_stock_limit, image_urls,
                           weight, weight_unit, size)
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
      input.quantity,
      input.low_stock_limit,
      input.image_urls,
      input.weight,
      input.weight_unit,
      input.size,
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

export function setQuantity(
  db: Queryable,
  storeId: number,
  id: number,
  quantity: number,
): Promise<number> {
  return execute(
    db,
    `UPDATE products SET quantity = $3, updated_at = now()
     WHERE id = $1 AND store_id = $2 AND deleted_at IS NULL`,
    [id, storeId, quantity],
  );
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
