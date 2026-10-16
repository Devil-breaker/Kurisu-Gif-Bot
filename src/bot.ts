import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Context } from 'grammy';
import { Bot, session } from 'grammy';


/** Sessions live in the configured database so polling and webhook instances share state. */
async function flushSession(key: string, sess: BotContext['session']): Promise<void> {
  if (sess === undefined) {
    await getDb().execute({ sql: 'DELETE FROM bot_sessions WHERE session_key = ?', args: [key] });
  } else {
    await getDb().execute({
      sql: `INSERT INTO bot_sessions (session_key, session_json) VALUES (?, ?)
            ON CONFLICT(session_key) DO UPDATE SET session_json = excluded.session_json,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      args: [key, JSON.stringify(sess)],
    });
  }
}

async function loadSession(key: string): Promise<BotContext['session'] | undefined> {
  const result = await getDb().execute({
    sql: 'SELECT session_json FROM bot_sessions WHERE session_key = ?',
    args: [key],
  });
  const raw = result.rows[0]?.session_json;
  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(raw) as BotContext['session'];
  } catch {
    await flushSession(key, undefined);
    return undefined;
  }
}

async function deleteSession(key: string): Promise<void> {
  await flushSession(key, undefined);
}

/** Simple async sleep for rate-limiting delays */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
import {
  getExpressionByAlias,
  getExpressionByName,
  listExpressions,
  createExpression,
  deleteExpression,
  updateCaptionTemplate,
  getMediaByFileUniqueId,
  markMediaLewdInChat,
  unmarkMediaLewdInChat,
  countChatLewdMedia,
  getChatLewdMediaPage,
  insertMedia,
  setMediaChannelMsgId,
  setMediaChannelMsgIdIfMissing,
  linkMediaToExpression,
  getRandomMediaForExpression,
  incrementUsage,
  getMediaStats,
  getAvailableExpressionNames,
  deleteMediaById,
  unlinkMediaFromExpression,
  isAdmin,
  addAdmin,
  removeAdmin,
  listAdmins,
  resolveChannelExpression,
  getChatSettings,
  upsertChatSettings,
  toggleExpressionLewd,
  findVisualDuplicate,
  mergeMedia,
  setMediaPhash,
  setMediaLewd,
} from './db/queries.js';
import { getDb } from './db/client.js';
import { loadConfig } from './config.js';
import { reverseSearch } from './services/sauce.js';
import { registerStickerFeatures, type StickerSession } from './stickers/register.js';
import { computePhash, hammingDistance } from './services/phash.js';
import { logSafeError, safeErrorSummary } from './services/safe-log.js';
import { TELEGRAM_CAPTION_LIMIT, clampVisible, formatCaption } from './services/caption.js';
import {
  buildAdminsMessage,
  buildBotAdminPanel,
  buildExpressionListMessage,
  buildGroupAdminPanel,
  buildLewdCommandsPanel,
  buildLocksMessage,
  buildMainMenuMessage,
  buildSauceCaption,
  buildSauceKeyboard,
  buildStartMessage,
  buildStatsMessage,
  buildStatsMessageText,
  buildUserCommandsPanel,
  quoteMenuText,
  CALLBACK_DATA,
  type BuiltMessage,
} from './services/messages.js';
import type { Expression } from './types/index.js';

interface UploadSessionItem {
  channelMsgId: number;
  mediaId: number | null;
  deleteMediaOnRemove: boolean;
  duplicateOfChannelMsgId?: number;
  expressionIds?: number[];
  expressionIdsAdded?: number[];
}

interface BotContext extends Context {
  session?: {
    activeExpression?: string;
    activeExpressions?: string[];
    rescanActive?: boolean;
    rescanMode?: 'index' | 'relink';
    rescannedCount?: number;
    uploadedCount?: number;
    skippedDuplicateCount?: number;
    duplicateTagCount?: number;
    uploadedItems?: UploadSessionItem[];
  } & StickerSession;
}

/** Undo only library records and expression links introduced by removed uploads. */
async function cleanupRemovedUploadItems(
  removedItems: UploadSessionItem[],
  remainingItems: UploadSessionItem[],
): Promise<void> {
  const mediaIds = new Set(removedItems.map((item) => item.mediaId).filter((id): id is number => id !== null));
  for (const mediaId of mediaIds) {
    const removed = removedItems.filter((item) => item.mediaId === mediaId);
    const remaining = remainingItems.filter((item) => item.mediaId === mediaId);
    if (remaining.length === 0 && removed.some((item) => item.deleteMediaOnRemove)) {
      await deleteMediaById(mediaId).catch((err) => {
        logSafeError('remove:database-cleanup', err);
      });
      continue;
    }

    // If the original post that created this media row was removed, point the
    // row at another surviving copy from this upload session.
    if (remaining.length > 0 && removed.some((item) => item.deleteMediaOnRemove)) {
      await setMediaChannelMsgId(mediaId, remaining[0].channelMsgId).catch((err) => {
        logSafeError('remove:relink', err);
      });
    }

    const addedExpressionIds = new Set(removed.flatMap((item) => item.expressionIdsAdded ?? []));
    for (const expressionId of addedExpressionIds) {
      const stillUsed = remaining.some((item) => item.expressionIds?.includes(expressionId));
      if (!stillUsed) {
        await unlinkMediaFromExpression(mediaId, expressionId).catch((err) => {
          logSafeError('remove:expression-rollback', err);
        });
      }
    }
  }
}

/** Bot process start time for uptime calculation */
const PROCESS_START_TIME = Date.now();

/** Format milliseconds to human-readable uptime string */
function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function logApiError(label: string, err: unknown, _extra: Record<string, unknown> = {}): void {
  // Grammy errors can contain the Bot instance and update context. Avoid logging
  // payload text, Context, request URLs, or arbitrary nested error objects.
  logSafeError(label, err);
}

/** Download a file from Telegram servers to a Buffer. */
async function downloadTelegramFile(ctx: Context, fileId: string): Promise<Buffer> {
  const config = loadConfig();
  const fileInfo = await ctx.api.getFile(fileId);
  if (!fileInfo.file_path) {
    throw new Error('Could not retrieve file path from Telegram');
  }

  // Contains the bot token: never log it and never put it in a message.
  const downloadUrl = `https://api.telegram.org/file/bot${config.BOT_TOKEN}/${fileInfo.file_path}`;
  const fileRes = await fetch(downloadUrl, { signal: AbortSignal.timeout(20_000) });
  if (!fileRes.ok) {
    throw new Error(`Failed to download file from Telegram: ${fileRes.status} ${fileRes.statusText}`);
  }

  return Buffer.from(await fileRes.arrayBuffer());
}

async function computeTelegramFilePhash(ctx: Context, fileId: string): Promise<string | null> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'phash-'));
  try {
    const tmpPath = join(tmpDir, 'file.bin');
    await writeFile(tmpPath, await downloadTelegramFile(ctx, fileId));
    return await computePhash(tmpPath);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Build Telegram's intentionally small slash menu. Other handlers remain usable directly. */
export function buildBotCommands(): Array<{ command: string; description: string }> {
  return [
    { command: 'start', description: 'Start the bot & show help' },
    { command: 'help', description: 'Show this help message' },
    { command: 'ping', description: 'Check bot uptime and latency' },
    { command: 'sauce', description: 'Reverse search a replied image, GIF, video, or sticker' },
    { command: 'listexpressions', description: 'List all available expressions' },
  ];
}

// Telegram command tokens only allow this character set. Expression names use
// the same validation even though expressions are no longer in the slash menu.
const VALID_BOT_COMMAND = /^[a-z0-9_]{1,32}$/;

/**
 * Whether the sender is the bot owner (full access).
 */
async function isBotOwner(userId: number | undefined): Promise<boolean> {
  if (!userId) return false;
  const config = loadConfig();
  return config.BOT_OWNER_ID === userId;
}

/**
 * Whether a user is a bot admin.
 * Bot owner always has admin access.
 *
 * ADMIN_IDS is checked first and on purpose: those holders are not rows in the
 * admins table, so a DB-only check locks a fresh deployment out of every admin
 * command — including /addadmin, the one that would let someone in.
 */
async function isBotAdmin(userId: number | undefined): Promise<boolean> {
  if (!userId) return false;
  if (await isBotOwner(userId)) return true;
  if (loadConfig().ADMIN_IDS.includes(userId)) return true;
  return isAdmin(userId);
}

/**
 * Whether the sender may manage per-chat settings (lock, bluetext, lewd mode)
 * in this chat: group admins/owners always can; bot admins can everywhere.
 */
async function canManageChat(ctx: Context): Promise<boolean> {
  if (!ctx.from) return false;
  const chatType = ctx.chat?.type;
  if (chatType === 'private') return true; // users manage their own PM settings
  if (chatType !== 'group' && chatType !== 'supergroup') return false;
  try {
    const member = await ctx.getChatMember(ctx.from.id);
    if (member.status === 'administrator' || member.status === 'creator') return true;
  } catch (err) {
    logApiError('canManageChat', err, { chat_id: ctx.chat?.id, user_id: ctx.from.id });
    // Fall through to bot-admin check
  }
  return isBotAdmin(ctx.from.id);
}

/**
 * Send one of the built HTML messages.
 *
 * Centralised so that a message the length cap truncated is always logged:
 * silently dropping the tail of /help as expressions are added is exactly the
 * kind of thing nobody notices until someone asks why a command is missing.
 */
async function sendHtml(ctx: Context, label: string, built: BuiltMessage, quoted = false): Promise<void> {
  if (built.dropped > 0) {
    console.warn(
      `[${label}] Message hit Telegram's length cap; ${built.dropped} line(s) dropped`,
    );
  }
  await ctx.reply(quoted ? quoteMenuText(built.text) : built.text, { parse_mode: 'HTML' });
}

interface DedupeRow {
  id: number;
  phash: string;
  usage_count: number;
  channel_msg_id: number | null;
}

function findVisualDuplicateGroups(rows: DedupeRow[]): number[][] {
  const parent = new Map<number, number>();
  const find = (id: number): number => {
    if (!parent.has(id)) parent.set(id, id);
    if (parent.get(id) !== id) parent.set(id, find(parent.get(id)!));
    return parent.get(id)!;
  };

  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const distance = hammingDistance(rows[i].phash, rows[j].phash);
      if (distance >= 0 && distance <= 8) {
        const left = find(rows[i].id);
        const right = find(rows[j].id);
        if (left !== right) parent.set(left, right);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (const row of rows) {
    const root = find(row.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(row.id);
  }

  return [...groups.values()]
    .filter((ids) => ids.length > 1)
    .map((ids) => ids.sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0]);
}

/** Create bot instance and configure middleware */
export function createBot() {
  const config = loadConfig();
  const bot = new Bot<BotContext>(config.BOT_TOKEN);

  // ---- Session middleware (database-backed for polling and serverless runtimes) ----
  const storage = {
    read: loadSession,
    write: flushSession,
    delete: deleteSession,
  } as any;
  bot.use(session({
    initial: (): BotContext['session'] => ({}),
    storage,
    getSessionKey: (ctx) => {
      if (ctx.chat?.type !== 'private' || !ctx.from) return undefined;
      return `${ctx.chat.id}:${ctx.from.id}`;
    },
  }) as any);

  // ---- Error handling ----
  bot.catch((err) => {
    const ctx = err.ctx;
    logApiError('unhandled', err.error);
    if (ctx.chat) {
      ctx.reply(
        '❌ An internal error occurred. The admins have been notified.',
      ).catch((replyErr) => logApiError('unhandled:reply', replyErr));
    }
  });

  // ---- Command: /start & /help ----
  bot.command(['start', 'help'], async (ctx) => {
    const isAdminUser = await isBotAdmin(ctx.from?.id);
    const isOwnerUser = await isBotOwner(ctx.from?.id);
    const isStart = ctx.message?.text?.split(/\s+/)[0]?.split('@')[0] === '/start';
    const built = isStart ? buildStartMessage(isAdminUser, isOwnerUser) : buildMainMenuMessage();
    const keyboardRows: Array<Array<{ text: string; callback_data: string }>> = isStart
      ? [[{ text: '📖 Help Menu', callback_data: CALLBACK_DATA.HELP_MENU }]]
      : [
          [{ text: '👤 User Commands', callback_data: CALLBACK_DATA.USER_COMMANDS }],
          ...((isAdminUser || isOwnerUser)
            ? [[{ text: '⚙️ Bot Admin Panel', callback_data: CALLBACK_DATA.BOT_ADMIN }]]
            : []),
          [{ text: '👥 Group Admin Panel', callback_data: CALLBACK_DATA.GROUP_ADMIN }],
          [{ text: '📊 Stats', callback_data: CALLBACK_DATA.STATS }],
        ];

    await ctx.reply(quoteMenuText(built.text), {
      parse_mode: 'HTML' as const,
      reply_markup: { inline_keyboard: keyboardRows },
    });
  });

  // ---- Callback query handler for menu navigation ----
  bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery?.data;
    if (!data) return;

    const groupLewdMatch = data.match(/^group_lewd:(prev|next|safe):(\d+)(?::(\d+))?$/);
    if (groupLewdMatch) {
      const chatId = ctx.chat?.id;
      const messageId = ctx.callbackQuery.message?.message_id;
      const chatType = ctx.chat?.type;
      if (!chatId || !messageId || (chatType !== 'group' && chatType !== 'supergroup')) {
        await ctx.answerCallbackQuery({ text: 'This control only works in its group.', show_alert: true });
        return;
      }
      if (!(await canManageChat(ctx))) {
        await ctx.answerCallbackQuery({ text: 'Only group admins can manage these GIFs.', show_alert: true });
        return;
      }

      const action = groupLewdMatch[1];
      const page = Number(groupLewdMatch[2]);
      const mediaId = groupLewdMatch[3] ? Number(groupLewdMatch[3]) : undefined;
      if (action === 'safe' && mediaId !== undefined) {
        await unmarkMediaLewdInChat(chatId, mediaId);
        await ctx.answerCallbackQuery({ text: 'Marked safe in this group.' });
      } else {
        await ctx.answerCallbackQuery();
      }

      const count = await countChatLewdMedia(chatId);
      if (count === 0) {
        await ctx.api.editMessageCaption(chatId, messageId, {
          caption: '✅ No GIFs are currently hidden in this group.',
          reply_markup: { inline_keyboard: [] },
        }).catch((err) => logApiError('group-lewd-browser:empty', err));
        return;
      }

      const requestedPage = action === 'next' ? page + 1 : action === 'prev' ? page - 1 : page;
      const currentPage = Math.max(0, Math.min(requestedPage, count - 1));
      const [media] = await getChatLewdMediaPage(chatId, currentPage, 1);
      if (!media) return;
      const rows: Array<Array<{ text: string; callback_data: string }>> = [];
      const navigation: Array<{ text: string; callback_data: string }> = [];
      if (currentPage > 0) navigation.push({ text: '◀️ Previous', callback_data: `group_lewd:prev:${currentPage}` });
      if (currentPage < count - 1) navigation.push({ text: 'Next ▶️', callback_data: `group_lewd:next:${currentPage}` });
      if (navigation.length) rows.push(navigation);
      rows.push([{ text: '✅ Mark safe in this group', callback_data: `group_lewd:safe:${currentPage}:${media.id}` }]);
      await ctx.api.editMessageMedia(chatId, messageId, {
        type: 'animation',
        media: media.file_id,
        caption: `🔞 <b>Hidden in this group</b> · ${currentPage + 1} of ${count}\nLewd Mode off filters this GIF from reactions.`,
        parse_mode: 'HTML',
      }, { reply_markup: { inline_keyboard: rows } }).catch((err) => logApiError('group-lewd-browser:edit', err));
      return;
    }

    const isAdminUser = await isBotAdmin(ctx.from?.id);
    const isOwnerUser = await isBotOwner(ctx.from?.id);
    const expressions = await listExpressions();
    const hasLewd = expressions.some((e) => e.is_lewd);

    type InlineKeyboard = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };

    let text: string;
    let replyMarkup: InlineKeyboard;

    switch (data) {
      case CALLBACK_DATA.USER_COMMANDS: {
        const userRows: Array<Array<{ text: string; callback_data: string }>> = [
          [{ text: '◀️ Back to Menu', callback_data: CALLBACK_DATA.BACK_TO_MENU }],
        ];
        if (hasLewd) {
          userRows.unshift([{ text: '🔞 Lewd Commands', callback_data: CALLBACK_DATA.LEWD_COMMANDS }]);
        }
        replyMarkup = { inline_keyboard: userRows };
        text = buildUserCommandsPanel(expressions).text;
        break;
      }

      case CALLBACK_DATA.BOT_ADMIN:
        text = isAdminUser || isOwnerUser
          ? buildBotAdminPanel(isOwnerUser).text
          : '⛔ <b>Access Denied</b>\n\nYou need bot admin privileges to view this panel.';
        replyMarkup = {
          inline_keyboard: [
            [{ text: '◀️ Back to Menu', callback_data: CALLBACK_DATA.BACK_TO_MENU }],
          ],
        };
        break;

      case CALLBACK_DATA.GROUP_ADMIN:
        text = buildGroupAdminPanel().text;
        replyMarkup = {
          inline_keyboard: [
            [{ text: '◀️ Back to Menu', callback_data: CALLBACK_DATA.BACK_TO_MENU }],
          ],
        };
        break;

      case CALLBACK_DATA.STATS: {
        const stats = await getMediaStats();
        text = stats.length > 0
          ? buildStatsMessageText(stats)
          : '📊 <b>Usage Statistics</b>\n\nNo GIFs have been used yet.';
        replyMarkup = {
          inline_keyboard: [
            [{ text: '◀️ Back to Menu', callback_data: CALLBACK_DATA.BACK_TO_MENU }],
          ],
        };
        break;
      }

      case CALLBACK_DATA.LEWD_COMMANDS:
        text = buildLewdCommandsPanel(expressions).text;
        replyMarkup = {
          inline_keyboard: [
            [{ text: '◀️ Back to User Commands', callback_data: CALLBACK_DATA.USER_COMMANDS }],
          ],
        };
        break;

      case CALLBACK_DATA.BACK_TO_MENU:
      case CALLBACK_DATA.HELP_MENU:
      default: {
        text = buildMainMenuMessage().text;
        const menuRows: Array<Array<{ text: string; callback_data: string }>> = [
          [{ text: '👤 User Commands', callback_data: CALLBACK_DATA.USER_COMMANDS }],
        ];
        if (isAdminUser || isOwnerUser) {
          menuRows.push([{ text: '⚙️ Bot Admin Panel', callback_data: CALLBACK_DATA.BOT_ADMIN }]);
        }
        menuRows.push([{ text: '👥 Group Admin Panel', callback_data: CALLBACK_DATA.GROUP_ADMIN }]);
        menuRows.push([{ text: '📊 Stats', callback_data: CALLBACK_DATA.STATS }]);
        replyMarkup = { inline_keyboard: menuRows };
        break;
      }
    }

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(quoteMenuText(text), {
      parse_mode: 'HTML' as const,
      reply_markup: replyMarkup,
    });
  });

  // ---- Command: /listexpressions ----
  bot.command('listexpressions', async (ctx) => {
    const expressions = await listExpressions();
    if (expressions.length === 0) {
      await ctx.reply('No expressions configured.');
      return;
    }
    await sendHtml(ctx, 'listexpressions', buildExpressionListMessage(expressions), true);
  });

  // ---- Command: /stats ----
  bot.command('stats', async (ctx) => {
    const stats = await getMediaStats();
    if (stats.length === 0) {
      await ctx.reply('No media uploaded yet.');
      return;
    }
    await sendHtml(ctx, 'stats', buildStatsMessage(stats));
  });

  // ---- Command: /ping ----
  bot.command('ping', async (ctx) => {
    const start = Date.now();
    // Send immediately so database checks do not delay the basic response.
    const pongMsg = await ctx.reply('🏓 Pong!').catch(() => null);
    const responseLatency = Date.now() - start;
    const uptime = formatUptime(Date.now() - PROCESS_START_TIME);
    let databaseStatus = '❌ Unavailable';
    try {
      const dbStart = Date.now();
      await getDb().execute('SELECT 1');
      databaseStatus = `✅ Connected (${Date.now() - dbStart} ms)`;
    } catch (err) {
      logApiError('ping:database', err);
    }
    const runtime = process.env.VERCEL === '1' ? 'Vercel function instance' : 'Polling process';

    const response = [
      '🏓 <b>Pong!</b>',
      '',
      '🟢 <b>Status:</b> Online',
      `⚡ <b>Telegram response:</b> ${responseLatency} ms`,
      `🗄 <b>Database:</b> ${databaseStatus}`,
      `⏱ <b>${runtime} uptime:</b> ${uptime}`,
    ].join('\n');

    if (pongMsg) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        pongMsg.message_id,
        response,
        { parse_mode: 'HTML' as const },
      ).catch(() => {
        // If edit fails (e.g., message too old), send new message
        ctx.reply(response, { parse_mode: 'HTML' as const }).catch(() => {});
      });
    } else {
      await ctx.reply(response, { parse_mode: 'HTML' as const }).catch(() => {});
    }
  });

  // ---- Admin: add expression ----
  bot.command('addexpression', async (ctx) => {
    if (!(await isBotAdmin(ctx.from?.id))) {
      await ctx.reply('❌ Only admins can add expressions.');
      return;
    }
    const text = ctx.match?.trim() ?? '';
    if (!text) {
      await ctx.reply(
        'Usage: /addexpression <name> [alias1,alias2,...] [-u|--uni]\n' +
        'Add -u or --uni for unidirectional expressions (smile, wave, stare …)\n' +
        'Example: /addexpression hug hugs cuddle\n' +
        'Example: /addexpression smile smiles -u',
      );
      return;
    }

    // Split on whitespace, but treat -u/--uni as its own token
    const tokens = text.split(/\s+/);
    const directionFlag = tokens[tokens.length - 1];
    const isUnidirectional =
      directionFlag === '-u' || directionFlag === '--uni';

    const cleanTokens = isUnidirectional ? tokens.slice(0, -1) : tokens;
    const name = cleanTokens[0]?.toLowerCase() ?? '';
    const aliases = cleanTokens.slice(1).map((a) => a.toLowerCase());

    if (!name) {
      await ctx.reply('Usage: /addexpression <name> [alias1,alias2,...] [-u|--uni]');
      return;
    }

    // Rejected here rather than at setMyCommands, which fails for the whole
    // menu rather than for the one bad name: "high-five" is the usual case.
    const invalid = [name, ...aliases].filter((n) => !VALID_BOT_COMMAND.test(n));
    if (invalid.length > 0) {
      await ctx.reply(
        `❌ Not usable as a command: ${invalid.join(', ')}\nUse 1-32 characters of a-z, 0-9 and _ (no dashes).`,
      );
      return;
    }

    try {
      await createExpression(name, aliases, undefined, isUnidirectional ? 'unidirectional' : 'bidirectional');
    } catch (err: any) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        await ctx.reply(`❌ Expression /${name} already exists.`);
      } else {
        logSafeError('addexpression', err);
        await ctx.reply('❌ Failed to add expression.');
      }
      return;
    }

    const dirNote = isUnidirectional
      ? ' (unidirectional — needs "at" in template or will auto-inject it)'
      : '';
    await ctx.reply(
      `✅ Expression /${name} added${aliases.length ? ` with aliases: ${aliases.join(', ')}` : ''}${dirNote}.`,
    );

  });

  // ---- Admin: delete expression ----
  bot.command('deleteexpression', async (ctx) => {
    if (!(await isBotAdmin(ctx.from?.id))) {
      await ctx.reply('❌ Only admins can delete expressions.');
      return;
    }
    const name = (ctx.match?.trim() ?? '').toLowerCase();
    if (!name) {
      await ctx.reply('Usage: /deleteexpression <name>');
      return;
    }
    const deleted = await deleteExpression(name);
    if (!deleted) {
      await ctx.reply(`❌ Expression /${name} not found.`);
      return;
    }
    await ctx.reply(`✅ Expression /${name} deleted.`);
  });

  // ---- Admin: update caption template ----
  bot.command('updatecaption', async (ctx) => {
    if (!(await isBotAdmin(ctx.from?.id))) {
      await ctx.reply('❌ Only admins can update caption templates.');
      return;
    }
    const match = ctx.match?.trim();
    if (!match) {
      await ctx.reply(
        'Usage: /updatecaption <expression> <caption template>\n' +
        'Placeholders: {from}, {to}, {action}\n' +
        'Examples:\n' +
        '/updatecaption hug {from} hugs {to}! 🤗\n' +
        '/updatecaption smile {from} smiles.',
      );
      return;
    }
    const split = match.split(/\s+/);
    const name = split[0].toLowerCase();
    const template = split.slice(1).join(' ');
    if (!template) {
      await ctx.reply('Please provide a caption template.');
      return;
    }
    const ok = await updateCaptionTemplate(name, template);
    if (ok) {
      await ctx.reply(`✅ Caption template for /${name} updated.`);
    } else {
      await ctx.reply(`❌ Expression /${name} not found.`);
    }
  });

  // ---- Admin: add admin ----
  bot.command('addadmin', async (ctx) => {
    if (!(await isBotAdmin(ctx.from?.id))) {
      await ctx.reply('❌ Only admins can add admins.');
      return;
    }
    const raw = ctx.match?.trim() ?? '';
    const repliedUser = ctx.message?.reply_to_message?.from;
    if (!raw && !repliedUser) {
      await ctx.reply('Usage: /addadmin <user_id> or reply to a user message with /addadmin.');
      return;
    }
    let userId: number;
    let username: string | null = raw ? null : repliedUser?.username ?? null;
    if (!raw && repliedUser) {
      if (repliedUser.is_bot) {
        await ctx.reply('❌ Bot accounts cannot be added as admins.');
        return;
      }
      userId = repliedUser.id;
    } else if (raw.startsWith('@')) {
      await ctx.reply('Telegram bots cannot resolve arbitrary usernames to user IDs. Use /addadmin <user_id> or reply to that user’s message with /addadmin.');
      return;
    } else {
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        await ctx.reply('❌ User ID must be a positive integer.');
        return;
      }
      userId = parsed;
    }
    try {
      await addAdmin(userId, username, ctx.from?.id ?? 0);
      await ctx.reply(`✅ User ${username ? `@${username}` : userId} added as admin.`);
    } catch (err) {
      logSafeError('addadmin', err);
      await ctx.reply('❌ Failed to add admin.');
    }
  });

  // ---- Admin: remove admin ----
  bot.command('rmadmin', async (ctx) => {
    if (!(await isBotAdmin(ctx.from?.id))) {
      await ctx.reply('❌ Only admins can remove admins.');
      return;
    }
    const raw = (ctx.match?.trim() ?? '');
    if (!raw) {
      await ctx.reply('Usage: /rmadmin <user_id>');
      return;
    }
    if (raw.startsWith('@')) {
      await ctx.reply('Please use numeric user ID, not @username, to remove an admin.');
      return;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      await ctx.reply('❌ User ID must be a positive integer.');
      return;
    }
    const userId = parsed;
    if (userId === (ctx.from?.id ?? 0)) {
      await ctx.reply('❌ You cannot remove yourself as admin.');
      return;
    }
    // removeAdmin only deletes a row, so for an ADMIN_IDS holder it would
    // report success and change nothing.
    if (loadConfig().ADMIN_IDS.includes(userId)) {
      await ctx.reply(
        `❌ User ${userId} is an admin via the ADMIN_IDS environment variable. Remove them there and restart the bot.`,
      );
      return;
    }
    try {
      const removed = await removeAdmin(userId);
      if (removed) {
        await ctx.reply(`✅ User ${userId} removed from admins.`);
      } else {
        await ctx.reply(`❌ User ${userId} was not an admin.`);
      }
    } catch (err) {
      logSafeError('rmadmin', err);
      await ctx.reply('❌ Failed to remove admin.');
    }
  });

  // ---- Admin: list admins ----
  bot.command('admins', async (ctx) => {
    if (!(await isBotAdmin(ctx.from?.id))) {
      await ctx.reply('❌ Only admins can view the admin list.');
      return;
    }
    const admins = await listAdmins();
    const envAdminIds = loadConfig().ADMIN_IDS;
    if (admins.length === 0 && envAdminIds.length === 0) {
      await ctx.reply('No admins found.');
      return;
    }
    await sendHtml(ctx, 'admins', buildAdminsMessage(admins, envAdminIds));
  });

  // ---- Admin: set mode (one or more expressions for caption-free uploads) ----
  bot.command('mode', async (ctx) => {
    if (!(await isBotAdmin(ctx.from?.id))) {
      await ctx.reply('❌ Only admins can use /mode.');
      return;
    }
    if (ctx.session?.conversionMode) {
      await ctx.reply('Finish sticker conversion first with /convert cancel or /batchconvert done.');
      return;
    }
    const requestedNames = (ctx.match?.trim() ?? '')
      .split(/[\s,]+/)
      .map((name) => name.replace(/^#/, '').toLowerCase())
      .filter(Boolean);
    if (requestedNames.length === 0) {
      await ctx.reply('Usage: /mode <expression> [expression ...]\nExample: /mode hug kiss');
      return;
    }
    if (requestedNames.includes('lewd')) {
      await ctx.reply('Use #lewd in an individual GIF caption to mark that upload as lewd. /mode accepts expression names only.');
      return;
    }
    const expressions = new Map<string, Expression>();
    const unknown: string[] = [];
    for (const name of requestedNames) {
      const expression = await getExpressionByName(name);
      if (expression) expressions.set(expression.name, expression);
      else unknown.push(name);
    }
    if (unknown.length > 0) {
      await ctx.reply(`❌ Unknown expression${unknown.length === 1 ? '' : 's'}: ${unknown.map((name) => `/${name}`).join(', ')}.`);
      return;
    }
    const activeExpressions = [...expressions.values()];
    const activeNames = activeExpressions.map((expression) => expression.name);
    ctx.session!.activeExpressions = activeNames;
    ctx.session!.activeExpression = activeNames[0];
    await ctx.reply(
      `✅ Active expressions set to ${activeNames.map((name) => `/${name}`).join(', ')}. Each GIF you upload will be tagged with all of them.\n\n` +
      `💬 Each reaction command keeps its own caption template, even when a GIF has many tags. Admins can edit any with /updatecaption &lt;expression&gt; &lt;template&gt; (placeholders: {from}, {to}, {action}).\n` +
      `💡 <b>Tips:</b> Upload in batches (5–10 at a time) with a short pause between batches to avoid rate limiting. ` +
      `To remove a mistaken upload, send /remove to see the numbered list, then /remove &lt;number&gt;. Send /done when finished.`,
      { parse_mode: 'HTML' },
    );
  });

  // ---- Admin: signal done uploading ----
  bot.command('done', async (ctx) => {
    if (!(await isBotAdmin(ctx.from?.id))) return;
    if (ctx.session?.conversionMode) {
      await ctx.reply('Use /convert cancel or /batchconvert done to finish sticker conversion.');
      return;
    }
    const wasRescan = ctx.session?.rescanActive ?? false;
    const rescannedCount = ctx.session?.rescannedCount ?? 0;
    const duplicateCount = wasRescan ? (ctx.session?.uploadedItems?.length ?? 0) : 0;
    const count = ctx.session?.uploadedCount ?? 0;
    const skippedDuplicateCount = ctx.session?.skippedDuplicateCount ?? 0;
    const duplicateTagCount = ctx.session?.duplicateTagCount ?? 0;
    const expressions = ctx.session?.activeExpressions ?? (ctx.session?.activeExpression ? [ctx.session.activeExpression] : []);
    // Clear the active expression from session and delete the session entry
    if (ctx.session) {
      ctx.session.activeExpression = undefined;
      ctx.session.activeExpressions = undefined;
      ctx.session.uploadedCount = undefined;
      ctx.session.skippedDuplicateCount = undefined;
      ctx.session.duplicateTagCount = undefined;
      if (wasRescan) {
        ctx.session.rescanActive = undefined;
        ctx.session.rescanMode = undefined;
        ctx.session.rescannedCount = undefined;
        if (duplicateCount === 0) ctx.session.uploadedItems = undefined;
      } else {
        ctx.session.uploadedItems = undefined;
      }
    }
    // Keep the duplicate list after reindexing so /remove can clean up the
    // flagged channel posts. All other finished sessions are discarded.
    if (!wasRescan || duplicateCount === 0) ctx.session = undefined;

    if (wasRescan) {
      await ctx.reply(
        `✅ Reindex finished. Processed ${rescannedCount} forwarded post${rescannedCount === 1 ? '' : 's'}.` +
        (duplicateCount > 0 ? `\n\nFound ${duplicateCount} duplicate channel post${duplicateCount === 1 ? '' : 's'}. Use /remove to review them or /remove all to delete only those duplicate posts.` : ''),
      );
      return;
    }
    if (count === 0) {
      await ctx.reply(
        skippedDuplicateCount > 0
          ? `✅ Upload session ended. No new GIFs were copied. Skipped ${skippedDuplicateCount} duplicate upload${skippedDuplicateCount === 1 ? '' : 's'}.` +
            (duplicateTagCount > 0 ? ` Added ${duplicateTagCount} new expression tag${duplicateTagCount === 1 ? '' : 's'} to existing GIF${duplicateTagCount === 1 ? '' : 's'}.` : '')
          : '✅ Upload session ended. No GIFs were uploaded this session.',
      );
      return;
    }
    const tagText = expressions.length ? ` with ${expressions.map((name) => `/${name}`).join(', ')}` : '';
    await ctx.reply(
      `✅ <b>Upload complete!</b>\n\n` +
      `📤 <b>${count}</b> GIF${count === 1 ? '' : 's'} forwarded to channel${tagText}.\n\n` +
      (skippedDuplicateCount > 0
        ? `⏭️ Skipped ${skippedDuplicateCount} duplicate upload${skippedDuplicateCount === 1 ? '' : 's'}; ${duplicateTagCount} new expression tag${duplicateTagCount === 1 ? '' : 's'} added to existing GIFs.\n\n`
        : '') +
      `Ready for another batch — send /mode &lt;expression&gt; [expression ...] to start.`,
      { parse_mode: 'HTML' },
    );
  });

  // ---- Admin: remove a mistakenly uploaded GIF from the dump channel ----
  bot.command('remove', async (ctx) => {
    if (!(await isBotAdmin(ctx.from?.id))) return;

    const items = ctx.session?.uploadedItems ?? [];
    const count = items.length;

    if (count === 0) {
      await ctx.reply('No GIFs in the current upload session to remove.');
      return;
    }

    const arg = (ctx.match?.trim() ?? '').toLowerCase();
    const channelId = config.DUMP_CHANNEL_ID;
    if (!channelId) {
      await ctx.reply('❌ No DUMP_CHANNEL_ID is configured.');
      return;
    }

    if (arg === 'all') {
      let deleted = 0;
      const remaining: typeof items = [];
      const removed: typeof items = [];
      const failed: Array<{ messageId: number; reason: string }> = [];
      for (const item of [...items]) {
        try {
          await ctx.api.deleteMessage(channelId, item.channelMsgId);
        } catch (err) {
          const reason = safeErrorSummary(err);
          failed.push({ messageId: item.channelMsgId, reason });
          remaining.push(item);
          continue;
        }
        deleted++;
        removed.push(item);
        await sleep(200);
      }
      await cleanupRemovedUploadItems(removed, remaining);
      ctx.session!.uploadedItems = remaining;
      ctx.session!.uploadedCount = Math.max(0, (ctx.session!.uploadedCount ?? count) - deleted);
      let report = `🗑️ Deleted ${deleted} of ${count} GIF${count === 1 ? '' : 's'} from the channel.`;
      if (failed.length > 0) {
        const failedIds = failed.slice(0, 15).map((item) => `#${item.messageId}`).join(', ');
        const more = failed.length > 15 ? ` and ${failed.length - 15} more` : '';
        const reason = failed[0].reason;
        const likelyAgeLimit = /message can't be deleted/i.test(reason);
        report += `\nCould not delete ${failed.length}: ${failedIds}${more}.`;
        report += likelyAgeLimit
          ? '\nTelegram usually returns this when a post is older than 48 hours. Delete those posts manually in the channel; the bot API cannot remove them.'
          : `\nTelegram says: ${reason}. Check that the bot has permission to delete channel messages, or delete these posts manually.`;
      }
      await ctx.reply(report);
      return;
    }

    // Parse index (1-based) from the argument
    const index = Number.parseInt(arg, 10);

    if (!arg || isNaN(index) || index < 1 || index > count) {
      const list = items
        .map((item, i) => `  ${i + 1}. channel post #${item.channelMsgId}${item.duplicateOfChannelMsgId ? ` (duplicate of #${item.duplicateOfChannelMsgId})` : ''}`)
        .join('\n');
      await ctx.reply(
        `<b>Uploaded GIFs (${count}):</b>\n${list}\n\n` +
        `Reply with /remove &lt;number&gt; to delete one, or /remove all to delete all.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    // Delete one by index
    const item = items[index - 1];
    try {
      await ctx.api.deleteMessage(channelId, item.channelMsgId);
    } catch (err) {
      const reason = safeErrorSummary(err);
      const detail = /message can't be deleted/i.test(reason)
        ? 'Telegram usually means the post is older than 48 hours. Delete it manually in the channel; the bot API cannot remove it.'
        : `Telegram says: ${reason}. Check that the bot has permission to delete channel messages.`;
      await ctx.reply(`❌ Could not delete channel post #${item.channelMsgId}. ${detail}`);
      return;
    }
    const remaining = items.filter((_, itemIndex) => itemIndex !== index - 1);
    await cleanupRemovedUploadItems([item], remaining);
    ctx.session!.uploadedItems = remaining;
    ctx.session!.uploadedCount = Math.max(0, (ctx.session!.uploadedCount ?? 1) - 1);
    await ctx.reply(`🗑️ Deleted GIF #${index} from channel.`);
  });

  // Bot API has no channel-history endpoint. Admins restore the index by
  // forwarding old channel posts; duplicates are tracked for optional removal.
  bot.command('rescan', async (ctx) => {
    if (!(await isBotAdmin(ctx.from?.id))) {
      await ctx.reply('❌ Only bot admins can run /rescan.').catch(() => {});
      return;
    }
    if (ctx.chat?.type !== 'private') {
      await ctx.reply('Run /rescan in a private chat with the bot, then forward the old channel posts here.');
      return;
    }
    const arg = (ctx.match?.trim() ?? '').toLowerCase();
    if (arg === 'off') {
      if (ctx.session) {
        ctx.session.rescanActive = undefined;
        ctx.session.rescanMode = undefined;
        ctx.session.rescannedCount = undefined;
      }
      await ctx.reply('Reindex mode stopped.');
      return;
    }
    if (ctx.session?.conversionMode) {
      await ctx.reply('Finish sticker conversion first with /convert cancel or /batchconvert done.');
      return;
    }
    ctx.session!.activeExpression = undefined;
    ctx.session!.activeExpressions = undefined;
    ctx.session!.rescanActive = true;
    ctx.session!.rescanMode = arg === 'relink' ? 'relink' : 'index';
    ctx.session!.rescannedCount = 0;
    ctx.session!.uploadedItems = [];
    const rescanPrompt = arg === 'relink'
      ? '🔗 <b>Relink mode is on.</b> Forward only the posts you are keeping; I will update each GIF record to point to that surviving channel post. Send /done when finished, or /rescan off to stop.'
      : '📥 <b>Reindex mode is on.</b> Forward the original batch first, then the reuploaded batch. I will rebuild the index, restore hashtag tags, and flag duplicates for optional removal without reposting. Send /done when finished, or /rescan off to stop.';
    await ctx.reply(rescanPrompt, { parse_mode: 'HTML' });
  });

  // ---- Admin: toggle expression lewd/safe ----
  bot.command('togglelewd', async (ctx) => {
    if (!(await isBotAdmin(ctx.from?.id))) {
      await ctx.reply('❌ Only admins can toggle lewd/safe.');
      return;
    }
    const name = (ctx.match?.trim() ?? '').toLowerCase();
    if (!name) {
      await ctx.reply('Usage: /togglelewd <expression>\nExample: /togglelewd kiss');
      return;
    }
    const expression = await getExpressionByName(name);
    if (!expression) {
      await ctx.reply(`❌ Unknown expression /${name}.`);
      return;
    }
    const nowLewd = !(expression.is_lewd === 1);
    const success = await toggleExpressionLewd(name, nowLewd);
    if (success) {
      await ctx.reply(`✅ Expression /${name} is now ${nowLewd ? 'lewd' : 'safe'}.`);
    } else {
      await ctx.reply('❌ Failed to toggle lewd/safe.');
    }
  });

  // ---- Admin: scan & merge visual duplicates ----
  bot.command('dedupe', async (ctx) => {
    if (!(await isBotAdmin(ctx.from?.id))) {
      await ctx.reply('❌ Only admins can run deduplication.');
      return;
    }
    const mode = (ctx.match?.trim() ?? '').toLowerCase();
    if (mode && mode !== 'preview' && mode !== 'apply') {
      await ctx.reply('Usage: /dedupe to preview matches, or /dedupe apply to merge them.');
      return;
    }
    const apply = mode === 'apply';
    const processing = await ctx.reply(apply ? '🧹 Merging duplicate GIF records…' : '🔍 Previewing possible duplicate GIFs…');

    const SCAN_CAP = 500;

    try {
      const [result, missingHashes] = await Promise.all([
        getDb().execute({
          sql: 'SELECT id, phash, usage_count, channel_msg_id FROM media WHERE phash IS NOT NULL ORDER BY id LIMIT ?',
          args: [SCAN_CAP],
        }),
        getDb().execute('SELECT COUNT(*) AS count FROM media WHERE phash IS NULL'),
      ]);
      const rows = result.rows as unknown as DedupeRow[];
      const groups = findVisualDuplicateGroups(rows);
      const totalToMerge = groups.reduce((count, ids) => count + ids.length - 1, 0);
      const missingHashCount = Number(missingHashes.rows[0]?.count ?? 0);
      const hitCap = rows.length >= SCAN_CAP;

      if (!apply) {
        const lines = [
          `🔎 Dedupe preview: scanned ${rows.length}${hitCap ? ` of at least ${SCAN_CAP}` : ''} hashed GIF records.`,
        ];

        if (groups.length === 0) {
          lines.push('No likely duplicate groups found.');
        } else {
          lines.push(`Found ${groups.length} group(s); applying would merge ${totalToMerge} record(s) into the oldest record in each group:`, '');
          const rowById = new Map(rows.map((row) => [row.id, row]));
          for (const ids of groups) {
            const primary = rowById.get(ids[0])!;
            const keepLabel = `Keep #${primary.id}${primary.channel_msg_id === null ? '' : ` (post ${primary.channel_msg_id})`}`;
            for (let start = 1; start < ids.length; start += 20) {
              const duplicates = ids.slice(start, start + 20).map((id) => {
                const row = rowById.get(id)!;
                return `#${id}${row.channel_msg_id === null ? '' : ` (post ${row.channel_msg_id})`}`;
              });
              lines.push(`${keepLabel}; merge ${duplicates.join(', ')}`);
            }
          }
          lines.push('', 'Review the full list above, then run /dedupe apply to merge matches in this scanned set.');
        }

        if (missingHashCount > 0) {
          lines.push('', `${missingHashCount} record(s) without perceptual hashes were skipped. Run the phash backfill script, then preview again.`);
        }
        if (hitCap) lines.push(`Only the first ${SCAN_CAP} hashed records are covered; records beyond that limit are not included in this preview or apply.`);

        const chunks: string[] = [];
        let chunk = '';
        for (const line of lines) {
          const next = chunk ? `${chunk}\n${line}` : line;
          if (next.length > 3500 && chunk) {
            chunks.push(chunk);
            chunk = line;
          } else {
            chunk = next;
          }
        }
        if (chunk) chunks.push(chunk);

        await ctx.api.editMessageText(processing.chat.id, processing.message_id, chunks[0]);
        for (const continuation of chunks.slice(1)) await ctx.reply(continuation);
        return;
      }

      let totalMerged = 0;
      for (const ids of groups) {
        const [primaryId, ...duplicateIds] = ids;
        for (const duplicateId of duplicateIds) {
          await mergeMedia(primaryId, duplicateId);
          totalMerged++;
        }
      }

      await ctx.api.editMessageText(
        processing.chat.id,
        processing.message_id,
        `✅ Merged ${totalMerged} duplicate GIF record${totalMerged === 1 ? '' : 's'} into the oldest record.`
        + (totalMerged === 0 ? ' No matches were found.' : '')
        + (hitCap ? ` Only the first ${SCAN_CAP} hashed records were included.` : '')
        + (missingHashCount > 0 ? ` ${missingHashCount} record(s) without perceptual hashes were skipped.` : ''),
      );
    } catch (err) {
      logApiError('dedupe', err);
      await ctx.api.editMessageText(processing.chat.id, processing.message_id, '❌ Deduplication failed. Check logs.').catch(() => {});
    } finally {
      // No temporary dir created in this handler.
    }
  });

  // ---- Chat: toggle lewd mode (NSFW) ----
  bot.command('lewdmode', async (ctx) => {
    const arg = (ctx.match?.trim() ?? '').toLowerCase();

    // Permission: group admins/owners or bot admins (anyone in PM)
    if (!(await canManageChat(ctx))) {
      await ctx.reply('❌ Only group admins/owners can toggle lewd mode.');
      return;
    }

    let enabled: boolean | null = null;
    if (arg === 'yes' || arg === 'on' || arg === 'enable' || arg === 'true' || arg === '1') {
      enabled = true;
    } else if (arg === 'no' || arg === 'off' || arg === 'disable' || arg === 'false' || arg === '0') {
      enabled = false;
    } else {
      // No arg or invalid arg -> show current state
      const settings = await getChatSettings(ctx.chat.id);
      await ctx.reply(`Lewd mode is currently ${settings.lewd_mode === 1 ? 'ON' : 'OFF'} in this chat.\nUsage: /lewdmode <yes|no|on|off|enable|disable|true|false>`);
      return;
    }

    await upsertChatSettings(ctx.chat.id, { lewd_mode: enabled ? 1 : 0 });
    await ctx.reply(`✅ Lewd mode is now ${enabled ? 'ON' : 'OFF'} in this chat.`);
  });

  // ---- Group admins: browse and unmark GIFs hidden only in this chat ----
  bot.command('lewdgifs', async (ctx) => {
    const chatType = ctx.chat.type;
    if (chatType !== 'group' && chatType !== 'supergroup') {
      await ctx.reply('Use /lewdgifs inside the group where the GIFs were marked.');
      return;
    }
    if (!(await canManageChat(ctx))) {
      await ctx.reply('❌ Only group admins can review hidden GIFs.');
      return;
    }

    const chatId = ctx.chat.id;
    const count = await countChatLewdMedia(chatId);
    if (count === 0) {
      await ctx.reply('✅ No GIFs are currently hidden in this group.');
      return;
    }

    const [media] = await getChatLewdMediaPage(chatId, 0, 1);
    if (!media) {
      await ctx.reply('✅ No GIFs are currently hidden in this group.');
      return;
    }
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    if (count > 1) rows.push([{ text: 'Next ▶️', callback_data: 'group_lewd:next:0' }]);
    rows.push([{ text: '✅ Mark safe in this group', callback_data: `group_lewd:safe:0:${media.id}` }]);
    await ctx.replyWithAnimation(media.file_id, {
      caption: `🔞 <b>Hidden in this group</b> · 1 of ${count}\nLewd Mode off filters this GIF from reactions.`,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: rows },
    });
  });

  // ---- Chat: lock/disable commands ----
  bot.command('lock', async (ctx) => {
    if (!(await canManageChat(ctx))) {
      await ctx.reply('❌ Only group admins/owners can lock commands.');
      return;
    }
    const cmd = (ctx.match?.trim() ?? '').toLowerCase();
    if (!cmd) {
      await ctx.reply('Usage: /lock <command>\nExample: /lock kiss');
      return;
    }
    // Strip leading slash if present
    const cleanCmd = cmd.startsWith('/') ? cmd.slice(1) : cmd;
    const expression = await getExpressionByAlias(cleanCmd);
    if (!expression) {
      await ctx.reply(`❌ Unknown command /${cleanCmd}.`);
      return;
    }
    const settings = await getChatSettings(ctx.chat.id);
    if (!settings.disabled_commands.includes(expression.name)) {
      settings.disabled_commands.push(expression.name);
      await upsertChatSettings(ctx.chat.id, { disabled_commands: settings.disabled_commands });
      await ctx.reply(`✅ Command /${expression.name} is now locked in this chat.`);
    } else {
      await ctx.reply(`⚠️ Command /${expression.name} is already locked in this chat.`);
    }
  });

  // ---- Chat: unlock/enable commands ----
  bot.command('unlock', async (ctx) => {
    if (!(await canManageChat(ctx))) {
      await ctx.reply('❌ Only group admins/owners can unlock commands.');
      return;
    }
    const cmd = (ctx.match?.trim() ?? '').toLowerCase();
    if (!cmd) {
      await ctx.reply('Usage: /unlock <command>\nExample: /unlock kiss');
      return;
    }
    // Strip leading slash if present
    const cleanCmd = cmd.startsWith('/') ? cmd.slice(1) : cmd;
    const expression = await getExpressionByAlias(cleanCmd);
    if (!expression) {
      await ctx.reply(`❌ Unknown command /${cleanCmd}.`);
      return;
    }
    const settings = await getChatSettings(ctx.chat.id);
    const index = settings.disabled_commands.indexOf(expression.name);
    if (index !== -1) {
      settings.disabled_commands.splice(index, 1);
      await upsertChatSettings(ctx.chat.id, { disabled_commands: settings.disabled_commands });
      await ctx.reply(`✅ Command /${expression.name} is now unlocked in this chat.`);
    } else {
      await ctx.reply(`⚠️ Command /${expression.name} is not locked in this chat.`);
    }
  });

  // ---- Chat: list locked commands ----
  bot.command('locks', async (ctx) => {
    if (!(await canManageChat(ctx))) {
      await ctx.reply('❌ Only group admins/owners can view locked commands.');
      return;
    }
    const settings = await getChatSettings(ctx.chat.id);
    if (settings.disabled_commands.length === 0) {
      await ctx.reply('No locked commands in this chat.');
      return;
    }
    await sendHtml(ctx, 'locks', buildLocksMessage(settings.disabled_commands));
  });

  // ---- Chat: toggle bluetext mode (delete command after sending) ----
  bot.command('bluetextmode', async (ctx) => {
    if (!(await canManageChat(ctx))) {
      await ctx.reply('❌ Only group admins/owners can toggle bluetext mode.');
      return;
    }
    const arg = (ctx.match?.trim() ?? '').toLowerCase();
    let enabled: boolean | null = null;
    if (arg === 'on' || arg === 'enable' || arg === 'true' || arg === '1') {
      enabled = true;
    } else if (arg === 'off' || arg === 'disable' || arg === 'false' || arg === '0') {
      enabled = false;
    } else {
      // No arg or invalid arg -> show current state
      const settings = await getChatSettings(ctx.chat.id);
      await ctx.reply(`Bluetext mode is currently ${settings.bluetext === 1 ? 'ON' : 'OFF'} in this chat.\nUsage: /bluetextmode <on|off|enable|disable|true|false>`);
      return;
    }

    await upsertChatSettings(ctx.chat.id, { bluetext: enabled ? 1 : 0 });
    await ctx.reply(`✅ Bluetext mode is now ${enabled ? 'ON' : 'OFF'} in this chat.`);
  });

  // ---- Group admins: apply chat-only lewd labels to bot-sent GIFs ----
  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text.trim().toLowerCase();
    if (text !== '#lewd' && text !== '#safe') return next();

    const chatType = ctx.chat?.type;
    if (chatType !== 'group' && chatType !== 'supergroup') return next();
    const replied = ctx.message.reply_to_message;
    if (!replied) return next();

    if (!(await canManageChat(ctx))) {
      await ctx.reply('❌ Only group admins can apply this group-only GIF label.');
      return;
    }

    const settings = await getChatSettings(ctx.chat.id);
    if (settings.lewd_mode === 1) {
      await ctx.reply('Turn Lewd Mode off before applying group-only #lewd or #safe labels.');
      return;
    }

    if (replied.from?.id !== ctx.me.id) {
      await ctx.reply('Reply to a GIF sent by this bot with #lewd or #safe.');
      return;
    }

    const fileUniqueId = replied.animation?.file_unique_id ?? replied.video?.file_unique_id;
    if (!fileUniqueId) {
      await ctx.reply('The replied bot message does not contain a GIF or video.');
      return;
    }
    const media = await getMediaByFileUniqueId(fileUniqueId);
    if (!media) {
      await ctx.reply('I could not match that GIF to the library.');
      return;
    }

    if (text === '#lewd') {
      await markMediaLewdInChat(ctx.chat.id, media.id, ctx.from.id);
      await ctx.reply('🔞 Marked lewd in this group. It will be filtered while Lewd Mode is off. Reply with #safe to undo.');
    } else {
      const removed = await unmarkMediaLewdInChat(ctx.chat.id, media.id);
      await ctx.reply(removed ? '✅ Removed this group-only lewd label.' : 'This GIF has no group-only lewd label to remove.');
    }
  });

  // ---- Dynamic expression command handler (catch-all for command messages) ----
  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text;
    if (!text.startsWith('/')) return next();

    // Accept an optional @BotName suffix on the command token while preserving
    // an @username argument as a target.
    const match = text.trim().match(/^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?(?=\s|$)/i);
    if (!match) return next();
    const cmd = match[1].toLowerCase();
    if (match[2] && match[2].toLowerCase() !== (ctx.me.username ?? '').toLowerCase()) return next();

    // Look up if this command matches any known expression or alias
    const expression = await getExpressionByAlias(cmd);
    if (!expression) return next();

    // ---- Resolve target user ----
    let targetUser = ctx.message.reply_to_message?.from;
    let targetMention: string | null = null;
    let targetMessageId: number | undefined;

    if (ctx.message.reply_to_message) {
      targetMessageId = ctx.message.reply_to_message.message_id;
      if (targetUser?.is_bot) {
        await ctx.reply('You can only react to human users.');
        return;
      }
    }

    // A bot cannot resolve arbitrary user usernames to numeric IDs through
    // getChat. Keep the explicit username as a plain caption mention instead.
    const mentionMatch = text.trim().match(/^\/\S+\s+@([a-z0-9_]+)/i);
    if (mentionMatch) {
      targetMention = `@${mentionMatch[1]}`;
    }

    // Must have a resolved target
    if ((!targetUser && !targetMention) || targetUser?.is_bot) {
      await ctx.reply(
        `Please reply to a user's message with /${expression.name}, or use /${expression.name} @username.`,
      );
      return;
    }

    // ---- Check per-chat settings ----
    const chatId = ctx.chat?.id ?? 0;
    const chatSettings = await getChatSettings(chatId);

    // Lock check
    if (chatSettings.disabled_commands.includes(expression.name.toLowerCase())) {
      await ctx.reply(`❌ Command /${expression.name} is currently disabled in this chat.`);
      return;
    }

    // Lewd check
    if (expression.is_lewd === 1 && chatSettings.lewd_mode !== 1) {
      await ctx.reply(
        `⚠️ This is a lewd command. Use /lewdmode on to enable lewd commands in this chat.`,
      );
      return;
    }

    // Group-specific #lewd overrides apply only while Lewd Mode is off.
    const allowLewd = chatSettings.lewd_mode === 1;
    const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
    const chatLewdFilter = isGroup && !allowLewd ? chatId : undefined;
    const media = await getRandomMediaForExpression(expression.id, allowLewd, chatLewdFilter);
    if (!media) {
      const available = (await getAvailableExpressionNames(allowLewd, chatLewdFilter)).map((name) => `/${name}`);
      const message = available.length
        ? `No GIFs are available for /${expression.name} yet. Try: ${available.join(' ')}`
        : 'No GIF commands have GIFs available yet.';
      await ctx.reply(message);
      return;
    }

    // Send the GIF as animation (Telegram treats GIF as animation)
    const caption = clampVisible(
      formatCaption(
        expression.caption_template,
        ctx.message.from,
        targetUser ?? { first_name: targetMention!, username: targetMention!.slice(1) },
        expression.name,
        expression.direction,
      ),
      TELEGRAM_CAPTION_LIMIT,
    );
    try {
      await ctx.replyWithAnimation(media.file_id, {
        caption,
        parse_mode: 'HTML',
        // Reply to the target message when replying; standalone for @username
        ...(targetMessageId ? { reply_parameters: { message_id: targetMessageId } } : {}),
      });
      await incrementUsage(media.id);

      // Bluetext: delete the invoking command message if enabled and in a group
      if (isGroup && chatSettings.bluetext === 0) {
        // Needs "delete messages" rights, which the bot often does not have;
        // logged rather than swallowed so the cause is visible.
        ctx.deleteMessage().catch((err) =>
          logApiError('bluetext:delete', err, { chat_id: ctx.chat?.id }),
        );
      }
    } catch (err) {
      logApiError('animation', err, {
        expression: expression.name,
        file_id: media.file_id,
        template: expression.caption_template,
      });
      await ctx.reply('❌ Failed to send GIF.');
    }
  });

  // ---- Media ingestion: handle channel posts (dump channel) ----
  bot.on('channel_post', async (ctx) => {
    const config = loadConfig();
    const msg = ctx.channelPost;
    if (!msg) return;

    if (config.DUMP_CHANNEL_ID && msg.chat.id !== config.DUMP_CHANNEL_ID) {
      return;
    }

    // Determine expression: either from CHANNEL_EXPRESSION_MAP or fallback to caption hashtags
    const expressions = new Map<number, Expression>();
    const mappedExpr = resolveChannelExpression(msg.chat.id, config.CHANNEL_EXPRESSION_MAP);
    if (mappedExpr) {
      const mapped = await getExpressionByName(mappedExpr);
      if (mapped) expressions.set(mapped.id, mapped);
    }

    // Extract file from animation or video
    const file = msg.animation ?? msg.video;
    if (!file) return;

    const { file_id, file_unique_id } = file;

    // Determine expression via caption hashtags if not resolved from channel map
    let isLewd = false;
    if (msg.caption) {
      const tags = (msg.caption.match(/#[a-z0-9_-]+/gi) ?? [])
        .map((tag) => tag.slice(1).toLowerCase());
      for (const tag of tags) {
        if (tag === 'lewd') {
          isLewd = true;
          continue;
        }
        const expr = await getExpressionByAlias(tag);
        if (expr) expressions.set(expr.id, expr);
      }
    }

    // ---- Visual duplicate check (perceptual hash) ----
    let phash: string | null = null;
    let media = await getMediaByFileUniqueId(file_unique_id);
    if (!media) {
      // No file_unique_id hit → check if this GIF visually matches an existing one
      try {
        phash = await computeTelegramFilePhash(ctx, file_id);

        if (phash) {
          const dupe = await findVisualDuplicate(phash);
          if (dupe) {
            console.log(
              `[dedupe] channel: file_unique_id=${file_unique_id} matches media #${dupe.media.id} (distance ${dupe.distance})`,
            );
            media = dupe.media;
            // If this post carries #lewd, mark the existing record lewd
            if (isLewd) {
              await setMediaLewd(media.id);
            }
          }
        }
      } catch (err) {
        logSafeError('dedupe:channel-phash', err);
      }

      // Insert (or keep the existing row from dupe check)
      if (!media) {
        media = await insertMedia(file_id, file_unique_id, isLewd ? 1 : 0, phash, msg.message_id);
      }
    }

    if (media.channel_msg_id === null) {
      await setMediaChannelMsgIdIfMissing(media.id, msg.message_id);
    }
    if (isLewd) await setMediaLewd(media.id);
    for (const expression of expressions.values()) {
      await linkMediaToExpression(media.id, expression.id);
    }
  });

  // ---- Media ingestion: handle private admin uploads via /mode ----
  bot.on(['message:animation', 'message:video'], async (ctx, next) => {
    if (ctx.chat?.type !== 'private') return;
    if (!ctx.message) return;
    if (!(await isBotAdmin(ctx.from?.id))) return next();

    const file = ctx.message.animation ?? ctx.message.video;
    if (!file) return;

    const { file_id, file_unique_id } = file;

    if (ctx.session?.rescanActive) {
      const origin = ctx.message.forward_origin;
      const dumpChannelId = loadConfig().DUMP_CHANNEL_ID;
      if (origin?.type !== 'channel' || (dumpChannelId !== undefined && origin.chat.id !== dumpChannelId)) {
        await ctx.reply('Please forward a GIF/video post from the configured dump channel while /rescan is active.');
        return;
      }

      const expressions = new Map<number, Expression>();
      const mappedName = resolveChannelExpression(origin.chat.id, loadConfig().CHANNEL_EXPRESSION_MAP);
      if (mappedName) {
        const mapped = await getExpressionByName(mappedName);
        if (mapped) expressions.set(mapped.id, mapped);
      }
      const tags = (ctx.message.caption?.match(/#[a-z0-9_-]+/gi) ?? []).map((tag) => tag.slice(1).toLowerCase());
      const isLewd = tags.includes('lewd');
      for (const tag of tags) {
        if (tag === 'lewd') continue;
        const expression = await getExpressionByAlias(tag);
        if (expression) expressions.set(expression.id, expression);
      }

      let media = await getMediaByFileUniqueId(file_unique_id);
      let phash: string | null = null;
      if (!media) {
        try {
          phash = await computeTelegramFilePhash(ctx, file_id);
          if (phash) {
            const duplicate = await findVisualDuplicate(phash);
            if (duplicate) media = duplicate.media;
          }
        } catch (err) {
          logSafeError('rescan:phash', err);
        }
      }
      if (!media) {
        media = await insertMedia(file_id, file_unique_id, isLewd ? 1 : 0, phash, origin.message_id);
      } else if (ctx.session.rescanMode === 'relink') {
        await setMediaChannelMsgId(media.id, origin.message_id);
      } else if (media.channel_msg_id === null) {
        await setMediaChannelMsgIdIfMissing(media.id, origin.message_id);
      }
      const duplicateOf = ctx.session.rescanMode !== 'relink' && media.channel_msg_id !== null && media.channel_msg_id !== origin.message_id
        ? media.channel_msg_id
        : null;
      if (isLewd) await setMediaLewd(media.id);
      for (const expression of expressions.values()) await linkMediaToExpression(media.id, expression.id);

      ctx.session.rescannedCount = (ctx.session.rescannedCount ?? 0) + 1;
      if (duplicateOf !== null) {
        ctx.session.uploadedItems = ctx.session.uploadedItems ?? [];
        ctx.session.uploadedItems.push({
          channelMsgId: origin.message_id,
          mediaId: media.id,
          deleteMediaOnRemove: false,
          duplicateOfChannelMsgId: duplicateOf,
        });
      }
      const tagSummary = expressions.size ? ` Tagged: ${[...expressions.values()].map((e) => `/${e.name}`).join(', ')}.` : ' No expression hashtag was found.';
      await ctx.reply(
        duplicateOf !== null
          ? `⚠️ Duplicate channel post #${origin.message_id} matches #${duplicateOf}. It is queued for optional removal with /remove.${tagSummary}`
          : `✅ Reindexed channel post #${origin.message_id}.${tagSummary}`,
      );
      return;
    }

    const activeNames = ctx.session?.activeExpressions ?? (ctx.session?.activeExpression ? [ctx.session.activeExpression] : []);
    if (activeNames.length === 0) return next();

    const expressions: Expression[] = [];
    for (const name of activeNames) {
      const expression = await getExpressionByName(name);
      if (expression) expressions.push(expression);
    }
    if (expressions.length !== activeNames.length) {
      await ctx.reply(`❌ One or more active expressions no longer exist. Reset with /mode expression [expression ...].`);
      return;
    }

    // Check for #lewd tag in caption or message text
    const msgText = ctx.message.caption ?? ctx.message.text ?? '';
    const isLewd = /(?:^|\s)#lewd\b/i.test(msgText);
    // #lewd classifies this media only. Expression visibility is controlled
    // separately by the explicit /togglelewd command.

    let media = await getMediaByFileUniqueId(file_unique_id);
    let createdMediaRecord = false;
    let isDuplicate = media !== null;
    let phash: string | null = null;
    if (!media) {
      // No file_unique_id hit → check whether this GIF visually matches an existing one
      try {
        phash = await computeTelegramFilePhash(ctx, file_id);

        if (phash) {
          const dupe = await findVisualDuplicate(phash);
          if (dupe) {
            console.log(
              `[dedupe] private upload: file_unique_id=${file_unique_id} matches media #${dupe.media.id} (distance ${dupe.distance})`,
            );
            media = dupe.media;
            isDuplicate = true;
            if (isLewd) {
              await setMediaLewd(media.id);
            }
          }
        }
      } catch (err) {
        logSafeError('dedupe:upload-phash', err);
      }
    }

    if (media && isDuplicate) {
      if (isLewd) await setMediaLewd(media.id);
      let addedTagCount = 0;
      for (const expression of expressions) {
        if (await linkMediaToExpression(media.id, expression.id)) addedTagCount += 1;
      }
      ctx.session!.skippedDuplicateCount = (ctx.session!.skippedDuplicateCount ?? 0) + 1;
      ctx.session!.duplicateTagCount = (ctx.session!.duplicateTagCount ?? 0) + addedTagCount;
      console.log(
        `[upload] skipped duplicate media #${media.id}; added ${addedTagCount} expression tag(s)`,
      );
      // Existing media can gain missing expression tags, but a duplicate copy
      // must not be added to the dump channel again.
      return;
    }

    // ---- Copy to dump channel if configured (sets caption on send) ----
    let channelMsgId: number | null = null;
    if (config.DUMP_CHANNEL_ID) {
      const channelId = config.DUMP_CHANNEL_ID;
      const captionText = `${expressions.map((expression) => `#${expression.name}`).join(' ')}${isLewd ? ' #lewd' : ''}`;
      const channelMsg = await ctx.api.copyMessage(
        channelId,
        ctx.chat.id,
        ctx.message.message_id,
        { caption: captionText, parse_mode: 'HTML' },
      ).catch((err) => {
        logSafeError('upload:copy-channel', err);
        return null;
      });

      if (channelMsg) {
        channelMsgId = channelMsg.message_id;
      }
    }

    if (config.DUMP_CHANNEL_ID && channelMsgId === null) {
      await ctx.reply('❌ The GIF could not be copied to the dump channel, so it was not added to the library.');
      return;
    }

    // ---- Save to DB (after copy so we have the channel_msg_id) ----
    if (!media) {
      // New media — insert with channel_msg_id
      media = await insertMedia(file_id, file_unique_id, isLewd ? 1 : 0, phash, channelMsgId);
      createdMediaRecord = true;
    } else if (channelMsgId !== null) {
      // Keep the original channel reference when this is a visual duplicate.
      await setMediaChannelMsgIdIfMissing(media.id, channelMsgId);
    }

    if (isLewd) await setMediaLewd(media.id);
    const expressionIdsAdded: number[] = [];
    for (const expression of expressions) {
      if (await linkMediaToExpression(media.id, expression.id)) expressionIdsAdded.push(expression.id);
    }

    if (channelMsgId !== null) {
      ctx.session!.uploadedItems = ctx.session!.uploadedItems ?? [];
      ctx.session!.uploadedItems.push({
        channelMsgId,
        mediaId: media.id,
        deleteMediaOnRemove: createdMediaRecord,
        expressionIds: expressions.map((expression) => expression.id),
        expressionIdsAdded,
      });
    }
    ctx.session!.uploadedCount = (ctx.session!.uploadedCount ?? 0) + 1;

    // Rate-limit: small delay between uploads to avoid Telegram throttling
    await sleep(400);
  });

  // ---- Command: /sauce (reverse image search) ----
  bot.command('sauce', async (ctx) => {
    if (!ctx.message?.reply_to_message) {
      await ctx.reply('Please reply to a GIF, video, or image with /sauce.');
      return;
    }
    const replyMsg = ctx.message.reply_to_message;

    let file: {
      file_id: string;
      file_unique_id: string;
    } | null = null;

    if (replyMsg.sticker?.is_animated && !replyMsg.sticker.is_video) {
      await ctx.reply('Animated TGS stickers are not supported yet. Try a static or video sticker.');
      return;
    } else if (replyMsg.sticker) {
      file = {
        file_id: replyMsg.sticker.file_id,
        file_unique_id: replyMsg.sticker.file_unique_id,
      };
    } else if (replyMsg.animation) {
      file = {
        file_id: replyMsg.animation.file_id,
        file_unique_id: replyMsg.animation.file_unique_id,
      };
    } else if (replyMsg.video) {
      file = {
        file_id: replyMsg.video.file_id,
        file_unique_id: replyMsg.video.file_unique_id,
      };
    } else if (replyMsg.photo) {
      const photo = replyMsg.photo.reduce((prev, curr) =>
        (prev.file_size ?? 0) > (curr.file_size ?? 0) ? prev : curr,
      );
      file = {
        file_id: photo.file_id,
        file_unique_id: photo.file_unique_id,
      };
    } else {
      await ctx.reply('Reply message must contain an image, GIF, video, or static/video sticker.');
      return;
    }

    if (!file) {
      await ctx.reply('Could not extract media from replied message.');
      return;
    }

    // The cache is checked inside reverseSearch, which returns `cached` so the
    // caption can say so. This handler used to parse the cache row a second
    // time and render its own caption from it; the two renderings drifted.
    const config = loadConfig();
    // Anchor both the temporary status and the final result to the media the
    // user selected, rather than to the /sauce command message.
    const processing = await ctx.api.sendMessage(ctx.chat.id, '🔍 Searching reverse image databases…', {
      reply_parameters: { message_id: replyMsg.message_id },
    });

    const tmpDir = await mkdtemp(join(tmpdir(), 'tg-bot-'));
    const tmpFile = join(tmpDir, 'input.bin');

    try {
      // Download the file from Telegram
      const fileInfo = await ctx.api.getFile(file.file_id);
      if (!fileInfo.file_path) {
        throw new Error('Could not retrieve file path from Telegram');
      }

      // Contains the bot token: never log it and never put it in a message.
      const downloadUrl = `https://api.telegram.org/file/bot${config.BOT_TOKEN}/${fileInfo.file_path}`;
      const fileRes = await fetch(downloadUrl, { signal: AbortSignal.timeout(20_000) });
      if (!fileRes.ok) {
        throw new Error(`Failed to download file from Telegram: ${fileRes.status} ${fileRes.statusText}`);
      }

      const buffer = Buffer.from(await fileRes.arrayBuffer());
      await writeFile(tmpFile, buffer);

      // Perform combined search
      const result = await reverseSearch(file.file_unique_id, tmpFile);
      console.log(
        `[sauce] ${file.file_unique_id}: traceMoe=${result.traceMoe ? 'hit' : 'miss'} sauceNao=${result.sauceNao ? 'hit' : 'miss'} iqdb=${result.iqdb ? 'hit' : 'miss'} cached=${result.cached}`,
      );

      // Backfill phash for existing media that lacks one — frames are already on disk.
      const existing = await getMediaByFileUniqueId(file.file_unique_id);
      if (existing && !existing.phash) {
        const phash = await computePhash(tmpFile);
        if (phash) {
          await setMediaPhash(existing.id, phash);
          console.log(`[sauce] backfilled phash for media #${existing.id}`);
        }
      }

      const built = buildSauceCaption({
        traceMoe: result.traceMoe,
        sauceNao: result.sauceNao,
        iqdb: result.iqdb,
        googleLensUrl: result.googleLensUrl,
        yandexUrl: result.yandexUrl,
        cached: result.cached,
      });
      const replyMarkup = buildSauceKeyboard({
        traceMoe: result.traceMoe,
        sauceNao: result.sauceNao,
        iqdb: result.iqdb,
        googleLensUrl: result.googleLensUrl,
        yandexUrl: result.yandexUrl,
      });
      if (built.dropped > 0) {
        console.warn(`[sauce] caption hit the length cap; ${built.dropped} line(s) dropped`);
      }

      const clipUrl = result.traceMoe?.videoUrl;
      if (clipUrl?.startsWith('https://api.trace.moe/')) {
        try {
          await ctx.api.sendVideo(processing.chat.id, clipUrl, {
            caption: built.text,
            parse_mode: 'HTML',
            supports_streaming: true,
            reply_parameters: { message_id: replyMsg.message_id },
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          });
          await ctx.api.deleteMessage(processing.chat.id, processing.message_id).catch(() => {});
          return;
        } catch (err) {
          logSafeError('sauce:send-clip', err);
        }
      }

      await ctx.api.editMessageText(processing.chat.id, processing.message_id, built.text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
    } catch (err) {
      logApiError('sauce', err, {
        file_unique_id: file.file_unique_id,
        chat_id: ctx.chat?.id,
      });
      await ctx.api
        .editMessageText(
          processing.chat.id,
          processing.message_id,
          '❌ Search failed. Please try again later.',
        )
        .catch((editErr) => logApiError('sauce:edit', editErr));
    } finally {
      try {
        await rm(tmpDir, { recursive: true, force: true });
      } catch (err) {
        logSafeError('sauce:remove-temp', err);
      }
    }
  });

  // ---- Inline mode: refused — lewd commands must stay out of inline mode ----
  bot.on('inline_query', async (ctx) => {
    await ctx.answerInlineQuery(
      [],
      { cache_time: 300, button: { text: 'Use /help in private', start_parameter: 'inline_off' } },
    );
  });

  registerStickerFeatures(bot, isBotAdmin);

  return bot;
}
