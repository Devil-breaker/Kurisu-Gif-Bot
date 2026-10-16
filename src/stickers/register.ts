import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Bot, Context, InputFile } from 'grammy';
import type { Message } from 'grammy/types';
import { loadConfig } from '../config.js';
import { logSafeError } from '../services/safe-log.js';
import {
  classifyStickerDocument,
  convertForTelegramSticker,
  MAX_STICKER_INPUT_BYTES,
  STICKER_SUPPORTED_FORMATS,
  StickerConversionError,
  type StickerSource,
} from './convert/conversion.js';
import { createLineTelegramPack } from './line/create.js';
import { downloadLinePackZip, parseLinePackUrl } from './line/download.js';

type AdminCheck = (userId: number | undefined) => Promise<boolean>;

export interface StickerSession {
  activeExpression?: string;
  activeExpressions?: string[];
  rescanActive?: boolean;
  conversionMode?: 'single' | 'batch';
  conversionTotal?: number;
  conversionConverted?: number;
  conversionAlreadyReady?: number;
  conversionFailed?: number;
}

const TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS = 20_000;

export function registerStickerFeatures<C extends Context & { session?: StickerSession }>(bot: Bot<C>, isBotAdmin: AdminCheck): void {
  registerLinePackCommands(bot, isBotAdmin);
  registerConversionCommands(bot, isBotAdmin);
}

