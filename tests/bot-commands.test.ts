import { describe, it, expect } from 'vitest';
import { buildBotCommands } from '../src/bot.js';

describe('buildBotCommands', () => {
  it('registers only the requested commands in Telegram’s slash menu', () => {
    const commands = buildBotCommands();
    const names = commands.map((c) => c.command);
    expect(names).toEqual(['start', 'help', 'ping', 'sauce', 'listexpressions']);
  });

  it('only emits valid Telegram command tokens', () => {
    const commands = buildBotCommands();
    for (const c of commands) {
      expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
    }
  });
});
