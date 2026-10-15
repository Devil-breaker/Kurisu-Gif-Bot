import 'dotenv/config';
import { createClient } from '@libsql/client';
import { runMigrations } from './client.js';
import { createExpression } from './queries.js';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { logSafeError } from '../services/safe-log.js';

/**
 * direction:
 *   "bidirectional"   — A does X to B  (hug, kiss, slap …)
 *   "unidirectional" — A does X at B  (smile, wave, stare …)
 *   "situational"    — A is doing X; B is context, not a target  (sleep, run, kill …)
 */
type Direction = 'bidirectional' | 'unidirectional' | 'situational';

const DEFAULT_EXPRESSIONS: Array<{
  name: string;
  aliases: string[];
  template?: string;
  direction: Direction;
}> = [
  // Bidirectional — A does X to B
  { name: 'hug',      aliases: ['hugs', 'cuddle'],   template: '{from} hugs {to}',           direction: 'bidirectional' },
  { name: 'kiss',     aliases: ['kisses'],           template: '{from} kisses {to}',        direction: 'bidirectional' },
  { name: 'pat',      aliases: ['pats', 'headpat'],   template: '{from} pats {to}',          direction: 'bidirectional' },
  { name: 'slap',     aliases: ['slaps'],             template: '{from} slaps {to}',         direction: 'bidirectional' },
  { name: 'punch',    aliases: ['punches'],          template: '{from} punches {to}',       direction: 'bidirectional' },
  { name: 'bite',     aliases: ['bites'],             template: '{from} bites {to}',        direction: 'bidirectional' },
  { name: 'poke',     aliases: ['pokes'],             template: '{from} pokes {to}',         direction: 'bidirectional' },
  { name: 'tickle',   aliases: ['tickles'],           template: '{from} tickles {to}',       direction: 'bidirectional' },
  { name: 'lick',     aliases: ['licks'],             template: '{from} licks {to}',         direction: 'bidirectional' },
  { name: 'highfive', aliases: ['high-5', 'high5'],  template: '{from} high-fives {to}',    direction: 'bidirectional' },
  { name: 'dance',    aliases: ['dances', 'dancing'], template: '{from} is dancing too',      direction: 'bidirectional' },
  { name: 'cry',      aliases: ['cries', 'sob'],      template: '{from} is crying too',      direction: 'bidirectional' },
  { name: 'laugh',    aliases: ['laughs', 'lol'],     template: '{from} is laughing too',    direction: 'bidirectional' },

  // Unidirectional — A does X at B
  { name: 'smile',    aliases: ['smiles'],             template: '{from} smiles at {to}',   direction: 'unidirectional' },
  { name: 'stare',    aliases: ['stares', 'glare'],    template: '{from} stares at {to}',   direction: 'unidirectional' },
  { name: 'wave',     aliases: ['waves', 'hello'],    template: '{from} waves at {to}',    direction: 'unidirectional' },
  { name: 'angry',    aliases: ['mad', 'rage'],       template: '{from} is angry at {to}', direction: 'unidirectional' },

  // Situational — A is doing X; B is context, not a target
  { name: 'sleep',   aliases: ['sleeps', 'zzz'],     template: '{from} is sleeping',        direction: 'situational' },
  { name: 'run',      aliases: ['runs', 'chase'],    template: '{from} is running',         direction: 'situational' },
  { name: 'kill',    aliases: ['kills'],              template: '{to} — target eliminated', direction: 'situational' },
];

async function main() {
  const url = process.env.TURSO_URL;
  const db = url
    ? createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN })
    : createClient({ url: pathToFileURL(join(process.cwd(), 'data', 'bot.db')).href });

  await runMigrations(db);

  for (const expr of DEFAULT_EXPRESSIONS) {
    try {
      await createExpression(expr.name, expr.aliases, expr.template, expr.direction);
      console.log(`  + ${expr.name} (${expr.direction})`);
    } catch (err: any) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        console.log(`  ~ ${expr.name} (already exists — skipping)`);
      } else {
        throw err;
      }
    }
  }

  console.log('\n✅ Default expressions seeded.');
  db.close();
}

main().catch((err) => {
  logSafeError('seed', err);
  process.exit(1);
});
