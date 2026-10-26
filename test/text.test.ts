import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { localize, languagesOf, tgBot } from '../src/index.js';
import { BOT_INFO, buildBot, fakeApi, message } from './helpers.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

const lastReply = (sent: () => { payload: Record<string, unknown> }[]) =>
  sent().at(-1)?.payload.text;

describe('localize', () => {
  const text = { default: 'Hello', ru: 'Привет', pt: 'Olá', 'pt-br': 'Oi' };

  it('picks the language, its base language, then the default', () => {
    expect(localize(text, 'ru')).toBe('Привет');
    expect(localize(text, 'RU')).toBe('Привет');
    expect(localize(text, 'pt-br')).toBe('Oi');
    expect(localize(text, 'pt-pt')).toBe('Olá');
    expect(localize(text, 'de')).toBe('Hello');
    expect(localize(text)).toBe('Hello');
  });

  it('matches keys in any case and only own keys', () => {
    expect(
      localize({ default: 'Hi', 'pt-BR': 'Oi', RU: 'Привет' }, 'pt-br'),
    ).toBe('Oi');
    expect(localize({ default: 'Hi', RU: 'Привет' }, 'ru')).toBe('Привет');
    expect(localize(text, 'constructor')).toBe('Hello');
    expect(localize(text, '__proto__')).toBe('Hello');
  });

  it('returns a plain value as it is', () => {
    expect(localize('Hello', 'ru')).toBe('Hello');
    const format = (n: number) => `${n}`;
    expect(localize(format, 'ru')).toBe(format);
    expect(languagesOf('Hello')).toEqual([]);
    expect(languagesOf(text)).toEqual(['ru', 'pt', 'pt-br']);
  });
});

