import { createHash } from 'node:crypto';
import pg from 'pg';

/** The part of a Postgres client used for plain queries: a `pg` Pool or Client, or PGlite */
export type SqlClient = {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
};

export type PoolOptions = {
  /** postgres:// or postgresql:// URL */
  url: string;
  /** Connections at most (default 10) */
  max?: number;
  /** How long to wait for a connection (default 5 s) */
  connectionTimeoutMs?: number;
  /** A query running longer fails (default none) */
  queryTimeoutMs?: number;
  /**
   * An idle connection that drops emits `error` on the pool, which would crash the
   * process without a listener; the pool replaces the connection, this only reports it
   */
  onIdleError?: (error: Error) => void;
};

/** A `pg` Pool that survives dropped idle connections; it connects on the first query */
export const createPool = ({
  url,
  max = 10,
  connectionTimeoutMs = 5000,
  queryTimeoutMs,
  onIdleError,
}: PoolOptions) => {
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new Error(
      '@dirai-kit/pg: the URL must start with postgres:// or postgresql://',
    );
  }
  const pool = new pg.Pool({
    connectionString: url,
    max,
    connectionTimeoutMillis: connectionTimeoutMs,
    ...(queryTimeoutMs !== undefined && { query_timeout: queryTimeoutMs }),
  });
  pool.on('error', (error) => onIdleError?.(error));
  return pool;
};

/**
 * A stable advisory lock key from a name, so each service picks a word instead of a
 * magic number: `lockKey('football-planner:migrations')`
 */
export const lockKey = (name: string) =>
  createHash('sha256').update(name).digest().readInt32BE(0);

/** What `withAdvisoryLock` needs from a pool: `pg.Pool` fits */
export type LockablePool = {
  connect(): Promise<SqlClient & { release(): void }>;
};

/**
 * Runs `task` while holding a session-level advisory lock on a connection of its own,
 * which it gets as an argument: two processes doing the same (two instances starting,
 * a server and a script) take turns instead of running together
 */
export const withAdvisoryLock = async <T>(
  pool: LockablePool,
  key: number,
  task: (client: SqlClient & { release(): void }) => Promise<T>,
) => {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [key]);
    try {
      return await task(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [key]);
    }
  } finally {
    client.release();
  }
};

/**
 * Applies the drizzle-kit migrations that have not run yet, one process at a time.
 * Needs `drizzle-orm`; run it before serving requests.
 */
export const migrateWithLock = async (
  pool: pg.Pool,
  {
    migrationsFolder,
    lock,
  }: {
    /** Folder with the SQL files and `meta/_journal.json` from drizzle-kit */
    migrationsFolder: string;
    /** Lock name, e.g. 'my-service:migrations' (see `lockKey`) */
    lock: string;
  },
) => {
  const [{ drizzle }, { migrate }] = await Promise.all([
    import('drizzle-orm/node-postgres'),
    import('drizzle-orm/node-postgres/migrator'),
  ]);
  await withAdvisoryLock(pool, lockKey(lock), (client) =>
    // On the locked connection: the migrations run in the session holding the lock
    migrate(drizzle({ client: client as pg.PoolClient }), {
      migrationsFolder,
    }),
  );
};

/**
 * `SELECT 1` within `timeoutMs` (default 2 s): false when the database is down or hangs,
 * so a health check answers quickly either way
 */
export const ping = async (client: SqlClient, timeoutMs = 2000) => {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.query('SELECT 1'),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('ping timed out')),
          timeoutMs,
        );
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

/** Postgres error codes worth handling in code */
export const PG_ERRORS = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
} as const;

/** The Postgres error code of a failed query, also when Drizzle wraps the driver's error */
export const pgErrorCode = (error: unknown): string | undefined => {
  for (let e = error, depth = 0; e && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
};

export const isUniqueViolation = (error: unknown) =>
  pgErrorCode(error) === PG_ERRORS.uniqueViolation;

export const isForeignKeyViolation = (error: unknown) =>
  pgErrorCode(error) === PG_ERRORS.foreignKeyViolation;
