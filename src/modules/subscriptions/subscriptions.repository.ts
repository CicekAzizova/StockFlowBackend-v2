import { execute, queryOne, type Queryable } from '../../db/pool.js';

/** Hər sahibin bir abunəliyi var. Qeydiyyatda "free" plan yaradılır. */

export function createFreeSubscription(
  db: Queryable,
  ownerId: number,
  productLimit: number | null,
): Promise<number> {
  return execute(
    db,
    `INSERT INTO subscriptions (owner_id, plan, product_limit) VALUES ($1, 'free', $2)
     ON CONFLICT (owner_id) DO NOTHING`,
    [ownerId, productLimit],
  );
}

export async function getProductLimit(db: Queryable, ownerId: number): Promise<number | null> {
  const row = await queryOne<{ product_limit: number | null }>(
    db,
    "SELECT product_limit FROM subscriptions WHERE owner_id = $1 AND status = 'active'",
    [ownerId],
  );
  return row?.product_limit ?? null;
}
