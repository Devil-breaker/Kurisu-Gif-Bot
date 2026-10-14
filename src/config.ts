import { z } from 'zod';
import type { ChannelExpressionMapEntry } from './types/index.js';

const channelExpressionMapSchema = z.array(
  z.object({
    channel_id: z.number().int(),
    expression: z.string().min(1),
  })
);

/** Treat an empty/whitespace-only env var as undefined before schema parsing. */
function emptyToUndefined<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    schema.optional()
  );
}

const envSchema = z.object({
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN is required'),
  BOT_OWNER_ID: z
    .string()
    .regex(/^\d+$/, 'BOT_OWNER_ID must be a numeric user ID')
    .transform(Number)
    .optional(),
  ADMIN_IDS: z
    .string()
    .min(1, 'ADMIN_IDS is required (comma-separated numeric user IDs)')
    .transform((s) =>
      s
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
        .map((id) => {
          const n = Number(id);
          if (!Number.isInteger(n) || n <= 0) {
            throw new Error(`Invalid ADMIN_IDS entry: "${id}" (must be a positive integer)`);
          }
          return n;
        })
    ),
  DUMP_CHANNEL_ID: emptyToUndefined(
    z
      .string()
      .regex(
        /^-100\d+$/,
        'Channel ID must be a negative number starting with -100 (e.g., -1001234567890)'
      )
      .transform(Number)
  ),
  WEBHOOK_SECRET: emptyToUndefined(z.string()),
  SAUCENAO_API_KEY: emptyToUndefined(z.string()),
  TURSO_URL: emptyToUndefined(z.string()),
  TURSO_AUTH_TOKEN: emptyToUndefined(z.string()),
  CHANNEL_EXPRESSION_MAP: z.preprocess(
    (v) => {
      if (typeof v !== 'string' || v.trim() === '') return undefined;
      try {
        const parsed: unknown = JSON.parse(v);
        const result = channelExpressionMapSchema.safeParse(parsed);
        if (!result.success) {
          throw new Error(`Invalid CHANNEL_EXPRESSION_MAP JSON: ${result.error.message}`);
        }
        return result.data;
      } catch (e) {
        throw new Error(`Invalid CHANNEL_EXPRESSION_MAP: not valid JSON (${(e as Error).message})`);
      }
    },
    z.custom<ChannelExpressionMapEntry[]>((v) => Array.isArray(v)).optional()
  ),
});

export type BotConfig = z.infer<typeof envSchema>;

let cachedConfig: BotConfig | null = null;

export function loadConfig(): BotConfig {
  if (cachedConfig) return cachedConfig;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Environment validation failed:\n${issues}`);
  }
  cachedConfig = parsed.data;
  return cachedConfig;
}

/** For tests: reset the cached config so env changes are picked up. */
export function resetConfigCache(): void {
  cachedConfig = null;
}
