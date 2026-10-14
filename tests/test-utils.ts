import { Bot, Context } from 'grammy';
import type { BotContext } from '../src/types/index.js';
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/client.js';
import { resetDb, setDb } from '../src/db/client.js';

/**
 * Create an isolated in-memory database for testing.
 */
export async function createTestDb(): Promise<ReturnType<typeof createClient>> {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  setDb(db);
  return db;
}

/** Clear the test database between tests. */
export async function clearTestDb() {
  const db = createClient({ url: ':memory:' });
  setDb(db);
  await db.executeMultiple(`
    DELETE FROM search_cache;
    DELETE FROM media_expressions;
    DELETE FROM media;
    DELETE FROM expressions;
    DELETE FROM admins;
  `);
}

/**
 * Mock Telegram context for unit tests.
 */
export function createMockContext(options: Partial<BotContext> = {}): BotContext {
  const base: BotContext = {
    // Minimal required properties from grammy Context
    update_id: 1,
    message: undefined,
    editedMessage: undefined,
    channelPost: undefined,
    editedChannelPost: undefined,
    inlineQuery: undefined,
    chosenInlineResult: undefined,
    callbackQuery: undefined,
    shippingQuery: undefined,
    preCheckoutQuery: undefined,
    poll: undefined,
    pollAnswer: undefined,
    myChatMember: undefined,
    chatMember: undefined,
    chatJoinRequest: undefined,
    chatBoost: undefined,
    removedChatBoost: undefined,
    from: {
      id: 12345,
      is_bot: false,
      first_name: 'Test',
      last_name: 'User',
      username: 'testuser',
      language_code: 'en',
    } as any,
    chat: {
      id: -1001234567890,
      type: 'private',
      title: undefined,
      username: undefined,
      first_name: undefined,
      last_name: undefined,
    } as any,
    date: Math.floor(Date.now() / 1000),
    // Additional test-specific properties
    session: {},
    api: {
      getMe: async () => ({
        id: 987654321,
        is_bot: true,
        first_name: 'TestBot',
        username: 'testbot',
      }) as any,
      getFile: async () => ({
        file_path: 'photos/file_1.jpg',
      }) as any,
      downloadFile: async () => Buffer.from([0x89, 0x50, 0x4E, 0x47]), // PNG header
      sendMessage: async () => ({ message_id: 2, chat: { id: 123 } }),
      editMessageText: async () => true,
      answerCallbackQuery: async () => true,
      sendAnimation: async () => ({ message_id: 3, chat: { id: 123 } }),
      getChat: async () => ({
        id: 987654321,
        type: 'private',
        first_name: 'Target',
        username: 'targetuser',
      }),
    } as any,
    ...options,
  };
  return base;
}

/**
 * Create a mock Bot instance with in-memory DB for testing.
 */
export async function createTestBot() {
  await createTestDb();
  // Mock process.env for bot config
  const originalEnv = { ...process.env };
  process.env.BOT_TOKEN = '123456:TEST_TOKEN';
  process.env.ADMIN_IDS = '12345,67890';
  process.env.DUMP_CHANNEL_ID = '-1001234567890';
  process.env.SAUCENAO_API_KEY = 'test-key';

  // Import bot creation after setting env
  const { createBot } = await import('../src/bot.js');
  const bot = createBot();

  // Restore env after bot creation (keeps the bot's internal config)
  process.env = originalEnv;

  return { bot, restoreEnv: () => (process.env = originalEnv) };
}