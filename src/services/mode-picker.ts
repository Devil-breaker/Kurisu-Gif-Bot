import type { Expression } from '../types/index.js';

export const MODE_PICKER_PAGE_SIZE = 8;

export interface ModePickerKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export type ModePickerCallback =
  | { action: 'toggle'; expressionId: number; page: number }
  | { action: 'page'; page: number }
  | { action: 'apply' | 'stop' | 'cancel' | 'clear' };

export function parseModePickerCallbackData(data: string): ModePickerCallback | null {
  const toggle = data.match(/^modepick:t:(\d+):(\d+)$/);
  if (toggle) {
    const expressionId = Number(toggle[1]);
    const page = Number(toggle[2]);
    if (Number.isSafeInteger(expressionId) && expressionId > 0 && Number.isSafeInteger(page)) {
      return { action: 'toggle', expressionId, page };
    }
    return null;
  }

  const page = data.match(/^modepick:p:(\d+)$/);
  if (page) {
    const pageNumber = Number(page[1]);
    return Number.isSafeInteger(pageNumber) ? { action: 'page', page: pageNumber } : null;
  }

  const action = data.match(/^modepick:a:(apply|stop|cancel|clear)$/)?.[1];
  if (action === 'apply' || action === 'stop' || action === 'cancel' || action === 'clear') {
    return { action };
  }
  return null;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function clampModePickerPage(page: number, expressionCount: number): number {
  const pageCount = Math.max(1, Math.ceil(expressionCount / MODE_PICKER_PAGE_SIZE));
  return Math.max(0, Math.min(Math.trunc(page), pageCount - 1));
}

export function buildModePickerKeyboard(
  expressions: Expression[],
  selectedIds: number[],
  requestedPage: number,
): ModePickerKeyboard {
  const page = clampModePickerPage(requestedPage, expressions.length);
  const pageCount = Math.max(1, Math.ceil(expressions.length / MODE_PICKER_PAGE_SIZE));
  const selected = new Set(selectedIds);
  const visible = expressions.slice(page * MODE_PICKER_PAGE_SIZE, (page + 1) * MODE_PICKER_PAGE_SIZE);
  const rows: ModePickerKeyboard['inline_keyboard'] = [];

  for (let index = 0; index < visible.length; index += 2) {
    rows.push(visible.slice(index, index + 2).map((expression) => ({
      text: `${selected.has(expression.id) ? '✅ ' : ''}${expression.name}`,
      callback_data: `modepick:t:${expression.id}:${page}`,
    })));
  }

  const navigation: Array<{ text: string; callback_data: string }> = [];
  if (page > 0) navigation.push({ text: '◀️ Previous', callback_data: `modepick:p:${page - 1}` });
  if (page < pageCount - 1) navigation.push({ text: 'Next ▶️', callback_data: `modepick:p:${page + 1}` });
  if (navigation.length > 0) rows.push(navigation);

  rows.push([
    { text: 'Clear selection', callback_data: 'modepick:a:clear' },
    { text: `Apply (${selected.size})`, callback_data: 'modepick:a:apply' },
  ]);
  rows.push([
    { text: 'Stop upload mode', callback_data: 'modepick:a:stop' },
    { text: 'Cancel', callback_data: 'modepick:a:cancel' },
  ]);

  return { inline_keyboard: rows };
}

export function buildModePickerText(
  expressions: Expression[],
  selectedIds: number[],
  requestedPage: number,
): string {
  const page = clampModePickerPage(requestedPage, expressions.length);
  const pageCount = Math.max(1, Math.ceil(expressions.length / MODE_PICKER_PAGE_SIZE));
  const byId = new Map(expressions.map((expression) => [expression.id, expression]));
  const selectedNames = selectedIds
    .map((id) => byId.get(id)?.name)
    .filter((name): name is string => name !== undefined);
  const displayNames = selectedNames.slice(0, 12).map((name) => `/${escapeHtml(name)}`);
  const overflow = selectedNames.length > displayNames.length
    ? ` and ${selectedNames.length - displayNames.length} more`
    : '';
  const selection = displayNames.length > 0 ? `${displayNames.join(', ')}${overflow}` : 'None';

  return [
    '<b>Choose expressions for GIF uploads</b>',
    'Tap expressions to select or deselect them. You can choose more than one, then tap Apply.',
    '',
    `<b>Selected (${selectedNames.length}):</b> ${selection}`,
    `Page ${page + 1} of ${pageCount}`,
  ].join('\n');
}
