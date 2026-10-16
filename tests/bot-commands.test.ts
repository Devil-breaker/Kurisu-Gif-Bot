import { describe, it, expect } from 'vitest';
import { buildBotCommands } from '../src/bot.js';

describe('buildBotCommands', () => {
  it('includes fixed utility and admin commands but omits dynamic expressions', () => {
    const commands = buildBotCommands();
    const names = commands.map((c) => c.command);
    for (const expected of ['start', 'help', 'listexpressions', 'stats', 'sauce', 'lewdmode', 'supported', 'convert', 'batchconvert']) {
      expect(names).toContain(expected);
    }
    expect(names).not.toContain('hug');
    expect(names).not.toContain('hugs');
    expect(names).not.toContain('pat');
  });

  it('only emits valid Telegram command tokens', () => {
    const commands = buildBotCommands();
    for (const c of commands) {
      expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
    }
  });
});
