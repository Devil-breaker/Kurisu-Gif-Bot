/**
 * Renders every HTML message the bot can send and validates it offline
 * against Telegram's HTML rules.
 *
 * This is the check that was missing when the bot was on MarkdownV2: the tests
 * asserted on string transformations, so a message that the Bot API would
 * reject with "can't parse entities" still passed. `expectValidTelegramHtml`
 * applies the rules from
 * https://core.telegram.org/bots/api#html-style — the allowed tag set, proper
 * nesting, and the four named entities — plus the length cap, which Telegram
 * measures after parsing.
 */
import { describe, it, expect } from 'vitest';
import {
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_MESSAGE_LIMIT,
  visibleLength,
} from '../../src/services/caption.js';
import {
  buildAdminsMessage,
  buildExpressionListMessage,
  buildHelpMessage,
  buildLocksMessage,
  buildSauceCaption,
  buildSauceKeyboard,
  buildStatsMessage,
} from '../../src/services/messages.js';
import type { AdminUser, Expression } from '../../src/types/index.js';

/** Exactly the tags Telegram's HTML parser accepts. */
const ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
  'span', 'tg-spoiler', 'tg-emoji', 'a', 'code', 'pre', 'blockquote',
]);

const VALID_ENTITY = /^&(?:amp|lt|gt|quot);/;

function expectValidTelegramHtml(html: string, limit: number): void {
  // 1. Tags: allowed, attributed correctly, and properly nested.
  const stack: string[] = [];
  const tagPattern = /<([^>]*)>/g;
  for (const [, inner] of html.matchAll(tagPattern)) {
    const closing = inner.startsWith('/');
    const body = closing ? inner.slice(1) : inner;
    const name = body.split(/[\s>]/)[0].toLowerCase();

    expect(ALLOWED_TAGS.has(name), `unsupported tag <${name}> in: ${html}`).toBe(true);

    if (closing) {
      expect(stack.pop(), `misnested </${name}> in: ${html}`).toBe(name);
    } else {
      if (name === 'a') {
        expect(body, `<a> without href in: ${html}`).toMatch(/\shref="[^"]*"/);
      }
      stack.push(name);
    }
  }
  expect(stack, `unclosed tags in: ${html}`).toEqual([]);

  // 2. Every bare "&" must begin one of the four named entities. Telegram
  //    rejects anything else, including &apos; and numeric references.
  for (let i = html.indexOf('&'); i !== -1; i = html.indexOf('&', i + 1)) {
    expect(VALID_ENTITY.test(html.slice(i)), `invalid entity at ${i} in: ${html}`).toBe(true);
  }

  // 3. No stray angle bracket left once the tags are removed: a literal "<"
  //    in prose has to be "&lt;" or the parser reads it as a tag.
  const withoutTags = html.replace(tagPattern, '');
  expect(withoutTags.includes('<'), `unescaped "<" in: ${html}`).toBe(false);
  expect(withoutTags.includes('>'), `unescaped ">" in: ${html}`).toBe(false);

  // 4. Length, as Telegram counts it.
  expect(visibleLength(html)).toBeLessThanOrEqual(limit);
}

const expr = (
  id: number,
  name: string,
  aliases: string[] = [],
  is_lewd = 0,
): Expression => ({ id, name, aliases, caption_template: '{from} {action} {to}!', is_lewd });

/** Names that have broken a send before, or would if interpolated raw. */
const HOSTILE = '<b>&"\'</b> 100% a_b-c';

