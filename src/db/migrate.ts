import { createClient } from '@libsql/client';
import { runMigrations } from './client.js';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { logSafeError } from '../services/safe-log.js';
import * as dotenv from 'dotenv';

dotenv.config();

async function main() {
  const url = process.env.TURSO_URL;
  const db = url
    ? createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN })
    : createClient({ url: pathToFileURL(join(process.cwd(), 'data', 'bot.db')).href });

  console.log(`Running migrations against ${url ?? 'local file:./data/bot.db'}…`);
  await runMigrations(db);
  console.log('Migrations complete.');
}

main().catch((err) => {
  logSafeError('migration', err);
  process.exit(1);
});
