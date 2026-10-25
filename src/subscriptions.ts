import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';

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

export type SubscriptionsTexts = {
  subscribed: (topics: string[]) => string;
  unsubscribed: string;
  unknownTopic: (topic: string, topics: readonly string[]) => string;
  status: (topics: string[]) => string;
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
};

const tgSubscriptionsPlugin: FastifyPluginAsync<
  TgSubscriptionsOptions
> = async (fastify, options) => {
  const { store, topics, commands = true } = options;
  const texts = { ...DEFAULT_TEXTS, ...options.texts };

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
    description: 'Подписать чат на уведомления',
    scope: 'chatAdmin',
    handler: async (ctx) => {
      const parsed = parseTopic(String(ctx.match ?? ''));
      if (!parsed.ok)
        return ctx.reply(texts.unknownTopic(parsed.topic, topics));

      const chat = await subscriptions.subscribe(
        ctx.chat!.id,
        parsed.topics ?? [...topics],
      );
      return ctx.reply(texts.subscribed(chat.topics));
    },
  });

  fastify.tg.command({
    command: 'unsubscribe',
    description: 'Отписать чат от уведомлений',
    scope: 'chatAdmin',
    handler: async (ctx) => {
      const parsed = parseTopic(String(ctx.match ?? ''));
      if (!parsed.ok)
        return ctx.reply(texts.unknownTopic(parsed.topic, topics));

      const chat = await subscriptions.unsubscribe(ctx.chat!.id, parsed.topics);
      return ctx.reply(chat ? texts.status(chat.topics) : texts.unsubscribed);
    },
  });

  fastify.tg.command({
    command: 'status',
    description: 'Подписки этого чата',
    handler: async (ctx) => {
      const chat = await store.get(ctx.chat!.id);
      return ctx.reply(texts.status(chat?.topics ?? []));
    },
  });
};

export const tgSubscriptions = fp(tgSubscriptionsPlugin, {
  fastify: '5.x',
  name: 'tg-kit-subscriptions',
  dependencies: ['tg-kit-bot'],
});
