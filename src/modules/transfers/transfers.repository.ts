import { queryMany, queryOne, type Queryable } from '../../db/pool.js';

export interface TransferItemRow {
  product_id: number | null;
  product_name: string;
  sku: string;
  quantity: number;
}

export interface TransferRow {
  id: number;
  from_location_id: number;
  from_location_name: string;
  to_location_id: number;
  to_location_name: string;
  created_by: number;
  created_by_name: string;
  note: string | null;
  created_at: Date;
  items: TransferItemRow[];
}

const SELECT = `
  SELECT t.id, t.from_location_id, lf.name AS from_location_name,
         t.to_location_id, lt.name AS to_location_name,
         t.created_by, trim(u.name || ' ' || u.surname) AS created_by_name,
         t.note, t.created_at,
         COALESCE((
           SELECT json_agg(json_build_object(
                    'product_id', i.product_id, 'product_name', i.product_name,
                    'sku', i.sku, 'quantity', i.quantity
                  ) ORDER BY i.id)
           FROM stock_transfer_items i WHERE i.transfer_id = t.id
         ), '[]'::json) AS items
  FROM stock_transfers t
  JOIN locations lf ON lf.id = t.from_location_id
  JOIN locations lt ON lt.id = t.to_location_id
  JOIN users u ON u.id = t.created_by`;

export async function listTransfers(
  db: Queryable,
  storeId: number,
  locationId: number | undefined,
  page: { limit: number; offset: number },
): Promise<{ rows: TransferRow[]; total: number }> {
  const filter = `t.store_id = $1 AND ($2::bigint IS NULL OR t.from_location_id = $2 OR t.to_location_id = $2)`;
  const [rows, count] = await Promise.all([
    queryMany<TransferRow>(
      db,
      `${SELECT} WHERE ${filter} ORDER BY t.created_at DESC, t.id DESC LIMIT $3 OFFSET $4`,
      [storeId, locationId ?? null, page.limit, page.offset],
    ),
    queryOne<{ count: number }>(
      db,
      `SELECT COUNT(*) AS count FROM stock_transfers t WHERE ${filter}`,
      [storeId, locationId ?? null],
    ),
  ]);
  return { rows, total: count?.count ?? 0 };
}

export function findTransfer(
  db: Queryable,
  storeId: number,
  id: number,
): Promise<TransferRow | null> {
  return queryOne<TransferRow>(db, `${SELECT} WHERE t.id = $1 AND t.store_id = $2`, [id, storeId]);
}

export async function insertTransfer(
  tx: Queryable,
  input: {
    storeId: number;
    fromLocationId: number;
    toLocationId: number;
    createdBy: number;
    note: string | undefined;
  },
): Promise<number> {
  const row = await queryOne<{ id: number }>(
    tx,
    `INSERT INTO stock_transfers (store_id, from_location_id, to_location_id, created_by, note)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.storeId, input.fromLocationId, input.toLocationId, input.createdBy, input.note ?? null],
  );
  if (!row) throw new Error('Failed to insert transfer');
  return row.id;
}

export async function insertTransferItem(
  tx: Queryable,
  transferId: number,
  item: { productId: number; productName: string; sku: string; quantity: number },
): Promise<void> {
  await tx.query(
    `INSERT INTO stock_transfer_items (transfer_id, product_id, product_name, sku, quantity)
     VALUES ($1, $2, $3, $4, $5)`,
    [transferId, item.productId, item.productName, item.sku, item.quantity],
  );
}
