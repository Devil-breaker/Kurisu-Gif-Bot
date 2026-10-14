import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient } from '@libsql/client';
import { runMigrations, setDb } from '../../src/db/client.js';
import {
  createExpression,
  deleteExpression,
  getExpressionByName,
  getExpressionByAlias,
  listExpressions,
  updateCaptionTemplate,
  insertMedia,
  getMediaByFileUniqueId,
  linkMediaToExpression,
  getRandomMediaForExpression,
  countMediaForExpression,
  incrementUsage,
  getMediaStats,
  deleteMediaByFileUniqueId,
  isAdmin,
  addAdmin,
  removeAdmin,
  listAdmins,
  getSearchCache,
  setSearchCache,
  clearSearchCache,
  getChatSettings,
  upsertChatSettings,
  isExpressionDisabledInChat,
  toggleExpressionLewd,
  getMediaNeedingPhash,
  setMediaPhash,
  mergeMedia,
  findVisualDuplicate,
} from '../../src/db/queries.js';

let db: ReturnType<typeof createClient>;

async function resetSchema() {
  db = createClient({ url: ':memory:' });
  await runMigrations(db);
  setDb(db);
}

describe('db/queries', () => {
  beforeEach(async () => {
    await resetSchema();
  });

  afterEach(() => {
    setDb(db);
  });

  // ─── Expressions ─────────────────────────────────────────────────────────

  describe('expressions', () => {
    it('creates and retrieves an expression', async () => {
      const expr = await createExpression('wave', ['waves', 'hello'], '{from} waved at {to}!');
      expect(expr.name).toBe('wave');
      expect(expr.aliases).toEqual(['waves', 'hello']);
      expect(expr.caption_template).toBe('{from} waved at {to}!');
      expect(typeof expr.id).toBe('number');
    });

    it('finds expression by exact name', async () => {
      await createExpression('hug');
      const found = await getExpressionByName('hug');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('hug');
    });

    it('finds expression by alias', async () => {
      await createExpression('kiss', ['kisses', 'love']);
      const found = await getExpressionByAlias('love');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('kiss');
    });

    it('getExpressionByName is case-insensitive', async () => {
      await createExpression('Hug');
      const found = await getExpressionByName('HUG');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('hug');
    });

    it('getExpressionByAlias is case-insensitive', async () => {
      await createExpression('dance', ['DANCES']);
      const found = await getExpressionByAlias('DANCES');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('dance');
    });

    it('returns null for non-existent expression', async () => {
      const found = await getExpressionByName('nonexistent');
      expect(found).toBeNull();
    });

    it('lists all expressions in alphabetical order', async () => {
      await createExpression('zebra');
      await createExpression('apple');
      await createExpression('mango');
      const all = await listExpressions();
      const names = all.map((e) => e.name);
      expect(names).toEqual(['apple', 'mango', 'zebra']);
    });

    it('deletes an existing expression', async () => {
      await createExpression('deleteMe');
      const deleted = await deleteExpression('deleteMe');
      expect(deleted).toBe(true);
      expect(await getExpressionByName('deleteMe')).toBeNull();
    });

    it('deleting non-existent expression returns false', async () => {
      const deleted = await deleteExpression('doesNotExist');
      expect(deleted).toBe(false);
    });

    it('updates caption template', async () => {
      await createExpression('punch', [], 'default template');
      const ok = await updateCaptionTemplate('punch', '{from} punched {to}!');
      expect(ok).toBe(true);
      const expr = await getExpressionByName('punch');
      expect(expr!.caption_template).toBe('{from} punched {to}!');
    });

    it('updateCaptionTemplate returns false for unknown expression', async () => {
      const ok = await updateCaptionTemplate('unknown', 'template');
      expect(ok).toBe(false);
    });

    it('createExpression throws on duplicate name', async () => {
      await createExpression('dup');
      await expect(createExpression('dup')).rejects.toThrow();
    });
  });

  // ─── Media & Expressions ────────────────────────────────────────────────

  describe('media', () => {
    it('inserts and retrieves media by file_unique_id', async () => {
      const media = await insertMedia('file_id_abc123', 'unique_abc123');
      expect(media.id).toBeGreaterThan(0);
      expect(media.file_id).toBe('file_id_abc123');
      expect(media.file_unique_id).toBe('unique_abc123');
      expect(media.usage_count).toBe(0);
    });

    it('insertMedia is idempotent (upsert)', async () => {
      const first = await insertMedia('id_v1', 'unique_x');
      await insertMedia('id_v2', 'unique_x'); // same unique ID
      const second = await getMediaByFileUniqueId('unique_x');
      expect(second!.id).toBe(first.id);
      expect(second!.file_id).toBe('id_v2'); // updated
    });

    it('links media to expression and retrieves it', async () => {
      const expr = await createExpression('hug');
      const media = await insertMedia('fig', 'uid_hug');
      await linkMediaToExpression(media.id, expr.id);

      const count = await countMediaForExpression(expr.id);
      expect(count).toBe(1);
    });

    it('getRandomMediaForExpression returns null when no media', async () => {
      const expr = await createExpression('orphan');
      const media = await getRandomMediaForExpression(expr.id);
      expect(media).toBeNull();
    });

    it('getRandomMediaForExpression returns a random media', async () => {
      const expr = await createExpression('lotsofgifs');
      // Insert 5 media items
      for (let i = 0; i < 5; i++) {
        const m = await insertMedia(`fid_${i}`, `uid_${i}`);
        await linkMediaToExpression(m.id, expr.id);
      }
      const media = await getRandomMediaForExpression(expr.id);
      expect(media).not.toBeNull();
      expect(media!.file_unique_id).toMatch(/^uid_/);
    });

    it('increments usage count', async () => {
      const media = await insertMedia('fid', 'uid');
      await incrementUsage(media.id);
      const after = await getMediaByFileUniqueId('uid');
      expect(after!.usage_count).toBe(1);
      await incrementUsage(media.id);
      const after2 = await getMediaByFileUniqueId('uid');
      expect(after2!.usage_count).toBe(2);
    });

    it('getMediaStats counts per expression', async () => {
      const x = await createExpression('x');
      const y = await createExpression('y');

      const mx1 = await insertMedia('f1', 'u1');
      const mx2 = await insertMedia('f2', 'u2');
      await linkMediaToExpression(mx1.id, x.id);
      await linkMediaToExpression(mx2.id, x.id);
      const my1 = await insertMedia('f3', 'u3');
      await linkMediaToExpression(my1.id, y.id);

      const stats = await getMediaStats();
      const statX = stats.find((s) => s.expression === 'x');
      const statY = stats.find((s) => s.expression === 'y');
      expect(statX?.count).toBe(2);
      expect(statY?.count).toBe(1);
    });

    it('deleteMediaByFileUniqueId removes media', async () => {
      await insertMedia('fid', 'uid_del');
      const deleted = await deleteMediaByFileUniqueId('uid_del');
      expect(deleted).toBe(true);
      expect(await getMediaByFileUniqueId('uid_del')).toBeNull();
    });
  });

  // ─── Admins ────────────────────────────────────────────────────────────

  describe('admins', () => {
    it('isAdmin returns true for added admin', async () => {
      await addAdmin(99999, null, 12345);
      expect(await isAdmin(99999)).toBe(true);
    });

    it('isAdmin returns false for non-admin', async () => {
      expect(await isAdmin(0)).toBe(false);
    });

    it('addAdmin stores username', async () => {
      await addAdmin(77777, 'testuser', 11111);
      const admins = await listAdmins();
      const added = admins.find((a) => a.user_id === 77777);
      expect(added?.username).toBe('testuser');
      expect(added?.added_by).toBe(11111);
    });

    it('removeAdmin deletes existing admin', async () => {
      await addAdmin(55555, null, 11111);
      const removed = await removeAdmin(55555);
      expect(removed).toBe(true);
      expect(await isAdmin(55555)).toBe(false);
    });

    it('removeAdmin returns false for non-existent', async () => {
      const removed = await removeAdmin(999999);
      expect(removed).toBe(false);
    });

    it('listAdmins returns all admins (user_id INTEGER PK is the rowid, so ordered by user_id)', async () => {
      await addAdmin(100, 'alpha', 0);
      await addAdmin(200, 'beta', 0);
      await addAdmin(50, 'first', 0);
      const admins = await listAdmins();
      expect(admins).toHaveLength(3);
      // user_id INTEGER PRIMARY KEY aliases the rowid, so ORDER BY rowid sorts by user_id
      expect(admins.map((a) => a.user_id)).toEqual([50, 100, 200]);
    });
  });

  // ─── Search Cache ──────────────────────────────────────────────────────

  describe('search_cache', () => {
    it('caches and retrieves a search result', async () => {
      const json = JSON.stringify({ animeTitle: 'Naruto', episode: 1 });
      await setSearchCache('uid_abc', 'combined', json);
      const cached = await getSearchCache('uid_abc', 'combined');
      expect(cached).toBe(json);
    });

    it('getSearchCache returns null for missing entry', async () => {
      const cached = await getSearchCache('never_existed', 'combined');
      expect(cached).toBeNull();
    });

    it('setSearchCache overwrites existing entry', async () => {
      await setSearchCache('uid_x', 'combined', 'v1');
      await setSearchCache('uid_x', 'combined', 'v2');
      const cached = await getSearchCache('uid_x', 'combined');
      expect(cached).toBe('v2');
    });

    it('clearSearchCache removes specific entry', async () => {
      await setSearchCache('uid_del', 'combined', 'data');
      const count = await clearSearchCache('uid_del');
      expect(count).toBe(1);
      expect(await getSearchCache('uid_del', 'combined')).toBeNull();
    });

    it('clearSearchCache with no argument clears all', async () => {
      await setSearchCache('uid_a', 'combined', 'a');
      await setSearchCache('uid_b', 'combined', 'b');
      const count = await clearSearchCache();
      expect(count).toBe(2);
    });
  });

  // ─── Chat Settings ─────────────────────────────────────────────────────

  describe('chat_settings', () => {
    it('getChatSettings returns defaults for a new chat', async () => {
      const settings = await getChatSettings(-100123);
      expect(settings).toEqual({
        chat_id: -100123,
        lewd_mode: 0,
        bluetext: 1,
        disabled_commands: [],
      });
    });

    it('upsertChatSettings toggles lewd_mode', async () => {
      await getChatSettings(-1001);
      await upsertChatSettings(-1001, { lewd_mode: 1 });
      const settings = await getChatSettings(-1001);
      expect(settings.lewd_mode).toBe(1);
      // Other fields unchanged
      expect(settings.bluetext).toBe(1);
      expect(settings.disabled_commands).toEqual([]);
    });

    it('upsertChatSettings toggles bluetext off and back on', async () => {
      await upsertChatSettings(-1002, { bluetext: 0 });
      expect((await getChatSettings(-1002)).bluetext).toBe(0);
      await upsertChatSettings(-1002, { bluetext: 1 });
      expect((await getChatSettings(-1002)).bluetext).toBe(1);
    });

    it('upsertChatSettings preserves disabled_commands across lewd toggle', async () => {
      await upsertChatSettings(-1003, { disabled_commands: ['kiss'] });
      await upsertChatSettings(-1003, { lewd_mode: 1 });
      const settings = await getChatSettings(-1003);
      expect(settings.disabled_commands).toEqual(['kiss']);
      expect(settings.lewd_mode).toBe(1);
    });

    it('settings are isolated per chat', async () => {
      await upsertChatSettings(-10, { lewd_mode: 1 });
      await upsertChatSettings(-20, { lewd_mode: 0, bluetext: 0 });
      const a = await getChatSettings(-10);
      const b = await getChatSettings(-20);
      expect(a.lewd_mode).toBe(1);
      expect(b.lewd_mode).toBe(0);
      expect(b.bluetext).toBe(0);
    });

    it('isExpressionDisabledInChat is case-insensitive and false by default', async () => {
      await createExpression('Kiss', ['kisses']);
      expect(await isExpressionDisabledInChat(-1, 'kiss')).toBe(false);
      await upsertChatSettings(-1, { disabled_commands: ['kiss'] });
      expect(await isExpressionDisabledInChat(-1, 'kiss')).toBe(true);
      expect(await isExpressionDisabledInChat(-1, 'KISS')).toBe(true);
      expect(await isExpressionDisabledInChat(-2, 'kiss')).toBe(false);
    });
  });

  // ─── Lewd expressions & media ──────────────────────────────────────────

  describe('lewd flags', () => {
    it('new expressions default to safe (is_lewd = 0)', async () => {
      const expr = await createExpression('hug');
      expect(expr.is_lewd).toBe(0);
    });

    it('toggleExpressionLewd flips is_lewd on and off', async () => {
      await createExpression('kiss');
      expect(await toggleExpressionLewd('kiss', true)).toBe(true);
      expect((await getExpressionByName('kiss'))!.is_lewd).toBe(1);
      expect(await toggleExpressionLewd('KISS', false)).toBe(true);
      expect((await getExpressionByName('kiss'))!.is_lewd).toBe(0);
    });

    it('toggleExpressionLewd returns false for unknown expression', async () => {
      expect(await toggleExpressionLewd('nope', true)).toBe(false);
    });

    it('insertMedia stores is_lewd flag', async () => {
      const safe = await insertMedia('f1', 'u1');
      const lewd = await insertMedia('f2', 'u2', 1);
      expect(safe.is_lewd).toBe(0);
      expect(lewd.is_lewd).toBe(1);
    });

    it('insertMedia upsert can mark existing media lewd', async () => {
      await insertMedia('f1', 'u1', 0);
      await insertMedia('f1', 'u1', 1);
      const media = await getMediaByFileUniqueId('u1');
      expect(media!.is_lewd).toBe(1);
      // file_id refreshed on upsert
      expect(media!.file_id).toBe('f1');
    });

    it('getRandomMediaForExpression excludes lewd media by default', async () => {
      const expr = await createExpression('hug');
      const safe = await insertMedia('safe_file', 'uid_safe', 0);
      const lewd = await insertMedia('lewd_file', 'uid_lewd', 1);
      await linkMediaToExpression(safe.id, expr.id);
      await linkMediaToExpression(lewd.id, expr.id);

      // Default (allowLewd=false) never returns the lewd media
      for (let i = 0; i < 10; i++) {
        const media = await getRandomMediaForExpression(expr.id);
        expect(media!.file_unique_id).toBe('uid_safe');
      }
    });

    it('getRandomMediaForExpression returns only lewd media when allowLewd=true and expression is all-lewd', async () => {
      const expr = await createExpression('smut');
      const lewd = await insertMedia('lewd_file', 'uid_lewd2', 1);
      await linkMediaToExpression(lewd.id, expr.id);

      expect(await getRandomMediaForExpression(expr.id, false)).toBeNull();
      const media = await getRandomMediaForExpression(expr.id, true);
      expect(media).not.toBeNull();
      expect(media!.file_unique_id).toBe('uid_lewd2');
    });

    it('media is_lewd defaults to 0 for plain inserts', async () => {
      const media = await insertMedia('f', 'u');
      expect(media.is_lewd).toBe(0);
    });
  });

  // ─── Phash & Dedupe ────────────────────────────────────────────────────────

  describe('phash & dedupe', () => {
    it('insertMedia stores and returns phash', async () => {
      const media = await insertMedia('fid1', 'uid1', 0, 'abcdef1234567890');
      expect(media.phash).toBe('abcdef1234567890');
    });

    it('insertMedia upsert keeps existing phash when new is null (COALESCE)', async () => {
      await insertMedia('fid1', 'uid_x', 0, 'deadbeefcafebabe');
      await insertMedia('fid2', 'uid_x', 0, null);
      const media = await getMediaByFileUniqueId('uid_x');
      expect(media!.phash).toBe('deadbeefcafebabe'); // original kept
    });

    it('insertMedia upsert fills NULL phash with real phash', async () => {
      await insertMedia('fid1', 'uid_y', 0, null);
      await insertMedia('fid2', 'uid_y', 0, '1111111111111111');
      const media = await getMediaByFileUniqueId('uid_y');
      expect(media!.phash).toBe('1111111111111111');
    });

    it('getMediaNeedingPhash lists only rows with NULL phash', async () => {
      await insertMedia('fid1', 'uid1', 0, null); // needs hash
      await insertMedia('fid2', 'uid2', 0, 'abcd1234abcd1234'); // has hash
      await insertMedia('fid3', 'uid3', 0, null); // needs hash

      const needing = await getMediaNeedingPhash();
      expect(needing).toHaveLength(2);
      expect(needing.map((m) => m.file_unique_id)).toEqual(['uid1', 'uid3']);
    });

    it('setMediaPhash persists and is readable', async () => {
      const media = await insertMedia('fid', 'uid', 0, null);
      await setMediaPhash(media.id, 'fedcba0987654321');
      const updated = await getMediaByFileUniqueId('uid');
      expect(updated!.phash).toBe('fedcba0987654321');
    });

    it('mergeMedia moves expression links and deletes duplicate', async () => {
      const expr = await createExpression('testexpr');
      const primary = await insertMedia('fid_p', 'uid_p', 0);
      const duplicate = await insertMedia('fid_d', 'uid_d', 0);

      await linkMediaToExpression(primary.id, expr.id);
      await linkMediaToExpression(duplicate.id, expr.id);

      const moved = await mergeMedia(primary.id, duplicate.id);
      expect(moved).toBe(true);

      // duplicate media row should be gone
      expect(await getMediaByFileUniqueId('uid_d')).toBeNull();

      // primary should remain, with both links merged
      expect(await getMediaByFileUniqueId('uid_p')).not.toBeNull();
      const count = await countMediaForExpression(expr.id);
      expect(count).toBe(1); // deduplicated: two links to same expr collapsed to one row
    });

    it('mergeMedia moves a link the primary lacks', async () => {
      const expr1 = await createExpression('exprA');
      const expr2 = await createExpression('exprB');
      const primary = await insertMedia('fid_p', 'uid_p', 0);
      const duplicate = await insertMedia('fid_d', 'uid_d', 0);

      await linkMediaToExpression(primary.id, expr1.id);
      await linkMediaToExpression(duplicate.id, expr2.id);

      await mergeMedia(primary.id, duplicate.id);

      expect(await countMediaForExpression(expr1.id)).toBe(1);
      expect(await countMediaForExpression(expr2.id)).toBe(1); // moved to primary
      const movedMedia = await getRandomMediaForExpression(expr2.id, true);
      expect(movedMedia?.id).toBe(primary.id);
    });

    it('mergeMedia is no-op when duplicate id missing', async () => {
      const primary = await insertMedia('fid_p', 'uid_p', 0);
      const moved = await mergeMedia(primary.id, 99999);
      expect(moved).toBe(false);
      expect(await getMediaByFileUniqueId('uid_p')).not.toBeNull();
    });

    it('findVisualDuplicate returns closest match within threshold', async () => {
      await insertMedia('fid1', 'uid1', 0, '000000000000000f'); // distance 4 from query
      await insertMedia('fid2', 'uid2', 0, '0000000000000003'); // distance 2 from query
      await insertMedia('fid3', 'uid3', 0, '00000000000000ff'); // distance 8 from query

      const match = await findVisualDuplicate('0000000000000000');
      expect(match).not.toBeNull();
      expect(match!.media.file_unique_id).toBe('uid2'); // closest
      expect(match!.distance).toBe(2);
    });

    it('findVisualDuplicate returns null when beyond threshold', async () => {
      await insertMedia('fid2', 'uid2', 0, 'ffffffffffffffff'); // distance 64

      expect(await findVisualDuplicate('0000000000000000', 8)).toBeNull();
    });

    it('findVisualDuplicate ignores rows with NULL phash', async () => {
      await insertMedia('fid1', 'uid1', 0, 'abcd1234abcd1234');
      await insertMedia('fid2', 'uid2', 0, null);

      const match = await findVisualDuplicate('abcd1234abcd1234');
      expect(match).not.toBeNull();
      expect(match!.media.file_unique_id).toBe('uid1');
      expect(match!.distance).toBe(0);
    });
  });
});