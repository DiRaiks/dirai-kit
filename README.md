<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-dark.svg">
  <img alt="dirai-kit" src=".github/assets/logo-light.svg" width="560">
</picture>

<p><b>The parts every Node service of mine kept rewriting, as small packages.</b><br>
Postgres that survives restarts and deploys, Fastify with health and metrics, Telegram bots in a few lines, and one deploy for all of them.</p>

[![CI](https://github.com/DiRaiks/dirai-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/DiRaiks/dirai-kit/actions/workflows/ci.yml)
[![Release](https://github.com/DiRaiks/dirai-kit/actions/workflows/release.yml/badge.svg)](https://github.com/DiRaiks/dirai-kit/actions/workflows/release.yml)
[![provenance](https://img.shields.io/badge/npm-provenance-2ea44f?logo=sigstore)](https://docs.npmjs.com/generating-provenance-statements)
[![license](https://img.shields.io/github/license/DiRaiks/dirai-kit)](LICENSE)

</div>

## Packages

| Package                                  | Version                                                                                                                         | What it does                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| [`@dirai-kit/tg`](packages/tg)           | [![npm](https://img.shields.io/npm/v/@dirai-kit/tg?color=cb3837&label=)](https://www.npmjs.com/package/@dirai-kit/tg)           | Fastify plugins for Telegram bots on grammY: commands and menus per language, subscriptions, rate-limited broadcasts, health |
| [`@dirai-kit/pg`](packages/pg)           | [![npm](https://img.shields.io/npm/v/@dirai-kit/pg?color=cb3837&label=)](https://www.npmjs.com/package/@dirai-kit/pg)           | Postgres: a pool that survives dropped connections, migrations under an advisory lock, ping, error codes, test databases     |
| [`@dirai-kit/fastify`](packages/fastify) | [![npm](https://img.shields.io/npm/v/@dirai-kit/fastify?color=cb3837&label=)](https://www.npmjs.com/package/@dirai-kit/fastify) | Fastify: `/health` and `/metrics` on one registry, JSON errors, a safe `TRUST_PROXY`, redacted logs, graceful shutdown       |

Each package is versioned and released on its own; take only what a service needs. All are ESM, typed, for Node 24 and Fastify 5.

## A service in one screen

```ts
import Fastify from 'fastify';
import { closeOnSignals, errors, loggerOptions, parseTrustProxy } from '@dirai-kit/fastify';
import { ops } from '@dirai-kit/fastify/ops';
import { createPool, migrateWithLock, ping } from '@dirai-kit/pg';
import { pgStore, tgBot, tgHealth, tgSubscriptions } from '@dirai-kit/tg';

const pool = createPool({ url: process.env.DATABASE_URL! });
await migrateWithLock(pool, { migrationsFolder: './drizzle', lock: 'my-bot:migrations' });

const app = Fastify({
  logger: loggerOptions({ level: 'info' }),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
});
await app.register(errors);
await app.register(ops, {
  health: async () => ({ status: (await ping(pool)) ? 'ok' : 'degraded' }),
});
await app.register(tgBot, { token: process.env.BOT_TOKEN! });
await app.register(tgSubscriptions, { store: pgStore(pool), topics: ['news'] });
await app.register(tgHealth, { registry: app.ops.registry, healthPath: false, metricsPath: false });

app.addHook('onClose', () => pool.end());
closeOnSignals(app);
await app.listen({ port: 3000, host: '0.0.0.0' });
```

Or start from the [`template`](template), a complete bot with tests and a Dockerfile:

```bash
npx degit DiRaiks/dirai-kit/template my-bot
```

## One deploy for every service

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) is a reusable workflow. It builds a service's images to GHCR, uploads its Compose files to a server, restarts the stack over SSH and waits until the services report healthy. [`deploy/postgres.compose.yml`](deploy/postgres.compose.yml) comes with it: Postgres with a daily `pg_dump`.

```yaml
# .github/workflows/deploy.yml of a service
on:
  workflow_run: { workflows: [CI], types: [completed], branches: [main] }
  workflow_dispatch:

jobs:
  deploy:
    if: github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success'
    uses: DiRaiks/dirai-kit/.github/workflows/deploy.yml@<commit> # main
    with:
      commit: ${{ github.event.workflow_run.head_sha || github.sha }}
      images: '[{"name": "my-bot", "dockerfile": "Dockerfile"}]'
      services: bot
      deploy-path: ${{ vars.DEPLOY_PATH }}
    secrets: inherit # VPS_HOST, VPS_USER, VPS_SSH_KEY, VPS_PORT
```

```yaml
# deploy/compose.yml of the service
include:
  - path: postgres.compose.yml
    env_file: [.env, postgres.env] # postgres.env: POSTGRES_NAME=my_bot
```

## Development

npm workspaces; everything runs from the root.

```bash
npm ci
npm run lint && npm run format && npm run types && npm test && npm run build
npm run examples:types   # examples import the packages by name, after the build
npm run template:check   # the template against the packages' sources
npm run pack:check       # each package ships only its build and docs
```

Tests that need a real Postgres run when `TEST_DATABASE_URL` is set, as in CI:

```bash
docker run --rm -d -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:18.6-alpine
TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:5432/postgres npm test
```

Dependabot collects all updates into one PR a week.

## Releasing

Releases are automatic. Every push to `main` runs [multi-semantic-release](https://github.com/lidofinance/multi-semantic-release): each package gets its own version from the [Conventional Commits](https://www.conventionalcommits.org) that touch its directory since its last tag (`@dirai-kit/tg@1.5.0`), and the run's summary lists what was published.

| Commit                                                      | Release |
| ----------------------------------------------------------- | ------- |
| `fix: …`, `perf: …` or a revert                             | patch   |
| `feat: …`                                                   | minor   |
| `feat!: …`, `fix(scope)!: …` or a `BREAKING CHANGE:` footer | major   |
| `docs:`, `chore:`, `ci:`, `test:`, `refactor:`              | none    |

A package that depends on another one here gets a patch release when that one is released. Versions are published from GitHub Actions with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (no npm token stored) and provenance, together with a GitHub Release per package. Commit messages are checked by commitlint locally and on pull requests.

A new package is published once by hand (`npm publish -w packages/<name> --provenance=false`), since npm sets up trusted publishing only for a package that exists; then its trusted publisher is this repository's `release.yml` in the `npm` environment, and its first tag (`@dirai-kit/<name>@<version>`) marks where releases continue from.

## License

[MIT](LICENSE)
