import { getDb } from './client.js';
import type { Expression, Media, AdminUser, SearchCacheEntry, ChannelExpressionMapEntry, ChatSettings } from '../types/index.js';

function parseAliases(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

function rowToExpression(row: Record<string, unknown>): Expression {
  return {
    id: row.id as number,
    name: row.name as string,
    aliases: parseAliases((row.aliases as string) ?? '[]'),
    caption_template: (row.caption_template as string) ?? '{from} {action} {to}!',
    is_lewd: (row.is_lewd as number) ?? 0,
    direction: (row.direction as 'bidirectional' | 'unidirectional' | 'situational') ?? 'bidirectional',
  };
}

// ─── Expressions ────────────────────────────────────────────────────────────

export async function getExpressionByName(name: string): Promise<Expression | null> {
  const db = getDb();
  const result = await db.execute({
    sql: 'SELECT * FROM expressions WHERE LOWER(name) = LOWER(?) LIMIT 1',
    args: [name],
  });
  if (result.rows.length === 0) return null;
  return rowToExpression(result.rows[0]);
}

export async function getExpressionByAlias(alias: string): Promise<Expression | null> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT * FROM expressions WHERE LOWER(name) = LOWER(?)
          OR EXISTS (
            SELECT 1 FROM json_each(expressions.aliases)
            WHERE LOWER(json_each.value) = LOWER(?)
          )
          LIMIT 1`,
    args: [alias, alias],
  });
  if (result.rows.length === 0) return null;
  return rowToExpression(result.rows[0]);
}

export async function listExpressions(): Promise<Expression[]> {
  const db = getDb();
  const result = await db.execute('SELECT * FROM expressions ORDER BY name');
  return result.rows.map(rowToExpression);
}

export async function createExpression(
  name: string,
  aliases: string[] = [],
  captionTemplate?: string,
  direction: 'bidirectional' | 'unidirectional' | 'situational' = 'bidirectional',
): Promise<Expression> {
  const db = getDb();
  const result = await db.execute({
    sql: 'INSERT INTO expressions (name, aliases, caption_template, direction) VALUES (?, ?, ?, ?) RETURNING *',
    args: [name.toLowerCase(), JSON.stringify(aliases), captionTemplate ?? '{from} {action} {to}!', direction],
  });
  return rowToExpression(result.rows[0]);
}

export async function deleteExpression(name: string): Promise<boolean> {
  const db = getDb();
  const result = await db.execute({
    sql: 'DELETE FROM expressions WHERE LOWER(name) = LOWER(?)',
    args: [name],
  });
  return result.rowsAffected > 0;
}

export async function updateCaptionTemplate(name: string, template: string): Promise<boolean> {
  const db = getDb();
  const result = await db.execute({
    sql: 'UPDATE expressions SET caption_template = ? WHERE LOWER(name) = LOWER(?)',
    args: [template, name],
  });
  return result.rowsAffected > 0;
}

// ─── Media & Tagging ────────────────────────────────────────────────────────

export async function getMediaByFileUniqueId(fileUniqueId: string): Promise<Media | null> {
  const db = getDb();
  const result = await db.execute({
    sql: 'SELECT * FROM media WHERE file_unique_id = ? LIMIT 1',
    args: [fileUniqueId],
  });
  if (result.rows.length === 0) return null;
  return result.rows[0] as unknown as Media;
}

/** Mark media as lewd only for one chat; this does not alter its global label. */
export async function markMediaLewdInChat(chatId: number, mediaId: number, markedBy: number): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO chat_lewd_media (chat_id, media_id, marked_by) VALUES (?, ?, ?)
          ON CONFLICT(chat_id, media_id) DO UPDATE SET marked_by = excluded.marked_by`,
    args: [chatId, mediaId, markedBy],
  });
}

/** Remove a chat-specific lewd override. */
export async function unmarkMediaLewdInChat(chatId: number, mediaId: number): Promise<boolean> {
  const db = getDb();
  const result = await db.execute({
    sql: 'DELETE FROM chat_lewd_media WHERE chat_id = ? AND media_id = ?',
    args: [chatId, mediaId],
  });
  return result.rowsAffected > 0;
}

