import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { tgBot } from '../src/index.js';
import { BOT_INFO, fakeApi } from './helpers.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

const SECRET = 'webhook-secret-123456';

const build = async (url: string) => {
  const api = fakeApi();
  const app = Fastify({ logger: false });
  await app.register(tgBot, {
    token: 't',
    mode: 'webhook',
    webhook: { url, secretToken: SECRET },
    botInfo: BOT_INFO,
    configureApi: api.configureApi,
  });
  await app.ready();
  close = () => app.close();
  return { app, api };
};

const update = {
  update_id: 1,
  message: {
    message_id: 1,
    date: 0,
    chat: { id: 5, type: 'private', first_name: 'U' },
    from: { id: 5, is_bot: false, first_name: 'U' },
    text: '/start',
    entities: [{ type: 'bot_command', offset: 0, length: 6 }],
  },
};

describe('webhook mode', () => {
  it('registers the webhook under the base URL path prefix', async () => {
    const { api } = await build('https://example.com/api/');

    expect(
      api.calls.find((c) => c.method === 'setWebhook')?.payload,
    ).toMatchObject({
      url: 'https://example.com/api/telegram/webhook',
      secret_token: SECRET,
    });
  });

  it('accepts updates only with the secret token', async () => {
    const { app, api } = await build('https://example.com');

    const denied = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      payload: update,
    });
    const accepted = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': SECRET },
      payload: update,
    });

    expect(denied.statusCode).toBe(401);
    expect(accepted.statusCode).toBe(200);
    expect(api.sent()).toHaveLength(1);
  });

  it('refuses a webhook URL without https', async () => {
    const app = Fastify({ logger: false });
    await expect(
      app
        .register(tgBot, {
          token: 't',
          mode: 'webhook',
          webhook: { url: 'http://example.com', secretToken: SECRET },
          botInfo: BOT_INFO,
        })
        .ready(),
    ).rejects.toThrow(/https/);
  });

  it('starts the server even when Telegram is down', async () => {
    const api = fakeApi(({ method }) => {
      if (method === 'setWebhook') throw new Error('network down');
      return true;
    });
    const app = Fastify({ logger: false });
    await app.register(tgBot, {
      token: 't',
      mode: 'webhook',
      webhook: { url: 'https://example.com', secretToken: SECRET },
      botInfo: BOT_INFO,
      configureApi: api.configureApi,
    });
    close = () => app.close();

    await expect(app.ready()).resolves.toBeDefined();
  });
});
