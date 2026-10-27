import { PGlite } from '@electric-sql/pglite';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  memoryStore,
  mongoStore,
  pgStore,
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

  it('takes command descriptions and replies from the options', async () => {
    const { app, api } = await buildBot({
      subscriptionTexts: {
        subscribeDescription: 'Subscribe this chat',
        unsubscribeDescription: 'Unsubscribe this chat',
        statusDescription: 'Subscriptions of this chat',
        status: (topics) => `Topics: ${topics.join(', ') || 'none'}`,
      },
    });
    close = () => app.close();

    await app.tg.bot.handleUpdate(message('/help'));
    const help = String(api.sent().at(-1)?.payload.text);
    expect(help).toContain('/subscribe — Subscribe this chat');
    expect(help).toContain('/unsubscribe — Unsubscribe this chat');
    expect(help).toContain('/status — Subscriptions of this chat');

    await app.tg.bot.handleUpdate(message('/status'));
    expect(api.sent().at(-1)?.payload.text).toBe('Topics: none');
  });

  it('keeps the Russian descriptions by default', async () => {
    const { app } = await buildBot();
    close = () => app.close();

    expect(
      app.tg
        .commands()
        .filter(({ command }) =>
          ['subscribe', 'unsubscribe', 'status'].includes(command),
        )
        .map(({ command, description }) => [command, description]),
    ).toEqual([
      ['subscribe', 'Подписать чат на уведомления'],
      ['unsubscribe', 'Отписать чат от уведомлений'],
      ['status', 'Подписки этого чата'],
    ]);
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

describe('pgStore', () => {
  let db: PGlite;
  let n = 0;

  beforeAll(async () => {
    db = await PGlite.create();
  });

  afterAll(async () => {
    await db?.close();
  });

  storeContract('contract', async () => pgStore(db, { table: `chats_${++n}` }));

  it('creates its table once and keeps chats across store instances', async () => {
    const first = pgStore(db, { table: 'shared_chats' });
    await first.save(-1001234567890, {
      topics: ['events'],
      settings: { nested: { list: [1, 'two'] } },
    });

    // A restart: a new store over the same table
    const second = pgStore(db, { table: 'shared_chats' });
    expect(await second.get(-1001234567890)).toEqual({
      chatId: -1001234567890,
      topics: ['events'],
      settings: { nested: { list: [1, 'two'] } },
    });
    expect(await second.list()).toHaveLength(1);
  });

  it('keeps fields the update leaves out', async () => {
    const store = pgStore(db, { table: `chats_${++n}` });
    await store.save(7, { topics: ['a'], settings: { x: 1 } });
    expect(await store.save(7, { topics: ['b'] })).toEqual({
      chatId: 7,
      topics: ['b'],
      settings: { x: 1 },
    });
    expect(await store.save(7, { settings: {} })).toEqual({
      chatId: 7,
      topics: ['b'],
      settings: {},
    });
  });

  it('works in a schema and refuses table names that are not identifiers', async () => {
    await db.query('CREATE SCHEMA IF NOT EXISTS bot');
    const store = pgStore(db, { table: 'bot.chats' });
    await store.save(1, { topics: ['x'] });
    expect((await store.listByTopic('x')).map((c) => c.chatId)).toEqual([1]);

    expect(() => pgStore(db, { table: 'chats; DROP TABLE x' })).toThrow(
      /invalid table name/,
    );
  });

  it('retries creating the table after the database failed', async () => {
    let fail = true;
    const flaky = {
      query: (text: string, values?: unknown[]) => {
        if (fail) return Promise.reject(new Error('connection refused'));
        return db.query(text, values);
      },
    };
    const store = pgStore(flaky, { table: `chats_${++n}` });
    await expect(store.list()).rejects.toThrow('connection refused');
    fail = false;
    expect(await store.list()).toEqual([]);
  });
});

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
