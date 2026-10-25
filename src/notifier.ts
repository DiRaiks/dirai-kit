import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { GrammyError } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';

import type { Html } from './html.js';

export type SendOptions = {
  pin?: boolean;
  /** Delivers without a sound, for low-priority updates */
  silent?: boolean;
  replyMarkup?: InlineKeyboardMarkup;
  disablePreview?: boolean;
};

export type EditOptions = Pick<SendOptions, 'replyMarkup' | 'disablePreview'>;

/** A message the bot sent, used to edit or unpin it later */
export type SentMessage = { chatId: number; messageId: number };

export type BroadcastResult = {
  sent: number;
  failed: number;
  removed: number;
  messages: SentMessage[];
};

export type Notifier = {
  /** Sends to every chat subscribed to the topic; resolves when the broadcast is done */
  notify(
    topic: string,
    message: Html,
    options?: SendOptions,
  ): Promise<BroadcastResult>;
  /** Sends to one chat through the same rate-limited queue; null when it was not delivered */
  send(
    chatId: number,
    message: Html,
    options?: SendOptions,
  ): Promise<SentMessage | null>;
  /** Replaces the text of a sent message; false when the message no longer exists */
  edit(
    target: SentMessage,
    message: Html,
    options?: EditOptions,
  ): Promise<boolean>;
  unpin(target: SentMessage): Promise<boolean>;
};

export type TgNotifierOptions = {
  /**
   * Minimum delay between two API calls of the queue. Telegram allows about 30 messages
   * per second overall; the default keeps a safe margin. 429 responses are retried by auto-retry.
   */
  minIntervalMs?: number;
};

declare module 'fastify' {
  interface FastifyInstance {
    notifier: Notifier;
  }
}

const isApiError = (error: unknown, code: number, description?: RegExp) =>
  error instanceof GrammyError &&
  error.error_code === code &&
  (!description || description.test(error.description));

// The bot can no longer write to the chat: blocked, kicked, or the chat is gone
const isUnreachableChat = (error: unknown) =>
  isApiError(error, 403) || isApiError(error, 400, /chat not found/i);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Delivery =
  | { status: 'sent'; message: SentMessage }
  | { status: 'failed' }
  | { status: 'removed' };

