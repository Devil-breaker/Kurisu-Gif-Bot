/**
 * Every HTML-formatted message the bot sends.
 *
 * These are pure functions on purpose: the 400s this bot used to return
 * ("can't parse entities", "message is too long") all came from text assembled
 * inline inside handlers, where nothing could render it without a live chat.
 * Built here, each message is checked by the test suite instead.
 *
 * House rules for anything added below:
 *   - interpolate user/admin/API values only through escapeHtml()
 *   - emit `&lt;name&gt;` for a literal placeholder, never a bare `<name>`
 *   - return the result of joinWithinLimit() so the caller can log truncation
 */
import {
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_MESSAGE_LIMIT,
  clampVisible,
  escapeHtml,
  joinWithinLimit,
} from './caption.js';
import type { AdminUser, Expression, IqdbResult, SauceNaoResult, TraceMoeResult } from '../types/index.js';

/** A built message plus how many list lines the length cap forced out. */
export interface BuiltMessage {
  text: string;
  dropped: number;
}

/** Apply Telegram's native quote styling to a help/menu panel built as HTML. */
export function quoteMenuText(text: string): string {
  return `<blockquote>${text}</blockquote>`;
}

/** Cap for a single interpolated value, so one long field cannot crowd out the rest. */
const FIELD_LIMIT = 200;

/** Escape and clamp one external value (anime title, author, username). */
function field(value: unknown): string {
  return clampVisible(escapeHtml(String(value)), FIELD_LIMIT);
}

/** Format expression commands in compact three-column rows for Telegram panels. */
function commandGrid(items: string[], columns = 3): string[] {
  const rows: string[] = [];
  for (let index = 0; index < items.length; index += columns) {
    rows.push(`  ${items.slice(index, index + columns).join('    ')}`);
  }
  return rows;
}

function expressionCommandGrid(expressions: Expression[]): string[] {
  return commandGrid(expressions.map((expression) => `• <code>/${escapeHtml(expression.name)}</code>`));
}

/** A similarity score as a percentage, or "?" when the source had no usable number. */
function percent(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '?';
}

/**
 * Callback data prefixes for inline keyboard navigation.
 * Format: "section:action" or "section:id:value"
 */
export const CALLBACK_DATA = {
  BACK_TO_MENU: 'menu:back',
  HELP_MENU: 'menu:help',
  USER_COMMANDS: 'menu:user',
  BOT_ADMIN: 'menu:bot_admin',
  GROUP_ADMIN: 'menu:group_admin',
  STATS: 'menu:stats',
  LIST_EXPRESSIONS: 'menu:list',
  LEWD_COMMANDS: 'menu:lewd',
  EXPRESSIONS: 'menu:expressions',
} as const;

/** Build the original welcome/status message shown by /start. */
export function buildStartMessage(isAdmin: boolean, isOwner: boolean): { text: string; dropped: number } {
  let status = '👤 <b>User Access</b>';
  if (isOwner) {
    status = '👑 <b>Bot Owner</b>';
  } else if (isAdmin) {
    status = '⚙️ <b>Bot Admin</b>';
  }

  const lines: string[] = [
    '🤖 <b>Kurisu Gif Bot</b>',
    '',
    '🎌 An anime-themed bot to send GIFs in chat with reverse search capability.',
    '',
    status,
  ];

  return joinWithinLimit(lines, TELEGRAM_MESSAGE_LIMIT);
}

/** Build the help landing message shown by /help and the Help Menu button. */
export function buildMainMenuMessage(): { text: string; dropped: number } {
  const lines: string[] = [
    '📖 <b>Kurisu Gif Bot Help</b>',
    '',
    'Choose a panel below to see available commands and how to use them.',
    'Use <code>/help</code> any time to return to this menu.',
  ];

  return joinWithinLimit(lines, TELEGRAM_MESSAGE_LIMIT);
}

/**
 * Build the User Commands panel.
 */
