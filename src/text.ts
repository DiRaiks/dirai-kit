import type { Context } from 'grammy';

/**
 * A value per language: keys are Telegram language codes (`en`, `ru`, `pt-br`, any
 * case), and `default` serves every language without its own entry. A plain object
 * with `default` always reads as translations, so `T` itself must not be one.
 */
export type Translations<T> = { default: T; [language: string]: T };

/** One value for every chat, or one per language */
export type Localized<T> = T | Translations<T>;

/** Picks the chat's language from an update; `undefined` means the default texts */
export type LanguageResolver = (
  ctx: Context,
) => string | undefined | Promise<string | undefined>;

const isTranslations = <T>(value: Localized<T>): value is Translations<T> =>
  typeof value === 'object' &&
  value !== null &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Object.hasOwn(value, 'default');

/** Own entry for a code in any case; a language like `constructor` finds nothing */
const entry = <T>(value: Translations<T>, code: string) =>
  Object.entries(value).find(([key]) => key.toLowerCase() === code)?.[1];

/**
 * The value for a language: its own entry, then its base language (`pt` for `pt-br`),
 * then `default`
 */
export const localize = <T>(value: Localized<T>, language?: string): T => {
  if (!isTranslations(value)) return value;
  if (!language) return value.default;
  const code = language.toLowerCase();
  return (
    entry(value, code) ?? entry(value, code.split('-')[0]!) ?? value.default
  );
};

/** Languages that have their own entry, besides `default` */
export const languagesOf = (value: Localized<unknown>): string[] =>
  isTranslations(value)
    ? Object.keys(value)
        .filter((key) => key !== 'default')
        .map((key) => key.toLowerCase())
    : [];

/** The user's Telegram language, the default resolver */
export const userLanguage: LanguageResolver = (ctx) => ctx.from?.language_code;