const tgNotifierPlugin: FastifyPluginAsync<TgNotifierOptions> = async (
  fastify,
  options,
) => {
  const { minIntervalMs = 40 } = options;
  const { api } = fastify.tg.bot;
  const subscriptions = fastify.hasDecorator('subscriptions')
    ? fastify.subscriptions
    : undefined;

  let queue: Promise<unknown> = Promise.resolve();
  let lastCallAt = 0;

  /** Runs API calls one after another with at least `minIntervalMs` between them */
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(async () => {
      const wait = lastCallAt + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await task();
      } finally {
        lastCallAt = Date.now();
      }
    });
    queue = run.catch(() => undefined);
    return run;
  };

  /** Unsubscribes chats the bot can no longer reach; a store failure is logged, not thrown */
  const handleUnreachable = async (chatId: number, error: unknown) => {
    if (!isUnreachableChat(error)) return false;
    fastify.log.info({ chatId }, 'telegram chat unreachable, unsubscribing');
    try {
      await subscriptions?.unsubscribe(chatId);
    } catch (storeError) {
      fastify.log.error(
        { err: storeError, chatId },
        'telegram unsubscribe failed',
      );
    }
    return true;
  };

  /** A group upgraded to a supergroup gets a new id: move its subscription there */
  const migratedChatId = async (chatId: number, error: unknown) => {
    const newChatId =
      error instanceof GrammyError
        ? error.parameters.migrate_to_chat_id
        : undefined;
    if (!newChatId) return null;

    try {
      const chat = await subscriptions?.store.get(chatId);
      if (chat) {
        await subscriptions?.store.save(newChatId, {
          topics: chat.topics,
          settings: chat.settings,
        });
        await subscriptions?.store.remove(chatId);
      }
      fastify.log.info(
        { chatId, newChatId },
        'telegram chat migrated to a supergroup',
      );
    } catch (storeError) {
      fastify.log.error(
        { err: storeError, chatId },
        'telegram chat migration failed',
      );
    }
    return newChatId;
  };

  const sendOnce = async (
    chatId: number,
    message: Html,
    options: SendOptions,
  ): Promise<SentMessage> => {
    const sent = await api.sendMessage(chatId, message.value, {
      parse_mode: 'HTML',
      reply_markup: options.replyMarkup,
      disable_notification: options.silent,
      link_preview_options: { is_disabled: options.disablePreview ?? true },
    });
    if (options.pin) {
      // Pinning needs admin rights in groups; a failure must not fail the message
      await api
        .pinChatMessage(chatId, sent.message_id, { disable_notification: true })
        .catch((error: unknown) =>
          fastify.log.warn({ err: error, chatId }, 'telegram pin failed'),
        );
    }
    return { chatId, messageId: sent.message_id };
  };

  const deliver = (chatId: number, message: Html, options: SendOptions = {}) =>
    enqueue(async (): Promise<Delivery> => {
      try {
        return {
          status: 'sent',
          message: await sendOnce(chatId, message, options),
        };
      } catch (error) {
        const newChatId = await migratedChatId(chatId, error);
        if (newChatId) {
          try {
            return {
              status: 'sent',
              message: await sendOnce(newChatId, message, options),
            };
          } catch (retryError) {
            fastify.log.error(
              { err: retryError, chatId: newChatId },
              'telegram send failed',
            );
            return { status: 'failed' };
          }
        }
        if (await handleUnreachable(chatId, error))
          return { status: 'removed' };
        fastify.log.error({ err: error, chatId }, 'telegram send failed');
        return { status: 'failed' };
      }
    });

  fastify.decorate('notifier', {
    async notify(topic, message, sendOptions) {
      if (!subscriptions)
        throw new Error('tg-kit: notify() needs the tgSubscriptions plugin');

      const chats = await subscriptions.listByTopic(topic);
      const results = await Promise.all(
        chats.map(({ chatId }) => deliver(chatId, message, sendOptions)),
      );

      return {
        sent: results.filter((result) => result.status === 'sent').length,
        failed: results.filter((result) => result.status === 'failed').length,
        removed: results.filter((result) => result.status === 'removed').length,
        messages: results.flatMap((result) =>
          result.status === 'sent' ? [result.message] : [],
        ),
      };
    },

    async send(chatId, message, sendOptions) {
      const result = await deliver(chatId, message, sendOptions);
      return result.status === 'sent' ? result.message : null;
    },

    edit({ chatId, messageId }, message, editOptions = {}) {
      return enqueue(async () => {
        try {
          await api.editMessageText(chatId, messageId, message.value, {
            parse_mode: 'HTML',
            reply_markup: editOptions.replyMarkup,
            link_preview_options: {
              is_disabled: editOptions.disablePreview ?? true,
            },
          });
          return true;
        } catch (error) {
          // Same text and markup as before: nothing to do
          if (isApiError(error, 400, /message is not modified/i)) return true;
          if (await handleUnreachable(chatId, error)) return false;
          fastify.log.warn(
            { err: error, chatId, messageId },
            'telegram edit failed',
          );
          return false;
        }
      });
    },

    unpin({ chatId, messageId }) {
      return enqueue(async () => {
        try {
          await api.unpinChatMessage(chatId, messageId);
          return true;
        } catch (error) {
          fastify.log.warn(
            { err: error, chatId, messageId },
            'telegram unpin failed',
          );
          return false;
        }
      });
    },
  } satisfies Notifier);
};

export const tgNotifier = fp(tgNotifierPlugin, {
  fastify: '5.x',
  name: 'tg-kit-notifier',
  dependencies: ['tg-kit-bot'],
});