function registerLinePackCommands<C extends Context>(bot: Bot<C>, isBotAdmin: AdminCheck): void {
  bot.command('linepack', async (ctx) => {
    if (!(await isBotAdmin(ctx.from?.id))) {
      await ctx.reply('❌ Only bot admins can use /linepack.');
      return;
    }
    if (ctx.chat?.type !== 'private') {
      await ctx.reply('Use /linepack in a private chat with the bot so the ZIP is sent privately.');
      return;
    }

    const [rawUrl, rawFormat] = (ctx.match?.trim() ?? '').split(/\s+/);
    const pack = rawUrl ? parseLinePackUrl(rawUrl) : null;
    if (!pack) {
      await ctx.reply(
        'Usage: /linepack <LINE pack URL> [static|animated]\n\n' +
        'Supports LINE sticker and emoji pack links. Sticker packs default to static; add “animated” for an animated pack when available. Emoji packs are static.',
      );
      return;
    }

    const format = (rawFormat?.toLowerCase() || 'static');
    if (format !== 'static' && format !== 'animated') {
      await ctx.reply('Choose either “static” or “animated”.');
      return;
    }
    if (pack.kind === 'emoji' && format === 'animated') {
      await ctx.reply('Emoji pack ZIPs are currently available as static packs only.');
      return;
    }

    const status = await ctx.reply('⏳ Fetching the LINE pack ZIP…');
    try {
      const result = await downloadLinePackZip(pack, format);
      await ctx.api.sendDocument(
        ctx.chat.id,
        new InputFile(result.buffer, result.filename),
        { reply_parameters: { message_id: ctx.msg.message_id } },
      );
      await ctx.api.deleteMessage(ctx.chat.id, status.message_id).catch((err) => logSafeError('linepack:status-cleanup', err));
    } catch (err) {
      logSafeError('linepack', err);
      await editStatus(ctx, status.message_id, '❌ Could not download this LINE pack. Check the URL and try again.', 'linepack:status');
    }
  });

  bot.command('linepackcreate', async (ctx) => {
    if (!(await isBotAdmin(ctx.from?.id))) {
      await ctx.reply('❌ Only bot admins can use /linepackcreate.');
      return;
    }
    if (ctx.chat?.type !== 'private') {
      await ctx.reply('Use /linepackcreate in a private chat with the bot.');
      return;
    }

    const commandText = ctx.match?.trim() ?? '';
    const separatorIndex = commandText.indexOf('|');
    const hasTitle = separatorIndex !== -1;
    const rawPackArguments = (hasTitle ? commandText.slice(0, separatorIndex) : commandText).trim().split(/\s+/).filter(Boolean);
    const recreateExisting = rawPackArguments.includes('--recreate');
    const packArguments = rawPackArguments.filter((argument) => argument !== '--recreate');
    const customTitle = hasTitle ? commandText.slice(separatorIndex + 1).trim() : undefined;
    const [rawUrl, requestedEmoji] = packArguments;
    const pack = rawUrl ? parseLinePackUrl(rawUrl) : null;
    if (!pack || packArguments.length > 2 || (hasTitle && !customTitle)) {
      await ctx.reply(
        'Usage: /linepackcreate <LINE pack URL> [emoji] [--recreate] | [custom pack name]\n\n' +
          'Example: /linepackcreate https://store.line.me/stickershop/product/27642/en 🎉 | Spy Family Reactions\n\n' +
          'Add --recreate before | only if Telegram says the existing pack cannot be found; it deletes and rebuilds the bot-created pack. ' +
          'Creates static Telegram pack(s) from a LINE sticker or emoji pack. Large packs are split to Telegram’s pack-size limit and filled automatically in batches. ' +
          'Animated LINE packs can still be downloaded with /linepack <URL> animated. Use /linepack <URL> to download the original ZIP instead.',
      );
      return;
    }

    if (customTitle && ([...customTitle].length > 64 || /[\u0000-\u001f\u007f]/.test(customTitle))) {
      await ctx.reply('❌ The custom pack name must be 1–64 characters and cannot contain control characters.');
      return;
    }

    const emoji = requestedEmoji || (pack.kind === 'emoji' ? '🙂' : '🎉');
    if (emoji.length > 32 || /\s/.test(emoji)) {
      await ctx.reply('Use one emoji without spaces, for example /linepackcreate <LINE pack URL> 🎉 | My Sticker Pack.');
      return;
    }

    const status = await ctx.reply(recreateExisting
      ? '⏳ Rebuilding the Telegram pack…'
      : '⏳ Downloading and preparing the LINE pack for Telegram…');
    try {
      const [download, me] = await Promise.all([
        downloadLinePackZip(pack, 'static'),
        ctx.api.getMe(),
      ]);
      if (!me.username || !ctx.from) throw new Error('The bot or admin account could not be identified.');

      let lastProgressEdit = 0;
      const result = await createLineTelegramPack(
        ctx.api,
        pack,
        download.buffer,
        ctx.from.id,
        me.username,
        emoji,
        customTitle,
        async (progress) => {
          const now = Date.now();
          if (now - lastProgressEdit < 1_500 && progress.completed < progress.total) return;
          lastProgressEdit = now;
          const ratio = progress.total > 0 ? progress.completed / progress.total : 0;
          const filled = Math.min(12, Math.floor(ratio * 12));
          const bar = `${'█'.repeat(filled)}${'░'.repeat(12 - filled)}`;
          const action = progress.phase === 'preparing' ? 'Preparing' : 'Adding to';
          const message = `⏳ ${action} ${progress.packTitle} (${progress.partNumber}/${progress.partCount})\n` +
            `${bar} ${Math.floor(ratio * 100)}%\n${progress.completed}/${progress.total} stickers`;
          await ctx.api.editMessageText(ctx.chat.id, status.message_id, message)
            .catch((err) => logSafeError('linepackcreate:progress', err));
        },
        recreateExisting,
      );
      const progress = result.parts.reduce((sum, part) => sum + Math.min(part.count, part.total), 0);
      const partLinks = result.parts.filter((part) => part.count > 0).map((part) =>
        `${part.title} — ${part.count}/${part.total}\n${part.url}`,
      ).join('\n');
      const message = result.completed
        ? `✅ Created ${result.parts.length} Telegram pack${result.parts.length === 1 ? '' : 's'} with all ${result.total} stickers.\n\n${partLinks}`
        : `⏳ Pack creation progress: ${progress}/${result.total} stickers.\n` +
            `${result.timeBudgetReached ? 'This pack exceeded one Vercel request’s time limit.' : 'The pack is not finished yet.'} ` +
            `Send the same /linepackcreate command again to resume from saved progress.\n${partLinks}`;
      await editStatus(ctx, status.message_id, message, 'linepackcreate:completion');
    } catch (err) {
      logSafeError('linepackcreate', err);
      await editStatus(ctx, status.message_id, '❌ Could not create this Telegram pack. Check the pack details and try again.', 'linepackcreate:error');
    }
  });
}

