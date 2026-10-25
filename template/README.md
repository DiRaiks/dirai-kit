# My Telegram bot

Made from the [@dirai/tg-kit](https://github.com/DiRaiks/tg-bot-kit) template: Fastify, grammY, chat subscriptions, rate-limited broadcasts, health checks and Prometheus metrics.

## Start

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Install and configure:

   ```bash
   npm install
   cp .env.example .env   # set BOT_TOKEN, and ANNOUNCE_KEY to try POST /announce
   npm run dev
   ```

3. Message the bot `/start`, then `/subscribe`, then announce something:

   ```bash
   curl -X POST localhost:3000/announce -H 'x-announce-key: <ANNOUNCE_KEY>' \
     -H 'content-type: application/json' -d '{"text":"Hello"}'
   ```

## What is inside

| File            | What it does                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/app.ts`    | The bot: commands (`/ping`, admin `/chats`, `/subscribe` from the kit), `POST /announce`, health and metrics. Add yours here |
| `src/config.ts` | Settings from the environment, checked on start                                                                              |
| `src/index.ts`  | Starts the server; MongoDB keeps subscriptions when `MONGO_URI` is set                                                       |
| `test/`         | The bot against a fake Telegram API: `npm test`                                                                              |
| `Dockerfile`    | Production image; secrets come from the environment at runtime                                                               |

Routes: `/telegram/health` (503 when the bot cannot get updates), `/metrics` (Prometheus), `/health`. Keep `/metrics` and `/announce` off the public internet, or protect them.

## Production

Build the image (`docker build -t my-bot .` after `npm install` has written `package-lock.json`) and run it with `BOT_TOKEN`, `MONGO_URI`, and either polling (no open port needed) or `BOT_MODE=webhook` behind an HTTPS proxy. See the kit's README for webhooks behind Caddy.
