import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the specific modules we need
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
}));

import { extractFrames } from '../../src/services/ffmpeg.js';
import { spawn } from 'node:child_process';
import { readdir, mkdir, rm } from 'node:fs/promises';

function mockFfmpegExit(code: number) {
  (spawn as ReturnType<typeof vi.fn>).mockImplementation(() => ({
    kill: vi.fn(),
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, cb: (code: number) => void) => {
      if (event === 'close') cb(code);
      return { on: vi.fn() };
    }),
  }));
}

describe('ffmpeg service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (rm as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('extractFrames', () => {
    it('extracts frames at 0%, 40%, 70% of a 10-frame sequence', async () => {
      // Mock ffmpeg success
      mockFfmpegExit(0);

      // Mock 10 frame files
      (readdir as ReturnType<typeof vi.fn>).mockResolvedValue(
        Array.from({ length: 10 }, (_, i) => `frame_${String(i).padStart(4, '0')}.jpg`)
      );

      const result = await extractFrames('/fake/input.mp4');

      expect(spawn).toHaveBeenCalledTimes(1);
      const [cmd, args] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(typeof cmd).toBe('string');
      expect(args).toContain('-i');
      expect(args).toContain('/fake/input.mp4');
      expect(args).toContain('-vf');
      expect(args).toContain('fps=1/2,scale=640:640:force_original_aspect_ratio=decrease');
      expect(args).toContain('-frames:v');
      expect(args).toContain('90');

      // 10 frames: picks = {0, floor(10*0.4)=4, min(9, floor(10*0.7))=7}
      expect(result.frames).toHaveLength(3);
      expect(result.frames[0]).toMatch(/frame_0000\.jpg$/);
      expect(result.frames[1]).toMatch(/frame_0004\.jpg$/);
      expect(result.frames[2]).toMatch(/frame_0007\.jpg$/);
    });

    it('creates a unique temp directory for the frames', async () => {
      mockFfmpegExit(0);
      (readdir as ReturnType<typeof vi.fn>).mockResolvedValue(['frame_0000.jpg']);

      const result = await extractFrames('/fake/input.mp4');

      expect(mkdir).toHaveBeenCalledTimes(1);
      const [dir, opts] = (mkdir as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(typeof dir).toBe('string');
      expect(dir).toMatch(/frames-/);
      expect(opts).toMatchObject({ recursive: true });
      // Returned dir matches the created one; frames live inside it
      expect(result.dir).toBe(dir);
      expect(result.frames[0]).toContain(dir);
    });

    it('selects correct indices for different frame counts', async () => {
      mockFfmpegExit(0);

      // Test case: 30 frames
      (readdir as ReturnType<typeof vi.fn>).mockResolvedValue(
        Array.from({ length: 30 }, (_, i) => `frame_${String(i).padStart(4, '0')}.jpg`)
      );

      const result = await extractFrames('/fake/video.gif');
      // 30 frames: picks = {0, floor(30*0.4)=12, min(29, floor(30*0.7))=21}
      expect(result.frames[0]).toMatch(/frame_0000\.jpg$/);
      expect(result.frames[1]).toMatch(/frame_0012\.jpg$/);
      expect(result.frames[2]).toMatch(/frame_0021\.jpg$/);
    });

    it('throws when ffmpeg fails', async () => {
      mockFfmpegExit(1);

      await expect(extractFrames('/bad/file.mp4')).rejects.toThrow(
        'ffmpeg exited with 1'
      );
    });

    it('throws when no frames extracted', async () => {
      mockFfmpegExit(0);

      (readdir as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await expect(extractFrames('/fake/video.mp4')).rejects.toThrow(
        'No frames extracted from input'
      );
    });

    it('retries with the first frame when the sampling filter drops a short or still image', async () => {
      mockFfmpegExit(0);
      (readdir as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(['frame_0001.jpg']);

      const result = await extractFrames('/fake/sticker.webp');

      expect(result.frames).toHaveLength(1);
      expect(result.frames[0]).toMatch(/frame_0001\.jpg$/);
      expect(spawn).toHaveBeenCalledTimes(2);
      const [, fallbackArgs] = (spawn as ReturnType<typeof vi.fn>).mock.calls[1]!;
      expect(fallbackArgs).toContain('-frames:v');
      expect(fallbackArgs).toContain('1');
      expect(fallbackArgs.join(' ')).not.toContain('fps=1/2');
    });

    it('succeeds with a single frame (all picks collapse to index 0)', async () => {
      mockFfmpegExit(0);

      (readdir as ReturnType<typeof vi.fn>).mockResolvedValue(['frame_0000.jpg']);

      const result = await extractFrames('/fake/video.mp4');
      expect(result.frames).toHaveLength(1);
      expect(result.frames[0]).toMatch(/frame_0000\.jpg$/);
    });

    it('does not delete the temp dir itself (caller owns cleanup)', async () => {
      mockFfmpegExit(0);
      (readdir as ReturnType<typeof vi.fn>).mockResolvedValue(['f1.jpg', 'f2.jpg', 'f3.jpg']);

      const result = await extractFrames('/fake/video.mp4');

      // extractFrames hands the dir back; bot.ts /sauce removes it in finally
      expect(rm).not.toHaveBeenCalled();
      expect(result.dir).toMatch(/frames-/);
      expect(result.frames).toHaveLength(3);
    });
  });
});
