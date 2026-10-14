import { createClient, type Client } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let dbClient: Client | null = null;

export function getDb(): Client {
  if (dbClient) return dbClient;
  const config = loadConfig();
  if (config.TURSO_URL) {
    dbClient = createClient({
      url: config.TURSO_URL,
      authToken: config.TURSO_AUTH_TOKEN,
    });
  } else {
    // Local file-based SQLite for development.
    // pathToFileURL handles Windows drive letters (file:///C:/...) which
    // libsql's file: handler cannot parse from a raw mixed path.
    const localPath = join(process.cwd(), 'data', 'bot.db');
    dbClient = createClient({ url: pathToFileURL(localPath).href });
  }
  return dbClient;
}

/** For tests: swap in an isolated client. */
export function setDb(client: Client): void {
  dbClient = client;
}

/** For tests: drop the cached client. */
export function resetDb(): void {
  dbClient = null;
}

export async function runMigrations(client?: Client): Promise<void> {
  const db = client ?? getDb();
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  await db.executeMultiple(schema);
  await addMissingColumns(db);
}

/**
 * SQLite has no "ADD COLUMN IF NOT EXISTS" — patch older databases created
 * before the is_nsfw columns existed. Fresh DBs are unaffected (no-op).
 */
async function addMissingColumns(db: Client): Promise<void> {
  const patches: Array<{ table: string; column: string; ddl: string }> = [
    { table: 'expressions', column: 'is_lewd', ddl: 'ALTER TABLE expressions ADD COLUMN is_lewd INTEGER NOT NULL DEFAULT 0' },
    { table: 'media', column: 'is_lewd', ddl: 'ALTER TABLE media ADD COLUMN is_lewd INTEGER NOT NULL DEFAULT 0' },
    { table: 'media', column: 'phash', ddl: 'ALTER TABLE media ADD COLUMN phash TEXT' },
    { table: 'media', column: 'channel_msg_id', ddl: 'ALTER TABLE media ADD COLUMN channel_msg_id INTEGER' },
    { table: 'expressions', column: 'direction', ddl: 'ALTER TABLE expressions ADD COLUMN direction TEXT NOT NULL DEFAULT \'bidirectional\'' },
  ];
  for (const { table, column, ddl } of patches) {
    const info = await db.execute(`PRAGMA table_info(${table})`);
    const exists = info.rows.some((r) => r.name === column);
    if (!exists) await db.execute(ddl);
  }
}
