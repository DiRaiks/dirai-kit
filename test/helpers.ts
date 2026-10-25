import Fastify from 'fastify';
import { GrammyError, type Api } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';

import {
  memoryStore,
  tgBot,
  tgNotifier,
  tgSubscriptions,
  type SubscriptionStore,
} from '../src/index.js';

export const BOT_INFO: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: 'Test bot',
  username: 'test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

export const ADMIN_ID = 100;

export type ApiCall = { method: string; payload: Record<string, unknown> };

/**
 * Replaces the Telegram API with an in-memory fake. `respond` can return a result,
 * or throw a GrammyError to simulate API errors.
 */
export const fakeApi = (respond: (call: ApiCall) => unknown = () => true) => {
  const calls: ApiCall[] = [];
  let messageId = 0;

  const configureApi = (api: Api) => {
    api.config.use(async (_prev, method, payload) => {
      const call = { method, payload: payload as Record<string, unknown> };
      calls.push(call);
      const custom = respond(call);
      const result =
        method === 'sendMessage' && custom === true
          ? {
              message_id: ++messageId,
              date: 0,
              chat: { id: call.payload.chat_id, type: 'private' },
            }
          : custom;
      return { ok: true, result } as never;
    });
  };

  return {
    calls,
    configureApi,
    sent: () => calls.filter((c) => c.method === 'sendMessage'),
  };
};

export const apiError = (method: string, code: number, description: string) =>
  new GrammyError(
    `Call to '${method}' failed!`,
    { ok: false, error_code: code, description },
    method,
    {},
  );

export const buildBot = async ({
  respond,
  store = memoryStore(),
  topics = ['news', 'alerts'],
  minIntervalMs = 0,
}: {
  respond?: (call: ApiCall) => unknown;
  store?: SubscriptionStore;
  topics?: string[];
  minIntervalMs?: number;
} = {}) => {
  const api = fakeApi(respond);
  const app = Fastify({ logger: false });
  await app.register(tgBot, {
    token: 'test-token',
    mode: 'none',
    botInfo: BOT_INFO,
    admins: [ADMIN_ID],
    configureApi: api.configureApi,
  });
  await app.register(tgSubscriptions, { store, topics });
  await app.register(tgNotifier, { minIntervalMs });
  await app.ready();

  return { app, api, store };
};

let updateId = 0;

/** Simulates a text message (e.g. a command) arriving at the bot */
export const message = (
  text: string,
  {
    chatId = 10,
    userId = 20,
    chatType = 'private',
  }: { chatId?: number; userId?: number; chatType?: 'private' | 'group' } = {},
): Update => ({
  update_id: ++updateId,
  message: {
    message_id: updateId,
    date: 0,
    chat:
      chatType === 'private'
        ? { id: chatId, type: 'private', first_name: 'U' }
        : { id: chatId, type: 'group', title: 'G' },
    from: { id: userId, is_bot: false, first_name: 'U' },
    text,
    entities: text.startsWith('/')
      ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }]
      : [],
  },
});
