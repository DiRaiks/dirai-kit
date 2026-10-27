# dirai-kit

Packages for Node services built with Fastify, Postgres and Telegram bots, published under the `@dirai-kit` npm scope.

| Package                                  | What it is                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [`@dirai-kit/tg`](packages/tg)           | Fastify plugins for Telegram bots on grammY: commands, subscriptions, broadcasts, health, metrics |
| [`@dirai-kit/pg`](packages/pg)           | Postgres: a resilient pool, migrations under an advisory lock, ping, error codes, test databases  |
| [`@dirai-kit/fastify`](packages/fastify) | Fastify: /health and /metrics, JSON errors, safe TRUST_PROXY, redacted logs, graceful shutdown    |

[`template`](template) is a complete bot to start from: `npx degit DiRaiks/dirai-kit/template my-bot`.

## Development

npm workspaces; run everything from the root.

```bash
npm ci
npm run lint && npm run format && npm run types && npm test && npm run build
npm run examples:types   # examples import the packages by name, after the build
npm run template:check   # the template against the packages' sources
npm run pack:check       # each package ships only its build and docs
```

## Releasing

Releases are automatic. Every push to `main` runs [multi-semantic-release](https://github.com/lidofinance/multi-semantic-release): each package gets its own version from the [Conventional Commits](https://www.conventionalcommits.org) that touch its directory since its last tag (`@dirai-kit/tg@1.5.0`).

| Commit                                                      | Release |
| ----------------------------------------------------------- | ------- |
| `fix: …`, `perf: …` or a revert                             | patch   |
| `feat: …`                                                   | minor   |
| `feat!: …`, `fix(scope)!: …` or a `BREAKING CHANGE:` footer | major   |
| `docs:`, `chore:`, `ci:`, `test:`, `refactor:`              | none    |

A package that depends on another one here gets a patch release when that one is released. Versions are published from GitHub Actions with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (no npm token stored) and provenance, together with a GitHub Release per package. Commit messages are checked by commitlint locally and on pull requests.

A new package is published once by hand (`npm publish -w packages/<name>`), since npm sets up trusted publishing only for a package that exists; then its trusted publisher is this repository's `release.yml` in the `npm` environment.

## License

[MIT](LICENSE)
