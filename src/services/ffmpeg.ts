import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const require = createRequire(import.meta.url);

/** Path to the ffmpeg binary bundled via ffmpeg-static (or fall back to PATH). */
export function getFfmpegPath(): string {
  try {
    // ffmpeg-static exports the absolute binary path as its default export
    const ffmpegStatic = require('ffmpeg-static') as unknown as string;
    if (typeof ffmpegStatic === 'string' && ffmpegStatic.length > 0) return ffmpegStatic;
    return 'ffmpeg';
  } catch {
    return 'ffmpeg';
  }
}

export interface ExtractedFrames {
  dir: string;
  /** Sampled frame paths spread across the bounded output sample. */
  frames: string[];
}

/**
 * Extract a bounded frame sample. Frames are resized and JPEG-compressed so
 * reverse-search providers receive small uploads instead of full-resolution
 * PNGs. At most 90 frames are written (one every two seconds).
 */
export async function extractFrames(inputPath: string): Promise<ExtractedFrames> {
  const dir = join(tmpdir(), `frames-${Date.now()}-${randomBytes(4).toString('hex')}`);
  await mkdir(dir, { recursive: true });

  const ffmpeg = getFfmpegPath();
  const args = [
    '-y',              // overwrite
    '-i', inputPath,
    '-vf', 'fps=1/2,scale=640:640:force_original_aspect_ratio=decrease',
    '-frames:v', '90', // hard output cap
    '-q:v', '4',        // JPEG quality; keeps JSON/base64 uploads comfortably small
    join(dir, 'frame_%04d.jpg'),
  ];

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      const timer = setTimeout(() => proc.kill(), 20_000);
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-4000);
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with ${code}: ${stderr.slice(-500)}`));
      });
    });

    const files = (await readdir(dir)).filter((f) => f.endsWith('.jpg')).sort();
    if (files.length === 0) throw new Error('No frames extracted from input');

    const total = files.length;
    const picks = new Set<number>([0, Math.floor(total * 0.4), Math.min(total - 1, Math.floor(total * 0.7))]);
    const frames = [...picks].sort().map((i) => join(dir, files[i]));
    return { dir, frames };
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
