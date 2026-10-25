# @diraiks/tg-kit

Fastify 5 plugins for Telegram bots built on [grammY](https://grammy.dev): commands with access control, chat subscriptions to topics, and rate-limited HTML broadcasts.

## Quick start

```ts
import Fastify from 'fastify';
import {
  html,
  memoryStore,
  tgBot,
  tgNotifier,
  tgSubscriptions,
} from '@diraiks/tg-kit';

const app = Fastify({ logger: true });

await app.register(tgBot, { token: process.env.BOT_TOKEN!, mode: 'polling' });
await app.register(tgSubscriptions, { store: memoryStore(), topics: ['news'] });
await app.register(tgNotifier);

app.tg.command({
  command: 'ping',
  description: 'Check that the bot is alive',
  handler: (ctx) => ctx.reply('pong'),
});

app.post('/announce', async () =>
  app.notifier.notify('news', html`<b>${'Release 1.0'}</b> is out`, {
    pin: true,
  }),
);

await app.listen({ port: 3000 });
```

## Plugins

### `tgBot`

Creates the grammY `Bot` (`app.tg.bot`) with automatic retries on rate limits and logs update errors.

| Option         | Description                                                                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `token`        | Bot token from @BotFather                                                                                                               |
| `mode`         | `polling` (default), `webhook`, or `none` (no updates: tests, send-only bots)                                                           |
| `webhook`      | `{ url, secretToken, path? }` — public base URL; updates arrive at `path` (default `/telegram/webhook`) and must carry the secret token |
| `admins`       | Telegram user ids allowed to run `admin` commands                                                                                       |
| `botInfo`      | Skips `getMe` (tests)                                                                                                                   |
| `configureApi` | Extra API transformers, e.g. a fake API in tests                                                                                        |
| `texts`        | Overrides for `/start`, the `/help` title and the "forbidden" reply                                                                     |

`app.tg.command({ command, description, scope, hidden, handler })` registers a command and lists it in `/help` and the Telegram command menu. Scopes: `all` (default), `admin` (ids from `admins`), `chatAdmin` (anyone in private chats, only group admins in groups).

On `ready` the plugin sets the command menu and starts polling or sets the webhook; on `close` it stops polling.

### `tgSubscriptions`

Adds `/subscribe [topic]`, `/unsubscribe [topic]` (both `chatAdmin`) and `/status`. Without a topic `/subscribe` subscribes to all topics and `/unsubscribe` removes the chat. `app.subscriptions` exposes the same operations to code.

Stores:

- `memoryStore()` — for tests and throwaway bots.
- `mongoStore(collection, { legacyTopics })` — any MongoDB collection (driver or `mongoose.connection.collection(...)`). Documents look like `{ chatId, topics, settings }`; documents without `topics` count as subscribed to `legacyTopics`, which lets a bot adopt an existing `chats` collection.

`settings` is free-form per-chat data, e.g. watched addresses.

### `tgNotifier`

| Method                                          | Description                                                                                                      |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `notify(topic, message, options)`               | Sends an `Html` message to every chat subscribed to `topic`; resolves with `{ sent, failed, removed, messages }` |
| `send(chatId, message, options)`                | Sends to one chat; resolves with `{ chatId, messageId }` or `null`                                               |
| `edit({ chatId, messageId }, message, options)` | Replaces the text, e.g. to keep a pinned status message up to date; "message is not modified" counts as success  |
| `unpin({ chatId, messageId })`                  | Unpins a message                                                                                                 |

Send options: `pin`, `silent` (no notification sound), `replyMarkup`, `disablePreview` (default `true`). Keep the returned `messages` to edit or unpin them later, e.g. a pinned announcement that shows live state while short updates go out silently.

Messages go through one queue spaced by `minIntervalMs` (default 40 ms, under Telegram's ~30 messages/s). Chats where the bot was blocked or removed are unsubscribed automatically. Pin failures (no admin rights) are logged and do not fail the message.

### `html`

```ts
html`<b>${userInput}</b>`; // interpolations are escaped
html`${html`<i>nested</i>`}`; // nested templates are kept
raw('<a href="...">trusted</a>'); // inserted as is
joinHtml([line1, maybeLine, line3]); // skips null/undefined/false, joins with \n
```

## Testing a bot

Use `mode: 'none'`, `botInfo` and a fake API, then feed updates with `app.tg.bot.handleUpdate(update)`. See `test/helpers.ts`.
