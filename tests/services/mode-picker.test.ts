import { describe, expect, it } from 'vitest';
import {
  buildModePickerKeyboard,
  buildModePickerText,
  clampModePickerPage,
  MODE_PICKER_PAGE_SIZE,
  parseModePickerCallbackData,
} from '../../src/services/mode-picker.js';
import type { Expression } from '../../src/types/index.js';

function makeExpressions(count: number): Expression[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    name: `expression_${index + 1}`,
    aliases: [],
    caption_template: '{from} {action} {to}!',
    is_lewd: 0,
    direction: 'bidirectional',
  }));
}

describe('mode picker', () => {
  it('clamps requested pages to the current expression list', () => {
    expect(clampModePickerPage(-3, 18)).toBe(0);
    expect(clampModePickerPage(100, 18)).toBe(2);
    expect(clampModePickerPage(100, 0)).toBe(0);
  });

  it('parses valid callbacks and rejects malformed or oversized identifiers', () => {
    expect(parseModePickerCallbackData('modepick:t:42:3')).toEqual({ action: 'toggle', expressionId: 42, page: 3 });
    expect(parseModePickerCallbackData('modepick:p:2')).toEqual({ action: 'page', page: 2 });
    expect(parseModePickerCallbackData('modepick:a:apply')).toEqual({ action: 'apply' });
    expect(parseModePickerCallbackData('modepick:t:999999999999999999999:0')).toBeNull();
    expect(parseModePickerCallbackData('modepick:a:delete')).toBeNull();
  });

  it('shows only one page of dynamically supplied expressions and marks selections', () => {
    const expressions = makeExpressions(MODE_PICKER_PAGE_SIZE + 1);
    const keyboard = buildModePickerKeyboard(expressions, [1, 9], 0);
    const labels = keyboard.inline_keyboard.flat().map((button) => button.text);

    expect(labels).toContain('✅ expression_1');
    expect(labels).not.toContain('✅ expression_9');
    expect(labels).not.toContain('/expression_9');
    expect(labels).toContain('Next ▶️');
    expect(keyboard.inline_keyboard.flat().map((button) => button.callback_data)).toContain('modepick:t:1:0');
  });

  it('keeps all expressions selectable across pages and summarizes large selections safely', () => {
    const expressions = makeExpressions(20);
    const keyboard = buildModePickerKeyboard(expressions, expressions.map((item) => item.id), 2);
    const text = buildModePickerText(expressions, expressions.map((item) => item.id), 2);

    expect(keyboard.inline_keyboard.flat().map((button) => button.text)).toContain('◀️ Previous');
    expect(text).toContain('<b>Selected (20):</b>');
    expect(text).toContain('and 8 more');
    expect(text).toContain('Page 3 of 3');
  });
});
