import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  createPool,
  isForeignKeyViolation,
  isUniqueViolation,
  lockKey,
  migrateWithLock,
  pgErrorCode,
  ping,
  withAdvisoryLock,
  type SqlClient,
} from '../src/index.js';
import {
  createTestDatabase,
  dropTestDatabases,
  migratedPglite,
} from '../src/testing.js';

const migrationsFolder = fileURLToPath(
  new URL('fixtures/drizzle', import.meta.url),
);

describe('migratedPglite', () => {
  it('returns migrated copies that do not share data', async () => {
    const a = await migratedPglite({ migrationsFolder });
    const b = await migratedPglite({ migrationsFolder });
    await a.query("INSERT INTO items (name) VALUES ('ball')");

    expect((await a.query('SELECT name FROM items')).rows).toEqual([
      { name: 'ball' },
    ]);
    expect((await b.query('SELECT name FROM items')).rows).toEqual([]);
    await Promise.all([a.close(), b.close()]);
  });
});

describe('error codes', () => {
  it('reads the code of a Postgres error, also wrapped', async () => {
    const db = await migratedPglite({ migrationsFolder });
    await db.query("INSERT INTO items (name) VALUES ('ball')");
    const error = await db
      .query("INSERT INTO items (name) VALUES ('ball')")
      .catch((e: unknown) => e);

    expect(pgErrorCode(error)).toBe('23505');
    expect(isUniqueViolation(new Error('query failed', { cause: error }))).toBe(
      true,
    );
    expect(isForeignKeyViolation(error)).toBe(false);
    expect(pgErrorCode(new Error('no code'))).toBeUndefined();
    await db.close();
  });
});

describe('ping', () => {
  it('is true for a live database and false for a failing or hanging one', async () => {
    const db = await migratedPglite({ migrationsFolder });
    expect(await ping(db)).toBe(true);
    await db.close();

    const failing: SqlClient = {
      query: () => Promise.reject(new Error('down')),
    };
    const hanging: SqlClient = { query: () => new Promise(() => {}) };
    expect(await ping(failing)).toBe(false);
    expect(await ping(hanging, 20)).toBe(false);
  });
});

describe('withAdvisoryLock', () => {
  const fakePool = () => {
    const log: string[] = [];
    const pool = {
      connect: async () => ({
        query: async (text: string, values?: unknown[]) => {
          log.push(`${text} ${String(values)}`);
          return { rows: [] };
        },
        release: () => log.push('release'),
      }),
    };
    return { pool, log };
  };

  it('locks, runs the task on the locked connection, unlocks and releases', async () => {
    const { pool, log } = fakePool();
    const result = await withAdvisoryLock(pool, 42, async (client) => {
      await client.query('task');
      return 'done';
    });

    expect(result).toBe('done');
    expect(log).toEqual([
      'SELECT pg_advisory_lock($1) 42',
      'task undefined',
      'SELECT pg_advisory_unlock($1) 42',
      'release',
    ]);
  });

  it('unlocks and releases when the task fails', async () => {
    const { pool, log } = fakePool();
    await expect(
      withAdvisoryLock(pool, 7, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(log.slice(-2)).toEqual([
      'SELECT pg_advisory_unlock($1) 7',
      'release',
    ]);
  });

  it('derives the same 32-bit key from the same name', () => {
    expect(lockKey('svc:migrations')).toBe(lockKey('svc:migrations'));
    expect(lockKey('svc:migrations')).not.toBe(lockKey('other:migrations'));
    expect(Number.isInteger(lockKey('svc:migrations'))).toBe(true);
    expect(Math.abs(lockKey('svc:migrations'))).toBeLessThan(2 ** 31);
  });
});

describe('createPool', () => {
  it('refuses a URL that is not Postgres', () => {
    expect(() => createPool({ url: 'mongodb://localhost/db' })).toThrow(
      /postgres:\/\//,
    );
  });
});

// On a real server: TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:5432/postgres
const adminUrl = process.env.TEST_DATABASE_URL;
const prefix = 'dirai_kit_pg_test_';

describe.skipIf(!adminUrl)('on Postgres (TEST_DATABASE_URL)', () => {
  it('migrates once from two pools at a time, then drops the database', async () => {
    const database = await createTestDatabase(adminUrl!, { prefix });
    const pools = [1, 2].map(() => createPool({ url: database.url }));
    try {
      await Promise.all(
        pools.map((pool) =>
          migrateWithLock(pool, { migrationsFolder, lock: 'test:migrations' }),
        ),
      );
      const { rows } = await pools[0]!.query(
        'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations',
      );
      expect(rows).toEqual([{ n: 1 }]);
      expect(await ping(pools[0]!)).toBe(true);
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
      await database.drop();
    }
    expect(await dropTestDatabases(adminUrl!, { prefix })).not.toContain(
      database.name,
    );
  });
});
