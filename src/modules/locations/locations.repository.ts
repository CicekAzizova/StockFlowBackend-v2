import { buildSetClause, execute, queryMany, queryOne, type Queryable } from '../../db/pool.js';

export type LocationKind = 'store' | 'warehouse';

export interface LocationRecord {
  id: number;
  store_id: number;
  name: string;
  kind: LocationKind;
  address: string;
  is_main: boolean;
}

const COLUMNS = 'id, store_id, name, kind, address, is_main';

/** Əsas məkan öndə, qalanlar yaranma sırası ilə. */
export function listLocations(db: Queryable, storeId: number): Promise<LocationRecord[]> {
  return queryMany<LocationRecord>(
    db,
    `SELECT ${COLUMNS} FROM locations WHERE store_id = $1 ORDER BY is_main DESC, id`,
    [storeId],
  );
}

export function findLocation(
  db: Queryable,
  storeId: number,
  id: number,
): Promise<LocationRecord | null> {
  return queryOne<LocationRecord>(
    db,
    `SELECT ${COLUMNS} FROM locations WHERE id = $1 AND store_id = $2`,
    [id, storeId],
  );
}

export async function countLocations(db: Queryable, storeId: number): Promise<number> {
  const row = await queryOne<{ count: number }>(
    db,
    'SELECT COUNT(*)::int AS count FROM locations WHERE store_id = $1',
    [storeId],
  );
  return row?.count ?? 0;
}

export async function insertLocation(
  db: Queryable,
  input: { storeId: number; name: string; kind: LocationKind; address: string; isMain: boolean },
): Promise<LocationRecord> {
  const row = await queryOne<LocationRecord>(
    db,
    `INSERT INTO locations (store_id, name, kind, address, is_main)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
    [input.storeId, input.name, input.kind, input.address, input.isMain],
  );
  if (!row) throw new Error('Failed to insert location');
  return row;
}

export async function updateLocation(
  db: Queryable,
  storeId: number,
  id: number,
  fields: { name?: string; address?: string },
): Promise<LocationRecord | null> {
  const set = buildSetClause(fields, 3);
  if (set.sql === '') return findLocation(db, storeId, id);
  return queryOne<LocationRecord>(
    db,
    `UPDATE locations SET ${set.sql}, updated_at = now()
     WHERE id = $1 AND store_id = $2 RETURNING ${COLUMNS}`,
    [id, storeId, ...set.params],
  );
}

/** Köhnə əsas məkanı çıxarır (unikal indeks səbəbindən əvvəl bu, sonra yeni əsas). */
export function clearMain(db: Queryable, storeId: number): Promise<number> {
  return execute(
    db,
    'UPDATE locations SET is_main = false, updated_at = now() WHERE store_id = $1 AND is_main',
    [storeId],
  );
}

export function setMain(db: Queryable, storeId: number, id: number): Promise<number> {
  return execute(
    db,
    'UPDATE locations SET is_main = true, updated_at = now() WHERE id = $1 AND store_id = $2',
    [id, storeId],
  );
}

/**
 * Mağazanın adı və ünvanı dəyişəndə əsas məkan da izləyir, amma yalnız sahib onu ayrıca dəyişməyibsə
 * (adı hələ mağazanın köhnə adına bərabərdirsə). Eyni adlı başqa məkan varsa ad dəyişmir.
 */
export async function syncMainWithStore(
  db: Queryable,
  storeId: number,
  previous: { name: string; address: string },
  next: { name?: string | undefined; address?: string | undefined },
): Promise<void> {
  if (next.name !== undefined && next.name !== previous.name) {
    await execute(
      db,
      `UPDATE locations SET name = $3, updated_at = now()
       WHERE store_id = $1 AND is_main AND name = $2
         AND NOT EXISTS (
           SELECT 1 FROM locations o
           WHERE o.store_id = $1 AND NOT o.is_main AND lower(o.name) = lower($3)
         )`,
      [storeId, previous.name, next.name],
    );
  }
  if (next.address !== undefined && next.address !== previous.address) {
    await execute(
      db,
      `UPDATE locations SET address = $3, updated_at = now()
       WHERE store_id = $1 AND is_main AND address = $2`,
      [storeId, previous.address, next.address],
    );
  }
}

/** Əsas olmayan məkanı silir (əsas məkanın silinməsinə marşrutda icazə verilmir). */
export function deleteLocation(db: Queryable, storeId: number, id: number): Promise<number> {
  return execute(db, 'DELETE FROM locations WHERE id = $1 AND store_id = $2 AND NOT is_main', [
    id,
    storeId,
  ]);
}

/** Məkanın silinməsinə mane olan şeylər: qalıq (>0), satış tarixçəsi və ya təyin olunmuş satıcı. */
export async function usageOf(
  db: Queryable,
  id: number,
): Promise<{ has_stock: boolean; has_sales: boolean; has_sellers: boolean }> {
  const row = await queryOne<{ has_stock: boolean; has_sales: boolean; has_sellers: boolean }>(
    db,
    `SELECT EXISTS (SELECT 1 FROM product_stock ps JOIN products p ON p.id = ps.product_id
                    WHERE ps.location_id = $1 AND ps.quantity > 0 AND p.deleted_at IS NULL) AS has_stock,
            EXISTS (SELECT 1 FROM sales WHERE location_id = $1) AS has_sales,
            EXISTS (SELECT 1 FROM users WHERE location_id = $1 AND deleted_at IS NULL) AS has_sellers`,
    [id],
  );
  return row ?? { has_stock: false, has_sales: false, has_sellers: false };
}
