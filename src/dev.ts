import 'dotenv/config';
import { buildBotCommands, createBot } from './bot.js';
import { logSafeError } from './services/safe-log.js';

async function main() {
  console.log('Starting Kurisu Gif Bot (long polling)...');
  const bot = createBot();

  // Replaces the previous default menu, removing dynamic expressions/aliases.
  await bot.api.setMyCommands(buildBotCommands()).catch((err) => logSafeError('commands:register', err));

  // Auto-migrate local DB on startup (no-op for Turso if schema already applied)
  const { getDb } = await import('./db/client.js');
  const { runMigrations } = await import('./db/client.js');
  try {
    await runMigrations(getDb());
    console.log('Database schema ready.');
  } catch (err) {
    logSafeError('migration', err);
  }

  await bot.start({
    // Drop pending updates so bot ignores messages sent while it was offline
    onStart: (me) => console.log(`Bot @${me.username} is up and running.`),
    drop_pending_updates: true,
  });
}

main().catch((err) => {
  logSafeError('startup', err);
  process.exit(1);
});
