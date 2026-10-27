import fp from 'fastify-plugin';
import type {
  FastifyError,
  FastifyInstance,
  FastifyPluginAsync,
  FastifyServerOptions,
} from 'fastify';

/** Comma separated values, trimmed, without empty ones: `a, b,` → `['a', 'b']` */
export const splitList = (value = ''): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * TRUST_PROXY as Fastify's `trustProxy`: a hop count (`1` behind one proxy), proxy IPs
 * or CIDRs, or empty / `false` for none. `true` is refused: it trusts whatever
 * X-Forwarded-For a client sends once a proxy passes it on, which defeats IP limits.
 */
export const parseTrustProxy = (
  value = '',
): false | string[] | ((address: string, hop: number) => boolean) => {
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'false') return false;
  if (trimmed === 'true') {
    throw new Error(
      'TRUST_PROXY=true is unsafe: set the number of proxy hops (e.g. 1) or proxy IPs/CIDRs',
    );
  }
  if (/^\d+$/.test(trimmed)) {
    // Only the given number of hops closest to the server
    const hops = Number(trimmed);
    return (_address, hop) => hop < hops;
  }
  return splitList(trimmed);
};

/** Headers that must not reach the logs */
export const REDACTED_HEADERS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-telegram-bot-api-secret-token"]',
];

/**
 * Fastify's logger options: JSON with credentials redacted, or pino-pretty when
 * `pretty` (it must be installed)
 */
export const loggerOptions = ({
  level = 'info',
  pretty = false,
  redact = REDACTED_HEADERS,
}: {
  level?: string;
  pretty?: boolean;
  redact?: string[];
} = {}): Exclude<FastifyServerOptions['logger'], boolean | undefined> => ({
  level,
  redact,
  ...(pretty && { transport: { target: 'pino-pretty' } }),
});

/** An expected error the client should see: rendered as `{ code, message }` with `status` */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

const errorsPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    if (error instanceof AppError) {
      return reply
        .code(error.status)
        .send({ code: error.code, message: error.message });
    }
    if ('validation' in error && error.validation) {
      return reply
        .code(400)
        .send({ code: 'VALIDATION_ERROR', message: error.message });
    }

    const status =
      'statusCode' in error && error.statusCode && error.statusCode >= 400
        ? error.statusCode
        : 500;
    if (status >= 500) request.log.error(error);
    // A server error's text may hold internals: the client gets a generic one
    return reply.code(status).send({
      code:
        'code' in error && typeof error.code === 'string'
          ? error.code
          : 'INTERNAL_ERROR',
      message: status >= 500 ? 'internal server error' : error.message,
    });
  });

  fastify.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      code: 'NOT_FOUND',
      message: `route ${request.method} ${request.url} not found`,
    }),
  );
};

/**
 * Errors as JSON `{ code, message }`: `AppError` with its status, validation as 400
 * `VALIDATION_ERROR`, server errors logged and answered without their text, unknown
 * routes as 404 `NOT_FOUND`
 */
export const errors = fp(errorsPlugin, {
  fastify: '5.x',
  name: 'dirai-kit-errors',
});

/**
 * Closes the app on SIGINT and SIGTERM (onClose hooks close the database and the rest),
 * then exits; a close that hangs longer than `timeoutMs` exits with 1. Also logs
 * unhandled rejections instead of letting them pass silently.
 */
export const closeOnSignals = (
  app: FastifyInstance,
  {
    timeoutMs = 10_000,
    signals = ['SIGINT', 'SIGTERM'],
    exit = (code: number) => process.exit(code),
  }: {
    timeoutMs?: number;
    signals?: NodeJS.Signals[];
    /** For tests */
    exit?: (code: number) => void;
  } = {},
) => {
  process.on('unhandledRejection', (reason) => {
    app.log.error({ reason }, 'unhandled rejection');
  });

  const close = async (signal: NodeJS.Signals) => {
    app.log.info({ signal }, 'shutting down');
    setTimeout(() => {
      app.log.error({ timeoutMs }, 'shutdown timed out');
      exit(1);
    }, timeoutMs).unref();
    try {
      await app.close();
      exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'shutdown failed');
      exit(1);
    }
  };
  for (const signal of signals) {
    process.once(signal, () => void close(signal));
  }
  return close;
};
