import { spawn } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { InputFile } from 'grammy';
import { getFfmpegPath } from '../../services/ffmpeg.js';
import type { ParsedLinePack } from './download.js';
import { logSafeError } from '../../services/safe-log.js';

const MAX_ZIP_ENTRIES = 2048;
const MAX_EXPANDED_ZIP_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_PNG_BYTES = 2 * 1024 * 1024;
const MAX_INITIAL_STICKERS = 50;
const MAX_STICKERS_PER_ADD_BATCH = 20;
const MAX_IMAGES_PER_LINE_PACK = 2048;
const MAX_REGULAR_STICKERS = 120;
const MAX_CUSTOM_EMOJI_STICKERS = 200;
const MAX_TELEGRAM_STICKER_BYTES = 512 * 1024;
// Leave time for the webhook to send its final Telegram response before
// Vercel's 300-second Hobby invocation limit.
const MAX_PROCESSING_TIME_MS = 270_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface ZipPng {
  name: string;
  data: Buffer;
}

function findEndOfCentralDirectory(zip: Buffer): number {
  if (zip.length < 22) throw new Error('LINE returned an invalid ZIP archive.');
  const minimum = Math.max(0, zip.length - 22 - 0xffff);
  for (let offset = zip.length - 22; offset >= minimum; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('LINE returned an invalid ZIP archive.');
}

/** Read only bounded PNG entries from a ZIP without writing to disk. */
function extractPngs(zip: Buffer): ZipPng[] {
  const eocd = findEndOfCentralDirectory(zip);
  const diskNumber = zip.readUInt16LE(eocd + 4);
  const centralDisk = zip.readUInt16LE(eocd + 6);
  const entriesOnDisk = zip.readUInt16LE(eocd + 8);
  const entryCount = zip.readUInt16LE(eocd + 10);
  const centralSize = zip.readUInt32LE(eocd + 12);
  const centralOffset = zip.readUInt32LE(eocd + 16);

  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount || entryCount === 0xffff ||
      centralSize === 0xffffffff || centralOffset === 0xffffffff || entryCount > MAX_ZIP_ENTRIES ||
      centralOffset + centralSize > eocd) {
    throw new Error('This LINE ZIP uses an unsupported or unusually large archive format.');
  }

  let offset = centralOffset;
  let expandedBytes = 0;
  const pngEntries: Array<{ name: string; flags: number; method: number; compressedSize: number; size: number; localOffset: number }> = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('LINE returned a damaged ZIP directory.');
    }

    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const size = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > zip.length) throw new Error('LINE returned a damaged ZIP directory.');

    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('This LINE ZIP uses an unsupported ZIP64 archive format.');
    }
    expandedBytes += size;
    if (expandedBytes > MAX_EXPANDED_ZIP_BYTES) {
      throw new Error('The unpacked LINE pack is too large to process in one Vercel request. Download its ZIP instead.');
    }

    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8').replaceAll('\\', '/');
    if (!name.endsWith('/') && name.toLowerCase().endsWith('.png') && !name.startsWith('__MACOSX/')) {
      if (size > MAX_SOURCE_PNG_BYTES) throw new Error(`Sticker image “${name}” is too large to process.`);
      if ((flags & 1) !== 0) throw new Error('LINE returned an encrypted ZIP entry, which cannot be processed.');
      if (method !== 0 && method !== 8) throw new Error('LINE returned a ZIP compression format that cannot be processed.');
      pngEntries.push({ name, flags, method, compressedSize, size, localOffset });
    }

    offset = nextOffset;
  }

  if (pngEntries.length === 0) throw new Error('This LINE pack ZIP does not contain static PNG images. Use /linepack to download it.');
  if (pngEntries.length > MAX_IMAGES_PER_LINE_PACK) {
    throw new Error(`This LINE pack has more than ${MAX_IMAGES_PER_LINE_PACK} images, which exceeds the safe processing limit. Use /linepack to download the ZIP.`);
  }

  return pngEntries.map((entry) => {
    const local = entry.localOffset;
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) {
      throw new Error(`Sticker image “${entry.name}” has a damaged ZIP header.`);
    }
    const localFlags = zip.readUInt16LE(local + 6);
    const localMethod = zip.readUInt16LE(local + 8);
    const nameLength = zip.readUInt16LE(local + 26);
    const extraLength = zip.readUInt16LE(local + 28);
    const start = local + 30 + nameLength + extraLength;
    const end = start + entry.compressedSize;
    if ((localFlags & 1) !== 0 || localMethod !== entry.method || end > zip.length) {
      throw new Error(`Sticker image “${entry.name}” has an invalid ZIP entry.`);
    }

    const compressed = zip.subarray(start, end);
    const data = entry.method === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength: MAX_SOURCE_PNG_BYTES });
    if (data.length !== entry.size || !data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new Error(`Sticker image “${entry.name}” is not a valid PNG.`);
    }
    return { name: entry.name, data };
  });
}

