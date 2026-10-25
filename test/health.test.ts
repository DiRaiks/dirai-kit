import Fastify from 'fastify';
import { Registry } from '@prometheus-io/client';
import { afterEach, describe, expect, it } from 'vitest';

import {
  html,
  memoryStore,
  tgBot,
  tgHealth,
  tgNotifier,
  tgSubscriptions,
  type SubscriptionStore,
  type TgHealthOptions,
} from '../src/index.js';
import {
  ADMIN_ID,
  BOT_INFO,
  fakeApi,
  message,
  type ApiCall,
} from './helpers.js';

type Setup = {
  health?: TgHealthOptions;
  store?: SubscriptionStore;
  respond?: (call: ApiCall) => unknown;
  webhook?: boolean;
};

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const build = async ({
  health,
  store = memoryStore(),
  respond,
  webhook,
}: Setup = {}) => {
  const api = fakeApi(respond);
  const app = Fastify({ logger: false });
  await app.register(tgBot, {
    token: 'test-token',
    mode: webhook ? 'webhook' : 'none',
    webhook: webhook
      ? { url: 'https://bot.example.com', secretToken: 'secret' }
      : undefined,
    botInfo: BOT_INFO,
    admins: [ADMIN_ID],
    configureApi: api.configureApi,
  });
  await app.register(tgSubscriptions, { store, topics: ['news'] });
  await app.register(tgNotifier, { minIntervalMs: 0 });
  await app.register(tgHealth, health ?? {});
  await app.ready();
  close = () => app.close();
  return { app, api };
};

const webhookInfo = (fields: Record<string, unknown> = {}) => ({
  url: 'https://bot.example.com/telegram/webhook',
  has_custom_certificate: false,
  pending_update_count: 2,
  ...fields,
});

