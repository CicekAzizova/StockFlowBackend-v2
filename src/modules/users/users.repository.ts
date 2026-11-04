import type { Role } from '../../app-types.js';
import type { Locale } from '../../config/env.js';
import { buildSetClause, execute, queryMany, queryOne, type Queryable } from '../../db/pool.js';

export interface UserRecord {
  id: number;
  role: Role;
  name: string;
  surname: string;
  email: string;
  phone: string;
  fin: string | null;
  password_hash: string;
  store_id: number | null;
  avatar_url: string | null;
  locale: Locale;
  email_verified_at: Date | null;
  is_active: boolean;
  deleted_at: Date | null;
  created_at: Date;
}

/** effective_store_id: sahib üçün ilk mağaza, satıcı üçün öz mağazası. */
export interface UserWithStore extends UserRecord {
  effective_store_id: number | null;
  store_name: string | null;
}

export interface AssociateRow {
  id: number;
  name: string;
  surname: string;
  fin: string | null;
  email: string;
  phone: string;
  role: Role;
  store_id: number;
  avatar_url: string | null;
  is_active: boolean;
  created_at: Date;
  today_sales: number;
  today_orders: number;
  month_sales: number;
  month_orders: number;
}

const WITH_STORE = `
  SELECT u.*, s.id AS effective_store_id, s.name AS store_name
  FROM users u
  LEFT JOIN LATERAL (
    SELECT st.id, st.name FROM stores st
    WHERE (u.role = 'SALES_ASSOCIATE' AND st.id = u.store_id)
       OR (u.role = 'OWNER' AND st.owner_id = u.id)
    ORDER BY st.id
    LIMIT 1
  ) s ON true`;

export function findActiveByEmail(db: Queryable, email: string): Promise<UserWithStore | null> {
  return queryOne<UserWithStore>(db, `${WITH_STORE} WHERE u.email = $1 AND u.deleted_at IS NULL`, [
    email,
  ]);
}

export function findActiveById(db: Queryable, id: number): Promise<UserWithStore | null> {
  return queryOne<UserWithStore>(db, `${WITH_STORE} WHERE u.id = $1 AND u.deleted_at IS NULL`, [
    id,
  ]);
}

export async function insertOwner(
  db: Queryable,
  input: {
    name: string;
    surname: string;
    email: string;
    phone: string;
    passwordHash: string;
    locale: Locale;
  },
): Promise<number> {
  const row = await queryOne<{ id: number }>(
    db,
    `INSERT INTO users (role, name, surname, email, phone, password_hash, locale)
     VALUES ('OWNER', $1, $2, $3, $4, $5, $6) RETURNING id`,
    [input.name, input.surname, input.email, input.phone, input.passwordHash, input.locale],
  );
  if (!row) throw new Error('Failed to insert owner');
  return row.id;
}

/** Satıcının emaili sahib tərəfindən daxil edilir, ona görə təsdiqlənmiş sayılır. */
export async function insertAssociate(
  db: Queryable,
  input: {
    name: string;
    surname: string;
    email: string;
    phone: string;
    fin: string;
    passwordHash: string;
    storeId: number;
    locale: Locale;
  },
): Promise<number> {
  const row = await queryOne<{ id: number }>(
    db,
    `INSERT INTO users (role, name, surname, email, phone, fin, password_hash, store_id, locale, email_verified_at)
     VALUES ('SALES_ASSOCIATE', $1, $2, $3, $4, $5, $6, $7, $8, now()) RETURNING id`,
    [
      input.name,
      input.surname,
      input.email,
      input.phone,
      input.fin,
      input.passwordHash,
      input.storeId,
      input.locale,
    ],
  );
  if (!row) throw new Error('Failed to insert associate');
  return row.id;
}

export async function updateUser(
  db: Queryable,
  id: number,
  fields: Partial<
    Pick<UserRecord, 'name' | 'surname' | 'phone' | 'email' | 'fin' | 'locale' | 'avatar_url'>
  >,
): Promise<void> {
  const set = buildSetClause(fields, 2);
  if (set.sql === '') return;
  await execute(db, `UPDATE users SET ${set.sql}, updated_at = now() WHERE id = $1`, [
    id,
    ...set.params,
  ]);
}

