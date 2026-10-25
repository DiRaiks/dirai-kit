# Changelog

Releases are published by [semantic-release](https://semantic-release.gitbook.io), and their notes are on [GitHub Releases](https://github.com/DiRaiks/tg-bot-kit/releases). This file is no longer updated.

## 0.1.0

First release on npm, extracted from football-planner.

- `tgBot`: commands with `all` / `admin` / `chatAdmin` scopes, `/help` and the command menu, polling, webhook (secret token, https) and `none` modes, auto-retry, startup that survives a Telegram outage
- `tgSubscriptions`: topics per chat, `/subscribe`, `/unsubscribe`, `/status`, `memoryStore` and `mongoStore` with legacy topics
- `tgNotifier`: rate-limited queue with `notify`, `send`, `edit`, `unpin`, silent messages, automatic unsubscribe of unreachable chats, supergroup migration
- `html` tagged template with escaping, `raw`, `joinHtml`