function registerConversionCommands<C extends Context & { session?: StickerSession }>(bot: Bot<C>, isBotAdmin: AdminCheck): void {
  bot.command('supported', async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.reply('Use /supported in a private chat with the bot.');
      return;
    }
    if (!(await isBotAdmin(ctx.from?.id))) {
      await ctx.reply('❌ Sticker conversion tools are available to bot admins only.');
      return;
    }
    await ctx.reply(
      '🧩 <b>Supported media for sticker conversion</b>\n\n' +
        STICKER_SUPPORTED_FORMATS.map((line) => `• ${escapeHtml(line)}`).join('\n') +
        '\n\nUse /convert for one file, or /batchconvert to start a multi-file session. The bot processes media only while one of those commands is active. ' +
        'Forward the returned file to <a href="https://t.me/Stickers">@Stickers</a> to add it to a pack. Video sticker output uses up to the first 3 seconds.',
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
    );
  });

  bot.command('convert', async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.reply('Use /convert in a private chat with the bot.');
      return;
    }
    if (!(await isBotAdmin(ctx.from?.id))) {
      await ctx.reply('❌ Sticker conversion tools are available to bot admins only.');
      return;
    }

    const action = (ctx.match?.trim() ?? '').toLowerCase();
    if (action === 'cancel') {
      if (ctx.session?.conversionMode === 'batch') {
        await ctx.reply('A batch is active. Use /batchconvert cancel or /batchconvert done.');
        return;
      }
      clearConversionSession(ctx.session);
      await ctx.reply('Sticker conversion cancelled.');
      return;
    }
    if (action) {
      await ctx.reply('Usage: reply to a media message with /convert, or send /convert and then send one file. Use /convert cancel to cancel.');
      return;
    }
    if (ctx.session?.conversionMode === 'batch') {
      await ctx.reply('A batch is active. Use /batchconvert done or /batchconvert cancel before starting a single conversion.');
      return;
    }
    if (hasActiveGifSession(ctx.session)) {
      await ctx.reply('Finish the active /mode or /rescan session with /done before starting sticker conversion.');
      return;
    }

    const repliedMessage = ctx.message?.reply_to_message;
    if (repliedMessage) {
      const source = getStickerSource(repliedMessage);
      if (!source) {
        await ctx.reply('The message you replied to does not contain a supported image, GIF, video, or sticker. Use /supported for formats.');
        return;
      }
      clearConversionSession(ctx.session);
      await convertStickerMedia(ctx, source, repliedMessage.message_id);
      return;
    }

    clearConversionSession(ctx.session);
    if (ctx.session) ctx.session.conversionMode = 'single';
    await ctx.reply('Send one image, GIF, video, or sticker now. I’ll convert only that file. Use /convert cancel to stop.');
  });

  bot.command('batchconvert', async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.reply('Use /batchconvert in a private chat with the bot.');
      return;
    }
    if (!(await isBotAdmin(ctx.from?.id))) {
      await ctx.reply('❌ Sticker conversion tools are available to bot admins only.');
      return;
    }

    const action = (ctx.match?.trim() ?? '').toLowerCase();
    if (action === 'done' || action === 'finish') {
      if (ctx.session?.conversionMode !== 'batch') {
        await ctx.reply('There is no active sticker conversion batch. Start one with /batchconvert.');
        return;
      }
      const summary = buildBatchSummary(ctx.session);
      clearConversionSession(ctx.session);
      await ctx.reply(`✅ ${summary}`);
      return;
    }
    if (action === 'cancel') {
      if (ctx.session?.conversionMode !== 'batch') {
        await ctx.reply('There is no active sticker conversion batch.');
        return;
      }
      const summary = buildBatchSummary(ctx.session);
      clearConversionSession(ctx.session);
      await ctx.reply(`Sticker conversion batch cancelled. ${summary}`);
      return;
    }
    if (action) {
      await ctx.reply('Usage: /batchconvert to start, /batchconvert done to finish, or /batchconvert cancel to stop early.');
      return;
    }
    if (ctx.session?.conversionMode === 'single') {
      await ctx.reply('A single conversion is waiting for a file. Send it, or use /convert cancel before starting a batch.');
      return;
    }

    if (hasActiveGifSession(ctx.session)) {
      await ctx.reply('Finish the active /mode or /rescan session with /done before starting sticker conversion.');
      return;
    }

    if (ctx.session?.conversionMode === 'batch') {
      await ctx.reply('A sticker conversion batch is already active. Send more files, then use /batchconvert done when finished.');
      return;
    }
    clearConversionSession(ctx.session);
    if (ctx.session) {
      ctx.session.conversionMode = 'batch';
      ctx.session.conversionTotal = 0;
      ctx.session.conversionConverted = 0;
      ctx.session.conversionAlreadyReady = 0;
      ctx.session.conversionFailed = 0;
    }
    await ctx.reply('Sticker conversion batch started. Send supported media one by one and wait for each result. I’ll process files only until you send /batchconvert done. Use /batchconvert cancel to stop.');
  });

  bot.on(['message:photo', 'message:document', 'message:animation', 'message:video', 'message:sticker'], async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    const mode = ctx.session?.conversionMode;
    if (!mode) return;
    if (!(await isBotAdmin(ctx.from?.id))) {
      clearConversionSession(ctx.session);
      await ctx.reply('❌ Sticker conversion tools are available to bot admins only.');
      return;
    }

    const source = getStickerSource(ctx.message);
    if (!source) {
      await countConversionOutcome(ctx.session, 'failed');
      if (mode === 'single') clearConversionSession(ctx.session);
      await ctx.reply('I could not identify a supported media file. Send /supported for the format list.');
      return;
    }
    const outcome = await convertStickerMedia(ctx, source, ctx.msg.message_id);
    await countConversionOutcome(ctx.session, outcome);
    if (mode === 'single') clearConversionSession(ctx.session);
  });

  bot.on('message:text', async (ctx) => {
    if (ctx.chat?.type !== 'private' || ctx.message.text.startsWith('/')) return;
    const mode = ctx.session?.conversionMode;
    if (!mode) return;
    if (!(await isBotAdmin(ctx.from?.id))) return;
    await ctx.reply(
      mode === 'single'
        ? 'I’m waiting for one supported media file. Send a file or use /convert cancel.'
        : 'I’m waiting for the next supported media file. Continue sending files or use /batchconvert done to finish.',
      { reply_parameters: { message_id: ctx.message.message_id } },
    );
  });
}

