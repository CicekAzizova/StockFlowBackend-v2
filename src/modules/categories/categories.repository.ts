import { execute, queryMany, queryOne, type Queryable } from '../../db/pool.js';

export interface CategoryRow {
  id: number;
  name: string;
  product_count: number;
}

/** Ad (böyük-kiçik hərfə baxmadan) varsa mövcudun id-sini, yoxdursa yenisini qaytarır. */
export async function upsertByName(db: Queryable, storeId: number, name: string): Promise<number> {
  const row = await queryOne<{ id: number }>(
    db,
    `INSERT INTO categories (store_id, name) VALUES ($1, $2)
     ON CONFLICT (store_id, lower(name)) DO UPDATE SET name = categories.name
     RETURNING id`,
    [storeId, name],
  );
  if (!row) throw new Error('Failed to upsert category');
  return row.id;
}

export function listCategories(db: Queryable, storeId: number): Promise<CategoryRow[]> {
  return queryMany<CategoryRow>(
    db,
    `SELECT c.id, c.name, COUNT(p.id) AS product_count
     FROM categories c
     LEFT JOIN products p ON p.category_id = c.id AND p.deleted_at IS NULL
     WHERE c.store_id = $1
     GROUP BY c.id
     ORDER BY lower(c.name)`,
    [storeId],
  );
}

export function renameCategory(
  db: Queryable,
  storeId: number,
  id: number,
  name: string,
): Promise<number> {
  return execute(db, 'UPDATE categories SET name = $3 WHERE id = $1 AND store_id = $2', [
    id,
    storeId,
    name,
  ]);
}

export function deleteCategory(db: Queryable, storeId: number, id: number): Promise<number> {
  return execute(db, 'DELETE FROM categories WHERE id = $1 AND store_id = $2', [id, storeId]);
}

export function findCategory(
  db: Queryable,
  storeId: number,
  id: number,
): Promise<CategoryRow | null> {
  return queryOne<CategoryRow>(
    db,
    `SELECT c.id, c.name, COUNT(p.id) AS product_count
     FROM categories c
     LEFT JOIN products p ON p.category_id = c.id AND p.deleted_at IS NULL
     WHERE c.id = $1 AND c.store_id = $2
     GROUP BY c.id`,
    [id, storeId],
  );
}