async function convertPngToTelegramSticker(input: Buffer, filename: string): Promise<Buffer> {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-i', 'pipe:0',
    '-frames:v', '1', '-vf', 'format=rgba,scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0,format=rgba',
    '-pix_fmt', 'rgba', '-compression_level', '9', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(getFfmpegPath(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = [];
    let outputSize = 0;
    let stderr = '';
    // Keep corrupt/hostile inputs from consuming a meaningful portion of the
    // Hobby invocation window; ordinary LINE PNGs convert much faster.
    const timer = setTimeout(() => proc.kill(), 8_000);

    proc.stdout.on('data', (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > MAX_TELEGRAM_STICKER_BYTES) {
        proc.kill();
        return;
      }
      output.push(Buffer.from(chunk));
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-1000);
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (outputSize > MAX_TELEGRAM_STICKER_BYTES) {
        reject(new Error(`Converted sticker “${filename}” is over Telegram’s 512 KB file limit.`));
      } else if (code !== 0) {
        reject(new Error(`Could not convert sticker “${filename}”: ${stderr || `ffmpeg exited with ${code}`}`));
      } else {
        resolve(Buffer.concat(output, outputSize));
      }
    });

    proc.stdin.on('error', () => {});
    proc.stdin.end(input);
  });
}

export interface LineTelegramPackPart {
  name: string;
  title: string;
  url: string;
  count: number;
  total: number;
}

export interface LineTelegramPackProgress {
  completed: number;
  total: number;
  phase: 'preparing' | 'adding';
  packTitle: string;
  partNumber: number;
  partCount: number;
}

export interface CreatedLineStickerPack {
  total: number;
  completed: boolean;
  timeBudgetReached: boolean;
  parts: LineTelegramPackPart[];
}

function createPackName(
  pack: ParsedLinePack,
  ownerId: number,
  botUsername: string,
  partNumber: number,
  partCount: number,
): string {
  const kind = pack.kind === 'emoji' ? 'e' : 's';
  const username = botUsername.toLowerCase();
  for (let idDigits = 8; idDigits >= 1; idDigits -= 1) {
    const prefix = `line${kind}${pack.productId.slice(-idDigits)}_${ownerId}`;
    const name = partCount === 1
      ? `${prefix}_by_${username}`
      : `${prefix}_p${partNumber}_by_${username}`;
    if (name.length <= 64) return name;
  }
  throw new Error('The bot username or Telegram account ID is too long to create a pack name.');
}

function buildPackTitle(base: string, partNumber: number, partCount: number): string {
  const suffix = partCount > 1 ? ` (${partNumber}/${partCount})` : '';
  const maxBaseLength = 64 - [...suffix].length;
  return `${[...base].slice(0, maxBaseLength).join('')}${suffix}`;
}

function isStickerSetInvalid(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'description' in error &&
    String(error.description).includes('STICKERSET_INVALID'),
  );
}

async function convertBatch(images: ZipPng[], emoji: string): Promise<Array<{ sticker: InputFile; format: 'static'; emoji_list: string[] }>> {
  const converted: Array<{ sticker: InputFile; format: 'static'; emoji_list: string[] }> = [];
  let nextImage = 0;
  const workers = Array.from({ length: Math.min(4, images.length) }, async () => {
    while (nextImage < images.length) {
      const index = nextImage;
      nextImage += 1;
      const image = images[index];
      const sticker = await convertPngToTelegramSticker(image.data, image.name);
      converted[index] = {
        sticker: new InputFile(sticker, image.name.split('/').at(-1) ?? 'sticker.png'),
        format: 'static',
        emoji_list: [emoji],
      };
    }
  });
  await Promise.all(workers);
  return converted;
}