export function buildUserCommandsPanel(expressions: Expression[]): BuiltMessage {
  const safe = expressions.filter((e) => !e.is_lewd);
  const example = safe[0]?.name ?? expressions[0]?.name ?? 'hug';

  const lines: string[] = [
    '👤 <b>User Commands</b>',
    '',
    'Reply to a user with <code>/' + escapeHtml(example) + '</code> to send a themed GIF.',
    '',
    '<b>🎭 Safe Expressions</b>',
  ];

  if (safe.length > 0) {
    lines.push(...expressionCommandGrid(safe));
  } else {
    lines.push('  No expressions configured yet.');
  }

  lines.push(
    '',
    '<b>🔧 Utility</b>',
    '  • <code>/ping</code> – bot status, response latency, database, and uptime',
    '  • <code>/stats</code> – usage statistics',
    '  • <code>/sauce</code> – reverse search an image, GIF, video, or sticker',
    '',
    `<i>Example: /${escapeHtml(example)} (reply to user)</i>`,
  );

  return joinWithinLimit(lines, TELEGRAM_MESSAGE_LIMIT);
}

/**
 * Build the Lewd (NSFW) Commands panel.
 */
export function buildLewdCommandsPanel(expressions: Expression[]): BuiltMessage {
  const lewd = expressions.filter((e) => e.is_lewd);

  const lines: string[] = [
    '🔞 <b>Lewd/NSFW Commands</b>',
    '',
    '⚠️ <b>Warning:</b> These commands are for adults only.',
    '',
    'To enable in a group, an admin must use <code>/lewdmode on</code>.',
    '',
    '<b>Available Commands:</b>',
  ];

  if (lewd.length > 0) {
    lines.push(...expressionCommandGrid(lewd));
  } else {
    lines.push('  No lewd expressions configured yet.');
  }

  lines.push(
    '',
    '<i>Usage: /cmd @username (reply to user)</i>',
  );

  return joinWithinLimit(lines, TELEGRAM_MESSAGE_LIMIT);
}

/**
 * Build the Expressions list panel (all safe + lewd).
 */
export function buildExpressionsPanel(expressions: Expression[]): BuiltMessage {
  const safe = expressions.filter((e) => !e.is_lewd);
  const lewd = expressions.filter((e) => e.is_lewd);

  const lines: string[] = [
    '📋 <b>All Expressions</b>',
    '',
    '<b>🎭 Safe Expressions</b>',
  ];

  if (safe.length > 0) {
    lines.push(...expressionCommandGrid(safe));
  } else {
    lines.push('  No safe expressions configured.');
  }

  if (lewd.length > 0) {
    lines.push('', '<b>🔞 Lewd Expressions</b> (requires /lewdmode on)');
    lines.push(...expressionCommandGrid(lewd));
  }

  return joinWithinLimit(lines, TELEGRAM_MESSAGE_LIMIT);
}

/**
 * Build the Bot Admin panel.
 */
export function buildBotAdminPanel(isOwner: boolean): BuiltMessage {
  const lines: string[] = [
    isOwner ? '👑 <b>Bot Owner Panel</b>' : '⚙️ <b>Bot Admin Panel</b>',
    '',
    '<b>📦 Expression Management</b>',
    '  • <code>/addexpression &lt;name&gt; [aliases...]</code>',
    '  • <code>/deleteexpression &lt;name&gt;</code>',
    '  • <code>/updatecaption &lt;expression&gt; &lt;template&gt;</code> – customize the caption for one reaction command',
    '    Example: <code>/updatecaption smile {from} smiles.</code>',
    '    Placeholders: <code>{from}</code> = command user, <code>{to}</code> = replied-to user, <code>{action}</code> = expression action.',
    '    A GIF tagged <code>#hug #kiss</code> uses the hug caption for <code>/hug</code> and the kiss caption for <code>/kiss</code>.',
    '  • <code>/togglelewd &lt;name&gt;</code>',
    '',
    '<b>👥 Admin Management</b>',
    '  • <code>/admins</code> – list bot admins',
    '  • <code>/addadmin &lt;user_id&gt;</code> or reply to a user message',
    '  • <code>/rmadmin &lt;id&gt;</code>',
  ];

  if (isOwner) {
    lines.push('', '<b>👑 Owner Only</b>');
    lines.push('  • Owner commands cannot be removed.');
  }

  lines.push(
    '',
    '<b>📤 Media Upload</b>',
    '  • <code>/mode</code> – open a paginated picker; tap expressions to select them, then Apply. The picker includes expressions added with /addexpression.',
    '  • <code>/mode &lt;expr&gt; [expr ...]</code> – quick-set tags for uploads, e.g. <code>/mode hug kiss</code>. You can change mode mid-session; all selected tags apply to each GIF until changed.',
    '  Upload GIFs/video in private chat. Use <code>/remove</code> then <code>/remove N</code> to undo a mistaken upload before <code>/done</code>.',
    '  • <code>/rescan</code> – re-index old posts by forwarding them here',
    '  • <code>/rescan relink</code> – update references to surviving channel posts',
    '  • <code>/remove &lt;N|all&gt;</code> – delete GIF(s) from channel',
    '  • Reply to a GIF sent by the bot with <code>/remove</code> to remove it from the library and delete its archive post.',
    '  • <code>/linepack &lt;LINE URL&gt; [static|animated]</code> – download a LINE pack ZIP',
    '  • <code>/linepackcreate &lt;LINE URL&gt; [emoji] [--recreate] | [pack name]</code> – create named Telegram pack(s) from a LINE pack',
    '  • <code>/convert</code> – convert one file; reply to media or send the command, then the file',
    '  • <code>/batchconvert</code> – start an opt-in multi-file session; send files one by one and wait for each result',
    '  • <code>/batchconvert done</code> / <code>/batchconvert cancel</code> – finish or stop the batch',
    '  • <code>/supported</code> – see formats accepted by the sticker converter',
    '  Conversion runs only after /convert or /batchconvert; ordinary forwarded GIFs are ignored by the converter. Forward output to @Stickers.',
    '',
    '<b>🔍 Utilities</b>',
    '  • <code>/stats</code> – usage statistics',
    '  • <code>/dedupe</code> – preview likely visual duplicates',
    '  • <code>/dedupe apply</code> – merge matches after reviewing the preview',
    '',
  );

  return joinWithinLimit(lines, TELEGRAM_MESSAGE_LIMIT);
}

