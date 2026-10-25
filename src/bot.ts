import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { Bot, webhookCallback, type Api, type Context } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import type { UserFromGetMe } from 'grammy/types';

/** Who may run a command: everyone, bot admins (by Telegram user id), or admins of the group */
export type CommandScope = 'all' | 'admin' | 'chatAdmin';

export type CommandDefinition = {
  command: string;
  description: string;
  scope?: CommandScope;
  /** Hidden commands work but are not listed in /help and the Telegram command menu */
  hidden?: boolean;
  handler: (ctx: Context) => unknown;
};

export type BotMode = 'polling' | 'webhook' | 'none';

export type TgBotTexts = {
  start: string;
  helpTitle: string;
  forbidden: string;
};

export type TgBotOptions = {
  token: string;
  /** `none` creates the bot without receiving updates (tests, send-only bots) */
  mode?: BotMode;
  webhook?: {
    /** Public base URL of the server, e.g. https://api.example.com */
    url: string;
    /** Route that receives updates, defaults to /telegram/webhook */
    path?: string;
    /** Telegram sends it in X-Telegram-Bot-Api-Secret-Token; requests without it are rejected */
    secretToken: string;
  };
  /** Telegram user ids allowed to run `admin` commands */
  admins?: number[];
  /** Skips the getMe call, e.g. in tests */
  botInfo?: UserFromGetMe;
  /** Extra API transformers, applied before auto-retry (e.g. a fake API in tests) */
  configureApi?: (api: Api) => void;
  texts?: Partial<TgBotTexts>;
};

export type TgBot = {
  bot: Bot;
  mode: BotMode;
  /** Registers a command with an access check and lists it in /help */
  command: (definition: CommandDefinition) => void;
  commands: () => readonly CommandDefinition[];
  isAdmin: (userId: number | undefined) => boolean;
};

declare module 'fastify' {
  interface FastifyInstance {
    tg: TgBot;
  }
}

const DEFAULT_TEXTS: TgBotTexts = {
  start: 'Привет! Список команд: /help',
  helpTitle: 'Команды:',
  forbidden: 'Эта команда вам недоступна.',
};

const tgBotPlugin: FastifyPluginAsync<TgBotOptions> = async (
  fastify,
  options,
) => {
  const { token, mode = 'polling', webhook, admins = [], botInfo } = options;
  const texts = { ...DEFAULT_TEXTS, ...options.texts };

  if (mode === 'webhook' && !webhook) {
    throw new Error(
      'tg-kit: `webhook` options (url, secretToken) are required in webhook mode',
    );
  }
  const webhookPath = webhook?.path ?? '/telegram/webhook';
  // Keeps a path prefix of the base URL, e.g. https://example.com/api + /telegram/webhook
  const webhookUrl =
    webhook && `${webhook.url.replace(/\/+$/, '')}${webhookPath}`;
  if (webhookUrl && !webhookUrl.startsWith('https://')) {
    throw new Error('tg-kit: the webhook URL must use https');
  }

  const bot = new Bot(token, botInfo ? { botInfo } : {});
  options.configureApi?.(bot.api);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));

  bot.catch(({ error, ctx }) => {
    fastify.log.error(
      { err: error, updateId: ctx.update.update_id },
      'telegram update failed',
    );
  });

  const registry: CommandDefinition[] = [];
  const isAdmin = (userId: number | undefined) =>
    userId !== undefined && admins.includes(userId);

  const isAllowed = async (ctx: Context, scope: CommandScope) => {
    if (scope === 'all') return true;
    if (isAdmin(ctx.from?.id)) return true;
    if (scope === 'admin') return false;

    // chatAdmin: anyone in a private chat, only admins in groups and channels
    const chat = ctx.chat;
    if (!chat) return false;
    if (chat.type === 'private') return true;
    // Channel posts and messages of anonymous group admins are sent on behalf of the chat
    if (chat.type === 'channel' || ctx.msg?.sender_chat?.id === chat.id)
      return true;
    if (!ctx.from) return false;

    try {
      const member = await ctx.api.getChatMember(chat.id, ctx.from.id);
      return member.status === 'creator' || member.status === 'administrator';
    } catch (error) {
      fastify.log.warn(
        { err: error, chatId: chat.id },
        'telegram admin check failed',
      );
      return false;
    }
  };

  const command = (definition: CommandDefinition) => {
    registry.push(definition);
    bot.command(definition.command, async (ctx) => {
      if (!(await isAllowed(ctx, definition.scope ?? 'all'))) {
        await ctx.reply(texts.forbidden);
        return;
      }
      await definition.handler(ctx);
    });
  };

  const visibleCommands = () =>
    registry.filter((definition) => !definition.hidden);

  command({
    command: 'start',
    description: 'Начать',
    hidden: true,
    handler: (ctx) => ctx.reply(texts.start),
  });
  command({
    command: 'help',
    description: 'Список команд',
    handler: (ctx) => {
      const isBotAdmin = isAdmin(ctx.from?.id);
      const lines = visibleCommands()
        .filter((definition) => isBotAdmin || definition.scope !== 'admin')
        .map(
          (definition) => `/${definition.command} — ${definition.description}`,
        );
      return ctx.reply([texts.helpTitle, ...lines].join('\n'));
    },
  });

  if (mode === 'webhook' && webhook) {
    fastify.post(
      webhookPath,
      webhookCallback(bot, 'fastify', { secretToken: webhook.secretToken }),
    );
  }

  // A Telegram outage must not keep the server from starting: log and carry on
  fastify.addHook('onReady', async () => {
    if (mode === 'none') return;

    try {
      await bot.init();
      await bot.api.setMyCommands(
        visibleCommands()
          .filter((definition) => definition.scope !== 'admin')
          .map(({ command: name, description }) => ({
            command: name,
            description,
          })),
      );

      if (mode === 'webhook' && webhookUrl && webhook) {
        await bot.api.setWebhook(webhookUrl, {
          secret_token: webhook.secretToken,
        });
        fastify.log.info({ url: webhookUrl }, 'telegram webhook set');
        return;
      }

      await bot.api.deleteWebhook();
    } catch (error) {
      fastify.log.error({ err: error }, 'telegram bot setup failed');
      if (mode === 'webhook') return;
    }

    // Polling runs in the background for the lifetime of the server
    bot
      .start({
        onStart: (me) =>
          fastify.log.info(
            { username: me.username },
            'telegram polling started',
          ),
      })
      .catch((error: unknown) =>
        fastify.log.error({ err: error }, 'telegram polling stopped'),
      );
  });

  fastify.addHook('onClose', async () => {
    if (bot.isRunning()) await bot.stop();
  });

  fastify.decorate('tg', {
    bot,
    mode,
    command,
    commands: () => registry,
    isAdmin,
  } satisfies TgBot);
};

export const tgBot = fp(tgBotPlugin, { fastify: '5.x', name: 'tg-kit-bot' });