/** Number of media entries marked lewd in one chat. */
export async function countChatLewdMedia(chatId: number): Promise<number> {
  const db = getDb();
  const result = await db.execute({
    sql: 'SELECT COUNT(*) AS count FROM chat_lewd_media WHERE chat_id = ?',
    args: [chatId],
  });
  return Number(result.rows[0]?.count ?? 0);
}

/** Fetch one stable page of chat-only lewd media for the admin browser. */
export async function getChatLewdMediaPage(chatId: number, offset: number, limit = 1): Promise<Media[]> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT m.* FROM media m
          JOIN chat_lewd_media clm ON clm.media_id = m.id
          WHERE clm.chat_id = ?
          ORDER BY clm.created_at, clm.media_id
          LIMIT ? OFFSET ?`,
    args: [chatId, limit, offset],
  });
  return result.rows as unknown as Media[];
}

/**
 * Upsert a media record, keyed on file_unique_id.
 * If phash is provided, stores it; ON CONFLICT uses COALESCE so an existing
 * hash is never overwritten by a null (which can happen when a re-encoded copy
 * comes in without a computed hash yet).
 */
export async function insertMedia(
  fileId: string,
  fileUniqueId: string,
  isLewd = 0,
  phash?: string | null,
  channelMsgId?: number | null,
): Promise<Media> {
  const db = getDb();
  const result = await db.execute({
    sql: `INSERT INTO media (file_id, file_unique_id, is_lewd, phash, channel_msg_id) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(file_unique_id) DO UPDATE SET
            file_id = excluded.file_id,
            is_lewd = excluded.is_lewd,
            phash = COALESCE(media.phash, excluded.phash),
            channel_msg_id = COALESCE(media.channel_msg_id, excluded.channel_msg_id)
          RETURNING *`,
    args: [fileId, fileUniqueId, isLewd, phash ?? null, channelMsgId ?? null],
  });
  return result.rows[0] as unknown as Media;
}

/** List media rows that still need a phash computed (for backfill). */
export async function getMediaNeedingPhash(limit = 100): Promise<Media[]> {
  const db = getDb();
  const result = await db.execute({
    sql: 'SELECT * FROM media WHERE phash IS NULL ORDER BY id LIMIT ?',
    args: [limit],
  });
  return result.rows as unknown as Media[];
}

/** List all media records that have a channel message ID set. */
export async function getAllMediaWithChannelId(): Promise<Media[]> {
  const db = getDb();
  const result = await db.execute({
    sql: 'SELECT * FROM media WHERE channel_msg_id IS NOT NULL',
    args: [],
  });
  return result.rows as unknown as Media[];
}

/** Update the channel_msg_id for a media record (used by sync). */
export async function setMediaChannelMsgId(mediaId: number, channelMsgId: number | null): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: 'UPDATE media SET channel_msg_id = ? WHERE id = ?',
    args: [channelMsgId, mediaId],
  });
}

export async function setMediaChannelMsgIdIfMissing(mediaId: number, channelMsgId: number): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: 'UPDATE media SET channel_msg_id = ? WHERE id = ? AND channel_msg_id IS NULL',
    args: [channelMsgId, mediaId],
  });
}

/** Set the phash for one media row. */
export async function setMediaPhash(mediaId: number, phash: string): Promise<void> {
  const db = getDb();
  await db.execute({ sql: 'UPDATE media SET phash = ? WHERE id = ?', args: [phash, mediaId] });
}

/** Mark a media row lewd (e.g. a re-upload carried a #lewd tag). */
export async function setMediaLewd(mediaId: number): Promise<void> {
  const db = getDb();
  await db.execute({ sql: 'UPDATE media SET is_lewd = 1 WHERE id = ?', args: [mediaId] });
}

/**
 * Merge duplicate media into the primary.
 * Re-points all media_expressions from the duplicate to the primary, then deletes the
 * duplicate.  Returns true if any expressions were moved.
 */
export async function mergeMedia(primaryId: number, duplicateId: number): Promise<boolean> {
  const db = getDb();
  await db.execute({
    sql: `UPDATE media SET
            usage_count = usage_count + COALESCE((SELECT usage_count FROM media WHERE id = ?), 0),
            is_lewd = MAX(is_lewd, COALESCE((SELECT is_lewd FROM media WHERE id = ?), 0)),
            channel_msg_id = COALESCE(channel_msg_id, (SELECT channel_msg_id FROM media WHERE id = ?))
          WHERE id = ?`,
    args: [duplicateId, duplicateId, duplicateId, primaryId],
  });
  // Move expression links from duplicate → primary
  await db.execute({
    sql: `INSERT OR IGNORE INTO media_expressions (media_id, expression_id)
          SELECT ?, expression_id FROM media_expressions WHERE media_id = ?`,
    args: [primaryId, duplicateId],
  });
  await db.execute({
    sql: `INSERT INTO chat_lewd_media (chat_id, media_id, marked_by, created_at)
          SELECT chat_id, ?, marked_by, created_at FROM chat_lewd_media WHERE media_id = ?
          ON CONFLICT(chat_id, media_id) DO NOTHING`,
    args: [primaryId, duplicateId],
  });
  const moved = await db.execute({
    sql: 'DELETE FROM media_expressions WHERE media_id = ?',
    args: [duplicateId],
  });
  await db.execute({ sql: 'DELETE FROM chat_lewd_media WHERE media_id = ?', args: [duplicateId] });
  // Delete the duplicate media row
  await db.execute({ sql: 'DELETE FROM media WHERE id = ?', args: [duplicateId] });
  return moved.rowsAffected > 0;
}

/**
 * Find an existing media row whose dHash is within threshold bits of the given hash.
 * Linear scan is correct at bot scale (thousands of rows); returns null if no close match.
 */
export async function findVisualDuplicate(
  phash: string,
  threshold = 8,
): Promise<{ media: Media; distance: number } | null> {
  const db = getDb();
  const result = await db.execute({
    sql: 'SELECT id, file_id, file_unique_id, phash, usage_count, is_lewd, channel_msg_id, created_at FROM media WHERE phash IS NOT NULL',
    args: [],
  });
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const { hammingDistance } = await import('../services/phash.js');

  let best: { media: Media; distance: number } | null = null;
  for (const row of result.rows) {
    const existingHash = row.phash as string;
    const dist = hammingDistance(phash, existingHash);
    if (dist >= 0 && dist <= threshold && (best === null || dist < best.distance)) {
      best = { media: row as unknown as Media, distance: dist };
    }
  }
  return best;
}

export async function linkMediaToExpression(mediaId: number, expressionId: number): Promise<boolean> {
  const db = getDb();
  const result = await db.execute({
    sql: `INSERT OR IGNORE INTO media_expressions (media_id, expression_id) VALUES (?, ?)`,
    args: [mediaId, expressionId],
  });
  return result.rowsAffected > 0;
}

export async function unlinkMediaFromExpression(mediaId: number, expressionId: number): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: 'DELETE FROM media_expressions WHERE media_id = ? AND expression_id = ?',
    args: [mediaId, expressionId],
  });
}

export async function getRandomMediaForExpression(
  expressionId: number,
  allowLewd = false,
  chatId?: number,
): Promise<Media | null> {
  const db = getDb();
  const lewdClause = allowLewd ? '' : 'AND m.is_lewd = 0';
  const result = await db.execute({
    sql: `SELECT m.* FROM media m
          JOIN media_expressions me ON me.media_id = m.id
          WHERE me.expression_id = ? ${lewdClause}
            AND (? IS NULL OR NOT EXISTS (
              SELECT 1 FROM chat_lewd_media clm WHERE clm.chat_id = ? AND clm.media_id = m.id
            ))
          -- Balance use across the eligible library; break ties randomly so
          -- similarly used GIFs still feel unpredictable.
          ORDER BY m.usage_count ASC, RANDOM() LIMIT 1`,
    args: [expressionId, chatId ?? null, chatId ?? null],
  });
  if (result.rows.length === 0) return null;
  return result.rows[0] as unknown as Media;
}

export async function countMediaForExpression(expressionId: number): Promise<number> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT COUNT(*) as count FROM media_expressions WHERE expression_id = ?`,
    args: [expressionId],
  });
  return Number(result.rows[0]?.count ?? 0);
}