/**
 * Build the Group Chats Admin panel.
 */
export function buildGroupAdminPanel(): BuiltMessage {
  const lines: string[] = [
    '👥 <b>Group Chats Admin Panel</b>',
    '',
    '<b>🔒 Command Locking</b>',
    '  • <code>/lock &lt;cmd&gt;</code> – disable a command',
    '  • <code>/unlock &lt;cmd&gt;</code> – enable a command',
    '  • <code>/locks</code> – list locked commands',
    '',
    '<b>🔞 NSFW Settings</b>',
    '  • <code>/lewdmode on|off</code> – enable/disable lewd commands',
    '  • With Lewd Mode off, reply <code>#lewd</code> to a bot GIF to hide it in this group; reply <code>#safe</code> to undo.',
    '  • <code>/lewdgifs</code> – browse hidden GIFs and mark one safe without finding its old message.',
    '',
    '<b>💬 Message Settings</b>',
    '  • <code>/bluetextmode on|off</code>',
    '    on = keep command message visible',
    '    off = delete command message after sending',
  ];

  return joinWithinLimit(lines, TELEGRAM_MESSAGE_LIMIT);
}

export function buildExpressionListMessage(expressions: Expression[]): BuiltMessage {
  const safe = expressions.filter((e) => !e.is_lewd);
  const lewd = expressions.filter((e) => e.is_lewd);

  const fmt = (e: Expression) => {
    const aliases = e.aliases.map((a) => `<code>/${escapeHtml(a)}</code>`).join(', ');
    return `  • <code>/${escapeHtml(e.name)}</code>${aliases ? ` (aliases: ${aliases})` : ''}`;
  };

  const lines: string[] = ['🎭 <b>Expressions &amp; Aliases</b>', '', '<b>Safe Expressions</b>', ...commandGrid(safe.map(fmt))];
  if (lewd.length > 0) {
    lines.push('', '<b>🔞 Lewd Expressions</b> (require <code>/lewdmode on</code>)', ...commandGrid(lewd.map(fmt)));
  }
  lines.push('', 'Reply to a user, or use <code>/&lt;cmd&gt; @username</code>, to send a GIF.');

  return joinWithinLimit(lines, TELEGRAM_MESSAGE_LIMIT);
}

export function buildStatsMessage(stats: Array<{ expression: string; count: number }>): BuiltMessage {
  const lines = [
    '📊 <b>Usage Statistics</b>',
    '',
    ...stats.map((s) => `• <code>/${escapeHtml(s.expression)}</code>: ${s.count} GIF${s.count === 1 ? '' : 's'}`),
  ];
  return joinWithinLimit(lines, TELEGRAM_MESSAGE_LIMIT);
}

/** Return only the text portion for inline panel use */
export function buildStatsMessageText(stats: Array<{ expression: string; count: number }>): string {
  return buildStatsMessage(stats).text;
}

/**
 * Build the comprehensive help message (used for text fallback).
 * This is a legacy function that provides a complete help overview.
 */
