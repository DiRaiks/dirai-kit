import fp from 'fastify-plugin';
import type {
  FastifyInstance,
  FastifyPluginAsync,
  onRequestHookHandler,
} from 'fastify';

export type TgHealthReport = {
  /** False when the bot cannot receive updates or the store does not answer */
  ok: boolean;
  mode: 'polling' | 'webhook' | 'none';
  username: string | null;
  /** Polling mode: whether the long-polling loop runs */
  polling: boolean | null;
  /**
   * Webhook mode: what Telegram reports about deliveries to the webhook. The URL itself
   * is not shown, since a secret path would leak through an open health route.
   */
  webhook: {
    /** Telegram has a webhook URL for the bot */
    set: boolean;
    host: string | null;
    pendingUpdates: number;
    /** Telegram's description of the last failed delivery, shortened */
    lastError: string | null;
    /** Unix seconds */
    lastErrorAt: number | null;
  } | null;
  store: 'ok' | 'error' | 'none';
  queue: number;
};

export type TgHealth = {
  /** The report served at `healthPath`; apps can merge it into their own /health */
  check(): Promise<TgHealthReport>;
};

/**
 * The part of a `@prometheus-io/client` (formerly `prom-client`) Registry the kit uses.
 * Declared here so the kit's types do not depend on the optional package.
 */
export type MetricsRegistry = {
  metrics(): Promise<string>;
  readonly contentType: string;
  getSingleMetric(name: string): unknown;
};

export type TgHealthOptions = {
  /** Route of the health report; false skips the route (default /telegram/health) */
  healthPath?: string | false;
  /**
   * Route of the Prometheus metrics; false skips the route (default /metrics).
   * Metrics need the optional `@prometheus-io/client` package; without it they are
   * skipped with a warning, unless `metricsPath` or `registry` asks for them.
   */
  metricsPath?: string | false;
  /** A Prometheus client Registry to add the kit's metrics to, e.g. the app's own one */
  registry?: MetricsRegistry;
  /** Prefix of metric names (default tg_) */
  prefix?: string;
  /** How long a webhook report from Telegram is reused (default 30 s) */
  webhookInfoTtlMs?: number;
  /** Longest wait for Telegram or the store before the report gives up (default 5 s) */
  timeoutMs?: number;
  /** Runs before both routes, e.g. to require a token: the routes are open otherwise */
  onRequest?: onRequestHookHandler;
};

declare module 'fastify' {
  interface FastifyInstance {
    tgHealth: TgHealth;
  }
}

/**
 * A webhook error newer than this, while updates wait, marks the bot as unhealthy.
 * Telegram keeps the last error after the webhook recovers, so the error alone says little.
 */
const RECENT_ERROR_S = 10 * 60;
const MAX_ERROR_LENGTH = 120;

const withTimeout = <T>(promise: Promise<T>, ms: number) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

type PromClient = typeof import('@prometheus-io/client');

const loadClient = async (): Promise<PromClient | null> => {
  const loaded = await import('@prometheus-io/client').catch(() => null);
  if (!loaded) return null;
  // A CommonJS package: its exports may arrive as named ones or under `default`
  return 'Registry' in loaded
    ? loaded
    : (loaded as { default: PromClient }).default;
};

const registerMetrics = (
  fastify: FastifyInstance,
  client: PromClient,
  registry: MetricsRegistry,
  prefix: string,
) => {
  const registers = [registry as InstanceType<PromClient['Registry']>];
  // A registry shared by several apps (e.g. one per test) already has the metrics
  const existing = <T>(name: string) =>
    registry.getSingleMetric(`${prefix}${name}`) as T | undefined;

  const counter = (name: string, help: string, labelNames: string[] = []) =>
    existing<InstanceType<PromClient['Counter']>>(name) ??
    new client.Counter({
      name: `${prefix}${name}`,
      help,
      labelNames,
      registers,
    });

  const updates = counter('updates_total', 'Updates received from Telegram');
  const failures = counter(
    'update_errors_total',
    'Updates whose handler threw',
  );
  const commands = counter(
    'commands_total',
    'Commands run, by command and whether access was allowed',
    ['command', 'allowed'],
  );
  const deliveries = counter(
    'messages_total',
    'Messages sent by notify and send: sent, failed, or removed (chat unreachable)',
    ['status'],
  );
  if (!existing('notifier_queue')) {
    new client.Gauge({
      name: `${prefix}notifier_queue`,
      help: 'Notifier API calls queued or in flight',
      registers,
      collect() {
        this.set(
          fastify.hasDecorator('notifier')
            ? (fastify.notifier.queueSize?.() ?? 0)
            : 0,
        );
      },
    });
  }

  const { events } = fastify.tg;
  events?.on('update', () => updates.inc());
  events?.on('failure', () => failures.inc());
  events?.on('command', ({ command, allowed }) =>
    commands.inc({ command, allowed: String(allowed) }),
  );
  events?.on('delivery', ({ status }) => deliveries.inc({ status }));
};

