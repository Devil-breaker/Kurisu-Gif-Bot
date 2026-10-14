import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildFallbackUrls, parseCachePayload } from '../../src/services/sauce.js';

describe('sauce service', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('buildFallbackUrls', () => {
    it('links to the engines without embedding any file URL', () => {
      // The URL the bot has for a Telegram file contains the bot token
      // (api.telegram.org/file/bot<TOKEN>/...), and these links go into chat
      // messages — so the token must never appear in either URL.
      const { googleLensUrl, yandexUrl } = buildFallbackUrls();
      for (const url of [googleLensUrl, yandexUrl]) {
        expect(url).not.toContain('bot');
        expect(url).not.toContain('api.telegram.org');
        expect(url).not.toMatch(/token|bot\d+/i);
        expect(url).toMatch(/^https:\/\/[a-z.]+\//);
      }
    });

    it('returns deterministic plain engine homepages', () => {
      expect(buildFallbackUrls()).toEqual({
        googleLensUrl: 'https://lens.google.com/',
        yandexUrl: 'https://yandex.com/images/',
      });
    });
  });

  describe('parseCachePayload', () => {
    const valid = {
      version: 5,
      traceMoe: { animeTitle: 'X', similarity: 0.9, from: 1, to: 2, episode: 1 },
      sauceNao: null,
      iqdb: null,
      sauceNaoConfigured: false,
      searchComplete: true,
      cachedAt: Date.now(),
    };

    it('accepts a fresh, well-formed entry', () => {
      const parsed = parseCachePayload(JSON.stringify(valid));
      expect(parsed).not.toBeNull();
      expect(parsed?.traceMoe?.animeTitle).toBe('X');
    });

    it('rejects a stale entry', () => {
      const stale = JSON.stringify({ ...valid, cachedAt: Date.now() - 25 * 60 * 60 * 1000 });
      expect(parseCachePayload(stale)).toBeNull();
    });

    it('rejects a future cachedAt (clock skew or corrupt row)', () => {
      // Date.now() - cachedAt goes negative; the old check (age < TTL) was
      // satisfied by that, so a corrupt row read as fresh.
      const future = JSON.stringify({ ...valid, cachedAt: Date.now() + 60_000 });
      expect(parseCachePayload(future)).toBeNull();
    });

    it('rejects a missing or non-numeric cachedAt instead of comparing NaN', () => {
      // NaN < TTL is false, so the old code treated these as expired and
      // burned an API call on every /sauce rather than reporting the problem.
      expect(parseCachePayload('{"traceMoe":null}')).toBeNull();
      expect(parseCachePayload('{"cachedAt":"yesterday"}')).toBeNull();
      expect(parseCachePayload('{"cachedAt":null}')).toBeNull();
    });

    it('rejects non-JSON and non-object payloads', () => {
      expect(parseCachePayload('not json{')).toBeNull();
      expect(parseCachePayload('null')).toBeNull();
      expect(parseCachePayload('42')).toBeNull();
      expect(parseCachePayload('"a string"')).toBeNull();
    });

    it('normalises missing provider fields to null', () => {
      const parsed = parseCachePayload(JSON.stringify({ ...valid, traceMoe: undefined, sauceNao: undefined, iqdb: undefined }));
      expect(parsed).toEqual({
        version: 5,
        traceMoe: null,
        sauceNao: null,
        iqdb: null,
        sauceNaoConfigured: false,
        searchComplete: true,
        cachedAt: expect.any(Number),
      });
    });

    it('reports corruption to the log so a failing cache is visible', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      parseCachePayload('{broken');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cache'));
    });
  });
});