export function buildHelpMessage(expressions: Expression[]): BuiltMessage {
  const safe = expressions.filter((e) => !e.is_lewd);
  const lewd = expressions.filter((e) => e.is_lewd);
  const example = safe[0]?.name ?? expressions[0]?.name ?? 'hug';

  const lines: string[] = [
    '🤖 <b>Kurisu Gif Bot</b>',
    '',
    `Reply to a user with <code>/${escapeHtml(example)}</code> to send a themed GIF.`,
    '',
    '<b>🎭 Expressions</b>',
    ...expressionCommandGrid(safe),
  ];

  if (lewd.length > 0) {
    lines.push('', '🔞 <b>Lewd Expressions</b> (requires <code>/lewdmode on</code> in groups)');
    lines.push(...expressionCommandGrid(lewd));
  }

  lines.push(
    '',
    '<b>🔧 Utility</b>',
    '  • <code>/ping</code> – bot status, response latency, database, and uptime',
    '  • <code>/stats</code> – usage statistics',
    '  • <code>/sauce</code> – reverse search an image, GIF, video, or sticker',
    '',
    '<b>👥 Group Admin</b>',
    '  • <code>/lewdmode on|off</code> – enable/disable lewd commands',
    '  • With Lewd Mode off, reply <code>#lewd</code> to a bot GIF to hide it in this group; reply <code>#safe</code> to undo.',
    '  • <code>/lewdgifs</code> – browse hidden GIFs and mark one safe without finding its old message.',
    '  • <code>/lock</code> / <code>/unlock</code> – per-chat command locking',
    '  • <code>/bluetextmode on|off</code> – message visibility settings',
    '',
    `<i>Example: /${escapeHtml(example)} (reply to user)</i>`,
    `<i>Or: /${escapeHtml(example)} @username (no reply needed)</i>`,
  );

  return joinWithinLimit(lines, TELEGRAM_MESSAGE_LIMIT);
}

/**
 * The admin list, env-configured admins first. ADMIN_IDS holders are not rows
 * in the database, so they would otherwise be invisible here — and they are the
 * only admins a fresh deployment has.
 */
export function buildAdminsMessage(admins: AdminUser[], envAdminIds: number[]): BuiltMessage {
  const lines = ['<b>Bot admins:</b>'];
  for (const id of envAdminIds) {
    lines.push(`• User ${id} (from ADMIN_IDS)`);
  }
  for (const a of admins) {
    if (envAdminIds.includes(a.user_id)) continue; // already listed above
    const who = a.username ? `@${field(a.username)}` : `User ${a.user_id}`;
    lines.push(`• ${who} (added by ${a.added_by})`);
  }
  return joinWithinLimit(lines, TELEGRAM_MESSAGE_LIMIT);
}

export function buildLocksMessage(commands: string[]): BuiltMessage {
  const lines = [
    '<b>Locked commands in this chat:</b>',
    ...commands.map((cmd) => `  • /${escapeHtml(cmd)}`),
  ];
  return joinWithinLimit(lines, TELEGRAM_MESSAGE_LIMIT);
}

export interface SauceCaptionInput {
  traceMoe?: TraceMoeResult | null;
  sauceNao?: SauceNaoResult | null;
  iqdb?: IqdbResult | null;
  googleLensUrl?: string;
  yandexUrl?: string;
  /** Served from the local cache, so say so rather than implying a fresh search. */
  cached?: boolean;
}

export interface SauceLinkKeyboard {
  inline_keyboard: Array<Array<{ text: string; url: string }>>;
}

