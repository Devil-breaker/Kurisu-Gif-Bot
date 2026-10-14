import { describe, it, expect } from 'vitest';
import {
  TELEGRAM_CAPTION_LIMIT,
  clampVisible,
  escapeHtml,
  formatCaption,
  formatTimestamp,
  joinWithinLimit,
  visibleLength,
} from '../../src/services/caption.js';

describe('caption service', () => {
  describe('escapeHtml', () => {
    it('escapes the three HTML-special characters', () => {
      expect(escapeHtml('&<>')).toBe('&amp;&lt;&gt;');
    });

    it('escapes ampersand first so entities are not double-escaped', () => {
      // A naive implementation that replaced < before & would yield '&amp;lt;'
      expect(escapeHtml('<')).toBe('&lt;');
      expect(escapeHtml('&lt;')).toBe('&amp;lt;');
      expect(escapeHtml('a & b < c')).toBe('a &amp; b &lt; c');
    });

    it('escapes tags so they render literally instead of as markup', () => {
      expect(escapeHtml('<b>bold</b>')).toBe('&lt;b&gt;bold&lt;/b&gt;');
    });

    it('handles empty string', () => {
      expect(escapeHtml('')).toBe('');
    });

    it('leaves plain text untouched', () => {
      expect(escapeHtml('Hello World 123')).toBe('Hello World 123');
    });

    it('leaves MarkdownV2-reserved punctuation untouched', () => {
      // The whole point of using HTML mode: none of these need escaping
      expect(escapeHtml('Ouch! (really) per-chat 98.5% _*[]~`#+=|{}')).toBe(
        'Ouch! (really) per-chat 98.5% _*[]~`#+=|{}'
      );
    });

    it('escapes double quotes so a value is safe inside an href', () => {
      // Without this, a sourceUrl containing a quote closes the attribute and
      // the rest of the URL is parsed as markup.
      expect(escapeHtml('a"b')).toBe('a&quot;b');
      expect(escapeHtml('https://x.test/?q="><b>')).toBe(
        'https://x.test/?q=&quot;&gt;&lt;b&gt;'
      );
    });

    it('coerces non-strings instead of throwing', () => {
      // Values parsed out of cached JSON are not always the declared type.
      expect(escapeHtml(123 as unknown as string)).toBe('123');
      expect(escapeHtml(null as unknown as string)).toBe('null');
      expect(escapeHtml(undefined as unknown as string)).toBe('undefined');
    });
  });

  describe('visibleLength', () => {
    it('ignores tags, which Telegram does not count', () => {
      expect(visibleLength('<b>hi</b>')).toBe(2);
      expect(visibleLength('<a href="https://example.test/very/long">x</a>')).toBe(1);
    });

    it('counts each entity as the single character it renders as', () => {
      expect(visibleLength('&amp;')).toBe(1);
      expect(visibleLength('&lt;b&gt;')).toBe(3);
      expect(visibleLength(escapeHtml('a & b'))).toBe(5);
    });
  });

  describe('clampVisible', () => {
    it('leaves text that already fits', () => {
      expect(clampVisible('hello', 10)).toBe('hello');
      expect(clampVisible('hello', 5)).toBe('hello');
    });

    it('truncates to the limit, ellipsis included', () => {
      const out = clampVisible('abcdefghij', 5);
      expect(out).toBe('abcd…');
      expect(visibleLength(out)).toBeLessThanOrEqual(5);
    });

    it('never cuts an entity in half', () => {
      // 'x' + '&amp;' is 2 visible chars; at limit 2 the entity must go whole
      // or not at all — '&am' would be a parse error, not a shorter message.
      const out = clampVisible(`x${escapeHtml('&')}y`, 2);
      expect(out).toBe('x…');
      expect(out).not.toMatch(/&(?!amp;|lt;|gt;|quot;)/);
    });

    it('never splits a surrogate pair', () => {
      // Every seeded caption ends in an emoji, so this boundary is the common
      // one. A lone surrogate is invalid UTF-8 on the wire.
      // At limit 5, the emoji fits (ab=2 + 🤗=2 + ellipsis=1 = 5).
      expect(clampVisible('ab🤗cd', 5)).toBe('ab🤗…');
      // At limit 4 the emoji does not fit; it must be dropped whole.
      expect(clampVisible('ab🤗cd', 4)).toBe('ab…');
    });

    it('drops a trailing partial tag', () => {
      const out = clampVisible('abc<b', 10);
      expect(out).toBe('abc<b'); // fits, untouched
      expect(clampVisible('abcdef<bcd', 8)).toBe('abcdef…');
    });

    it('returns empty for a non-positive limit', () => {
      expect(clampVisible('abc', 0)).toBe('');
      expect(clampVisible('abc', -5)).toBe('');
    });
  });

  describe('joinWithinLimit', () => {
    it('joins with newlines and reports nothing dropped when it fits', () => {
      expect(joinWithinLimit(['a', 'b', 'c'], 100)).toEqual({ text: 'a\nb\nc', dropped: 0 });
    });

    it('drops whole lines and says how many', () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
      const { text, dropped } = joinWithinLimit(lines, 60);
      expect(dropped).toBeGreaterThan(0);
      expect(visibleLength(text)).toBeLessThanOrEqual(60);
      expect(text).toContain(`… and ${dropped} more`);
      // A dropped line is dropped entirely, so markup stays balanced.
      expect(text.split('\n').every((l) => l === `… and ${dropped} more` || /^line \d+$/.test(l)))
        .toBe(true);
    });

    it('keeps per-line markup balanced', () => {
      const lines = Array.from({ length: 30 }, (_, i) => `<b>row ${i}</b>`);
      const { text } = joinWithinLimit(lines, 50);
      const opens = (text.match(/<b>/g) ?? []).length;
      const closes = (text.match(/<\/b>/g) ?? []).length;
      expect(opens).toBe(closes);
    });

    it('clamps a single over-long first line rather than returning nothing', () => {
      const { text, dropped } = joinWithinLimit(['x'.repeat(100), 'second'], 20);
      expect(visibleLength(text)).toBeLessThanOrEqual(20);
      expect(dropped).toBe(2);
    });

    it('handles an empty list', () => {
      expect(joinWithinLimit([], 100)).toEqual({ text: '', dropped: 0 });
    });
  });

  describe('formatCaption', () => {
    const fromUser = { id: 1, first_name: 'Alice', username: 'alice' };
    const toUser   = { id: 2, first_name: 'Bob',   username: 'bob'   };

    it('renders {from} and {to} as clickable Telegram profile links', () => {
      const template = '{from} hugged {to}';
      const result = formatCaption(template, fromUser, toUser, 'hugged');
      expect(result).toBe('<a href="tg://user?id=1">Alice</a> hugged <a href="tg://user?id=2">Bob</a>');
    });

    it('falls back to username when first_name is missing', () => {
      const fromNoName = { id: 1, username: 'alice' };
      const toNoName   = { id: 2, username: 'bob'   };
      const result = formatCaption('{from} kissed {to}', fromNoName, toNoName, 'kissed');
      expect(result).toBe('<a href="tg://user?id=1">alice</a> kissed <a href="tg://user?id=2">bob</a>');
    });

    it('escapes HTML-special characters in display names', () => {
      const fromSpecial = { id: 1, first_name: 'A<b>lice', username: 'a&lice' };
      const toSpecial   = { id: 2, first_name: 'Bob', username: 'bo>b'       };
      const result = formatCaption('{from} patted {to}', fromSpecial, toSpecial, 'patted');
      expect(result).toBe('<a href="tg://user?id=1">A&lt;b&gt;lice</a> patted <a href="tg://user?id=2">Bob</a>');
    });

    it('escapes the action word', () => {
      const result = formatCaption('{from} {action} {to}', fromUser, toUser, '<hi&five>');
      expect(result).toBe('<a href="tg://user?id=1">Alice</a> &lt;hi&amp;five&gt; <a href="tg://user?id=2">Bob</a>');
    });

    it('escapes markup in the template so it renders literally', () => {
      const result = formatCaption('{from} <3 & <b>loves {to}', fromUser, toUser, 'loves');
      expect(result).toBe(
        '<a href="tg://user?id=1">Alice</a> &lt;3 &amp; &lt;b&gt;loves <a href="tg://user?id=2">Bob</a>',
      );
    });

    it('does not re-substitute a placeholder appearing inside a display name', () => {
      // username contains {to} but it must not be re-substituted
      const sneaky = { id: 3, first_name: 'Eve', username: '{to}' };
      const result = formatCaption('{from} poked {to}', sneaky, toUser, 'poked');
      expect(result).toBe('<a href="tg://user?id=3">Eve</a> poked <a href="tg://user?id=2">Bob</a>');
    });

    it('handles missing placeholders gracefully', () => {
      const result = formatCaption('Hello {from} and {to} and {missing}', fromUser, toUser, 'test');
      expect(result).toBe(
        'Hello <a href="tg://user?id=1">Alice</a> and <a href="tg://user?id=2">Bob</a> and {missing}',
      );
    });

    it('leaves template punctuation untouched', () => {
      const result = formatCaption('{from} slapped {to}. Ouch!', fromUser, toUser, 'slapped');
      expect(result).toBe(
        '<a href="tg://user?id=1">Alice</a> slapped <a href="tg://user?id=2">Bob</a>. Ouch!',
      );
    });

    it('injects "at" for unidirectional expressions without it in the template', () => {
      // Template uses bare {to} — function should inject "at"
      const result = formatCaption('{from} smiled {to}', fromUser, toUser, 'smiled', 'unidirectional');
      expect(result).toBe(
        '<a href="tg://user?id=1">Alice</a> smiled at <a href="tg://user?id=2">Bob</a>',
      );
    });

    it('does not double-inject "at" when template already has it', () => {
      // Template already has "at {to}" — no change needed
      const result = formatCaption('{from} smiled at {to}', fromUser, toUser, 'smiled', 'unidirectional');
      expect(result).toBe(
        '<a href="tg://user?id=1">Alice</a> smiled at <a href="tg://user?id=2">Bob</a>',
      );
    });

    it('stays inside the caption cap once clamped, even with long names', () => {
      const long = { id: 99, first_name: 'L'.repeat(64), username: 'u'.repeat(64) };
      const caption = clampVisible(
        formatCaption(`${'x'.repeat(1000)} {from} {to}`, long, long, 'hugged'),
        TELEGRAM_CAPTION_LIMIT,
      );
      expect(visibleLength(caption)).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
    });
  });

  describe('formatTimestamp', () => {
    it('converts seconds to MM:SS format', () => {
      expect(formatTimestamp(0)).toBe('0:00');
      expect(formatTimestamp(59)).toBe('0:59');
      expect(formatTimestamp(60)).toBe('1:00');
      expect(formatTimestamp(125)).toBe('2:05');
      expect(formatTimestamp(3600)).toBe('60:00');
      expect(formatTimestamp(3661)).toBe('61:01');
    });

    it('pads seconds with leading zero', () => {
      expect(formatTimestamp(1)).toBe('0:01');
      expect(formatTimestamp(9)).toBe('0:09');
      expect(formatTimestamp(10)).toBe('0:10');
    });

    it('floors fractional seconds', () => {
      expect(formatTimestamp(59.9)).toBe('0:59');
      expect(formatTimestamp(125.7)).toBe('2:05');
    });

    it('returns 0:00 for junk instead of "NaN:NaN"', () => {
      // A corrupted cache row or a missing API field used to reach the chat
      // as "NaN:NaN".
      expect(formatTimestamp(NaN)).toBe('0:00');
      expect(formatTimestamp(Infinity)).toBe('0:00');
      expect(formatTimestamp(-5)).toBe('0:00');
      expect(formatTimestamp(undefined as unknown as number)).toBe('0:00');
    });
  });
});