const tgHealthPlugin: FastifyPluginAsync<TgHealthOptions> = async (
  fastify,
  options,
) => {
  const {
    healthPath = '/telegram/health',
    prefix = 'tg_',
    webhookInfoTtlMs = 30_000,
    timeoutMs = 5000,
    onRequest,
  } = options;
  const { bot, mode } = fastify.tg;

  type Webhook = TgHealthReport['webhook'];
  let cached: { at: number; value: Promise<Webhook> } | null = null;
  // One request at a time, also reused when it failed: probes must not hammer Telegram
  const readWebhook = (): Promise<Webhook> => {
    if (cached && Date.now() - cached.at < webhookInfoTtlMs) {
      return cached.value;
    }
    const value = withTimeout(bot.api.getWebhookInfo(), timeoutMs).then(
      (info): Webhook => ({
        set: Boolean(info.url),
        host: info.url ? new URL(info.url).host : null,
        pendingUpdates: info.pending_update_count,
        lastError: info.last_error_message
          ? info.last_error_message.slice(0, MAX_ERROR_LENGTH)
          : null,
        lastErrorAt: info.last_error_date ?? null,
      }),
      (error: unknown) => {
        fastify.log.warn({ err: error }, 'telegram webhook info failed');
        return null;
      },
    );
    cached = { at: Date.now(), value };
    return value;
  };

  const checkStore = async (): Promise<TgHealthReport['store']> => {
    if (!fastify.hasDecorator('subscriptions')) return 'none';
    try {
      await withTimeout(fastify.subscriptions.store.get(0), timeoutMs);
      return 'ok';
    } catch (error) {
      fastify.log.warn({ err: error }, 'telegram store check failed');
      return 'error';
    }
  };

  const tgHealth: TgHealth = {
    async check() {
      const [webhook, store] = await Promise.all([
        mode === 'webhook' ? readWebhook() : Promise.resolve(null),
        checkStore(),
      ]);
      const now = Date.now() / 1000;
      const failing =
        webhook !== null &&
        webhook.lastErrorAt !== null &&
        now - webhook.lastErrorAt < RECENT_ERROR_S &&
        webhook.pendingUpdates > 0;
      const webhookOk =
        mode !== 'webhook' || (webhook !== null && webhook.set && !failing);
      const polling = mode === 'polling' ? bot.isRunning() : null;

      return {
        ok: webhookOk && polling !== false && store !== 'error',
        mode,
        username: bot.isInited() ? bot.botInfo.username : null,
        polling,
        webhook,
        store,
        queue: fastify.hasDecorator('notifier')
          ? (fastify.notifier.queueSize?.() ?? 0)
          : 0,
      };
    },
  };
  fastify.decorate('tgHealth', tgHealth);

  if (healthPath) {
    fastify.get(healthPath, { onRequest }, async (_request, reply) => {
      const report = await tgHealth.check();
      return reply.code(report.ok ? 200 : 503).send(report);
    });
  }

  // Metrics are on by default; asked for explicitly, a missing package is an error
  const wantsMetrics =
    options.metricsPath !== undefined || options.registry !== undefined;
  const metricsPath =
    options.metricsPath === undefined ? '/metrics' : options.metricsPath;
  if (!metricsPath && !options.registry) return;

  const client = await loadClient();
  if (!client) {
    const message =
      'tg-kit: metrics need the @prometheus-io/client package (npm install @prometheus-io/client), or set metricsPath: false';
    if (wantsMetrics) throw new Error(message);
    fastify.log.warn(message);
    return;
  }
  const registry = options.registry ?? new client.Registry();
  registerMetrics(fastify, client, registry, prefix);
  if (metricsPath) {
    fastify.get(metricsPath, { onRequest }, async (_request, reply) =>
      reply.type(registry.contentType).send(await registry.metrics()),
    );
  }
};

export const tgHealth = fp(tgHealthPlugin, {
  fastify: '5.x',
  name: 'tg-kit-health',
  dependencies: ['tg-kit-bot'],
});
