import { Registry, Counter } from '@prometheus-io/client';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AppError,
  closeOnSignals,
  errors,
  loggerOptions,
  parseTrustProxy,
  splitList,
} from '../src/index.js';
import { ops } from '../src/ops.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

const build = () => {
  const app = Fastify({ logger: false });
  close = () => app.close();
  return app;
};

describe('parseTrustProxy', () => {
  it('reads hops, addresses and none, and refuses true', () => {
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('10.0.0.1, 10.0.1.0/24')).toEqual([
      '10.0.0.1',
      '10.0.1.0/24',
    ]);
    const hops = parseTrustProxy('1') as (a: string, hop: number) => boolean;
    expect([hops('x', 0), hops('x', 1)]).toEqual([true, false]);
    expect(() => parseTrustProxy('true')).toThrow(/unsafe/);
  });

  it('takes the client address from one proxy hop only', async () => {
    const app = Fastify({ logger: false, trustProxy: parseTrustProxy('1') });
    close = () => app.close();
    app.get('/ip', async (request) => request.ip);
    const response = await app.inject({
      url: '/ip',
      remoteAddress: '172.18.0.2',
      headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.7' },
    });
    expect(response.body).toBe('203.0.113.7');
  });
});

describe('splitList and loggerOptions', () => {
  it('splits and trims', () => {
    expect(splitList(' a, b ,,c ')).toEqual(['a', 'b', 'c']);
    expect(splitList()).toEqual([]);
  });

  it('redacts credentials and makes pretty optional', () => {
    expect(loggerOptions()).toEqual({
      level: 'info',
      redact: expect.arrayContaining(['req.headers.authorization']),
    });
    expect(loggerOptions({ level: 'debug', pretty: true })).toMatchObject({
      level: 'debug',
      transport: { target: 'pino-pretty' },
    });
  });
});

describe('errors', () => {
  it('renders AppError, validation, server errors and unknown routes as JSON', async () => {
    const app = build();
    await app.register(errors);
    app.get('/app', async () => {
      throw new AppError(409, 'TAKEN', 'email is taken');
    });
    app.get('/boom', async () => {
      throw new Error('password=hunter2 in the stack');
    });
    app.post(
      '/valid',
      { schema: { body: { type: 'object', required: ['name'] } } },
      async () => 'ok',
    );

    const [taken, boom, invalid, missing] = await Promise.all([
      app.inject('/app'),
      app.inject('/boom'),
      app.inject({ method: 'POST', url: '/valid', payload: {} }),
      app.inject('/nope'),
    ]);
    expect([taken.statusCode, taken.json()]).toEqual([
      409,
      { code: 'TAKEN', message: 'email is taken' },
    ]);
    expect([boom.statusCode, boom.json()]).toEqual([
      500,
      { code: 'INTERNAL_ERROR', message: 'internal server error' },
    ]);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe('VALIDATION_ERROR');
    expect([missing.statusCode, missing.json().code]).toEqual([
      404,
      'NOT_FOUND',
    ]);
  });
});

describe('ops', () => {
  it('serves health and metrics with one registry, quietly and uncached', async () => {
    const app = build();
    const registry = new Registry();
    let up = true;
    await app.register(ops, {
      registry,
      defaultMetrics: false,
      health: () => ({ status: up ? 'ok' : 'degraded', db: up }),
    });
    new Counter({
      name: 'items_total',
      help: 'Items',
      registers: [app.ops.registry],
    }).inc(3);
    app.get('/items/:id', async () => 'ok');
    await app.inject('/items/1');
    await app.inject('/items/2');

    const health = await app.inject('/health');
    expect([health.statusCode, health.json()]).toEqual([
      200,
      { status: 'ok', db: true },
    ]);
    expect(health.headers['cache-control']).toBe('no-store');
    up = false;
    expect((await app.inject('/health')).json().status).toBe('degraded');

    const metrics = (await app.inject('/metrics')).body;
    expect(metrics).toContain('items_total 3');
    expect(metrics).toContain(
      'http_request_duration_seconds_count{method="GET",route="/items/:id",status="200"} 2',
    );
    expect(metrics).not.toContain('route="/health"');
  });

  it('turns routes off and maps a degraded report to a status code', async () => {
    const app = build();
    await app.register(ops, {
      metricsPath: false,
      healthPath: '/ready',
      health: () => ({ status: 'degraded' }),
      healthStatusCode: (report) => (report.status === 'ok' ? 200 : 503),
    });
    expect((await app.inject('/ready')).statusCode).toBe(503);
    expect((await app.inject('/metrics')).statusCode).toBe(404);
  });
});

describe('closeOnSignals', () => {
  it('closes the app and exits 0, or 1 when closing fails', async () => {
    const codes: number[] = [];
    const app = build();
    let closed = false;
    app.addHook('onClose', async () => {
      closed = true;
    });
    const shutdown = closeOnSignals(app, {
      signals: [],
      exit: (code) => codes.push(code),
    });
    await shutdown('SIGTERM');
    expect([closed, codes]).toEqual([true, [0]]);

    const broken = build();
    broken.addHook('onClose', async () => {
      throw new Error('stuck');
    });
    await closeOnSignals(broken, {
      signals: [],
      exit: (code) => codes.push(code),
    })('SIGINT');
    expect(codes).toEqual([0, 1]);
  });
});
