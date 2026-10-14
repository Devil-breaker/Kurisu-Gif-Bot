import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createBot } from '../src/bot.js';
import { loadConfig } from '../src/config.js';
import { getDb } from '../src/db/client.js';

// grammY docs: a webhook function must return an explicit response and must
// not let the bot process update processing errors uncaught — wrap in try/catch.
const bot = createBot();
const config = loadConfig();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }

  // Telegram sets X-Telegram-Bot-Api-Secret-Token to the secret_token
  // value given in setWebhook; verify it to reject spoofed calls.
  if (config.WEBHOOK_SECRET) {
    const provided = req.headers['x-telegram-bot-api-secret-token'];
    if (provided !== config.WEBHOOK_SECRET) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }
  }

  // Ensure DB schema exists before handling (no-op after first request per instance)
  await getDb().execute('SELECT 1');

  try {
    await bot.handleUpdate(req.body as never);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('handleUpdate failed:', err);
    // Always 200 for Telegram so it doesn't retry-spam; the error is logged.
    res.status(200).json({ ok: false });
  }
}
