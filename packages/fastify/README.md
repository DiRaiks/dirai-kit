<div align="center">

# @dirai-kit/fastify

Fastify 5 plumbing every service repeats: `/health` and `/metrics` on one Prometheus registry, JSON errors that hide internals, a `TRUST_PROXY` that cannot be set unsafely, logs without credentials, and a shutdown that cannot hang.

[![npm](https://img.shields.io/npm/v/@dirai-kit/fastify?color=cb3837&logo=npm)](https://www.npmjs.com/package/@dirai-kit/fastify)
[![node](https://img.shields.io/node/v/@dirai-kit/fastify)](package.json)
[![license](https://img.shields.io/npm/l/@dirai-kit/fastify)](LICENSE)

</div>

## Install

```bash
npm install @dirai-kit/fastify fastify
npm install @prometheus-io/client   # for @dirai-kit/fastify/ops
```

## Use

```ts
import Fastify from 'fastify';
import {
  AppError,
  closeOnSignals,
  errors,
  loggerOptions,
  parseTrustProxy,
  splitList,
} from '@dirai-kit/fastify';
import { ops } from '@dirai-kit/fastify/ops';
import { ping } from '@dirai-kit/pg';

const app = Fastify({
  logger: loggerOptions({ level: env.LOG_LEVEL, pretty: env.LOG_FORMAT === 'pretty' }),
  trustProxy: parseTrustProxy(env.TRUST_PROXY), // '1' behind Caddy
});

await app.register(errors);
await app.register(ops, {
  health: async () => {
    const db = await ping(pool);
    return { status: db ? 'ok' : 'degraded', db };
  },
});
await app.register(cors, { origin: splitList(env.CORS_ORIGINS) });

app.get('/items/:id', async (request) => {
  const item = await findItem(request.params.id);
  if (!item) throw new AppError(404, 'NOT_FOUND', 'item not found');
  return item;
});

closeOnSignals(app); // SIGINT/SIGTERM: app.close(), onClose hooks, exit
await app.listen({ port: 3000, host: '0.0.0.0' });
```

### `@dirai-kit/fastify`

| Export                                             | What it does                                                                                                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseTrustProxy(value)`                           | `TRUST_PROXY` as Fastify's `trustProxy`: a hop count, proxy IPs/CIDRs, or none. `true` throws: it trusts any client-sent header                     |
| `splitList(value)`                                 | `'a, b,'` → `['a', 'b']`, for comma separated settings                                                                                              |
| `loggerOptions({ level, pretty, redact })`         | JSON logs with `authorization`, cookies and API keys redacted; `pretty` uses pino-pretty                                                            |
| `errors` plugin, `AppError(status, code, message)` | Errors as `{ code, message }`: `AppError` with its status, validation as 400, server errors logged and answered generically, 404 for unknown routes |
| `closeOnSignals(app, { timeoutMs })`               | Closes the app on SIGINT/SIGTERM and exits; a close that hangs past `timeoutMs` (10 s) exits with 1. Logs unhandled rejections                      |

### `@dirai-kit/fastify/ops`

The `ops` plugin adds `/health` and `/metrics`, process metrics and `http_request_duration_seconds` by route pattern, and exposes `app.ops.registry` for the service's own metrics (and plugins such as `@dirai-kit/tg`'s `tgHealth`).

| Option                          | Default               | Meaning                                                                               |
| ------------------------------- | --------------------- | ------------------------------------------------------------------------------------- |
| `health`                        | `{ status: 'ok' }`    | Builds the report: `{ status: 'ok' \| 'degraded', ...details }`                       |
| `healthStatusCode`              | always 200            | A degraded dependency must not get the container restarted; monitoring reads `status` |
| `registry`                      | a new one             | Share one registry with other plugins                                                 |
| `defaultMetrics`, `httpMetrics` | `true`                | Process metrics; request durations                                                    |
| `healthPath`, `metricsPath`     | `/health`, `/metrics` | `false` turns a route off                                                             |

Both routes are hidden from Swagger, not logged, not rate limited and sent with `cache-control: no-store`. Keep `/metrics` off the public proxy.

## License

[MIT](LICENSE)
