import { memoryStore, mongoStore } from '@dirai/tg-kit';
import { MongoClient } from 'mongodb';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig(process.env);

// Without MongoDB subscriptions live in memory and are lost on restart
const mongo = config.mongoUri ? new MongoClient(config.mongoUri) : null;
const store = mongo
  ? mongoStore(mongo.db().collection('chats'))
  : memoryStore();

const app = await buildApp(config, store);
if (!mongo)
  app.log.warn('MONGO_URI is not set: subscriptions are kept in memory');

const shutdown = async () => {
  setTimeout(() => process.exit(1), 8000).unref();
  await app.close();
  await mongo?.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

await app.listen({ port: config.port, host: '0.0.0.0' });
