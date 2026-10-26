import pg from 'pg';

// pg COUNT/SUM nəticələrini sətir kimi qaytarır. Bizim məbləğlər iki onluqludur
// və 2^53-dən kiçikdir, ona görə rəqəmə çevirmək təhlükəsizdir.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => Number(value));

/** Həm Pool, həm də transaksiya içindəki PoolClient bu interfeysə uyğundur. */
export type Queryable = Pick<pg.ClientBase, 'query'>;

export function createPool(connectionString: string, max: number): pg.Pool {
  const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000 });
  // Boş bağlantıdakı gözlənilməz xəta prosesi çökdürməsin.
  pool.on('error', (error) => {
    console.error('Unexpected idle PostgreSQL client error:', error.message);
  });
  return pool;
}

export async function queryMany<T extends pg.QueryResultRow>(
  db: Queryable,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await db.query<T>(sql, params);
  return result.rows;
}

export async function queryOne<T extends pg.QueryResultRow>(
  db: Queryable,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const result = await db.query<T>(sql, params);
  return result.rows[0] ?? null;
}

export async function execute(db: Queryable, sql: string, params: unknown[] = []): Promise<number> {
  const result = await db.query(sql, params);
  return result.rowCount ?? 0;
}

export async function withTransaction<T>(
  pool: pg.Pool,
  work: (tx: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Unikal məhdudiyyət pozuntusunu (23505) constraint adı ilə tanıyır. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, constraint: name } = error as { code?: string; constraint?: string };
  return code === '23505' && (constraint === undefined || name === constraint);
}

/**
 * SET hissəsini yalnız verilmiş (undefined olmayan) sahələrdən yığır.
 * null verilsə sütun təmizlənir, undefined verilsə toxunulmur.
 */
export function buildSetClause(
  fields: Record<string, unknown>,
  startIndex: number,
): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const [column, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    params.push(value);
    parts.push(`${column} = $${startIndex + params.length - 1}`);
  }
  return { sql: parts.join(', '), params };
}
