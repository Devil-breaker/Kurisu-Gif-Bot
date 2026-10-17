import { spawn } from 'node:child_process';
import { getFfmpegPath } from '../../services/ffmpeg.js';

export const MAX_STICKER_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_STATIC_STICKER_BYTES = 512 * 1024;
const MAX_VIDEO_STICKER_BYTES = 256 * 1024;
const PROCESS_TIMEOUT_MS = 25_000;

export type StickerMediaKind = 'image' | 'video' | 'sticker';

export interface StickerSource {
  fileId: string;
  fileName: string;
  mimeType?: string;
  fileSize?: number;
  kind: StickerMediaKind;
}

export interface ConversionResult {
  alreadySuitable: boolean;
  buffer?: Buffer;
  filename?: string;
  format?: 'static' | 'video';
  trimmedToThreeSeconds?: boolean;
}

export class StickerConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StickerConversionError';
  }
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.ico', '.svg', '.psd']);
const VIDEO_EXTENSIONS = new Set(['.gif', '.mov', '.avi', '.mp4', '.webm', '.m4v', '.mkv']);

export const STICKER_SUPPORTED_FORMATS = [
  'Images: PNG, JPG, static WebP, TIFF, ICO, SVG, PSD',
  'Videos: GIF, MOV, AVI, MP4, WebM, M4V, MKV, animated WebP, Live Photos (when Telegram sends the motion clip)',
  'Stickers: static, video, animated',
] as const;

export function classifyStickerDocument(fileName: string, mimeType?: string): StickerMediaKind | null {
  const extension = extensionOf(fileName);
  if (extension === '.tgs') return 'sticker';
  if (VIDEO_EXTENSIONS.has(extension) || mimeType === 'image/gif' || mimeType?.startsWith('video/')) return 'video';
  if (IMAGE_EXTENSIONS.has(extension) || mimeType?.startsWith('image/')) return 'image';
  return null;
}

export function canContinueAfterMediaProbe(
  kind: StickerMediaKind,
  width: number | null,
  height: number | null,
): boolean {
  return kind === 'video' || (width !== null && width > 0 && height !== null && height > 0);
}

export async function convertForTelegramSticker(
  inputPath: string,
  inputName: string,
  inputBytes: number,
  kind: StickerMediaKind,
): Promise<ConversionResult> {
  if (inputBytes <= 0) throw new StickerConversionError('This file is empty. Send a different image, GIF, video, or sticker.');
  if (inputBytes > MAX_STICKER_INPUT_BYTES) {
    throw new StickerConversionError('This file is too large to convert. The maximum input size is 20 MB.');
  }
  if (kind === 'sticker') return { alreadySuitable: true };

  const info = await inspectMedia(inputPath);
  // Telegram animations/GIFs can be valid inputs even when FFmpeg's metadata
  // probe does not print the dimensions. Let the actual transcode decode them
  // instead of rejecting them before FFmpeg gets a chance to process the video.
  if (!canContinueAfterMediaProbe(kind, info.width, info.height)) {
    throw new StickerConversionError('I could not read this media. It may be corrupted or use an unsupported codec.');
  }

  const extension = extensionOf(inputName);
  const detectedVideo = kind === 'video' || (extension === '.webp' && info.frameCount > 1);
  if (!detectedVideo && isSuitableStaticSticker(extension, inputBytes, info)) {
    return { alreadySuitable: true };
  }
  if (detectedVideo && extension === '.webm' && isSuitableVideoSticker(inputBytes, info)) {
    return { alreadySuitable: true };
  }

  const outputFormat = detectedVideo ? 'video' : 'static';
  const outputExtension = detectedVideo ? '.webm' : '.webp';
  const outputPath = `${inputPath}.converted${outputExtension}`;
  await runFfmpeg(buildConversionArgs(inputPath, outputPath, detectedVideo));
  const { readFile, stat } = await import('node:fs/promises');
  const outputSize = (await stat(outputPath)).size;
  const sizeLimit = detectedVideo ? MAX_VIDEO_STICKER_BYTES : MAX_STATIC_STICKER_BYTES;
  if (outputSize > sizeLimit) {
    throw new StickerConversionError(
      detectedVideo
        ? 'The converted video is still over Telegram’s 256 KB sticker limit. Try a shorter or lower-resolution clip.'
        : 'The converted image is still over Telegram’s 512 KB sticker limit. Try a smaller source image.',
    );
  }

  return {
    alreadySuitable: false,
    buffer: await readFile(outputPath),
    filename: `telegram-sticker${outputExtension}`,
    format: outputFormat,
    trimmedToThreeSeconds: detectedVideo && (info.durationSeconds === null || info.durationSeconds > 3),
  };
}