type ConversionOutcome = 'converted' | 'already-ready' | 'failed';

async function convertStickerMedia(ctx: Context, source: StickerSource, sourceMessageId: number): Promise<ConversionOutcome> {
  if (source.fileSize !== undefined && source.fileSize > MAX_STICKER_INPUT_BYTES) {
    await ctx.reply('❌ This file is too large to convert. The maximum input size is 20 MB.', {
      reply_parameters: { message_id: sourceMessageId },
    });
    return 'failed';
  }
  if (source.kind === 'sticker') {
    await ctx.reply('✅ This is already a Telegram sticker. No conversion is needed; forward the original sticker to @Stickers.', {
      reply_parameters: { message_id: sourceMessageId },
    });
    return 'already-ready';
  }

  const status = await ctx.api.sendMessage(ctx.chat!.id, '⏳ Checking the media and preparing a Telegram sticker file…', {
    reply_parameters: { message_id: sourceMessageId },
  });
  let tempDir: string | undefined;
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'sticker-convert-'));
    const inputPath = join(tempDir, `input${extensionOf(source.fileName)}`);
    const input = await downloadTelegramFile(ctx, source.fileId, source.fileSize);
    await writeFile(inputPath, input);
    const result = await convertForTelegramSticker(inputPath, source.fileName, input.length, source.kind);
    if (result.alreadySuitable) {
      await editStatus(ctx, status.message_id, '✅ This media already meets Telegram’s sticker file requirements. No converted file was needed; forward the original media to @Stickers.', 'sticker-convert:already-suitable');
      return 'already-ready';
    }
    if (!result.buffer || !result.filename || !result.format) {
      throw new Error('Conversion returned no output file.');
    }

    await ctx.api.sendDocument(
      ctx.chat!.id,
      new InputFile(result.buffer, result.filename),
      {
        caption: result.format === 'video'
          ? '✅ Video sticker file is ready. Forward this file to @Stickers to add it to a pack. Video sticker output uses up to the first 3 seconds.'
          : '✅ Static sticker file is ready. Forward this file to @Stickers to add it to a pack.',
        reply_parameters: { message_id: sourceMessageId },
      },
    );
    await ctx.api.deleteMessage(ctx.chat!.id, status.message_id)
      .catch((err) => logSafeError('sticker-convert:status-cleanup', err));
    return 'converted';
  } catch (err) {
    logSafeError('sticker-convert', err);
    const message = err instanceof StickerConversionError
      ? `❌ ${err.message}`
      : '❌ I could not convert this media. Try a supported, smaller file or another format.';
    await editStatus(ctx, status.message_id, message, 'sticker-convert:error');
    return 'failed';
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
        .catch((err) => logSafeError('sticker-convert:cleanup', err));
    }
  }
}

async function countConversionOutcome(session: StickerSession | undefined, outcome: ConversionOutcome): Promise<void> {
  if (!session || session.conversionMode !== 'batch') return;
  session.conversionTotal = (session.conversionTotal ?? 0) + 1;
  if (outcome === 'converted') session.conversionConverted = (session.conversionConverted ?? 0) + 1;
  else if (outcome === 'already-ready') session.conversionAlreadyReady = (session.conversionAlreadyReady ?? 0) + 1;
  else session.conversionFailed = (session.conversionFailed ?? 0) + 1;
}

