import { memoryStore } from '@dirai/tg-kit';
import type { Api } from 'grammy';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

/** Telegram replaced by a list of calls */
const fakeTelegram = () => {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const configureApi = (api: Api) =>
    api.config.use(async (_prev, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      const result =
        method === 'sendMessage'
          ? {
              message_id: calls.length,
              date: 0,
              chat: { id: 1, type: 'private' },
            }
          : true;
      return { ok: true, result } as never;
    });
  return { calls, configureApi };
};

const botInfo = {
  id: 1,
  is_bot: true as const,
  first_name: 'Bot',
  username: 'my_bot',
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

let close: (() => Promise<unknown>) | undefined;
afterEach(async () => close?.());

const start = async () => {
  const telegram = fakeTelegram();
  const config = loadConfig({ BOT_TOKEN: 'test', ANNOUNCE_KEY: 'secret' });
  const app = await buildApp(config, memoryStore(), {
    mode: 'none',
    botInfo,
    configureApi: telegram.configureApi,
  });
  await app.ready();
  close = () => app.close();
  return { app, telegram };
};

let updateId = 0;
const command = (text: string, chatId = 10) => ({
  update_id: ++updateId,
  message: {
    message_id: updateId,
    date: 0,
    chat: { id: chatId, type: 'private' as const, first_name: 'U' },
    from: { id: 20, is_bot: false, first_name: 'U' },
    text,
    entities: [
      {
        type: 'bot_command' as const,
        offset: 0,
        length: text.split(' ')[0]!.length,
      },
    ],
  },
});

describe('bot', () => {
  it('answers /ping', async () => {
    const { app, telegram } = await start();
    await app.tg.bot.handleUpdate(command('/ping'));
    expect(telegram.calls.at(-1)?.payload.text).toBe('pong');
  });

  it('announces to subscribed chats with the right key only', async () => {
    const { app, telegram } = await start();
    await app.tg.bot.handleUpdate(command('/subscribe', 10));

    const wrong = await app.inject({
      method: 'POST',
      url: '/announce',
      headers: { 'x-announce-key': 'nope' },
      payload: { text: 'hi' },
    });
    expect(wrong.statusCode).toBe(401);

    const sent = await app.inject({
      method: 'POST',
      url: '/announce',
      headers: { 'x-announce-key': 'secret' },
      payload: { text: 'Релиз <2.0>' },
    });
    expect(sent.json()).toMatchObject({ sent: 1 });
    expect(telegram.calls.at(-1)?.payload).toMatchObject({
      chat_id: 10,
      text: '📣 Релиз &lt;2.0&gt;',
    });
  });

  it('reports health and metrics', async () => {
    const { app } = await start();
    expect(
      (await app.inject({ url: '/telegram/health' })).json(),
    ).toMatchObject({ ok: true });
    expect((await app.inject({ url: '/metrics' })).body).toContain(
      'tg_updates_total',
    );
  });
});

describe('config', () => {
  it('needs a token, and webhook settings in webhook mode', () => {
    expect(() => loadConfig({})).toThrow('BOT_TOKEN');
    expect(() => loadConfig({ BOT_TOKEN: 't', BOT_MODE: 'webhook' })).toThrow(
      'BOT_WEBHOOK_URL',
    );
    expect(loadConfig({ BOT_TOKEN: 't', BOT_ADMINS: '1, 2' }).admins).toEqual([
      1, 2,
    ]);
  });
});