export async function incrementUsage(mediaId: number): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: 'UPDATE media SET usage_count = usage_count + 1 WHERE id = ?',
    args: [mediaId],
  });
}

export async function getMediaStats(): Promise<{ expression: string; count: number }[]> {
  const db = getDb();
  const result = await db.execute(`
    SELECT e.name as expression, COUNT(me.media_id) as count
    FROM expressions e
    LEFT JOIN media_expressions me ON me.expression_id = e.id
    GROUP BY e.name
    ORDER BY count DESC, e.name
  `);
  return result.rows.map((r) => ({
    expression: r.expression as string,
    count: Number(r.count),
  }));
}

export async function getAvailableExpressionNames(allowLewd = false, chatId?: number): Promise<string[]> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT DISTINCT e.name
          FROM expressions e
          JOIN media_expressions me ON me.expression_id = e.id
          JOIN media m ON m.id = me.media_id
          WHERE (? = 1 OR (e.is_lewd = 0 AND m.is_lewd = 0))
            AND (? IS NULL OR NOT EXISTS (
              SELECT 1 FROM chat_lewd_media clm WHERE clm.chat_id = ? AND clm.media_id = m.id
            ))
          ORDER BY e.name`,
    args: [allowLewd ? 1 : 0, chatId ?? null, chatId ?? null],
  });
  return result.rows.map((row) => row.name as string);
}

export async function deleteMediaByFileUniqueId(fileUniqueId: string): Promise<boolean> {
  const db = getDb();
  await db.execute({
    sql: 'DELETE FROM chat_lewd_media WHERE media_id = (SELECT id FROM media WHERE file_unique_id = ?)',
    args: [fileUniqueId],
  });
  const result = await db.execute({
    sql: 'DELETE FROM media WHERE file_unique_id = ?',
    args: [fileUniqueId],
  });
  return result.rowsAffected > 0;
}

export async function deleteMediaById(mediaId: number): Promise<boolean> {
  const db = getDb();
  await db.execute({ sql: 'DELETE FROM media_expressions WHERE media_id = ?', args: [mediaId] });
  await db.execute({ sql: 'DELETE FROM chat_lewd_media WHERE media_id = ?', args: [mediaId] });
  const result = await db.execute({ sql: 'DELETE FROM media WHERE id = ?', args: [mediaId] });
  return result.rowsAffected > 0;
}

// ─── Admins ─────────────────────────────────────────────────────────────────

export async function isAdmin(userId: number): Promise<boolean> {
  const db = getDb();
  const result = await db.execute({
    sql: 'SELECT 1 FROM admins WHERE user_id = ? LIMIT 1',
    args: [userId],
  });
  return result.rows.length > 0;
}

export async function addAdmin(userId: number, username: string | null, addedBy: number): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO admins (user_id, username, added_by) VALUES (?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET username = excluded.username`,
    args: [userId, username, addedBy],
  });
}