function clearConversionSession(session: StickerSession | undefined): void {
  if (!session) return;
  session.conversionMode = undefined;
  session.conversionTotal = undefined;
  session.conversionConverted = undefined;
  session.conversionAlreadyReady = undefined;
  session.conversionFailed = undefined;
}

function buildBatchSummary(session: StickerSession): string {
  const total = session.conversionTotal ?? 0;
  return `Batch finished: ${total} file(s) processed — ${session.conversionConverted ?? 0} converted, ` +
    `${session.conversionAlreadyReady ?? 0} already ready, ${session.conversionFailed ?? 0} failed or unsupported.`;
}

function hasActiveGifSession(session: StickerSession | undefined): boolean {
  return Boolean(session?.activeExpression || session?.activeExpressions?.length || session?.rescanActive);
}

function getStickerSource(message: Message | undefined): StickerSource | null {
  if (!message) return null;
  if (message.sticker) {
    return {
      fileId: message.sticker.file_id,
      fileName: message.sticker.is_video ? 'sticker.webm' : message.sticker.is_animated ? 'sticker.tgs' : 'sticker.webp',
      fileSize: message.sticker.file_size,
      kind: 'sticker',
    };
  }
  if (message.photo?.length) {
    const photo = message.photo.reduce((largest, item) => (item.file_size ?? 0) > (largest.file_size ?? 0) ? item : largest);
    return { fileId: photo.file_id, fileName: 'photo.jpg', mimeType: 'image/jpeg', fileSize: photo.file_size, kind: 'image' };
  }
  if (message.animation) {
    return { fileId: message.animation.file_id, fileName: message.animation.file_name ?? 'animation.mp4', mimeType: message.animation.mime_type, fileSize: message.animation.file_size, kind: 'video' };
  }
  if (message.video) {
    return { fileId: message.video.file_id, fileName: message.video.file_name ?? 'video.mp4', mimeType: message.video.mime_type, fileSize: message.video.file_size, kind: 'video' };
  }
  if (message.document) {
    const kind = classifyStickerDocument(message.document.file_name ?? '', message.document.mime_type);
    if (!kind) return null;
    return {
      fileId: message.document.file_id,
      fileName: message.document.file_name ?? `media${extensionForMime(message.document.mime_type)}`,
      mimeType: message.document.mime_type,
      fileSize: message.document.file_size,
      kind,
    };
  }
  return null;
}

async function downloadTelegramFile(ctx: Context, fileId: string, knownSize?: number): Promise<Buffer> {
  if (knownSize !== undefined && knownSize > MAX_STICKER_INPUT_BYTES) {
    throw new StickerConversionError('This file is too large to convert. The maximum input size is 20 MB.');
  }
  const fileInfo = await ctx.api.getFile(fileId);
  if (!fileInfo.file_path) throw new StickerConversionError('Telegram did not provide a downloadable file path.');
  if (fileInfo.file_size !== undefined && fileInfo.file_size > MAX_STICKER_INPUT_BYTES) {
    throw new StickerConversionError('This file is too large to convert. The maximum input size is 20 MB.');
  }

  const token = loadConfig().BOT_TOKEN;
  const url = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new StickerConversionError(`Telegram file download failed (HTTP ${response.status}).`);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_STICKER_INPUT_BYTES) {
    throw new StickerConversionError('This file is too large to convert. The maximum input size is 20 MB.');
  }
  if (!response.body) throw new StickerConversionError('Telegram returned an empty file.');

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_STICKER_INPUT_BYTES) {
        await reader.cancel();
        throw new StickerConversionError('This file is too large to convert. The maximum input size is 20 MB.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function editStatus<C extends Context>(ctx: C, messageId: number, text: string, logLabel: string): Promise<void> {
  try {
    await ctx.api.editMessageText(ctx.chat!.id, messageId, text, { link_preview_options: { is_disabled: true } });
  } catch (err) {
    logSafeError(logLabel, err);
    await ctx.reply(text, { reply_parameters: { message_id: messageId } })
      .catch((replyError) => logSafeError(`${logLabel}:reply`, replyError));
  }
}

function extensionOf(filename: string): string {
  const match = filename.toLowerCase().match(/\.[a-z0-9]{1,8}$/);
  return match?.[0] ?? '';
}

function extensionForMime(mimeType?: string): string {
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'image/svg+xml') return '.svg';
  if (mimeType === 'image/tiff') return '.tiff';
  if (mimeType?.startsWith('image/')) return '.jpg';
  if (mimeType === 'video/webm') return '.webm';
  if (mimeType?.startsWith('video/')) return '.mp4';
  return '.bin';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
