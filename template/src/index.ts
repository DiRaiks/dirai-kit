import { createPool } from '@dirai-kit/pg';
import { memoryStore, pgStore } from '@dirai-kit/tg';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig(process.env);

// Without Postgres subscriptions live in memory and are lost on restart
const pool = config.databaseUrl
  ? createPool({
      url: config.databaseUrl,
      onIdleError: (err) =>
        app.log.warn({ err }, 'idle Postgres connection dropped'),
    })
  : null;
// The table is created on first use
const store = pool ? pgStore(pool, { table: 'chats' }) : memoryStore();

const app = await buildApp(config, store);
if (!pool)
  app.log.warn('DATABASE_URL is not set: subscriptions are kept in memory');

const shutdown = async () => {
  setTimeout(() => process.exit(1), 8000).unref();
  await app.close();
  await pool?.end();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

await app.listen({ port: config.port, host: '0.0.0.0' });
