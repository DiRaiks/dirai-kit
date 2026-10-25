import { readFile } from 'node:fs/promises';
// @ts-expect-error -- the plugin ships without types
import { analyzeCommits } from '@semantic-release/commit-analyzer';
// @ts-expect-error -- the plugin ships without types
import { generateNotes } from '@semantic-release/release-notes-generator';
import { describe, expect, it } from 'vitest';

type PluginConfig = Record<string, unknown>;

const pluginConfig = async (name: string): Promise<PluginConfig> => {
  const config = JSON.parse(
    await readFile(new URL('../.releaserc.json', import.meta.url), 'utf8'),
  ) as { plugins: (string | [string, PluginConfig])[] };
  const entry = config.plugins.find((plugin) =>
    Array.isArray(plugin) ? plugin[0] === name : plugin === name,
  );
  return Array.isArray(entry) ? entry[1] : {};
};

const silent = { log: () => {}, error: () => {}, success: () => {} };
const context = (messages: string[]) => ({
  cwd: process.cwd(),
  logger: silent,
  options: { repositoryUrl: 'https://github.com/DiRaiks/tg-bot-kit.git' },
  lastRelease: { gitTag: 'v1.0.0', version: '1.0.0' },
  nextRelease: { gitTag: 'v2.0.0', version: '2.0.0' },
  commits: messages.map((message, index) => ({
    message,
    hash: `${index}`.padStart(40, 'a'),
    commit: { short: `${index}`.padStart(7, 'a') },
  })),
});

const releaseType = async (message: string): Promise<string | null> =>
  analyzeCommits(
    await pluginConfig('@semantic-release/commit-analyzer'),
    context([message]),
  );

// Checks the release rules the README promises against the installed semantic-release
describe('release config', () => {
  it.each([
    ['feat!: drop Node 22', 'major'],
    ['fix(bot)!: rename the webhook option', 'major'],
    ['feat: add a store\n\nBREAKING CHANGE: the store API changed', 'major'],
    ['feat: z', 'minor'],
    ['fix: y', 'patch'],
    ['perf: faster queue', 'patch'],
    [
      'revert: feat: z\n\nThis reverts commit 1234567890abcdef1234567890abcdef12345678.',
      'patch',
    ],
    ['docs: x', null],
    ['chore: x', null],
    ['ci: x', null],
  ])('%j releases %s', async (message, expected) => {
    expect(await releaseType(message)).toBe(expected);
  });

  it('lists a feat! commit under breaking changes in the release notes', async () => {
    const notes = (await generateNotes(
      await pluginConfig('@semantic-release/release-notes-generator'),
      context(['feat!: drop Node 22']),
    )) as string;

    expect(notes).toContain('BREAKING CHANGES');
    expect(notes).toContain('drop Node 22');
  });
});