export function setPassword(db: Queryable, id: number, passwordHash: string): Promise<number> {
  return execute(db, 'UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [
    id,
    passwordHash,
  ]);
}

export function markEmailVerified(db: Queryable, id: number): Promise<number> {
  return execute(
    db,
    'UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = $1',
    [id],
  );
}

/** Email və ya FIN artıq aktiv hesabda istifadə olunurmu? excludeId düzəliş zamanı özünü sayma. */
export async function isEmailOrFinTaken(
  db: Queryable,
  input: { email?: string | undefined; fin?: string | undefined },
  excludeId?: number,
): Promise<boolean> {
  const row = await queryOne(
    db,
    `SELECT 1 FROM users
     WHERE deleted_at IS NULL
       AND ($3::bigint IS NULL OR id <> $3)
       AND (($1::text IS NOT NULL AND email = $1) OR ($2::text IS NOT NULL AND fin = $2))
     LIMIT 1`,
    [input.email ?? null, input.fin ?? null, excludeId ?? null],
  );
  return row !== null;
}

export function listAssociates(
  db: Queryable,
  storeId: number,
  timezone: string,
): Promise<AssociateRow[]> {
  return queryMany<AssociateRow>(
    db,
    `SELECT u.id, u.name, u.surname, u.fin, u.email, u.phone, u.role, u.store_id,
            u.avatar_url, u.is_active, u.created_at,
            COALESCE((
              SELECT SUM(s.total_price) FROM sales s
              WHERE s.sold_by = u.id
                AND s.created_at >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2
            ), 0) AS today_sales,
            (
              SELECT COUNT(*) FROM sales s
              WHERE s.sold_by = u.id
                AND s.created_at >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2
            ) AS today_orders,
            COALESCE((
              SELECT SUM(s.total_price) FROM sales s
              WHERE s.sold_by = u.id
                AND s.created_at >= date_trunc('month', now() AT TIME ZONE $2) AT TIME ZONE $2
            ), 0) AS month_sales,
            (
              SELECT COUNT(*) FROM sales s
              WHERE s.sold_by = u.id
                AND s.created_at >= date_trunc('month', now() AT TIME ZONE $2) AT TIME ZONE $2
            ) AS month_orders
     FROM users u
     WHERE u.store_id = $1 AND u.role = 'SALES_ASSOCIATE' AND u.deleted_at IS NULL
     ORDER BY u.id DESC`,
    [storeId, timezone],
  );
}

export function findAssociate(
  db: Queryable,
  storeId: number,
  id: number,
): Promise<UserRecord | null> {
  return queryOne<UserRecord>(
    db,
    `SELECT * FROM users
     WHERE id = $1 AND store_id = $2 AND role = 'SALES_ASSOCIATE' AND deleted_at IS NULL`,
    [id, storeId],
  );
}

/** Satıcını deaktiv/aktiv etmək. Hesab, satış tarixçəsi, email və FIN olduğu kimi qalır. */
export function setActive(db: Queryable, id: number, isActive: boolean): Promise<number> {
  return execute(db, 'UPDATE users SET is_active = $2, updated_at = now() WHERE id = $1', [
    id,
    isActive,
  ]);
}

/** Sahibin sildiyi satıcı: giriş bağlanır, satış tarixçəsində adı qalır. */
export function deactivate(db: Queryable, id: number): Promise<number> {
  return execute(
    db,
    `UPDATE users SET deleted_at = now(), password_hash = '!', updated_at = now() WHERE id = $1`,
    [id],
  );
}

/** İstifadəçinin öz hesabını silməsi: şəxsi məlumat silinir, satış tarixçəsi qalır. */
export function anonymize(db: Queryable, id: number): Promise<number> {
  return execute(
    db,
    `UPDATE users
     SET deleted_at = now(), name = 'Deleted user', surname = '', phone = '', fin = NULL,
         avatar_url = NULL, password_hash = '!', email = 'deleted-' || id || '@deleted.invalid',
         updated_at = now()
     WHERE id = $1`,
    [id],
  );
}

/** Sahibin hesabı: mağazalar, məhsullar, satışlar və satıcılar cascade ilə silinir. */
export function deleteOwner(db: Queryable, id: number): Promise<number> {
  return execute(db, "DELETE FROM users WHERE id = $1 AND role = 'OWNER'", [id]);
}
