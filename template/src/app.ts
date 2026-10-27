import {
  html,
  tgBot,
  tgHealth,
  tgNotifier,
  tgSubscriptions,
  type SubscriptionStore,
  type TgBotOptions,
} from '@dirai-kit/tg';
import Fastify from 'fastify';

import type { Config } from './config.js';

const TOPIC = 'news';

/**
 * The bot as a Fastify app: commands, chat subscriptions, an announce endpoint and
 * health checks. Add your own commands and routes here.
 */
export const buildApp = async (
  config: Config,
  store: SubscriptionStore,
  /** For tests: a fake Telegram API and no polling */
  overrides: Partial<TgBotOptions> = {},
) => {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  await app.register(tgBot, {
    token: config.botToken,
    mode: config.mode,
    webhook: config.webhook,
    admins: config.admins,
    texts: {
      start:
        'Привет! Отправьте /subscribe, чтобы получать новости. Все команды: /help',
    },
    ...overrides,
  });
  await app.register(tgSubscriptions, { store, topics: [TOPIC] });
  await app.register(tgNotifier);
  // GET /telegram/health and GET /metrics; keep /metrics off the public proxy
  await app.register(tgHealth);

  app.tg.command({
    command: 'ping',
    description: 'Проверить, что бот жив',
    handler: (ctx) => ctx.reply('pong'),
  });

  app.tg.command({
    command: 'chats',
    description: 'Сколько чатов подписано',
    scope: 'admin',
    handler: async (ctx) => {
      const chats = await app.subscriptions.listByTopic(TOPIC);
      return ctx.reply(`Подписанных чатов: ${chats.length}`);
    },
  });

  if (config.announceKey) {
    app.post<{ Body: { text: string } }>(
      '/announce',
      {
        schema: {
          body: {
            type: 'object',
            required: ['text'],
            additionalProperties: false,
            properties: {
              text: { type: 'string', minLength: 1, maxLength: 3000 },
            },
          },
        },
      },
      async (request, reply) => {
        if (request.headers['x-announce-key'] !== config.announceKey) {
          return reply.code(401).send({ error: 'wrong key' });
        }
        return app.notifier.notify(TOPIC, html`📣 ${request.body.text}`);
      },
    );
  }

  app.get('/health', async () => ({ status: 'ok' }));
  return app;
};
