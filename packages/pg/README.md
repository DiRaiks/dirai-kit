<div align="center">

# @dirai-kit/pg

Postgres plumbing every Node service repeats: a pool that survives dropped connections, drizzle-kit migrations that two instances never apply at once, a health ping that cannot hang, error codes, and fresh databases for tests.

[![npm](https://img.shields.io/npm/v/@dirai-kit/pg?color=cb3837&logo=npm)](https://www.npmjs.com/package/@dirai-kit/pg)
[![node](https://img.shields.io/node/v/@dirai-kit/pg)](package.json)
[![license](https://img.shields.io/npm/l/@dirai-kit/pg)](LICENSE)

</div>

Works with any Node code: no framework, and Drizzle only where migrations need it.

## Install

```bash
npm install @dirai-kit/pg pg
npm install -D drizzle-orm @electric-sql/pglite   # migrations, and test databases
```

## Use

```ts
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createPool, isUniqueViolation, migrateWithLock, ping } from '@dirai-kit/pg';

const pool = createPool({
  url: process.env.DATABASE_URL!,
  onIdleError: (err) => log.warn({ err }, 'idle Postgres connection dropped'),
});

// Before serving requests: a second instance starting at the same time waits here,
// then finds the migrations applied
await migrateWithLock(pool, {
  migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
  lock: 'my-service:migrations',
});

const db = drizzle({ client: pool, schema });

app.get('/health', async () => ({ db: (await ping(pool)) ? 'up' : 'down' }));

try {
  await db.insert(users).values(user);
} catch (error) {
  if (isUniqueViolation(error)) throw new Conflict('email is taken');
  throw error;
}
```

| Export                                                                          | What it does                                                                                                 |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `createPool({ url, max, connectionTimeoutMs, queryTimeoutMs, onIdleError })`    | A `pg` Pool that checks the URL and does not crash the process when an idle connection drops                 |
| `migrateWithLock(pool, { migrationsFolder, lock })`                             | Applies pending drizzle-kit migrations on one connection under a session advisory lock                       |
| `withAdvisoryLock(pool, key, task)`                                             | Any task under an advisory lock, on the locked connection; always unlocks and releases                       |
| `lockKey(name)`                                                                 | A stable 32-bit lock key from a name, instead of a magic number                                              |
| `ping(client, timeoutMs = 2000)`                                                | `SELECT 1` that answers `false` in time when the database is down or hangs; takes a Pool, a Client or PGlite |
| `pgErrorCode(error)`, `isUniqueViolation`, `isForeignKeyViolation`, `PG_ERRORS` | The Postgres code of a failed query, through Drizzle's wrapping                                              |

## Tests

`@dirai-kit/pg/testing` gives each test its own database.

```ts
import { createTestDatabase, migratedPglite } from '@dirai-kit/pg/testing';

const adminUrl = process.env.TEST_DATABASE_URL;

// In memory by default: the migrations run once per worker, every call is a copy
const pglite = await migratedPglite({ migrationsFolder });
const db = drizzle({ client: pglite, schema });

// Or on a real server, e.g. TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:5432/postgres
const database = await createTestDatabase(adminUrl, { prefix: 'my_service_test_' });
// ...connect to database.url, migrate, test...
await database.drop();
```

`dropTestDatabases(adminUrl, { prefix })` removes what crashed runs left behind; call it from a vitest `globalSetup`.

## License

[MIT](LICENSE)
