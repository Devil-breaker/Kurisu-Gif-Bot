import { describe, expect, it } from 'vitest';
import {
  canContinueAfterMediaProbe,
  classifyStickerDocument,
  MAX_STICKER_INPUT_BYTES,
  STICKER_SUPPORTED_FORMATS,
} from '../../src/stickers/convert/conversion.js';

describe('sticker conversion input handling', () => {
  it.each([
    ['poster.png', 'image/png', 'image'],
    ['clip.gif', 'image/gif', 'video'],
    ['clip.webm', 'video/webm', 'video'],
    ['sticker.tgs', 'application/x-tgsticker', 'sticker'],
  ] as const)('classifies %s', (name, mime, kind) => {
    expect(classifyStickerDocument(name, mime)).toBe(kind);
  });

  it('accepts image and video MIME types when a filename extension is missing', () => {
    expect(classifyStickerDocument('', 'image/jpeg')).toBe('image');
    expect(classifyStickerDocument('', 'video/mp4')).toBe('video');
  });

  it('lets video inputs reach transcoding when metadata dimensions are unavailable', () => {
    expect(canContinueAfterMediaProbe('video', null, null)).toBe(true);
    expect(canContinueAfterMediaProbe('image', null, null)).toBe(false);
    expect(canContinueAfterMediaProbe('image', 320, 240)).toBe(true);
  });

  it('rejects unsupported files and advertises the input size ceiling', () => {
    expect(classifyStickerDocument('archive.zip', 'application/zip')).toBeNull();
    expect(MAX_STICKER_INPUT_BYTES).toBe(20 * 1024 * 1024);
    expect(STICKER_SUPPORTED_FORMATS.join(' ')).toContain('GIF');
    expect(STICKER_SUPPORTED_FORMATS.join(' ')).toContain('animated');
  });
});