function fullTimestamp(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remainder = safe % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${remainder.toString().padStart(2, '0')}`;
}

/**
 * The /sauce result. One builder for both the cached and the live path: when
 * they were separate copies they drifted, and the cached copy was the one that
 * forgot things.
 */
export function buildSauceCaption(input: SauceCaptionInput): BuiltMessage {
  const lines: string[] = [`🔎 <b>Reverse Image Search</b>${input.cached ? ' <i>(cached)</i>' : ''}`, ''];

  if (input.traceMoe) {
    const t = input.traceMoe;
    lines.push('<b>Anime match</b>', `<b>${field(t.animeTitle ?? 'Unknown title')}</b>`);
    if (t.animeRomaji && t.animeRomaji !== t.animeTitle) lines.push(`<i>${field(t.animeRomaji)}</i>`);
    lines.push('');
    const episodeValue = t.episode === null || t.episode === undefined ? undefined : String(t.episode);
    const formattedEpisode = episodeValue && /^\d+$/.test(episodeValue)
      ? episodeValue.padStart(2, '0')
      : episodeValue && field(episodeValue);
    const episode = formattedEpisode ? `🎬 Episode ${formattedEpisode}` : undefined;
    const episodeDetails = [episode, t.format && field(t.format), t.year].filter(Boolean).join(' · ');
    if (episodeDetails) lines.push(episodeDetails);
    const sceneFrom = Number.isFinite(t.from) ? t.from : 0;
    const sceneTo = Number.isFinite(t.to) ? t.to : sceneFrom;
    const sceneDuration = Math.max(0, sceneTo - sceneFrom);
    const sceneTime = typeof t.at === 'number' && Number.isFinite(t.at) ? t.at : sceneFrom;
    lines.push(`⏱ <b>Scene</b>  ${fullTimestamp(sceneTime)} · ${sceneDuration.toFixed(1)} sec`);
    if (t.sourceDuration !== undefined && t.sourceDuration > 0) {
      lines.push(`🎞 <b>Runtime</b>  ${fullTimestamp(t.sourceDuration)}`);
    }
    lines.push(`🎯 <b>Similarity</b>  ${percent(t.similarity)}`);
    lines.push('');
  }

  if (input.sauceNao) {
    const s = input.sauceNao;
    const isPageSource = /manga|comic|novel|book/i.test(s.sourceType ?? '');
    lines.push(`${isPageSource ? '📖' : '🎨'} <b>${isPageSource ? 'Manga / print match' : 'Artwork match'}</b>`, `<b>${field(s.title ?? 'Unknown title')}</b>`);
    if (s.authorName) lines.push(`<i>${field(s.authorName)}</i>`);
    lines.push(`🎯 <b>Similarity</b>  ${percent(s.similarity)}`);
    lines.push('');
  }

  if (input.iqdb?.matches.length) {
    lines.push('📖 <b>IQDB artwork matches</b>');
    for (const match of input.iqdb.matches) {
      const sources = match.sources.length ? match.sources.map(field).join(' · ') : 'Image match';
      const rating = match.rating ? ` · ${field(match.rating)}` : '';
      lines.push(`${sources}${rating} · ${percent(match.similarity)}`);
    }
    lines.push('');
  }

  if (!input.traceMoe && !input.sauceNao && !input.iqdb?.matches.length) {
    lines.push('No confident match found. Try another frame or use one of the image search buttons below.', '');
  }

  // Keep the result compact; source links are presented as inline buttons.
  return joinWithinLimit(lines, TELEGRAM_CAPTION_LIMIT);
}

export function buildSauceKeyboard(input: SauceCaptionInput): SauceLinkKeyboard | undefined {
  const catalog: Array<{ text: string; url: string }> = [];
  const trace = input.traceMoe;
  if (trace?.anilistId) catalog.push({ text: 'AniList', url: `https://anilist.co/anime/${trace.anilistId}` });
  if (trace?.malId) catalog.push({ text: 'MyAnimeList', url: `https://myanimelist.net/anime/${trace.malId}` });
  if (trace?.anidbUrl) catalog.push({ text: 'AniDB', url: trace.anidbUrl });
  const sources: Array<{ text: string; url: string }> = [];
  if (input.sauceNao?.sourceUrl && /^https:\/\//i.test(input.sauceNao.sourceUrl)) {
    sources.push({ text: 'Source', url: input.sauceNao.sourceUrl });
  }
  if (input.sauceNao?.authorUrl && /^https:\/\//i.test(input.sauceNao.authorUrl)) {
    sources.push({ text: 'Artist', url: input.sauceNao.authorUrl });
  }
  for (const match of input.iqdb?.matches ?? []) {
    if (match.sourceUrl.startsWith('https://')) {
      sources.push({ text: `IQDB · ${percent(match.similarity)}`, url: match.sourceUrl });
    }
  }

  const alternatives: Array<{ text: string; url: string }> = [];
  if (input.googleLensUrl) alternatives.push({ text: 'Google Lens', url: input.googleLensUrl });
  if (input.yandexUrl) alternatives.push({ text: 'Yandex', url: input.yandexUrl });
  const rows = [catalog, sources, alternatives].filter((row) => row.length > 0);
  return rows.length ? { inline_keyboard: rows } : undefined;
}