describe('tgHealth: report', () => {
  it('reports a healthy bot without webhook', async () => {
    const { app } = await build();
    const response = await app.inject({ url: '/telegram/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      mode: 'none',
      username: 'test_bot',
      polling: null,
      webhook: null,
      store: 'ok',
      queue: 0,
    });
  });

  it('answers 503 when the store fails', async () => {
    const store = memoryStore();
    store.get = async () => {
      throw new Error('db down');
    };
    const { app } = await build({ store });
    const response = await app.inject({ url: '/telegram/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ ok: false, store: 'error' });
  });

  it('includes what Telegram says about the webhook and caches it', async () => {
    const { app, api } = await build({
      webhook: true,
      respond: (call) =>
        call.method === 'getWebhookInfo' ? webhookInfo() : true,
    });
    const report = await app.tgHealth.check();
    await app.tgHealth.check();
    expect(report).toMatchObject({
      ok: true,
      mode: 'webhook',
      webhook: {
        set: true,
        host: 'bot.example.com',
        pendingUpdates: 2,
        lastError: null,
        lastErrorAt: null,
      },
    });
    expect(api.calls.filter((c) => c.method === 'getWebhookInfo')).toHaveLength(
      1,
    );
  });

  it('marks recent webhook errors with waiting updates as unhealthy', async () => {
    const now = Math.floor(Date.now() / 1000);
    let errorAt = now - 60;
    let pending = 2;
    const { app } = await build({
      webhook: true,
      health: { webhookInfoTtlMs: 0 },
      respond: (call) =>
        call.method === 'getWebhookInfo'
          ? webhookInfo({
              last_error_date: errorAt,
              last_error_message: `Wrong response ${'x'.repeat(200)}`,
              pending_update_count: pending,
            })
          : true,
    });
    const report = await app.tgHealth.check();
    expect(report.ok).toBe(false);
    expect(report.webhook?.lastError).toMatch(/^Wrong response x+$/);
    expect(report.webhook?.lastError).toHaveLength(120);
    // Telegram keeps the last error after the webhook recovers: no waiting updates, healthy
    pending = 0;
    expect((await app.tgHealth.check()).ok).toBe(true);
    pending = 2;
    errorAt = now - 3600;
    expect((await app.tgHealth.check()).ok).toBe(true);
  });

  it('is unhealthy when the webhook is not set or Telegram does not answer', async () => {
    let fail = false;
    const { app, api } = await build({
      webhook: true,
      health: { webhookInfoTtlMs: 0 },
      respond: (call) => {
        if (call.method !== 'getWebhookInfo') return true;
        if (fail) throw new Error('network');
        return webhookInfo({ url: '' });
      },
    });
    expect((await app.tgHealth.check()).ok).toBe(false);
    fail = true;
    expect(await app.tgHealth.check()).toMatchObject({
      ok: false,
      webhook: null,
    });
    // Concurrent probes share one request
    const before = api.calls.length;
    await Promise.all([app.tgHealth.check(), app.tgHealth.check()]);
    expect(api.calls.length - before).toBeLessThanOrEqual(2);
  });

  it('protects both routes with onRequest', async () => {
    const { app } = await build({
      health: {
        onRequest: async (request, reply) => {
          if (request.headers.authorization !== 'Bearer s3cret') {
            await reply.code(401).send({ error: 'unauthorized' });
          }
        },
      },
    });
    expect((await app.inject({ url: '/telegram/health' })).statusCode).toBe(
      401,
    );
    expect((await app.inject({ url: '/metrics' })).statusCode).toBe(401);
    const allowed = await app.inject({
      url: '/telegram/health',
      headers: { authorization: 'Bearer s3cret' },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('can skip the route', async () => {
    const { app } = await build({ health: { healthPath: false } });
    expect((await app.inject({ url: '/telegram/health' })).statusCode).toBe(
      404,
    );
    expect((await app.tgHealth.check()).ok).toBe(true);
  });
});

describe('tgHealth: metrics', () => {
  it('counts updates, commands and deliveries', async () => {
    const { app } = await build({
      respond: (call) => {
        if (call.method === 'sendMessage' && call.payload.chat_id === 2) {
          throw new Error('network down');
        }
        return true;
      },
    });
    await app.tg.bot.handleUpdate(message('/subscribe', { chatId: 1 }));
    await app.tg.bot.handleUpdate(message('/status', { chatId: 1 }));
    await app.subscriptions.subscribe(2, ['news']);
    await app.notifier.notify('news', html`hello`);

    const response = await app.inject({ url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    const text = response.body;
    expect(text).toContain('tg_updates_total 2');
    expect(text).toContain(
      'tg_commands_total{command="subscribe",allowed="true"} 1',
    );
    expect(text).toContain(
      'tg_commands_total{command="status",allowed="true"} 1',
    );
    expect(text).toContain('tg_messages_total{status="sent"} 1');
    expect(text).toContain('tg_messages_total{status="failed"} 1');
    expect(text).toContain('tg_notifier_queue 0');
  });

  it('adds metrics to the app registry with a prefix and no route of its own', async () => {
    const registry = new Registry();
    const { app } = await build({
      health: { registry, metricsPath: false, prefix: 'mybot_tg_' },
    });
    await app.tg.bot.handleUpdate(message('/help'));
    expect((await app.inject({ url: '/metrics' })).statusCode).toBe(404);
    expect(await registry.metrics()).toContain('mybot_tg_updates_total 1');
  });
});

describe('tgHealth: shared registries', () => {
  it('lets several apps share one registry', async () => {
    const registry = new Registry();
    const first = await build({ health: { registry, metricsPath: false } });
    const firstClose = close;
    close = undefined;
    const second = await build({ health: { registry, metricsPath: false } });
    await first.app.tg.bot.handleUpdate(message('/help'));
    await second.app.tg.bot.handleUpdate(message('/help'));
    expect(await registry.metrics()).toContain('tg_updates_total 2');
    await firstClose?.();
  });
});
