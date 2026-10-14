import { describe, it, expect } from 'vitest';
import {
  computePhash,
  dHashFromGray,
  hammingDistance,
  PHASH_DUPLICATE_THRESHOLD,
} from '../../src/services/phash.js';

describe('services/phash', () => {
  describe('dHashFromGray', () => {
    it('returns all zeros for uniform gray buffer', () => {
      const gray = Buffer.alloc(72, 128); // 9x8 = 72 bytes, all same value
      expect(dHashFromGray(gray)).toBe('0000000000000000');
    });

    it('returns alternating pattern for gradient buffer', () => {
      // Create a buffer where each byte is one more than the previous
      const gray = Buffer.from(
        Array.from({ length: 72 }, (_, i) => i)
      );
      // Each adjacent pair: right > left, so every bit should be 1
      // Result should be 0xFFFFFFFFFFFFFFFF
      expect(dHashFromGray(gray)).toBe('ffffffffffffffff');
    });

    it('returns mirror image hash correctly', () => {
      // Left half bright, right half dark vs vice versa
      const gray = Buffer.alloc(72);
      for (let row = 0; row < 8; row++) {
        const rowStart = row * 9;
        // Left 4 pixels bright (255), right 4 pixels dark (0), last pixel unused
        for (let col = 0; col < 4; col++) {
          gray[rowStart + col] = 255; // bright
          gray[rowStart + col + 4] = 0; // dark
        }
        // gray[rowStart + 8] unused (9th column)
      }
      const hash1 = dHashFromGray(gray);

      // Now mirror: left dark, right bright
      gray.fill(0);
      for (let row = 0; row < 8; row++) {
        const rowStart = row * 9;
        for (let col = 0; col < 4; col++) {
          gray[rowStart + col] = 0; // dark
          gray[rowStart + col + 4] = 255; // bright
        }
      }
      const hash2 = dHashFromGray(gray);

      // Block 1 [255,255,255,255,0,0,0,0,(0)]: no right neighbour is brighter → all bits 0.
      expect(hash1).toBe('0000000000000000');
      // Block 2 [0,0,0,0,255,255,255,255,255]: only the col3→col4 step is a rise,
      // setting bit (7-3)=4 of each row byte → row byte 0x10.
      expect(hash2).toBe('1010101010101010');
      // One set bit per row × 8 rows = 8 differing bits.
      expect(hammingDistance(hash1, hash2)).toBe(8);
    });

    it('is deterministic', () => {
      const buffer1 = Buffer.from('test-image-data-123', 'utf-8');
      const buffer2 = Buffer.from('test-image-data-123', 'utf-8');

      // Pad/truncate to 72 bytes
      const gray1 = Buffer.alloc(72, 0);
      const gray2 = Buffer.alloc(72, 0);
      buffer1.copy(gray1, 0, 0, Math.min(buffer1.length, 72));
      buffer2.copy(gray2, 0, 0, Math.min(buffer2.length, 72));

      expect(dHashFromGray(gray1)).toBe(dHashFromGray(gray2));
    });
  });

  describe('hammingDistance', () => {
    it('returns 0 for identical hashes', () => {
      expect(hammingDistance('aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa')).toBe(0);
      expect(hammingDistance('ffffffffffffffff', 'ffffffffffffffff')).toBe(0);
    });

    it('returns correct distance for single bit flip', () => {
      expect(hammingDistance('0000000000000000', '0000000000000001')).toBe(1);
      expect(hammingDistance('ffffffffffffffff', 'fffffffffffffffe')).toBe(1);
    });

    it('returns 64 for complete opposite', () => {
      expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
    });

    it('returns -1 for invalid input length', () => {
      expect(hammingDistance('abc', 'def')).toBe(-1);
      expect(hammingDistance('abcdefghijklmnop', 'abcdefghijklmnopq')).toBe(-1);
      expect(hammingDistance('', 'abcdefghijklmnop')).toBe(-1);
    });

    it('returns -1 for non-hex characters', () => {
      expect(hammingDistance('gggggggggggggggg', 'hhhhhhhhhhhhhhhh')).toBe(-1);
      expect(hammingDistance('000000000000000z', '0000000000000000')).toBe(-1);
    });

    it('is case-insensitive', () => {
      // 0x1234 vs 0x4321 in the low 16 bits: 0x1234^0x4321 = 0x5115 → 6 bits
      expect(hammingDistance('ABCDEFabcdef1234', 'abcdefABCDEF4321')).toBe(6);
      // Upper-case vs lower-case of the same value: identical → 0
      expect(hammingDistance('ABCDEF0123456789', 'abcdef0123456789')).toBe(0);
    });
  });

  describe('PHASH_DUPLICATE_THRESHOLD', () => {
    it('is set to 8', () => {
      expect(PHASH_DUPLICATE_THRESHOLD).toBe(8);
    });
  });

  // Note: computePhash requires actual media files and ffmpeg,
  // so we don't unit test it here to avoid dependencies and platform issues.
  // It's tested implicitly via the backfill script and manual testing.
});