/** Create or resume static Telegram pack parts from a LINE ZIP. */
export async function createLineTelegramPack(
  api: {
    getStickerSet(name: string): Promise<{ title: string; stickers: unknown[] }>;
    createNewStickerSet(
      userId: number,
      name: string,
      title: string,
      stickers: Array<{ sticker: InputFile; format: 'static'; emoji_list: string[] }>,
      options?: { sticker_type?: 'regular' | 'custom_emoji' },
    ): Promise<true>;
    addStickerToSet(
      userId: number,
      name: string,
      sticker: { sticker: InputFile; format: 'static'; emoji_list: string[] },
    ): Promise<true>;
    setStickerSetTitle(name: string, title: string): Promise<true>;
    deleteStickerSet(name: string): Promise<true>;
  },
  pack: ParsedLinePack,
  zip: Buffer,
  ownerId: number,
  botUsername: string,
  emoji: string,
  customTitle?: string,
  onProgress?: (progress: LineTelegramPackProgress) => Promise<void> | void,
  recreateExisting = false,
): Promise<CreatedLineStickerPack> {
  const images = extractPngs(zip);
  const perSetLimit = pack.kind === 'emoji' ? MAX_CUSTOM_EMOJI_STICKERS : MAX_REGULAR_STICKERS;
  const partCount = Math.ceil(images.length / perSetLimit);
  const startedAt = Date.now();
  const parts: LineTelegramPackPart[] = [];
  let timeBudgetReached = false;

  for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
    const partImages = images.slice(partIndex * perSetLimit, (partIndex + 1) * perSetLimit);
    const partNumber = partIndex + 1;
    const name = createPackName(pack, ownerId, botUsername, partNumber, partCount);
    const url = `https://t.me/addstickers/${name}`;
    const requestedTitle = buildPackTitle(
      customTitle ?? `LINE ${pack.kind === 'emoji' ? 'emoji' : 'stickers'} ${pack.productId}`,
      partNumber,
      partCount,
    );
    let title = requestedTitle;
    let count = 0;
    let exists = false;
    if (recreateExisting) {
      let foundExisting = false;
      try {
        await api.getStickerSet(name);
        foundExisting = true;
      } catch {
        // No existing set needs to be removed.
      }
      if (foundExisting) {
        try {
          await api.deleteStickerSet(name);
          console.info(`[linepackcreate] Deleted existing set ${name} for a requested rebuild.`);
        } catch (error) {
          if (!isStickerSetInvalid(error)) throw error;
          console.info(`[linepackcreate] Telegram says set ${name} is already invalid; creating it again.`);
        }
      }
    }
    try {
      const existing = await api.getStickerSet(name);
      count = existing.stickers.length;
      exists = true;
      title = existing.title;
      console.info(`[linepackcreate] Found existing set ${name}: ${count}/${partImages.length} stickers.`);
    } catch {
      // A missing set is created below. Telegram stores continuation progress.
    }
    if (exists && customTitle && title !== requestedTitle) {
      try {
        await api.setStickerSetTitle(name, requestedTitle);
        title = requestedTitle;
      } catch (error) {
        // Keep processing a valid existing set when Telegram refuses a rename.
        // The completion message will report the title Telegram actually has.
        logSafeError('linepackcreate:rename', error);
        if (isStickerSetInvalid(error)) {
          try {
            const current = await api.getStickerSet(name);
            count = current.stickers.length;
            title = current.title;
          } catch {
            // Telegram no longer exposes the old set; try creating it again.
            count = 0;
            exists = false;
          }
        }
      }
    }

    while (count < partImages.length) {
      if (Date.now() - startedAt >= MAX_PROCESSING_TIME_MS) {
        timeBudgetReached = true;
        break;
      }

      if (count === 0) {
        const initial = partImages.slice(0, MAX_INITIAL_STICKERS);
        await onProgress?.({
          completed: partIndex * perSetLimit + count,
          total: images.length,
          phase: 'preparing',
          packTitle: title,
          partNumber,
          partCount,
        });
        const converted = await convertBatch(initial, emoji);
        try {
          await api.createNewStickerSet(ownerId, name, title, converted, {
            sticker_type: pack.kind === 'emoji' ? 'custom_emoji' : 'regular',
          });
          count = initial.length;
          await onProgress?.({
            completed: partIndex * perSetLimit + count,
            total: images.length,
            phase: 'adding',
            packTitle: title,
            partNumber,
            partCount,
          });
        } catch (error) {
          // On a webhook retry/race, read Telegram's saved progress before failing.
          try {
            const existing = await api.getStickerSet(name);
            count = existing.stickers.length;
            title = existing.title;
          } catch {
            throw error;
          }
        }
      } else {
        const batch = partImages.slice(count, Math.min(partImages.length, count + MAX_STICKERS_PER_ADD_BATCH));
        await onProgress?.({
          completed: partIndex * perSetLimit + count,
          total: images.length,
          phase: 'preparing',
          packTitle: title,
          partNumber,
          partCount,
        });
        const converted = await convertBatch(batch, emoji);
        // Each successful call is reflected in Telegram's sticker count, making
        // retries safe if a later upload fails or Vercel stops this invocation.
        for (const sticker of converted) {
          await api.addStickerToSet(ownerId, name, sticker);
          count += 1;
          await onProgress?.({
            completed: partIndex * perSetLimit + count,
            total: images.length,
            phase: 'adding',
            packTitle: title,
            partNumber,
            partCount,
          });
        }
      }
    }

    parts.push({ name, title, url, count, total: partImages.length });
    if (timeBudgetReached) break;
  }

  const completed = parts.length === partCount && parts.every((part) => part.count >= part.total);
  return { total: images.length, completed, timeBudgetReached, parts };
}
