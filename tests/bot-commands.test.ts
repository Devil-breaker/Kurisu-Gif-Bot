import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildBotCommands } from '../src/bot.js';
import type { Expression } from '../../src/types/index.js';

const expr = (name: string, aliases: string[] = [], is_lewd = 0): Expression => ({
  id: 1,
  name,
  aliases,
  caption_template: '{from} {action} {to}!',
  is_lewd,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildBotCommands', () => {
  it('includes the fixed utility commands plus every expression and alias', () => {
    const commands = buildBotCommands([expr('hug', ['hugs']), expr('pat', [], 1)]);
    const names = commands.map((c) => c.command);
    for (const expected of ['start', 'help', 'listexpressions', 'lewdmode', 'hug', 'hugs', 'pat']) {
      expect(names).toContain(expected);
    }
  });

  it('drops names violating Telegram\'s [a-z0-9_] rule instead of 400-ing the whole menu', () => {
    // 'high-five' ships in the seed data; setMyCommands rejects the entire
    // call over one bad name, taking the menu down for every command.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const commands = buildBotCommands([expr('highfive', ['high-five', 'high5'])]);
    const names = commands.map((c) => c.command);
    expect(names).toContain('highfive');
    expect(names).toContain('high5');
    expect(names).not.toContain('high-five');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('high-five'));
  });

  it('drops names over 32 characters', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const long = 'a'.repeat(33);
    const commands = buildBotCommands([expr(long)]);
    expect(commands.map((c) => c.command)).not.toContain(long);
    expect(warn).toHaveBeenCalled();
  });

  it('accepts the 32-character maximum', () => {
    const max = 'a'.repeat(32);
    expect(buildBotCommands([expr(max)]).map((c) => c.command)).toContain(max);
  });

  it('caps the menu at 100 commands, dropping from the end', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 12 fixed + lewdmode + 90 expressions = 103
    const many = Array.from({ length: 90 }, (_, i) => expr(`expression_${i}`));
    const commands = buildBotCommands(many);
    expect(commands.length).toBe(100);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exceeds'));
    // The fixed commands and lewdmode survive the cut; the last expressions do not.
    expect(commands.map((c) => c.command)).toContain('lewdmode');
    expect(commands.map((c) => c.command)).not.toContain('expression_89');
  });

  it('does not push lewdmode when there are no expressions', () => {
    const commands = buildBotCommands([]);
    expect(commands.map((c) => c.command)).not.toContain('lewdmode');
  });

  it('never emits an empty or undefined command', () => {
    const commands = buildBotCommands([expr('ok', ['', 'ok'])]);
    for (const c of commands) {
      expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
    }
  });
});
