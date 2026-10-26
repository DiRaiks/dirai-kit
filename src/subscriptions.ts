import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import type { Localized } from './text.js';

export type ChatSubscription = {
  chatId: number;
  topics: string[];
  /** Per-chat bot settings, e.g. watched addresses */
  settings: Record<string, unknown>;
};

export interface SubscriptionStore {
  get(chatId: number): Promise<ChatSubscription | null>;
  /** Creates the chat if needed and replaces the given fields */
  save(
    chatId: number,
    update: { topics?: string[]; settings?: Record<string, unknown> },
  ): Promise<ChatSubscription>;
  remove(chatId: number): Promise<void>;
  listByTopic(topic: string): Promise<ChatSubscription[]>;
  list(): Promise<ChatSubscription[]>;
}

export const memoryStore = (): SubscriptionStore => {
  const chats = new Map<number, ChatSubscription>();
  const copy = (chat: ChatSubscription) => structuredClone(chat);

  return {
    async get(chatId) {
      const chat = chats.get(chatId);
      return chat ? copy(chat) : null;
    },
    async save(chatId, update) {
      const chat = {
        chatId,
        topics: [],
        settings: {},
        ...chats.get(chatId),
        ...update,
      };
      chats.set(chatId, copy(chat));
      return copy(chat);
    },
    async remove(chatId) {
      chats.delete(chatId);
    },
    async listByTopic(topic) {
      return [...chats.values()]
        .filter((chat) => chat.topics.includes(topic))
        .map(copy);
    },
    async list() {
      return [...chats.values()].map(copy);
    },
  };
};

type ChatDocument = {
  chatId: number;
  topics?: string[];
  settings?: Record<string, unknown>;
};

/** The subset of a MongoDB collection used by the store (works with the driver and mongoose) */
export type MongoCollectionLike = {
  findOne(filter: object): Promise<unknown>;
  find(filter: object): { toArray(): Promise<unknown[]> };
  findOneAndUpdate(
    filter: object,
    update: object,
    options: { upsert: boolean; returnDocument: 'after' },
  ): Promise<unknown>;
  deleteOne(filter: object): Promise<unknown>;
};

export type MongoStoreOptions = {
  /**
   * Topics of chats saved before topics existed (documents without a `topics` field),
   * e.g. a `chats` collection with only `chatId`
   */
  legacyTopics?: string[];
};

const definedFields = <T extends object>(value: T) =>
  Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  );

export const mongoStore = (
  collection: MongoCollectionLike,
  { legacyTopics = [] }: MongoStoreOptions = {},
): SubscriptionStore => {
  const toSubscription = (doc: unknown): ChatSubscription => {
    const { chatId, topics, settings } = doc as ChatDocument;
    return {
      chatId,
      topics: topics ?? [...legacyTopics],
      settings: settings ?? {},
    };
  };

  return {
    async get(chatId) {
      const doc = await collection.findOne({ chatId });
      return doc ? toSubscription(doc) : null;
    },
    async save(chatId, update) {
      const doc = await collection.findOneAndUpdate(
        { chatId },
        {
          $set: { ...definedFields(update), updatedAt: new Date() },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true, returnDocument: 'after' },
      );
      // The driver returns the document; older drivers wrap it in `{ value }`
      const value =
        doc && typeof doc === 'object' && 'value' in doc && !('chatId' in doc)
          ? doc.value
          : doc;
      return toSubscription(value);
    },
    async remove(chatId) {
      await collection.deleteOne({ chatId });
    },
    async listByTopic(topic) {
      const filter = legacyTopics.includes(topic)
        ? { $or: [{ topics: topic }, { topics: { $exists: false } }] }
        : { topics: topic };
      return (await collection.find(filter).toArray()).map(toSubscription);
    },
    async list() {
      return (await collection.find({}).toArray()).map(toSubscription);
    },
  };
};

/** The subset of a Postgres client used by the store: a `pg` Pool or Client, or PGlite */
export type PgClientLike = {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
};

export type PgStoreOptions = {
  /** Table of the chats, created on first use (default tg_chats); `schema.table` works */
  table?: string;
};