describe('texts per language', () => {
  const texts = {
    start: { default: 'Hi! Commands: /help', ru: 'Привет! Команды: /help' },
    helpTitle: { default: 'Commands:', ru: 'Команды:' },
    helpDescription: { default: 'List commands', ru: 'Список команд' },
    forbidden: { default: 'Not for you.', ru: 'Не для вас.' },
  };

  it("answers in the user's Telegram language, else the default", async () => {
    const { app, api } = await buildBot({ texts });
    close = () => app.close();
    app.tg.command({
      command: 'secret',
      description: { default: 'Secret', ru: 'Секрет' },
      scope: 'admin',
      handler: (ctx) => ctx.reply('ok'),
    });

    await app.tg.bot.handleUpdate(message('/start', { languageCode: 'ru' }));
    expect(lastReply(api.sent)).toBe('Привет! Команды: /help');
    await app.tg.bot.handleUpdate(message('/start', { languageCode: 'de' }));
    expect(lastReply(api.sent)).toBe('Hi! Commands: /help');
    await app.tg.bot.handleUpdate(message('/secret', { languageCode: 'ru' }));
    expect(lastReply(api.sent)).toBe('Не для вас.');

    await app.tg.bot.handleUpdate(message('/help', { languageCode: 'ru' }));
    const help = String(lastReply(api.sent));
    expect(help.startsWith('Команды:\n')).toBe(true);
    expect(help).toContain('/help — Список команд');
  });

  it('takes the language from the `language` option, once per update', async () => {
    const api = fakeApi();
    const app = Fastify({ logger: false });
    close = () => app.close();
    let calls = 0;
    await app.register(tgBot, {
      token: 't',
      mode: 'none',
      botInfo: BOT_INFO,
      configureApi: api.configureApi,
      texts,
      language: async () => {
        calls += 1;
        return 'ru';
      },
    });
    await app.ready();

    await app.tg.bot.handleUpdate(message('/help', { languageCode: 'en' }));
    expect(String(lastReply(api.sent)).startsWith('Команды:')).toBe(true);
    expect(calls).toBe(1);
  });

  it('falls back to the default texts when the lookup fails', async () => {
    const api = fakeApi();
    const app = Fastify({ logger: false });
    close = () => app.close();
    await app.register(tgBot, {
      token: 't',
      mode: 'none',
      botInfo: BOT_INFO,
      configureApi: api.configureApi,
      texts,
      language: () => {
        throw new Error('db down');
      },
    });
    await app.ready();

    await app.tg.bot.handleUpdate(message('/start', { languageCode: 'ru' }));
    expect(lastReply(api.sent)).toBe('Hi! Commands: /help');
  });

  it('localizes the subscription commands', async () => {
    const { app, api } = await buildBot({
      subscriptionTexts: {
        subscribed: {
          default: (topics) => `Subscribed: ${topics.join(', ')}`,
          ru: (topics) => `Подписан: ${topics.join(', ')}`,
        },
        unsubscribed: { default: 'Unsubscribed', ru: 'Отписан' },
        statusDescription: { default: 'Status', ru: 'Подписки' },
      },
    });
    close = () => app.close();

    await app.tg.bot.handleUpdate(
      message('/subscribe news', { languageCode: 'ru' }),
    );
    expect(lastReply(api.sent)).toBe('Подписан: news');
    await app.tg.bot.handleUpdate(message('/unsubscribe'));
    expect(lastReply(api.sent)).toBe('Unsubscribed');
    await app.tg.bot.handleUpdate(message('/help', { languageCode: 'ru' }));
    expect(String(lastReply(api.sent))).toContain('/status — Подписки');
  });

  it('sets the default menu and one per two-letter language', async () => {
    const api = fakeApi();
    const app = Fastify({ logger: false });
    close = () => app.close();
    await app.register(tgBot, {
      token: 't',
      mode: 'webhook',
      webhook: { url: 'https://example.com', secretToken: 'secret-123456' },
      botInfo: BOT_INFO,
      configureApi: api.configureApi,
      texts: {
        helpDescription: { default: 'Help', ru: 'Помощь', 'pt-br': 'Ajuda' },
      },
    });
    app.tg.command({
      command: 'watch',
      description: { default: 'Watch', ru: 'Следить', en: 'Watch it' },
      handler: () => undefined,
    });
    app.tg.command({
      command: 'stats',
      description: { default: 'Stats', ru: 'Статистика' },
      scope: 'admin',
      handler: () => undefined,
    });
    await app.ready();

    const menus = api.calls
      .filter(({ method }) => method === 'setMyCommands')
      .map(({ payload }) => [payload.language_code, payload.commands]);
    expect(menus.length).toBe(3);
    expect(menus).toEqual([
      [
        undefined,
        [
          { command: 'help', description: 'Help' },
          { command: 'watch', description: 'Watch' },
        ],
      ],
      [
        'ru',
        [
          { command: 'help', description: 'Помощь' },
          { command: 'watch', description: 'Следить' },
        ],
      ],
      [
        'en',
        [
          { command: 'help', description: 'Help' },
          { command: 'watch', description: 'Watch it' },
        ],
      ],
    ]);
  });
});

it('sets the other menus when one is rejected', async () => {
  const api = fakeApi(({ method, payload }) => {
    if (method === 'setMyCommands' && payload.language_code === 'ru')
      throw new Error('BOT_COMMAND_DESCRIPTION_INVALID');
    return true;
  });
  const app = Fastify({ logger: false });
  close = () => app.close();
  await app.register(tgBot, {
    token: 't',
    mode: 'webhook',
    webhook: { url: 'https://example.com', secretToken: 'secret-123456' },
    botInfo: BOT_INFO,
    configureApi: api.configureApi,
    texts: { helpDescription: { default: 'Help', ru: '', en: 'Help me' } },
  });
  await app.ready();

  const methods = api.calls.map(({ method, payload }) =>
    method === 'setMyCommands'
      ? `menu:${String(payload.language_code)}`
      : method,
  );
  expect(methods).toEqual(
    expect.arrayContaining([
      'menu:undefined',
      'menu:ru',
      'menu:en',
      'setWebhook',
    ]),
  );
});
