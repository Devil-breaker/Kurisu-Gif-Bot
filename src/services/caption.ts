/**
 * Telegram's own length caps, both measured *after* entity parsing — markup
 * does not count, and each entity (`&amp;`) counts as the one character it
 * renders as. Exceeding either is a 400, the same failure class as a missed
 * escape, so every unbounded list or interpolated value is clamped before it
 * reaches the API.
 */
export const TELEGRAM_MESSAGE_LIMIT = 4096;
export const TELEGRAM_CAPTION_LIMIT = 1024;

/** The only named entities Telegram's HTML parser understands. */
const ENTITY = /&(?:amp|lt|gt|quot);/g;
const TAG = /<[^>]*>/g;

/**
 * Escape text for Telegram's HTML parse_mode.
 *
 * HTML mode reserves only these characters, so ordinary prose — trailing "!",
 * parentheses, dots in URLs — passes through untouched. This is why the bot
 * uses HTML rather than MarkdownV2, which reserves 18 characters and silently
 * 400s whenever one is missed.
 *
 * `"` is escaped so the result is also safe inside an attribute, e.g. the
 * href of a link; `&quot;` renders as a plain quote in text.
 */
export function escapeHtml(text: string): string {
  // String(): callers include values parsed out of cached JSON, where a field
  // typed as string can turn out to be a number.
  return String(text)
    .replaceAll('&', '&amp;') // must run first, or later entities get re-escaped
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** The length Telegram charges for: tags removed, each entity one character. */
export function visibleLength(html: string): number {
  return html.replace(TAG, '').replace(ENTITY, 'x').length;
}

/**
 * Clamp already-escaped text to `limit` visible characters.
 *
 * Cuts only on character and entity boundaries, so a half-written `&amp;` or a
 * split surrogate pair (every caption here ends in an emoji) can never reach
 * the API. Intended for tag-free text such as a GIF caption; a trailing
 * partial tag is dropped, but balancing open tags is the caller's job.
 */
export function clampVisible(text: string, limit: number): string {
  if (limit <= 0) return '';
  if (visibleLength(text) <= limit) return text;

  // Each step consumes one entity or one whole code point (the /u flag).
  const token = /&(?:amp|lt|gt|quot);|[\s\S]/gu;
  let out = '';
  let used = 0;
  for (const [unit] of text.matchAll(token)) {
    const cost = unit.startsWith('&') ? 1 : unit.length;
    if (used + cost > limit - 1) break; // leave room for the ellipsis
    out += unit;
    used += cost;
  }

  const lastOpen = out.lastIndexOf('<');
  if (lastOpen !== -1 && !out.includes('>', lastOpen)) out = out.slice(0, lastOpen);
  return `${out}…`;
}

/**
 * Join lines into one message that fits `limit`, dropping whole lines rather
 * than splitting one — so per-line markup stays balanced and no entity is cut
 * in half. The list messages (/help, /listexpressions, /stats) grow with every
 * expression an admin adds, which is how they eventually hit the cap.
 */
export function joinWithinLimit(
  lines: string[],
  limit: number,
): { text: string; dropped: number } {
  const all = lines.join('\n');
  if (visibleLength(all) <= limit) return { text: all, dropped: 0 };

  const marker = (n: number) => `\n… and ${n} more`;
  // Budget against the longest the marker could be, so it always fits.
  const budget = limit - visibleLength(marker(lines.length));
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = visibleLength(line) + (kept.length > 0 ? 1 : 0); // +1 for "\n"
    if (used + cost > budget) break;
    kept.push(line);
    used += cost;
  }

  const dropped = lines.length - kept.length;
  // Degenerate case: even the first line is over the cap on its own.
  if (kept.length === 0) return { text: clampVisible(lines[0] ?? '', limit), dropped };
  return { text: kept.join('\n') + marker(dropped), dropped };
}

/**
 * Format a caption using the expression's template.
 *
 * Replaces {from}, {to} and {action}. The template is treated as pure text:
 * it is escaped along with the interpolated values, so an admin-supplied
 * template containing "<3" or an unclosed tag renders literally instead of
 * breaking the send. Templates deliberately do not support markup.
 */
/**
 * Format a caption using the expression's template.
 *
 * Replaces {from} and {to} with clickable Telegram user mention tags
 * (<a href="tg://user?id=123">Name</a>) so users get notified when the GIF
 * is posted in a group.
 *
 * Handles both bidirectional ("A hugged B") and unidirectional
 * ("A smiled at B") reaction styles.
 *
 * The template is treated as pure text: it is escaped along with the
 * interpolated values, so an admin-supplied template containing "<3"
 * or an unclosed tag renders literally instead of breaking the send.
 */
export function formatCaption(
  template: string,
  fromUser: { id: number; first_name: string; username?: string },
  toUser: { id?: number; first_name: string; username?: string },
  action: string,
  direction: 'bidirectional' | 'unidirectional' | 'situational' = 'bidirectional',
): string {
  const fromName = fromUser.first_name || fromUser.username || 'Someone';
  const toName   = toUser.first_name   || toUser.username   || 'Someone';

  // Use null characters as safe markers — they never appear in HTML or user content,
  // so escaping the template doesn't touch them and they uniquely identify each link.
  const fromMarker = '\x00FROM\x00';
  const toMarker   = '\x00TO\x00';
  const fromLink = `<a href="tg://user?id=${fromUser.id}">${escapeHtml(fromName)}</a>`;
  const toLink = typeof toUser.id === 'number'
    ? `<a href="tg://user?id=${toUser.id}">${escapeHtml(toName)}</a>`
    : escapeHtml(toName);

  // Bidirectional: "{from} hugged {to}" → "Alice hugged Bob"
  // Unidirectional: "{from} smiled {to}" → "Alice smiled at Bob"
  let result = escapeHtml(template)
    .replace('{from}', fromMarker)
    .replace('{to}',   toMarker)
    .replace('{action}', escapeHtml(action));

  if (direction === 'unidirectional' && !result.includes(' at ')) {
    // Inject "at" before the {to} link (toMarker is already unescaped here)
    result = result.replace(toMarker, `at ${toMarker}`);
  }

  // Replace markers with the actual HTML links
  result = result.replace(fromMarker, fromLink).replace(toMarker, toLink);

  return result;
}

/**
 * Convert seconds to MM:SS format (e.g., 725 -> "12:05").
 *
 * Guards against the junk a corrupted cache entry or a missing API field can
 * produce — "NaN:NaN" in a caption is better caught here than in the chat.
 */
export function formatTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