type ChatRow = {
  chat_id: string | number;
  topics: string[] | null;
  settings: Record<string, unknown> | null;
};

const TABLE_NAME = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

/**
 * Chats in a Postgres table: `chat_id` bigint, `topics` text[] with a GIN index,
 * `settings` jsonb. The table and index are created on first use, so a bot needs no
 * migration of its own for them.
 */
export const pgStore = (
  client: PgClientLike,
  { table = 'tg_chats' }: PgStoreOptions = {},
): SubscriptionStore => {
  // The name goes into SQL as is: only plain identifiers are accepted
  if (!TABLE_NAME.test(table)) {
    throw new Error(`pgStore: invalid table name "${table}"`);
  }
  // An index takes the schema of its table, so its own name has no schema
  const index = `${table.replace('.', '_')}_topics_idx`;

  let ready: Promise<unknown> | null = null;
  const query = async (text: string, values?: unknown[]) => {
    ready ??= client
      .query(
        `CREATE TABLE IF NOT EXISTS ${table} (
          chat_id bigint PRIMARY KEY,
          topics text[] NOT NULL DEFAULT '{}',
          settings jsonb NOT NULL DEFAULT '{}',
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )`,
      )
      .then(() =>
        client.query(
          `CREATE INDEX IF NOT EXISTS ${index} ON ${table} USING gin (topics)`,
        ),
      )
      .catch((error: unknown) => {
        // Try again on the next call: the database may have been down
        ready = null;
        throw error;
      });
    await ready;
    return (await client.query(text, values)).rows as ChatRow[];
  };

  // bigint arrives as a string from node-postgres; chat ids fit in a JS number
  const toSubscription = (row: ChatRow): ChatSubscription => ({
    chatId: Number(row.chat_id),
    topics: row.topics ?? [],
    settings: row.settings ?? {},
  });
  const columns = 'chat_id, topics, settings';

  return {
    async get(chatId) {
      const [row] = await query(
        `SELECT ${columns} FROM ${table} WHERE chat_id = $1`,
        [chatId],
      );
      return row ? toSubscription(row) : null;
    },
    async save(chatId, update) {
      const topics = update.topics ?? null;
      const settings =
        update.settings === undefined ? null : JSON.stringify(update.settings);
      const [row] = await query(
        `INSERT INTO ${table} AS t (chat_id, topics, settings)
         VALUES ($1, COALESCE($2::text[], '{}'), COALESCE($3::jsonb, '{}'))
         ON CONFLICT (chat_id) DO UPDATE SET
           topics = COALESCE($2::text[], t.topics),
           settings = COALESCE($3::jsonb, t.settings),
           updated_at = now()
         RETURNING ${columns}`,
        [chatId, topics, settings],
      );
      return toSubscription(row!);
    },
    async remove(chatId) {
      await query(`DELETE FROM ${table} WHERE chat_id = $1`, [chatId]);
    },
    async listByTopic(topic) {
      const rows = await query(
        `SELECT ${columns} FROM ${table} WHERE topics @> ARRAY[$1]::text[] ORDER BY chat_id`,
        [topic],
      );
      return rows.map(toSubscription);
    },
    async list() {
      const rows = await query(
        `SELECT ${columns} FROM ${table} ORDER BY chat_id`,
      );
      return rows.map(toSubscription);
    },
  };
};

export type Subscriptions = {
  store: SubscriptionStore;
  topics: readonly string[];
  subscribe(chatId: number, topics: string[]): Promise<ChatSubscription>;
  /** Without topics removes the chat completely */
  unsubscribe(
    chatId: number,
    topics?: string[],
  ): Promise<ChatSubscription | null>;
  listByTopic(topic: string): Promise<ChatSubscription[]>;
};

/** Each text is one value, or one per language (see `Translations`) */
export type SubscriptionsTexts = {
  subscribed: Localized<(topics: string[]) => string>;
  unsubscribed: Localized<string>;
  unknownTopic: Localized<(topic: string, topics: readonly string[]) => string>;
  status: Localized<(topics: string[]) => string>;
  /** Descriptions of /subscribe, /unsubscribe and /status in /help and the command menu */
  subscribeDescription: Localized<string>;
  unsubscribeDescription: Localized<string>;
  statusDescription: Localized<string>;
};

