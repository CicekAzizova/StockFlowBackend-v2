import { execute, queryMany, queryOne, type Queryable } from '../../db/pool.js';

export type MovementType =
  'initial' | 'sale' | 'restock' | 'transfer_in' | 'transfer_out' | 'adjustment';

export interface MovementInput {
  storeId: number;
  productId: number;
  locationId: number;
  type: MovementType;
  /** Mənfi: azalma, müsbət: artım. Sıfır olarsa heç nə yazılmır. */
  change: number;
  balanceAfter: number;
  userId: number;
  saleId?: number;
  transferId?: number;
  relatedLocationId?: number;
  note?: string | undefined;
}

export async function recordMovement(db: Queryable, input: MovementInput): Promise<void> {
  if (input.change === 0) return;
  await execute(
    db,
    `INSERT INTO stock_movements (store_id, product_id, location_id, type, quantity_change,
                                  balance_after, user_id, sale_id, transfer_id,
                                  related_location_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      input.storeId,
      input.productId,
      input.locationId,
      input.type,
      input.change,
      input.balanceAfter,
      input.userId,
      input.saleId ?? null,
      input.transferId ?? null,
      input.relatedLocationId ?? null,
      input.note?.trim() ? input.note.trim() : null,
    ],
  );
}

export interface MovementRow {
  id: number;
  type: MovementType;
  quantity_change: number;
  balance_after: number | null;
  location_id: number;
  location_name: string;
  related_location_name: string | null;
  user_name: string | null;
  receipt_no: number | null;
  note: string | null;
  created_at: Date;
}

export async function listMovements(
  db: Queryable,
  storeId: number,
  productId: number,
  locationId: number | undefined,
  page: { limit: number; offset: number },
): Promise<{ rows: MovementRow[]; total: number }> {
  const filter = `m.store_id = $1 AND m.product_id = $2 AND ($3::bigint IS NULL OR m.location_id = $3)`;
  const [rows, count] = await Promise.all([
    queryMany<MovementRow>(
      db,
      `SELECT m.id, m.type, m.quantity_change, m.balance_after,
              m.location_id, l.name AS location_name, rl.name AS related_location_name,
              NULLIF(trim(u.name || ' ' || u.surname), '') AS user_name,
              s.receipt_no, m.note, m.created_at
       FROM stock_movements m
       JOIN locations l ON l.id = m.location_id
       LEFT JOIN locations rl ON rl.id = m.related_location_id
       LEFT JOIN users u ON u.id = m.user_id
       LEFT JOIN sales s ON s.id = m.sale_id
       WHERE ${filter}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT $4 OFFSET $5`,
      [storeId, productId, locationId ?? null, page.limit, page.offset],
    ),
    queryOne<{ count: number }>(
      db,
      `SELECT COUNT(*) AS count FROM stock_movements m WHERE ${filter}`,
      [storeId, productId, locationId ?? null],
    ),
  ]);
  return { rows, total: count?.count ?? 0 };
}
