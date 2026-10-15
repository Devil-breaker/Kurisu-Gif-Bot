/**
 * Backfill phash for media rows that lack one, optionally merging visual duplicates.
 *
 * Usage:
 *   npm run backfill:phash                  # hash every media row that has no phash yet
 *   npm run backfill:phash -- --merge       # also merge near-duplicate rows into the oldest
 *   npm run backfill:phash -- --dry-run     # report only, write nothing
 *
 * Rows whose file can no longer be downloaded (expired file_id) are left NULL;
 * they may fill in later via /sauce or a re-run of this script.
 */

import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { logSafeError } from '../services/safe-log.js';
import { createClient } from '@libsql/client';
import * as dotenv from 'dotenv';

import { loadConfig } from '../config.js';
import { runMigrations, setDb } from './client.js';
import { getMediaNeedingPhash, setMediaPhash, mergeMedia } from './queries.js';
import { computePhash, hammingDistance, PHASH_DUPLICATE_THRESHOLD } from '../services/phash.js';
import type { Media } from '../types/index.js';

dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');
const DO_MERGE = process.argv.includes('--merge');

/** Download a Telegram file to a fresh temp dir; caller removes the dir. */
async function downloadToTemp(fileId: string, botToken: string): Promise<string> {
  const infoRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!infoRes.ok) throw new Error(`getFile failed: HTTP ${infoRes.status}`);
  const info = (await infoRes.json()) as { ok: boolean; result?: { file_path?: string } };
  if (!info.ok || !info.result?.file_path) throw new Error('Telegram returned no file_path');

  // Contains the bot token: never log it.
  const fileRes = await fetch(
    `https://api.telegram.org/file/bot${botToken}/${info.result.file_path}`,
  );
  if (!fileRes.ok) throw new Error(`download failed: HTTP ${fileRes.status}`);

  const tmpDir = await mkdtemp(join(tmpdir(), 'phash-backfill-'));
  const tmpPath = join(tmpDir, 'file.bin');
  await writeFile(tmpPath, Buffer.from(await fileRes.arrayBuffer()));
  return tmpPath;
}

async function backfill(): Promise<void> {
  // Loop in batches; rows that fail keep phash NULL, so track attempted ids to
  // avoid re-processing them forever.
  const attempted = new Set<number>();
  let hashed = 0;
  let failed = 0;

  while (true) {
    const batch = (await getMediaNeedingPhash(100)).filter((r) => !attempted.has(r.id));
    if (batch.length === 0) break;

    for (const row of batch) {
      attempted.add(row.id);
      process.stdout.write(`  #${row.id} (${row.file_unique_id}) … `);
      let tmpPath: string | null = null;
      try {
        tmpPath = await downloadToTemp(row.file_id, loadConfig().BOT_TOKEN);
        const phash = await computePhash(tmpPath);
        if (!phash) {
          console.log('⚠ no hash produced, left NULL');
          failed++;
        } else if (DRY_RUN) {
          console.log(`would store ${phash}`);
        } else {
          await setMediaPhash(row.id, phash);
          console.log(`✅ ${phash}`);
        }
      } catch (err) {
        console.log(`❌ ${(err as Error).message} — left NULL (may fill via /sauce later)`);
        failed++;
      } finally {
        if (tmpPath) await rm(dirname(tmpPath), { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  console.log(`[backfill] done: ${hashed} hashed, ${failed} skipped, ${attempted.size} total.\n`);
}

/** Group all hashed media by visual similarity and merge each group into its oldest row. */
async function mergePass(): Promise<void> {
  const db = (await import('./client.js')).getDb();
  const result = await db.execute('SELECT * FROM media WHERE phash IS NOT NULL ORDER BY id');
  const all = result.rows as unknown as Media[];
  console.log(`[merge] ${all.length} row(s) with a phash; scanning for duplicates…`);

  // Union-find over all pairs within the threshold. O(n²) — fine at library
  // scale (2k rows ≈ 2M comparisons, well under a second).
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let root = x;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root)!;
    while ((parent.get(x) ?? x) !== x) {
      const next = parent.get(x)!;
      parent.set(x, root);
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const dist = hammingDistance(all[i].phash ?? '', all[j].phash ?? '');
      if (dist >= 0 && dist <= PHASH_DUPLICATE_THRESHOLD) union(all[i].id, all[j].id);
    }
  }

  const groups = new Map<number, number[]>();
  for (const m of all) {
    const root = find(m.id);
    const g = groups.get(root);
    if (g) g.push(m.id);
    else groups.set(root, [m.id]);
  }

  let removed = 0;
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    ids.sort((a, b) => a - b); // lowest id = primary (oldest row)
    const [primary, ...dupes] = ids;
    console.log(`[merge] keep #${primary}; duplicate(s): ${dupes.map((d) => `#${d}`).join(', ')}`);
    if (DRY_RUN) {
      removed += dupes.length;
      continue;
    }
    for (const dup of dupes) {
      await mergeMedia(primary, dup);
      removed++;
    }
  }

  console.log(
    `[merge] ${removed} duplicate row(s) ${DRY_RUN ? 'would be ' : ''}removed.`,
  );
}

async function main() {
  const url = process.env.TURSO_URL;
  const client = url
    ? createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN })
    : createClient({ url: pathToFileURL(join(process.cwd(), 'data', 'bot.db')).href });

  await runMigrations(client);
  setDb(client);

  console.log(`=== phash backfill ===  dry-run=${DRY_RUN} merge=${DO_MERGE}\n`);
  await backfill();
  if (DO_MERGE) await mergePass();
  console.log('\nDone.');
}

main().catch((err) => {
  logSafeError('backfill-phash', err);
  process.exit(1);
});
