import 'dotenv/config';
import { createClient, type Client } from '@libsql/client';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { runMigrations } from './client.js';

type LocalExpression = {
  name: string;
  aliases: string;
  caption_template: string;
  is_lewd: number;
  direction: string;
};

type LocalMedia = {
  id: number;
  file_id: string;
  file_unique_id: string;
  phash: string | null;
  usage_count: number;
  is_lewd: number;
  created_at: string;
  channel_msg_id: number | null;
};

async function count(db: Client, table: string): Promise<number> {
  const result = await db.execute(`SELECT COUNT(*) AS count FROM ${table}`);
  return Number(result.rows[0]?.count ?? 0);
}

async function main() {
  const url = process.env.TURSO_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) {
    throw new Error('Set TURSO_URL and TURSO_AUTH_TOKEN in .env before importing.');
  }
  if (!url.startsWith('libsql://') && !url.startsWith('https://')) {
    throw new Error('TURSO_URL must point to a remote libSQL/Turso database.');
  }

  const source = createClient({
    url: pathToFileURL(join(process.cwd(), 'data', 'bot.db')).href,
  });
  const target = createClient({ url, authToken });

  try {
    const [expressions, media, links] = await Promise.all([
      source.execute('SELECT name, aliases, caption_template, is_lewd, direction FROM expressions ORDER BY id'),
      source.execute('SELECT id, file_id, file_unique_id, phash, usage_count, is_lewd, created_at, channel_msg_id FROM media ORDER BY id'),
      source.execute(`SELECT m.file_unique_id, e.name AS expression_name
        FROM media_expressions me
        JOIN media m ON m.id = me.media_id
        JOIN expressions e ON e.id = me.expression_id
        ORDER BY m.id, e.name`),
    ]);

    const sourceExpressions = expressions.rows as unknown as LocalExpression[];
    const sourceMedia = media.rows as unknown as LocalMedia[];
    const sourceLinks = links.rows as unknown as Array<{ file_unique_id: string; expression_name: string }>;
    console.log(`Local SQLite: ${sourceExpressions.length} expressions, ${sourceMedia.length} GIFs, ${sourceLinks.length} expression tags.`);
    console.log(`Turso before import: ${await count(target, 'expressions')} expressions, ${await count(target, 'media')} GIFs.`);

    if (!process.argv.includes('--apply')) {
      console.log('Preview only; rerun with --apply to import these records.');
      return;
    }

    await runMigrations(target);

    // Local expression definitions are the source of truth for matching names.
    for (const expression of sourceExpressions) {
      await target.execute({
        sql: `INSERT INTO expressions (name, aliases, caption_template, is_lewd, direction)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET
            aliases = excluded.aliases,
            caption_template = excluded.caption_template,
            is_lewd = excluded.is_lewd,
            direction = excluded.direction`,
        args: [expression.name, expression.aliases, expression.caption_template, expression.is_lewd, expression.direction],
      });
    }

    for (const item of sourceMedia) {
      await target.execute({
        sql: `INSERT INTO media (file_id, file_unique_id, phash, usage_count, is_lewd, created_at, channel_msg_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(file_unique_id) DO UPDATE SET
            file_id = excluded.file_id,
            phash = COALESCE(media.phash, excluded.phash),
            usage_count = MAX(media.usage_count, excluded.usage_count),
            is_lewd = MAX(media.is_lewd, excluded.is_lewd),
            channel_msg_id = COALESCE(media.channel_msg_id, excluded.channel_msg_id)`,
        args: [item.file_id, item.file_unique_id, item.phash, item.usage_count, item.is_lewd, item.created_at, item.channel_msg_id],
      });
    }

    for (const link of sourceLinks) {
      await target.execute({
        sql: `INSERT OR IGNORE INTO media_expressions (media_id, expression_id)
          SELECT m.id, e.id FROM media m, expressions e
          WHERE m.file_unique_id = ? AND LOWER(e.name) = LOWER(?)`,
        args: [link.file_unique_id, link.expression_name],
      });
    }

    console.log(`Turso after import: ${await count(target, 'expressions')} expressions, ${await count(target, 'media')} GIFs, ${await count(target, 'media_expressions')} expression tags.`);
    console.log('Import complete. The original local SQLite database was not modified.');
  } finally {
    source.close();
    target.close();
  }
}

main().catch((err: unknown) => {
  console.error('Local SQLite to Turso import failed:', err);
  process.exitCode = 1;
});
