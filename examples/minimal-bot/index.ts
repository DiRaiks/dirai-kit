/**
 * A bot in one file: commands, chat subscriptions, broadcasts and health checks.
 *
 *   BOT_TOKEN=123:abc ANNOUNCE_KEY=secret npx tsx examples/minimal-bot/index.ts
 *
 * Then add the bot to a chat, send /subscribe, and announce something:
 *
 *   curl -X POST localhost:3000/announce -H 'x-announce-key: secret' \
 *     -H 'content-type: application/json' -d '{"text":"Release 2.0 is out"}'
 */
import Fastify from 'fastify';
import {
  html,
  memoryStore,
  tgBot,
  tgHealth,
  tgNotifier,
  tgSubscriptions,
} from '@dirai/tg-kit';

const token = process.env.BOT_TOKEN;
const announceKey = process.env.ANNOUNCE_KEY;
if (!token || !announceKey) {
  console.error('Set BOT_TOKEN (from @BotFather) and ANNOUNCE_KEY');
  process.exit(1);
}

const app = Fastify({ logger: true });

await app.register(tgBot, {
  token,
  mode: 'polling',
  admins: (process.env.BOT_ADMINS ?? '').split(',').filter(Boolean).map(Number),
  texts: {
    start: 'Hi! Send /subscribe to get announcements here. All commands: /help',
  },
});
// Chats are kept in memory; use mongoStore(collection) to keep them across restarts
await app.register(tgSubscriptions, {
  store: memoryStore(),
  topics: ['announcements'],
});
await app.register(tgNotifier);
// GET /telegram/health and GET /metrics (needs @prometheus-io/client)
await app.register(tgHealth);

app.tg.command({
  command: 'ping',
  description: 'Check that the bot is alive',
  handler: (ctx) => ctx.reply('pong'),
});

app.tg.command({
  command: 'chats',
  description: 'How many chats are subscribed',
  scope: 'admin',
  handler: async (ctx) => {
    const chats = await app.subscriptions.listByTopic('announcements');
    return ctx.reply(`Subscribed chats: ${chats.length}`);
  },
});

app.post<{ Body: { text: string } }>(
  '/announce',
  {
    schema: {
      body: {
        type: 'object',
        required: ['text'],
        properties: { text: { type: 'string', minLength: 1, maxLength: 3000 } },
      },
    },
  },
  async (request, reply) => {
    if (request.headers['x-announce-key'] !== announceKey) {
      return reply.code(401).send({ error: 'wrong key' });
    }
    return app.notifier.notify('announcements', html`📣 ${request.body.text}`, {
      pin: true,
    });
  },
);

await app.listen({ port: Number(process.env.PORT ?? 3000) });
