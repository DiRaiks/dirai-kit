import { afterEach, describe, expect, it } from 'vitest';

import { html } from '../src/index.js';
import { GrammyError } from 'grammy';

import { apiError, buildBot } from './helpers.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

describe('tgNotifier', () => {
  it('broadcasts HTML to subscribers of a topic and pins when asked', async () => {
    const { app, api, store } = await buildBot();
    close = () => app.close();
    await store.save(1, { topics: ['news'] });
    await store.save(2, { topics: ['news'] });
    await store.save(3, { topics: ['alerts'] });

    const result = await app.notifier.notify('news', html`<b>${'A & B'}</b>`, {
      pin: true,
    });

    expect(result).toMatchObject({ sent: 2, failed: 0, removed: 0 });
    expect(result.messages.map((m) => m.chatId)).toEqual([1, 2]);
    expect(api.sent().map((c) => c.payload)).toEqual([
      expect.objectContaining({
        chat_id: 1,
        text: '<b>A &amp; B</b>',
        parse_mode: 'HTML',
      }),
      expect.objectContaining({
        chat_id: 2,
        text: '<b>A &amp; B</b>',
        parse_mode: 'HTML',
      }),
    ]);
    expect(api.calls.filter((c) => c.method === 'pinChatMessage')).toHaveLength(
      2,
    );
  });

  it('unsubscribes chats where the bot was blocked and counts failures', async () => {
    const { app, store } = await buildBot({
      respond: ({ method, payload }) => {
        if (method !== 'sendMessage') return true;
        if (payload.chat_id === 1)
          throw apiError(method, 403, 'Forbidden: bot was blocked by the user');
        if (payload.chat_id === 2)
          throw apiError(method, 400, 'Bad Request: message is too long');
        return true;
      },
    });
    close = () => app.close();
    for (const chatId of [1, 2, 3])
      await store.save(chatId, { topics: ['news'] });

    const result = await app.notifier.notify('news', html`hi`);

    expect(result).toMatchObject({ sent: 1, failed: 1, removed: 1 });
    expect(await store.get(1)).toBeNull();
    expect(await store.get(2)).not.toBeNull();
  });

  it('does not fail the message when pinning is not allowed', async () => {
    const { app } = await buildBot({
      respond: ({ method }) => {
        if (method === 'pinChatMessage')
          throw apiError(method, 400, 'Bad Request: not enough rights');
        return true;
      },
    });
    close = () => app.close();

    expect(await app.notifier.send(5, html`x`, { pin: true })).toMatchObject({
      chatId: 5,
    });
  });

  it('sends messages one at a time with the minimum interval', async () => {
    const times: number[] = [];
    const { app, store } = await buildBot({
      minIntervalMs: 30,
      respond: ({ method }) => {
        if (method === 'sendMessage') times.push(Date.now());
        return true;
      },
    });
    close = () => app.close();
    for (const chatId of [1, 2, 3])
      await store.save(chatId, { topics: ['news'] });

    await app.notifier.notify('news', html`x`);

    expect(times).toHaveLength(3);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(25);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(25);
  });

  it('edits messages, treating "not modified" as success', async () => {
    let notModified = false;
    const { app, api } = await buildBot({
      respond: ({ method }) => {
        if (method === 'editMessageText' && notModified) {
          throw apiError(method, 400, 'Bad Request: message is not modified');
        }
        if (method === 'editMessageText') return true;
        return true;
      },
    });
    close = () => app.close();
    const sent = await app.notifier.send(7, html`v1`, { silent: true });

    expect(api.sent()[0]?.payload.disable_notification).toBe(true);
    expect(await app.notifier.edit(sent!, html`<b>v2</b>`)).toBe(true);
    expect(
      api.calls.find((c) => c.method === 'editMessageText')?.payload,
    ).toMatchObject({
      chat_id: 7,
      message_id: sent!.messageId,
      text: '<b>v2</b>',
      parse_mode: 'HTML',
    });

    notModified = true;
    expect(await app.notifier.edit(sent!, html`<b>v2</b>`)).toBe(true);
  });

  it('reports edits of deleted messages and unpins', async () => {
    const { app } = await buildBot({
      respond: ({ method }) => {
        if (method === 'editMessageText')
          throw apiError(method, 400, 'Bad Request: message to edit not found');
        return true;
      },
    });
    close = () => app.close();

    expect(await app.notifier.edit({ chatId: 1, messageId: 1 }, html`x`)).toBe(
      false,
    );
    expect(await app.notifier.unpin({ chatId: 1, messageId: 1 })).toBe(true);
  });

  it('keeps broadcasting when unsubscribing an unreachable chat fails', async () => {
    const { app, store } = await buildBot({
      respond: ({ method, payload }) => {
        if (method === 'sendMessage' && payload.chat_id === 1) {
          throw apiError(method, 403, 'Forbidden: bot was kicked');
        }
        return true;
      },
    });
    close = () => app.close();
    for (const chatId of [1, 2]) await store.save(chatId, { topics: ['news'] });
    store.remove = async () => {
      throw new Error('db down');
    };

    const result = await app.notifier.notify('news', html`x`);

    expect(result).toMatchObject({ sent: 1, removed: 1 });
    expect(result.messages).toEqual([
      { chatId: 2, messageId: expect.any(Number) },
    ]);
  });

  it('follows a group that was upgraded to a supergroup', async () => {
    const { app, api, store } = await buildBot({
      respond: ({ method, payload }) => {
        if (method === 'sendMessage' && payload.chat_id === -1) {
          throw new GrammyError(
            "Call to 'sendMessage' failed!",
            {
              ok: false,
              error_code: 400,
              description:
                'Bad Request: group chat was upgraded to a supergroup chat',
              parameters: { migrate_to_chat_id: -1001 },
            },
            method,
            {},
          );
        }
        return true;
      },
    });
    close = () => app.close();
    await store.save(-1, { topics: ['news'], settings: { muted: false } });

    const result = await app.notifier.notify('news', html`x`);

    expect(result.sent).toBe(1);
    expect(api.sent().at(-1)?.payload.chat_id).toBe(-1001);
    expect(await store.get(-1)).toBeNull();
    expect(await store.get(-1001)).toEqual({
      chatId: -1001,
      topics: ['news'],
      settings: { muted: false },
    });
  });
});
