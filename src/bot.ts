import { EventEmitter } from 'node:events';
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { Bot, webhookCallback, type Api, type Context } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import type { UserFromGetMe } from 'grammy/types';
import {
  languagesOf,
  localize,
  userLanguage,
  type LanguageResolver,
  type Localized,
} from './text.js';

/** Who may run a command: everyone, bot admins (by Telegram user id), or admins of the group */
export type CommandScope = 'all' | 'admin' | 'chatAdmin';

export type CommandDefinition = {
  command: string;
  /** One description, or one per language for /help and the command menu */
  description: Localized<string>;
  scope?: CommandScope;
  /** Hidden commands work but are not listed in /help and the Telegram command menu */
  hidden?: boolean;
  handler: (ctx: Context) => unknown;
};

export type BotMode = 'polling' | 'webhook' | 'none';

/** Each text is one string, or one per language (see `Translations`) */
export type TgBotTexts = {
  start: Localized<string>;
  helpTitle: Localized<string>;
  forbidden: Localized<string>;
  /**
   * Description of /start, seen only in `app.tg.commands()`: /start is hidden, so it is
   * not listed in /help or the Telegram command menu
   */
  startDescription: Localized<string>;
  /** Description of /help in /help and the Telegram command menu */
  helpDescription: Localized<string>;
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
  /**
   * The language of an update's texts, e.g. one the chat chose in settings; defaults to
   * the user's Telegram language. Resolved once per update.
   */
  language?: LanguageResolver;
};

/**
 * What the kit reports as it works; tgHealth turns these into metrics. (No `error`
 * event: Node's EventEmitter throws on an `error` nobody listens to.)
 */
export type TgEvents = {
  update: [];
  command: [{ command: string; allowed: boolean }];
  failure: [];
  delivery: [{ status: 'sent' | 'failed' | 'removed' }];
};

/** Emits without letting a listener's error reach the caller */
export const safeEmit = <K extends keyof TgEvents>(
  events: EventEmitter<TgEvents> | undefined,
  log: { warn: (obj: object, msg: string) => void },
  name: K,
  ...args: TgEvents[K]
) => {
  if (!events) return;
  try {
    (events.emit as (event: K, ...rest: unknown[]) => boolean).call(
      events,
      name,
      ...args,
    );
  } catch (error) {
    log.warn({ err: error, event: name }, 'tg-kit event listener failed');
  }
};

export type TgBot = {
  bot: Bot;
  mode: BotMode;
  /** Optional in the type so hand-made fakes of `app.tg` keep compiling */
  events?: EventEmitter<TgEvents>;
  /** Registers a command with an access check and lists it in /help */
  command: (definition: CommandDefinition) => void;
  commands: () => readonly CommandDefinition[];
  isAdmin: (userId: number | undefined) => boolean;
  /** The update's language from the `language` option */
  language: (ctx: Context) => Promise<string | undefined>;
  /** A value in the update's language */
  text: <T>(value: Localized<T>, ctx: Context) => Promise<T>;
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
  startDescription: 'Начать',
  helpDescription: 'Список команд',
};

const tgBotPlugin: FastifyPluginAsync<TgBotOptions> = async (
  fastify,
  options,
) => {
  const { token, mode = 'polling', webhook, admins = [], botInfo } = options;
  const texts = { ...DEFAULT_TEXTS, ...options.texts };
  const resolveLanguage = options.language ?? userLanguage;
  const languages = new WeakMap<Context, Promise<string | undefined>>();
  const language = (ctx: Context) => {
    let found = languages.get(ctx);
    if (!found) {
      // A failed lookup must not cost the reply: the default texts then
      found = Promise.resolve()
        .then(() => resolveLanguage(ctx))
        .catch((error: unknown) => {
          fastify.log.warn({ err: error }, 'tg-kit language lookup failed');
          return undefined;
        });
      languages.set(ctx, found);
    }
    return found;
  };
  const text = async <T>(value: Localized<T>, ctx: Context) =>
    localize(value, await language(ctx));

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

  const events = new EventEmitter<TgEvents>();
  bot.use((_ctx, next) => {
    safeEmit(events, fastify.log, 'update');
    return next();
  });

  bot.catch(({ error, ctx }) => {
    safeEmit(events, fastify.log, 'failure');
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
      const allowed = await isAllowed(ctx, definition.scope ?? 'all');
      safeEmit(events, fastify.log, 'command', {
        command: definition.command,
        allowed,
      });
      if (!allowed) {
        await ctx.reply(await text(texts.forbidden, ctx));
        return;
      }
      await definition.handler(ctx);
    });
  };

  const visibleCommands = () =>
    registry.filter((definition) => !definition.hidden);

  command({
    command: 'start',
    description: texts.startDescription,
    hidden: true,
    handler: async (ctx) => ctx.reply(await text(texts.start, ctx)),
  });
  command({
    command: 'help',
    description: texts.helpDescription,
    handler: async (ctx) => {
      const code = await language(ctx);
      const isBotAdmin = isAdmin(ctx.from?.id);
      const lines = visibleCommands()
        .filter((definition) => isBotAdmin || definition.scope !== 'admin')
        .map(
          (definition) =>
            `/${definition.command} — ${localize(definition.description, code)}`,
        );
      return ctx.reply([localize(texts.helpTitle, code), ...lines].join('\n'));
    },
  });

  if (mode === 'webhook' && webhook) {
    fastify.post(
      webhookPath,
      webhookCallback(bot, 'fastify', { secretToken: webhook.secretToken }),
    );
  }

  /**
   * The default menu, plus one per language some description has. Telegram takes only
   * two-letter codes there, so keys like `pt-br` show only in replies.
   */
  const setMenus = async () => {
    const menuCommands = visibleCommands().filter(
      (definition) => definition.scope !== 'admin',
    );
    const menu = (code?: string) =>
      menuCommands.map(({ command: name, description }) => ({
        command: name,
        description: localize(description, code),
      }));
    const codes = new Set(
      menuCommands
        .flatMap(({ description }) => languagesOf(description))
        .filter((code) => /^[a-z]{2}$/.test(code)),
    );
    // Each menu on its own: a rejected translation must not cost the others
    const set = async (...args: Parameters<Api['setMyCommands']>) => {
      try {
        await bot.api.setMyCommands(...args);
      } catch (error) {
        fastify.log.error(
          { err: error, language: args[1]?.language_code },
          'telegram command menu failed',
        );
      }
    };
    await set(menu());
    for (const code of codes) {
      // Telegram's list of codes is a closed union; the check above keeps the shape
      await set(menu(code), {
        language_code: code,
      } as Parameters<Api['setMyCommands']>[1]);
    }
  };

  // A Telegram outage must not keep the server from starting: log and carry on
  fastify.addHook('onReady', async () => {
    if (mode === 'none') return;

    try {
      await bot.init();
      await setMenus();

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
    events,
    command,
    commands: () => registry,
    isAdmin,
    language,
    text,
  } satisfies TgBot);
};

export const tgBot = fp(tgBotPlugin, { fastify: '5.x', name: 'tg-kit-bot' });
