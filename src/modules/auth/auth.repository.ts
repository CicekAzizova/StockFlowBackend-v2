import { execute, queryOne, type Queryable } from '../../db/pool.js';

export interface RefreshTokenRecord {
  id: number;
  user_id: number;
  family_id: string;
  expires_at: Date;
  revoked_at: Date | null;
  rotated_at: Date | null;
}

export type CodePurpose = 'verify_email' | 'reset_password';

export interface OneTimeCodeRecord {
  id: number;
  code_hash: string;
  attempts: number;
}

// ---------------------------------------------------------------- refresh tokens

export function insertRefreshToken(
  db: Queryable,
  input: {
    userId: number;
    familyId: string;
    tokenHash: string;
    expiresAt: Date;
    userAgent: string | null;
  },
): Promise<number> {
  return execute(
    db,
    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.userId, input.familyId, input.tokenHash, input.expiresAt, input.userAgent],
  );
}

/** Eyni token-i paralel yeniləyən iki sorğu növbə ilə işləsin deyə sətri kilidləyir. */
export function findRefreshTokenForUpdate(
  tx: Queryable,
  tokenHash: string,
): Promise<RefreshTokenRecord | null> {
  return queryOne<RefreshTokenRecord>(
    tx,
    `SELECT id, user_id, family_id, expires_at, revoked_at, rotated_at
     FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
    [tokenHash],
  );
}

export function findRefreshToken(
  db: Queryable,
  tokenHash: string,
): Promise<RefreshTokenRecord | null> {
  return queryOne<RefreshTokenRecord>(
    db,
    `SELECT id, user_id, family_id, expires_at, revoked_at, rotated_at
     FROM refresh_tokens WHERE token_hash = $1`,
    [tokenHash],
  );
}

export function revokeRefreshToken(db: Queryable, id: number): Promise<number> {
  return execute(
    db,
    'UPDATE refresh_tokens SET revoked_at = now(), rotated_at = now() WHERE id = $1',
    [id],
  );
}

export function revokeFamily(db: Queryable, familyId: string): Promise<number> {
  return execute(
    db,
    'UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now()), rotated_at = NULL WHERE family_id = $1',
    [familyId],
  );
}

export function revokeAllForUser(db: Queryable, userId: number): Promise<number> {
  return execute(
    db,
    'UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now()), rotated_at = NULL WHERE user_id = $1',
    [userId],
  );
}

/** Müddəti bitmiş token-ləri və köhnə kodları təmizləyir. */
export async function deleteExpired(db: Queryable): Promise<void> {
  await execute(db, "DELETE FROM refresh_tokens WHERE expires_at < now() - interval '7 days'");
  await execute(db, "DELETE FROM one_time_codes WHERE expires_at < now() - interval '1 day'");
}

// ---------------------------------------------------------------- one-time codes

export async function latestCodeCreatedAt(
  db: Queryable,
  userId: number,
  purpose: CodePurpose,
): Promise<Date | null> {
  const row = await queryOne<{ created_at: Date }>(
    db,
    `SELECT created_at FROM one_time_codes
     WHERE user_id = $1 AND purpose = $2 ORDER BY created_at DESC LIMIT 1`,
    [userId, purpose],
  );
  return row?.created_at ?? null;
}

export function invalidateCodes(
  db: Queryable,
  userId: number,
  purpose: CodePurpose,
): Promise<number> {
  return execute(
    db,
    `UPDATE one_time_codes SET consumed_at = now()
     WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL`,
    [userId, purpose],
  );
}

export function insertCode(
  db: Queryable,
  input: { userId: number; purpose: CodePurpose; codeHash: string; expiresAt: Date },
): Promise<number> {
  return execute(
    db,
    `INSERT INTO one_time_codes (user_id, purpose, code_hash, expires_at) VALUES ($1, $2, $3, $4)`,
    [input.userId, input.purpose, input.codeHash, input.expiresAt],
  );
}

export function findActiveCodeForUpdate(
  tx: Queryable,
  userId: number,
  purpose: CodePurpose,
): Promise<OneTimeCodeRecord | null> {
  return queryOne<OneTimeCodeRecord>(
    tx,
    `SELECT id, code_hash, attempts FROM one_time_codes
     WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [userId, purpose],
  );
}

export function incrementCodeAttempts(db: Queryable, id: number): Promise<number> {
  return execute(db, 'UPDATE one_time_codes SET attempts = attempts + 1 WHERE id = $1', [id]);
}

export function consumeCode(db: Queryable, id: number): Promise<number> {
  return execute(db, 'UPDATE one_time_codes SET consumed_at = now() WHERE id = $1', [id]);
}
