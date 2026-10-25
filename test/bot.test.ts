import { afterEach, describe, expect, it } from 'vitest';

import { ADMIN_ID, apiError, buildBot, message } from './helpers.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

const lastReply = (sent: () => { payload: Record<string, unknown> }[]) =>
  sent().at(-1)?.payload.text;

describe('tgBot', () => {
  it('lists visible commands in /help, admin commands only for admins', async () => {
    const { app, api } = await buildBot();
    close = () => app.close();
    app.tg.command({
      command: 'secret',
      description: 'Admin only',
      scope: 'admin',
      handler: (ctx) => ctx.reply('ok'),
    });

    await app.tg.bot.handleUpdate(message('/help'));
    const userHelp = String(lastReply(api.sent));
    await app.tg.bot.handleUpdate(message('/help', { userId: ADMIN_ID }));
    const adminHelp = String(lastReply(api.sent));

    expect(userHelp).toContain('/subscribe');
    expect(userHelp).not.toContain('/start');
    expect(userHelp).not.toContain('/secret');
    expect(adminHelp).toContain('/secret — Admin only');
  });

  it('enforces command scopes', async () => {
    const { app, api } = await buildBot();
    close = () => app.close();
    app.tg.command({
      command: 'secret',
      description: 'x',
      scope: 'admin',
      handler: (ctx) => ctx.reply('done'),
    });

    await app.tg.bot.handleUpdate(message('/secret'));
    expect(lastReply(api.sent)).toBe('Эта команда вам недоступна.');

    await app.tg.bot.handleUpdate(message('/secret', { userId: ADMIN_ID }));
    expect(lastReply(api.sent)).toBe('done');
  });

  it('lets only group admins run chatAdmin commands in groups', async () => {
    let status = 'member';
    const { app, api } = await buildBot({
      respond: ({ method }) =>
        method === 'getChatMember' ? { status, user: { id: 20 } } : true,
    });
    close = () => app.close();

    await app.tg.bot.handleUpdate(
      message('/subscribe', { chatId: -5, chatType: 'group' }),
    );
    expect(lastReply(api.sent)).toBe('Эта команда вам недоступна.');

    status = 'administrator';
    await app.tg.bot.handleUpdate(
      message('/subscribe', { chatId: -5, chatType: 'group' }),
    );
    expect(lastReply(api.sent)).toBe('Чат подписан на: news, alerts');
  });

  it('requires webhook options in webhook mode', async () => {
    const { default: Fastify } = await import('fastify');
    const { tgBot } = await import('../src/index.js');
    const app = Fastify();

    await expect(
      app.register(tgBot, { token: 't', mode: 'webhook' }).ready(),
    ).rejects.toThrow(/webhook/);
  });

  it('treats anonymous admins and channel posts as chat admins', async () => {
    const { app, api } = await buildBot({
      respond: ({ method }) =>
        method === 'getChatMember'
          ? { status: 'member', user: { id: 1 } }
          : true,
    });
    close = () => app.close();

    const anonymous = message('/subscribe', {
      chatId: -7,
      chatType: 'group',
      userId: 1087968824,
    });
    anonymous.message!.sender_chat = { id: -7, type: 'group', title: 'G' };
    await app.tg.bot.handleUpdate(anonymous);
    expect(api.sent().at(-1)?.payload.text).toBe(
      'Чат подписан на: news, alerts',
    );

    await app.tg.bot.handleUpdate({
      update_id: 9001,
      channel_post: {
        message_id: 1,
        date: 0,
        chat: { id: -8, type: 'channel', title: 'C' },
        text: '/subscribe news',
        entities: [{ type: 'bot_command', offset: 0, length: 10 }],
      },
    });
    expect(api.sent().at(-1)?.payload).toMatchObject({
      chat_id: -8,
      text: 'Чат подписан на: news',
    });
  });

  it('denies chatAdmin commands when the admin check fails', async () => {
    const { app, api } = await buildBot({
      respond: ({ method }) => {
        if (method === 'getChatMember')
          throw apiError(method, 400, 'Bad Request: user not found');
        return true;
      },
    });
    close = () => app.close();

    await app.tg.bot.handleUpdate(
      message('/subscribe', { chatId: -9, chatType: 'group' }),
    );

    expect(api.sent().at(-1)?.payload.text).toBe('Эта команда вам недоступна.');
  });
});
