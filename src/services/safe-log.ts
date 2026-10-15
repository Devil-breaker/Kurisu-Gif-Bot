/** Redact common credential formats before an error message reaches logs. */
export function safeErrorSummary(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : 'Unknown error';

  return raw
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_BOT_TOKEN]')
    .replace(/https?:\/\/api\.telegram\.org\/(?:file\/)?bot[^\s/"'<>]+/gi, 'https://api.telegram.org/bot[REDACTED]')
    .replace(/\b((?:bot_?)?token|(?:turso_?)?auth_?token|webhook_?secret|api_?key|authorization)\s*([=:])\s*([^\s,;"'<>]+)/gi, '$1$2[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .slice(0, 500);
}

/** Log only a short, sanitized error summary; never pass raw error/context objects. */
export function logSafeError(label: string, error: unknown): void {
  console.error(`[${label}] ${safeErrorSummary(error)}`);
}
