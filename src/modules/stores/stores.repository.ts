import { buildSetClause, execute, queryOne, type Queryable } from '../../db/pool.js';

export interface StoreRecord {
  id: number;
  owner_id: number;
  name: string;
  address: string;
  phone: string;
  timezone: string;
  currency: string;
  created_at: Date;
}

const COLUMNS = 'id, owner_id, name, address, phone, timezone, currency, created_at';

export function insertStore(
  db: Queryable,
  input: {
    ownerId: number;
    name: string;
    address: string;
    phone: string;
    timezone: string;
    currency: string;
  },
): Promise<StoreRecord | null> {
  return queryOne<StoreRecord>(
    db,
    `INSERT INTO stores (owner_id, name, address, phone, timezone, currency)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
    [input.ownerId, input.name, input.address, input.phone, input.timezone, input.currency],
  );
}

export function findStoreById(db: Queryable, id: number): Promise<StoreRecord | null> {
  return queryOne<StoreRecord>(db, `SELECT ${COLUMNS} FROM stores WHERE id = $1`, [id]);
}

export async function updateStore(
  db: Queryable,
  id: number,
  fields: { name?: string; address?: string; phone?: string; currency?: string },
): Promise<StoreRecord | null> {
  const set = buildSetClause(fields, 2);
  if (set.sql === '') return findStoreById(db, id);
  return queryOne<StoreRecord>(
    db,
    `UPDATE stores SET ${set.sql}, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, ...set.params],
  );
}

/** Qəbz nömrəsini mağaza üzrə ardıcıl verir. Eyni mağazadakı satışları qısa müddət növbəyə qoyur. */
export async function nextReceiptNo(tx: Queryable, storeId: number): Promise<number> {
  const row = await queryOne<{ last_receipt_no: number }>(
    tx,
    'UPDATE stores SET last_receipt_no = last_receipt_no + 1 WHERE id = $1 RETURNING last_receipt_no',
    [storeId],
  );
  if (!row) throw new Error(`Store ${storeId} not found`);
  return row.last_receipt_no;
}

/** Sahibin ilk (əsas) mağazası. */
export function findDefaultStoreIdOf(
  db: Queryable,
  ownerId: number,
): Promise<{ id: number } | null> {
  return queryOne<{ id: number }>(
    db,
    'SELECT id FROM stores WHERE owner_id = $1 ORDER BY id LIMIT 1',
    [ownerId],
  );
}

export function deleteStoresOf(db: Queryable, ownerId: number): Promise<number> {
  return execute(db, 'DELETE FROM stores WHERE owner_id = $1', [ownerId]);
}
