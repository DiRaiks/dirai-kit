import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  memoryStore,
  mongoStore,
  type SubscriptionStore,
} from '../src/index.js';
import { buildBot, message } from './helpers.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

describe('subscription commands', () => {
  it('subscribes to all or one topic, reports status and unsubscribes', async () => {
    const { app, api, store } = await buildBot();
    close = () => app.close();
    const reply = () => api.sent().at(-1)?.payload.text;

    await app.tg.bot.handleUpdate(message('/subscribe alerts'));
    expect(reply()).toBe('Чат подписан на: alerts');

    await app.tg.bot.handleUpdate(message('/subscribe'));
    expect(reply()).toBe('Чат подписан на: alerts, news');

    await app.tg.bot.handleUpdate(message('/subscribe weather'));
    expect(reply()).toBe('Неизвестная тема «weather». Доступны: news, alerts');

    await app.tg.bot.handleUpdate(message('/unsubscribe alerts'));
    expect(reply()).toBe('Подписки чата: news');

    await app.tg.bot.handleUpdate(message('/status'));
    expect(reply()).toBe('Подписки чата: news');

    await app.tg.bot.handleUpdate(message('/unsubscribe'));
    expect(reply()).toBe('Чат отписан от уведомлений');
    expect(await store.get(10)).toBeNull();
  });
});

const storeContract = (
  name: string,
  create: () => Promise<SubscriptionStore>,
) => {
  describe(name, () => {
    it('saves, lists by topic and removes chats', async () => {
      const store = await create();

      await store.save(1, { topics: ['news'] });
      await store.save(2, {
        topics: ['news', 'alerts'],
        settings: { addresses: ['0xabc'] },
      });
      await store.save(1, { settings: { muted: true } });

      expect(await store.get(1)).toEqual({
        chatId: 1,
        topics: ['news'],
        settings: { muted: true },
      });
      expect(
        (await store.listByTopic('news')).map((c) => c.chatId).sort(),
      ).toEqual([1, 2]);
      expect((await store.listByTopic('alerts')).map((c) => c.chatId)).toEqual([
        2,
      ]);

      await store.remove(2);
      expect(await store.get(2)).toBeNull();
      expect(await store.list()).toHaveLength(1);
    });
  });
};

storeContract('memoryStore', async () => memoryStore());

describe('mongoStore', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let n = 0;
  const collection = () => client.db('test').collection(`chats_${++n}`);

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = await MongoClient.connect(mongo.getUri());
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await mongo?.stop();
  });

  storeContract('contract', async () => mongoStore(collection()));

  it('treats chats saved before topics existed as subscribed to legacy topics', async () => {
    const chats = collection();
    await chats.insertOne({ chatId: 42, createdAt: new Date() });
    const store = mongoStore(chats, { legacyTopics: ['events'] });

    expect(await store.get(42)).toEqual({
      chatId: 42,
      topics: ['events'],
      settings: {},
    });
    expect((await store.listByTopic('events')).map((c) => c.chatId)).toEqual([
      42,
    ]);
    expect(await store.listByTopic('other')).toEqual([]);

    await store.save(42, { topics: [] });
    expect(await store.listByTopic('events')).toEqual([]);
  });
});
