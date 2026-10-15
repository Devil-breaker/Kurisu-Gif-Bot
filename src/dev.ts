import 'dotenv/config';
import { buildBotCommands, createBot } from './bot.js';

async function main() {
  console.log('Starting Kurisu Gif Bot (long polling)...');
  const bot = createBot();

  // Replaces the previous default menu, removing dynamic expressions/aliases.
  await bot.api.setMyCommands(buildBotCommands()).catch((err) => console.warn('Could not set commands:', err));

  // Auto-migrate local DB on startup (no-op for Turso if schema already applied)
  const { getDb } = await import('./db/client.js');
  const { runMigrations } = await import('./db/client.js');
  try {
    await runMigrations(getDb());
    console.log('Database schema ready.');
  } catch (err) {
    console.warn('Migration warning (may already be applied):', err);
  }

  await bot.start({
    // Drop pending updates so bot ignores messages sent while it was offline
    onStart: (me) => console.log(`Bot @${me.username} is up and running.`),
    drop_pending_updates: true,
  });
}

main().catch((err) => {
  console.error('Failed to start bot:', err);
  process.exit(1);
});
