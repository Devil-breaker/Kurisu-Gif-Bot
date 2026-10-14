import { describe, expect, it } from 'vitest';
import { buildLinePackZipUrl, parseLinePackUrl } from '../../src/services/line-stickers.js';

describe('LINE sticker pack URL handling', () => {
  it('accepts official sticker pack URLs and builds static and animated CDN links', () => {
    const pack = parseLinePackUrl('https://store.line.me/stickershop/product/1565020/en');
    expect(pack).toEqual({ kind: 'stickers', productId: '1565020' });
    expect(buildLinePackZipUrl(pack!, 'static')).toBe(
      'https://stickershop.line-scdn.net/stickershop/v1/product/1565020/android/stickers.zip',
    );
    expect(buildLinePackZipUrl(pack!, 'animated')).toBe(
      'https://stickershop.line-scdn.net/stickershop/v1/product/1565020/android/stickerpack.zip',
    );
  });

  it('accepts emoji pack URLs and builds the universal static ZIP link', () => {
    const pack = parseLinePackUrl('https://store.line.me/emojishop/product/5dac0626100cc3fca3e27018/en');
    expect(pack).toEqual({ kind: 'emoji', productId: '5dac0626100cc3fca3e27018' });
    expect(buildLinePackZipUrl(pack!, 'static')).toBe(
      'https://stickershop.line-scdn.net/sticonshop/v1/5dac0626100cc3fca3e27018/sticon/iphone/package.zip',
    );
    expect(() => buildLinePackZipUrl(pack!, 'animated')).toThrow(/not supported/i);
  });

  it.each([
    'http://store.line.me/stickershop/product/1565020/en',
    'https://store.line.me.evil.example/stickershop/product/1565020/en',
    'https://example.com/stickershop/product/1565020/en',
    'https://store.line.me/themeshop/product/1565020/en',
    'https://store.line.me/stickershop/product/not-a-pack/en',
    'https://user:pass@store.line.me/stickershop/product/1565020/en',
  ])('rejects unsupported or unsafe URL %s', (url) => {
    expect(parseLinePackUrl(url)).toBeNull();
  });
});
