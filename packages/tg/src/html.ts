/** Markup that is already safe to send with `parse_mode: 'HTML'` */
export class Html {
  constructor(readonly value: string) {}

  toString() {
    return this.value;
  }
}

export const escapeHtml = (value: unknown): string =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const render = (value: unknown): string => {
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(value);
};

/**
 * Template tag for Telegram HTML messages: interpolated values are escaped unless they are
 * `Html` (e.g. nested `html` templates or `raw()`). `null`, `undefined` and `false` render nothing.
 */
export const html = (
  strings: TemplateStringsArray,
  ...values: unknown[]
): Html =>
  new Html(
    strings.reduce(
      (out, chunk, i) =>
        out + chunk + (i < values.length ? render(values[i]) : ''),
      '',
    ),
  );

/** Trusted markup, inserted without escaping */
export const raw = (value: string) => new Html(value);

/** Joins messages or fragments with a separator */
export const joinHtml = (
  parts: (Html | string | null | undefined | false)[],
  separator = '\n',
) =>
  new Html(
    parts
      .filter((part) => part !== null && part !== undefined && part !== false)
      .map(render)
      .join(separator),
  );
