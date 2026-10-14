import { describe, it, expect, beforeEach } from 'vitest';
import { loadConfig, resetConfigCache } from '../src/config.js';

const BASE_ENV = {
  BOT_TOKEN: '123456:TEST-TOKEN',
  ADMIN_IDS: '12345,67890',
};

function withEnv(env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('config', () => {
  beforeEach(() => {
    resetConfigCache();
    // Clean slate for each test
    delete process.env.DUMP_CHANNEL_ID;
    delete process.env.WEBHOOK_SECRET;
    delete process.env.SAUCENAO_API_KEY;
    delete process.env.TURSO_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    delete process.env.CHANNEL_EXPRESSION_MAP;
    withEnv(BASE_ENV);
  });

  it('parses valid minimal config', () => {
    const cfg = loadConfig();
    expect(cfg.BOT_TOKEN).toBe('123456:TEST-TOKEN');
    expect(cfg.ADMIN_IDS).toEqual([12345, 67890]);
  });

  it('throws when BOT_TOKEN missing', () => {
    delete process.env.BOT_TOKEN;
    expect(() => loadConfig()).toThrow(/BOT_TOKEN/);
  });

  it('throws when ADMIN_IDS missing', () => {
    delete process.env.ADMIN_IDS;
    expect(() => loadConfig()).toThrow(/ADMIN_IDS/);
  });

  it('throws on non-numeric ADMIN_IDS entry', () => {
    withEnv({ ADMIN_IDS: '12345,notanumber' });
    expect(() => loadConfig()).toThrow(/notanumber/);
  });

  it('accepts DUMP_CHANNEL_ID in -100… form', () => {
    withEnv({ DUMP_CHANNEL_ID: '-1001234567890' });
    const cfg = loadConfig();
    expect(cfg.DUMP_CHANNEL_ID).toBe(-1001234567890);
  });

  it('rejects malformed DUMP_CHANNEL_ID', () => {
    withEnv({ DUMP_CHANNEL_ID: 'not-a-number' });
    expect(() => loadConfig()).toThrow();
  });

  it('treats empty optional vars as undefined', () => {
    withEnv({ SAUCENAO_API_KEY: '', TURSO_URL: '', WEBHOOK_SECRET: '' });
    const cfg = loadConfig();
    expect(cfg.SAUCENAO_API_KEY).toBeUndefined();
    expect(cfg.TURSO_URL).toBeUndefined();
    expect(cfg.WEBHOOK_SECRET).toBeUndefined();
  });

  it('parses a valid CHANNEL_EXPRESSION_MAP', () => {
    withEnv({
      CHANNEL_EXPRESSION_MAP: JSON.stringify([
        { channel_id: -100111, expression: 'hug' },
        { channel_id: -100222, expression: 'kiss' },
      ]),
    });
    const cfg = loadConfig();
    expect(cfg.CHANNEL_EXPRESSION_MAP).toHaveLength(2);
    expect(cfg.CHANNEL_EXPRESSION_MAP![0]).toEqual({ channel_id: -100111, expression: 'hug' });
  });

  it('throws on invalid CHANNEL_EXPRESSION_MAP JSON', () => {
    withEnv({ CHANNEL_EXPRESSION_MAP: '{not json' });
    expect(() => loadConfig()).toThrow(/not valid JSON/);
  });

  it('caches the config between calls', () => {
    const cfg1 = loadConfig();
    withEnv({ BOT_TOKEN: 'changed:token' });
    const cfg2 = loadConfig();
    expect(cfg2.BOT_TOKEN).toBe(cfg1.BOT_TOKEN); // cached, not re-parsed
  });

  it('resetConfigCache forces re-parse', () => {
    const cfg1 = loadConfig();
    withEnv({ BOT_TOKEN: 'changed:token' });
    resetConfigCache();
    const cfg2 = loadConfig();
    expect(cfg2.BOT_TOKEN).toBe('changed:token');
  });
});