describe('message builders', () => {
  const expressions: Expression[] = [
    expr(1, 'hug', ['hugs', 'cuddle']),
    expr(2, 'pat', ['pats']),
    expr(3, 'kiss', ['kisses'], 1),
  ];

  describe('buildHelpMessage', () => {
    it('is valid Telegram HTML', () => {
      const { text, dropped } = buildHelpMessage(expressions);
      expectValidTelegramHtml(text, TELEGRAM_MESSAGE_LIMIT);
      expect(dropped).toBe(0);
    });

    it('uses a real expression as the example, not a hardcoded /hug', () => {
      const { text } = buildHelpMessage([expr(9, 'boop')]);
      expect(text).toContain('<code>/boop</code>');
      expect(text).not.toContain('/hug');
    });

    it('lists lewd commands separately, and omits the section when there are none', () => {
      expect(buildHelpMessage(expressions).text).toContain('Lewd Expressions');
      expect(buildHelpMessage([expr(1, 'hug')]).text).not.toContain('Lewd Expressions');
    });

    it('describes bluetext settings', () => {
      expect(buildHelpMessage(expressions).text).toContain('message visibility settings');
    });

    it('survives a hostile expression name', () => {
      expectValidTelegramHtml(
        buildHelpMessage([expr(1, HOSTILE)]).text,
        TELEGRAM_MESSAGE_LIMIT,
      );
    });

    it('stays inside the cap with far more expressions than fit', () => {
      const many = Array.from({ length: 500 }, (_, i) => expr(i, `expression_number_${i}`));
      const { text, dropped } = buildHelpMessage(many);
      expectValidTelegramHtml(text, TELEGRAM_MESSAGE_LIMIT);
      expect(dropped).toBeGreaterThan(0);
      expect(text).toContain('… and');
    });

    it('handles an empty expression list', () => {
      expectValidTelegramHtml(buildHelpMessage([]).text, TELEGRAM_MESSAGE_LIMIT);
    });
  });

  describe('buildExpressionListMessage', () => {
    it('is valid Telegram HTML with aliases', () => {
      const { text } = buildExpressionListMessage(expressions);
      expectValidTelegramHtml(text, TELEGRAM_MESSAGE_LIMIT);
      expect(text).toContain('(aliases: <code>/hugs</code>, <code>/cuddle</code>)');
    });

    it('omits the alias parenthetical when there are none', () => {
      const { text } = buildExpressionListMessage([expr(1, 'hug')]);
      expect(text).toContain('<code>/hug</code>');
      expect(text).not.toContain('aliases');
    });

    it('escapes a hostile alias', () => {
      expectValidTelegramHtml(
        buildExpressionListMessage([expr(1, 'ok', [HOSTILE])]).text,
        TELEGRAM_MESSAGE_LIMIT,
      );
    });

    it('stays inside the cap with 500 expressions', () => {
      const many = Array.from({ length: 500 }, (_, i) => expr(i, `e${i}`, [`a${i}`, `b${i}`]));
      const { text, dropped } = buildExpressionListMessage(many);
      expectValidTelegramHtml(text, TELEGRAM_MESSAGE_LIMIT);
      expect(dropped).toBeGreaterThan(0);
    });
  });

  describe('buildStatsMessage', () => {
    it('is valid Telegram HTML and pluralises', () => {
      const { text } = buildStatsMessage([
        { expression: 'hug', count: 1 },
        { expression: 'pat', count: 12 },
      ]);
      expectValidTelegramHtml(text, TELEGRAM_MESSAGE_LIMIT);
      expect(text).toContain('<code>/hug</code>: 1 GIF');
      expect(text).toContain('<code>/pat</code>: 12 GIFs');
    });

    it('escapes a hostile expression name', () => {
      expectValidTelegramHtml(
        buildStatsMessage([{ expression: HOSTILE, count: 3 }]).text,
        TELEGRAM_MESSAGE_LIMIT,
      );
    });

    it('stays inside the cap with 1000 rows', () => {
      const many = Array.from({ length: 1000 }, (_, i) => ({
        expression: `expression_${i}`,
        count: i,
      }));
      const { text, dropped } = buildStatsMessage(many);
      expectValidTelegramHtml(text, TELEGRAM_MESSAGE_LIMIT);
      expect(dropped).toBeGreaterThan(0);
    });
  });

  describe('buildAdminsMessage', () => {
    const admin = (user_id: number, username: string | null): AdminUser => ({
      user_id,
      username,
      added_by: 42,
      created_at: '2026-01-01T00:00:00Z',
    });

    it('lists env admins, which are not rows in the database', () => {
      const { text } = buildAdminsMessage([], [111, 222]);
      expectValidTelegramHtml(text, TELEGRAM_MESSAGE_LIMIT);
      expect(text).toContain('• User 111 (from ADMIN_IDS)');
      expect(text).toContain('• User 222 (from ADMIN_IDS)');
    });

    it('does not list an env admin twice when they are also in the table', () => {
      const { text } = buildAdminsMessage([admin(111, 'root')], [111]);
      expect(text).toContain('(from ADMIN_IDS)');
      expect(text).not.toContain('@root');
      expect(text.split('111').length - 1).toBe(1);
    });

    it('escapes a hostile username', () => {
      const { text } = buildAdminsMessage([admin(5, HOSTILE)], []);
      expectValidTelegramHtml(text, TELEGRAM_MESSAGE_LIMIT);
      expect(text).toContain('&lt;b&gt;');
    });

    it('falls back to the user ID when there is no username', () => {
      expect(buildAdminsMessage([admin(7, null)], []).text).toContain('• User 7 (added by 42)');
    });
  });

  describe('buildLocksMessage', () => {
    it('is valid Telegram HTML', () => {
      const { text } = buildLocksMessage(['kiss', 'slap']);
      expectValidTelegramHtml(text, TELEGRAM_MESSAGE_LIMIT);
      expect(text).toContain('  • /kiss');
    });

    it('escapes a hostile command name', () => {
      expectValidTelegramHtml(buildLocksMessage([HOSTILE]).text, TELEGRAM_MESSAGE_LIMIT);
    });
  });

  describe('buildSauceCaption', () => {
    const traceMoe = {
      animeTitle: 'Some Anime: The Movie (2019)',
      episode: 3,
      similarity: 0.985,
      from: 125,
      to: 131.4,
      anilistId: 12345,
    };
    const sauceNao = {
      title: 'Illustration & Study',
      authorName: 'Artist <Name>',
      similarity: 0.72,
      sourceUrl: 'https://pixiv.test/artworks/1?a=1&b=2',
    };

    it('renders both providers as valid Telegram HTML', () => {
      const { text } = buildSauceCaption({
        traceMoe,
        sauceNao,
        googleLensUrl: 'https://lens.google.com/',
        yandexUrl: 'https://yandex.com/images/',
      });
      expectValidTelegramHtml(text, TELEGRAM_CAPTION_LIMIT);
      expect(text).toContain('🎯 <b>Similarity</b>  98.5%');
      expect(text).toContain('⏱ <b>Scene</b>  00:02:05 · 6.4 sec');
      expect(text).toContain('🎬 Episode 03');
    });

    it('escapes "&" inside a source URL', () => {
      const { text } = buildSauceCaption({ sauceNao });
      expect(text).toContain('Illustration &amp; Study');
      expect(buildSauceKeyboard({ sauceNao })?.inline_keyboard[0]?.[0]?.url)
        .toBe('https://pixiv.test/artworks/1?a=1&b=2');
      expectValidTelegramHtml(text, TELEGRAM_CAPTION_LIMIT);
    });

    it('escapes "&" inside an href so the link does not break the parse', () => {
      const keyboard = buildSauceKeyboard({
        googleLensUrl: 'https://lens.google.com/search?q=1&hl=en',
      });
      expect(keyboard?.inline_keyboard[0]?.[0]?.url)
        .toBe('https://lens.google.com/search?q=1&hl=en');
    });

    it('marks a cached result as cached', () => {
      expect(buildSauceCaption({ traceMoe, cached: true }).text).toContain('(cached)');
      expect(buildSauceCaption({ traceMoe, cached: false }).text).not.toContain('(cached)');
    });

    it('accepts a string episode, which the API returns for ranges', () => {
      const { text } = buildSauceCaption({ traceMoe: { ...traceMoe, episode: '1-2' } });
      expect(text).toContain('🎬 Episode 1-2');
      expectValidTelegramHtml(text, TELEGRAM_CAPTION_LIMIT);
    });

    it('omits the episode line when there is no episode', () => {
      expect(buildSauceCaption({ traceMoe: { ...traceMoe, episode: null } }).text)
        .not.toContain('Episode');
    });

    it('prints "?" rather than NaN% for a missing similarity', () => {
      const { text } = buildSauceCaption({
        traceMoe: { ...traceMoe, similarity: undefined as unknown as number },
      });
      expect(text).toContain('🎯 <b>Similarity</b>  ?');
      expect(text).not.toContain('NaN');
    });

    it('prints 0:00 rather than NaN:NaN for missing timestamps', () => {
      const { text } = buildSauceCaption({
        traceMoe: {
          ...traceMoe,
          from: undefined as unknown as number,
          to: undefined as unknown as number,
        },
      });
      expect(text).toContain('⏱ <b>Scene</b>  00:00:00 · 0.0 sec');
      expect(text).not.toContain('NaN');
    });

    it('stays inside the caption cap when every field is overlong', () => {
      const { text } = buildSauceCaption({
        traceMoe: { ...traceMoe, animeTitle: `${'A&'.repeat(400)}🤗` },
        sauceNao: {
          ...sauceNao,
          title: '<'.repeat(400),
          authorName: 'B'.repeat(400),
          sourceUrl: `https://x.test/${'c'.repeat(400)}`,
        },
        googleLensUrl: 'https://lens.google.com/',
        yandexUrl: 'https://yandex.com/images/',
      });
      expectValidTelegramHtml(text, TELEGRAM_CAPTION_LIMIT);
    });

    it('renders a result with no provider hits at all', () => {
      expectValidTelegramHtml(buildSauceCaption({}).text, TELEGRAM_CAPTION_LIMIT);
    });
  });
});
