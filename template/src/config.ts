/** Settings from the environment; the bot refuses to start with a broken one */
export type Config = {
  botToken: string;
  mode: 'polling' | 'webhook';
  webhook?: { url: string; secretToken: string };
  admins: number[];
  mongoUri?: string;
  /** Protects POST /announce; without it the route is off */
  announceKey?: string;
  port: number;
};

export const loadConfig = (env: NodeJS.ProcessEnv): Config => {
  const botToken = env.BOT_TOKEN?.trim();
  if (!botToken) throw new Error('Set BOT_TOKEN (from @BotFather)');

  const mode = env.BOT_MODE === 'webhook' ? 'webhook' : 'polling';
  const url = env.BOT_WEBHOOK_URL?.trim();
  const secretToken = env.BOT_WEBHOOK_SECRET?.trim();
  if (mode === 'webhook' && (!url || !secretToken)) {
    throw new Error(
      'BOT_MODE=webhook needs BOT_WEBHOOK_URL and BOT_WEBHOOK_SECRET',
    );
  }

  return {
    botToken,
    mode,
    webhook: url && secretToken ? { url, secretToken } : undefined,
    admins: (env.BOT_ADMINS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .map(Number),
    mongoUri: env.MONGO_URI?.trim() || undefined,
    announceKey: env.ANNOUNCE_KEY?.trim() || undefined,
    port: Number(env.PORT ?? 3000),
  };
};