interface MediaInfo {
  width: number | null;
  height: number | null;
  frameCount: number;
  durationSeconds: number | null;
  videoCodec: string | null;
  hasAudio: boolean;
}

async function inspectMedia(inputPath: string): Promise<MediaInfo> {
  const stderr = await runFfmpeg(
    ['-hide_banner', '-i', inputPath, '-map', '0:v:0', '-frames:v', '2', '-f', 'null', '-'],
    { allowNonZeroExit: true, timeoutMs: 10_000 },
  );
  const videoLine = stderr.split(/\r?\n/).find((line) => /Video:/i.test(line)) ?? '';
  const dimensions = videoLine.match(/\b(\d{1,5})x(\d{1,5})\b/);
  const duration = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/i);
  const frames = [...stderr.matchAll(/frame=\s*(\d+)/g)].map((match) => Number(match[1]));
  const codec = videoLine.match(/Video:\s*([^,\s]+)/i)?.[1]?.toLowerCase() ?? null;
  return {
    width: dimensions ? Number(dimensions[1]) : null,
    height: dimensions ? Number(dimensions[2]) : null,
    frameCount: frames.length ? Math.max(...frames) : 1,
    durationSeconds: duration
      ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
      : null,
    videoCodec: codec,
    hasAudio: /Audio:/i.test(stderr),
  };
}

function isSuitableStaticSticker(extension: string, size: number, info: MediaInfo): boolean {
  return (extension === '.png' || extension === '.webp')
    && size <= MAX_STATIC_STICKER_BYTES
    && info.frameCount <= 1
    && Math.max(info.width ?? 0, info.height ?? 0) === 512
    && Math.min(info.width ?? 0, info.height ?? 0) <= 512;
}

function isSuitableVideoSticker(size: number, info: MediaInfo): boolean {
  return size <= MAX_VIDEO_STICKER_BYTES
    && info.videoCodec === 'vp9'
    && !info.hasAudio
    && info.durationSeconds !== null
    && info.durationSeconds <= 3
    && Math.max(info.width ?? 0, info.height ?? 0) === 512
    && Math.min(info.width ?? 0, info.height ?? 0) <= 512;
}

function buildConversionArgs(inputPath: string, outputPath: string, video: boolean): string[] {
  if (video) {
    return [
      '-y', '-hide_banner', '-loglevel', 'error', '-i', inputPath,
      '-t', '3', '-an', '-vf', 'fps=30,scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,format=yuva420p',
      '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '5', '-row-mt', '1',
      '-b:v', '500k', '-maxrate', '600k', '-bufsize', '1200k', '-pix_fmt', 'yuva420p',
      '-f', 'webm', outputPath,
    ];
  }
  return [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', inputPath,
    '-frames:v', '1', '-vf', 'scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba',
    '-c:v', 'libwebp', '-quality', '78', '-compression_level', '6', '-f', 'webp', outputPath,
  ];
}

function runFfmpeg(
  args: string[],
  options: { allowNonZeroExit?: boolean; timeoutMs?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(getFfmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => proc.kill(), options.timeoutMs ?? PROCESS_TIMEOUT_MS);
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-12_000);
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(new StickerConversionError(`FFmpeg could not start: ${error.message}`));
    });
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 || (options.allowNonZeroExit && stderr.includes('Input #'))) {
        resolve(stderr);
      } else if (signal === 'SIGTERM') {
        reject(new StickerConversionError('Conversion took too long. Try a smaller file or shorter video.'));
      } else {
        reject(new StickerConversionError('This media could not be converted. Check that it is not corrupted and try another file.'));
      }
    });
  });
}

function extensionOf(filename: string): string {
  const match = filename.toLowerCase().match(/\.[a-z0-9]{1,8}$/);
  return match?.[0] ?? '';
}