export async function removeAdmin(userId: number): Promise<boolean> {
  const db = getDb();
  const result = await db.execute({
    sql: 'DELETE FROM admins WHERE user_id = ?',
    args: [userId],
  });
  return result.rowsAffected > 0;
}

export async function listAdmins(): Promise<AdminUser[]> {
  const db = getDb();
  // rowid preserves insertion order (created_at has only centisecond precision)
  const result = await db.execute('SELECT * FROM admins ORDER BY rowid');
  return result.rows.map((row) => ({
    user_id: row.user_id as number,
    username: (row.username as string) ?? null,
    added_by: row.added_by as number,
    created_at: row.created_at as string,
  }));
}

// ─── Search Cache ───────────────────────────────────────────────────────────

export async function getSearchCache(fileUniqueId: string, provider: string): Promise<string | null> {
  const db = getDb();
  const result = await db.execute({
    sql: 'SELECT result_json FROM search_cache WHERE file_unique_id = ? AND provider = ? LIMIT 1',
    args: [fileUniqueId, provider],
  });
  if (result.rows.length === 0) return null;
  return result.rows[0].result_json as string;
}

export async function setSearchCache(
  fileUniqueId: string,
  provider: string,
  resultJson: string
): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO search_cache (file_unique_id, provider, result_json) VALUES (?, ?, ?)
          ON CONFLICT(file_unique_id, provider) DO UPDATE SET result_json = excluded.result_json, created_at = excluded.created_at`,
    args: [fileUniqueId, provider, resultJson],
  });
}

export async function clearSearchCache(fileUniqueId?: string): Promise<number> {
  const db = getDb();
  if (fileUniqueId) {
    const result = await db.execute({
      sql: 'DELETE FROM search_cache WHERE file_unique_id = ?',
      args: [fileUniqueId],
    });
    return result.rowsAffected;
  }
  const result = await db.execute('DELETE FROM search_cache');
  return result.rowsAffected;
}

// ─── Chat Settings ────────────────────────────────────────────────────────

export async function getChatSettings(chatId: number): Promise<ChatSettings> {
  const db = getDb();
  const result = await db.execute({
    sql: 'SELECT * FROM chat_settings WHERE chat_id = ?',
    args: [chatId],
  });
  if (result.rows.length) {
    const row = result.rows[0];
    return {
      chat_id: row.chat_id as number,
      lewd_mode: row.lewd_mode as number,
      bluetext: row.bluetext as number,
      disabled_commands: JSON.parse(row.disabled_commands as string ?? '[]'),
    };
  }
  await db.execute({
    sql: `INSERT INTO chat_settings (chat_id, lewd_mode, bluetext, disabled_commands)
          VALUES (?, 0, 1, '[]')`,
    args: [chatId],
  });
  return { chat_id: chatId, lewd_mode: 0, bluetext: 1, disabled_commands: [] };
}

export async function upsertChatSettings(
  chatId: number,
  updates: Partial<Omit<ChatSettings, 'chat_id'>>
): Promise<void> {
  const db = getDb();
  const current = await getChatSettings(chatId);
  const merged = { ...current, ...updates };
  await db.execute({
    sql: `INSERT INTO chat_settings (chat_id, lewd_mode, bluetext, disabled_commands)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(chat_id) DO UPDATE SET
            lewd_mode = excluded.lewd_mode,
            bluetext = excluded.bluetext,
            disabled_commands = excluded.disabled_commands`,
    args: [
      chatId,
      merged.lewd_mode,
      merged.bluetext,
      JSON.stringify(merged.disabled_commands),
    ],
  });
}

export async function isExpressionDisabledInChat(
  chatId: number,
  expressionName: string
): Promise<boolean> {
  const settings = await getChatSettings(chatId);
  return settings.disabled_commands.includes(expressionName.toLowerCase());
}

// ─── Channel Expression Map (from config) ──────────────────────────────────

export function resolveChannelExpression(
  channelId: number,
  map: ChannelExpressionMapEntry[] | undefined
): string | null {
  if (!map) return null;
  const entry = map.find((e) => e.channel_id === channelId);
  return entry?.expression ?? null;
}

// ─── NSFW toggle ────────────────────────────────────────────────────────────

export async function toggleExpressionLewd(name: string, on: boolean): Promise<boolean> {
  const db = getDb();
  const result = await db.execute({
    sql: 'UPDATE expressions SET is_lewd = ? WHERE LOWER(name) = LOWER(?)',
    args: [on ? 1 : 0, name],
  });
  return result.rowsAffected > 0;
}

export { parseAliases };

export type { SearchCacheEntry };
