import {
  collectDefaultMetrics,
  Histogram,
  Registry,
} from '@prometheus-io/client';
import fp from 'fastify-plugin';
import type { FastifyPluginAsync, RouteShorthandOptions } from 'fastify';

/** What /health answers; `degraded` while something the service needs is down */
export type HealthReport = { status: 'ok' | 'degraded' } & Record<
  string,
  unknown
>;

export type OpsOptions = {
  /** One registry for the service and its plugins; created when not given */
  registry?: Registry;
  /** Process metrics (memory, event loop, GC); default true */
  defaultMetrics?: boolean;
  /** `http_request_duration_seconds` by method, route pattern and status; default true */
  httpMetrics?: boolean;
  /** Builds the health report; without it /health answers `{ status: 'ok' }` */
  health?: () => HealthReport | Promise<HealthReport>;
  /**
   * The HTTP status of a report. Default 200 even when degraded: an outage of a
   * dependency must not get the container restarted; monitoring reads `status`.
   */
  healthStatusCode?: (report: HealthReport) => number;
  /** Route of the health report, or false for none; default /health */
  healthPath?: string | false;
  /** Route of the metrics, or false for none; default /metrics. Keep it off the public proxy. */
  metricsPath?: string | false;
};

declare module 'fastify' {
  interface FastifyInstance {
    ops: { registry: Registry };
  }
}

/** Ops routes stay out of the docs, the logs and the rate limits, and are never cached */
const quiet: RouteShorthandOptions = {
  // @fastify/swagger reads `hide`; its types are not needed here
  schema: { hide: true } as RouteShorthandOptions['schema'],
  logLevel: 'silent',
  config: { rateLimit: false },
};

const opsPlugin: FastifyPluginAsync<OpsOptions> = async (fastify, options) => {
  const {
    registry = new Registry(),
    defaultMetrics = true,
    httpMetrics = true,
    health = () => ({ status: 'ok' as const }),
    healthStatusCode = () => 200,
    healthPath = '/health',
    metricsPath = '/metrics',
  } = options;

  if (defaultMetrics) collectDefaultMetrics({ register: registry });

  if (httpMetrics) {
    const duration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP requests by method, route pattern and status',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    });
    const skip = new Set([healthPath, metricsPath]);
    fastify.addHook('onResponse', async (request, reply) => {
      // The route pattern (/v1/items/:id), not the URL: ids would explode the labels
      const route = request.routeOptions.url;
      if (!route || skip.has(route)) return;
      duration.observe(
        { method: request.method, route, status: String(reply.statusCode) },
        reply.elapsedTime / 1000,
      );
    });
  }

  if (healthPath) {
    fastify.get(healthPath, quiet, async (_request, reply) => {
      const report = await health();
      reply
        .header('cache-control', 'no-store')
        .code(healthStatusCode(report))
        .send(report);
    });
  }

  if (metricsPath) {
    fastify.get(metricsPath, quiet, async (_request, reply) => {
      reply
        .header('cache-control', 'no-store')
        .type(registry.contentType)
        .send(await registry.metrics());
    });
  }

  fastify.decorate('ops', { registry });
};

/**
 * /health and /metrics with one Prometheus registry for the service, plus HTTP request
 * durations; `app.ops.registry` takes the service's own metrics
 */
export const ops = fp(opsPlugin, { fastify: '5.x', name: 'dirai-kit-ops' });
