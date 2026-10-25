import { describe, expect, it } from 'vitest';

import { escapeHtml, html, joinHtml, raw } from '../src/index.js';

describe('html', () => {
  it('escapes interpolated values', () => {
    const name = '<b>Bob</b> & "co"';
    expect(html`Hello ${name}`.value).toBe(
      'Hello &lt;b&gt;Bob&lt;/b&gt; &amp; &quot;co&quot;',
    );
  });

  it('keeps nested templates and raw markup', () => {
    const bold = html`<b>${'1 < 2'}</b>`;
    expect(html`${bold} ${raw('<i>x</i>')}`.value).toBe(
      '<b>1 &lt; 2</b> <i>x</i>',
    );
  });

  it('skips empty values and joins fragments', () => {
    expect(html`a${null}${undefined}${false}b`.value).toBe('ab');
    expect(joinHtml([html`<b>x</b>`, null, 'y & z', false]).value).toBe(
      '<b>x</b>\ny &amp; z',
    );
    expect(escapeHtml(5)).toBe('5');
  });
});