export type TgSubscriptionsOptions = {
  store: SubscriptionStore;
  /** Topics a chat can subscribe to; /subscribe without an argument subscribes to all of them */
  topics: string[];
  /** Adds /subscribe, /unsubscribe and /status (default true) */
  commands?: boolean;
  texts?: Partial<SubscriptionsTexts>;
};

declare module 'fastify' {
  interface FastifyInstance {
    subscriptions: Subscriptions;
  }
}

const DEFAULT_TEXTS: SubscriptionsTexts = {
  subscribed: (topics) => `Чат подписан на: ${topics.join(', ')}`,
  unsubscribed: 'Чат отписан от уведомлений',
  unknownTopic: (topic, topics) =>
    `Неизвестная тема «${topic}». Доступны: ${topics.join(', ')}`,
  status: (topics) =>
    topics.length
      ? `Подписки чата: ${topics.join(', ')}`
      : 'Чат ни на что не подписан',
  subscribeDescription: 'Подписать чат на уведомления',
  unsubscribeDescription: 'Отписать чат от уведомлений',
  statusDescription: 'Подписки этого чата',
};

const tgSubscriptionsPlugin: FastifyPluginAsync<
  TgSubscriptionsOptions
> = async (fastify, options) => {
  const { store, topics, commands = true } = options;
  const texts = { ...DEFAULT_TEXTS, ...options.texts };
  const { text } = fastify.tg;

  const subscriptions: Subscriptions = {
    store,
    topics,
    async subscribe(chatId, add) {
      const current = (await store.get(chatId))?.topics ?? [];
      return store.save(chatId, { topics: [...new Set([...current, ...add])] });
    },
    async unsubscribe(chatId, remove) {
      if (!remove) {
        await store.remove(chatId);
        return null;
      }
      const current = (await store.get(chatId))?.topics ?? [];
      return store.save(chatId, {
        topics: current.filter((topic) => !remove.includes(topic)),
      });
    },
    listByTopic: (topic) => store.listByTopic(topic),
  };

  fastify.decorate('subscriptions', subscriptions);
  if (!commands) return;

  const parseTopic = (match: string) => {
    const topic = match.trim();
    if (!topic) return { ok: true as const, topics: undefined };
    if (!topics.includes(topic)) return { ok: false as const, topic };
    return { ok: true as const, topics: [topic] };
  };

  fastify.tg.command({
    command: 'subscribe',
    description: texts.subscribeDescription,
    scope: 'chatAdmin',
    handler: async (ctx) => {
      const parsed = parseTopic(String(ctx.match ?? ''));
      if (!parsed.ok)
        return ctx.reply(
          (await text(texts.unknownTopic, ctx))(parsed.topic, topics),
        );

      const chat = await subscriptions.subscribe(
        ctx.chat!.id,
        parsed.topics ?? [...topics],
      );
      return ctx.reply((await text(texts.subscribed, ctx))(chat.topics));
    },
  });

  fastify.tg.command({
    command: 'unsubscribe',
    description: texts.unsubscribeDescription,
    scope: 'chatAdmin',
    handler: async (ctx) => {
      const parsed = parseTopic(String(ctx.match ?? ''));
      if (!parsed.ok)
        return ctx.reply(
          (await text(texts.unknownTopic, ctx))(parsed.topic, topics),
        );

      const chat = await subscriptions.unsubscribe(ctx.chat!.id, parsed.topics);
      return ctx.reply(
        chat
          ? (await text(texts.status, ctx))(chat.topics)
          : await text(texts.unsubscribed, ctx),
      );
    },
  });

  fastify.tg.command({
    command: 'status',
    description: texts.statusDescription,
    handler: async (ctx) => {
      const chat = await store.get(ctx.chat!.id);
      return ctx.reply((await text(texts.status, ctx))(chat?.topics ?? []));
    },
  });
};

export const tgSubscriptions = fp(tgSubscriptionsPlugin, {
  fastify: '5.x',
  name: 'tg-kit-subscriptions',
  dependencies: ['tg-kit-bot'],
});
