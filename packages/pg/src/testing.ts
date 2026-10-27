/**
 * Databases for tests: Postgres in WebAssembly (PGlite) by default, or fresh databases
 * on a real server from TEST_DATABASE_URL. Needs `@electric-sql/pglite` and
 * `drizzle-orm` as dev dependencies.
 */
import { randomBytes } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

const templates = new Map<string, Promise<PGlite>>();

const migratedTemplate = async (migrationsFolder: string) => {
  const [{ PGlite }, { drizzle }, { migrate }] = await Promise.all([
    import('@electric-sql/pglite'),
    import('drizzle-orm/pglite'),
    import('drizzle-orm/pglite/migrator'),
  ]);
  const client = await PGlite.create();
  await migrate(drizzle({ client }), { migrationsFolder });
  return client;
};

/**
 * A PGlite with the migrations applied. They run once per test worker and folder; each
 * call returns a copy of that template, so tests start from an empty schema quickly and
 * do not share data. Close it when done.
 */
export const migratedPglite = async ({
  migrationsFolder,
}: {
  migrationsFolder: string;
}): Promise<PGlite> => {
  let template = templates.get(migrationsFolder);
  if (!template) {
    template = migratedTemplate(migrationsFolder);
    templates.set(migrationsFolder, template);
  }
  return (await template).clone() as Promise<PGlite>;
};

const adminQuery = async (adminUrl: string, text: string) => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    return await admin.query<{ datname: string }>(text);
  } finally {
    await admin.end();
  }
};

/** Database names are made of the prefix and random letters: nothing to quote */
const checkPrefix = (prefix: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(prefix)) {
    throw new Error(
      `@dirai-kit/pg: the test database prefix must be lowercase letters, digits and _, got "${prefix}"`,
    );
  }
};

/**
 * A new empty database on the server of `adminUrl` (e.g. TEST_DATABASE_URL), named
 * `<prefix><random>`. Returns its URL; `drop()` removes it, even with open connections.
 */
export const createTestDatabase = async (
  adminUrl: string,
  { prefix }: { prefix: string },
) => {
  checkPrefix(prefix);
  const name = `${prefix}${randomBytes(6).toString('hex')}`;
  await adminQuery(adminUrl, `CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    name,
    url: url.toString(),
    drop: async () => {
      await adminQuery(
        adminUrl,
        `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`,
      );
    },
  };
};

/**
 * Drops every database named `<prefix>…` on the server: for a vitest globalSetup, to
 * clean up after runs that crashed before their own `drop()`
 */
export const dropTestDatabases = async (
  adminUrl: string,
  { prefix }: { prefix: string },
) => {
  checkPrefix(prefix);
  const { rows } = await adminQuery(
    adminUrl,
    `SELECT datname FROM pg_database WHERE starts_with(datname, '${prefix}')`,
  );
  for (const { datname } of rows) {
    await adminQuery(
      adminUrl,
      `DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`,
    );
  }
  return rows.map(({ datname }) => datname);
};
