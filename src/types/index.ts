import { Context } from 'grammy';

export interface Expression {
  id: number;
  name: string;
  aliases: string[];
  caption_template: string;
  is_lewd: number; // 0 = safe, 1 = lewd
  /**
   * "bidirectional" = A does X to B (hug, kiss)
   * "unidirectional" = A does X at B (smile, wave)
   * "situational" = A is doing X; B is context, not a target (sleep, run, kill)
   */
  direction: 'bidirectional' | 'unidirectional' | 'situational';
}

export interface Media {
  id: number;
  file_id: string;
  file_unique_id: string;
  /** dHash of the first frame, 16 hex chars, or null until computed. */
  phash: string | null;
  usage_count: number;
  is_lewd: number; // 0 = safe, 1 = lewd
  /** Telegram message ID in the dump channel, null if never synced or message was deleted. */
  channel_msg_id: number | null;
  created_at: string;
}

export interface MediaWithExpressions extends Media {
  expressions: string[];
}

export interface AdminUser {
  user_id: number;
  username: string | null;
  added_by: number;
  created_at: string;
}

export interface SearchCacheEntry {
  file_unique_id: string;
  provider: 'saucenao' | 'tracemoe';
  result_json: string;
  created_at: string;
}

export interface TraceMoeResult {
  animeTitle: string;
  animeRomaji?: string;
  animeNative?: string;
  episode: number | string | null;
  similarity: number;
  from: number;
  to: number;
  /** Timestamp of the closest matching frame in the source video. */
  at?: number;
  /** Full source-video duration in seconds. */
  sourceDuration?: number;
  year?: number;
  format?: string;
  anidbUrl?: string;
  videoUrl?: string;
  imageUrl?: string;
  anilistId?: number;
  malId?: number;
}

export interface SauceNaoResult {
  title: string;
  sourceType?: string;
  sourceUrl?: string;
  authorName?: string;
  authorUrl?: string;
  similarity: number;
  thumbnailUrl?: string;
}

export interface IqdbMatch {
  sourceUrl: string;
  sources: string[];
  similarity: number;
  rating?: string;
}

export interface IqdbResult {
  matches: IqdbMatch[];
}

export interface CombinedSauceResult {
  traceMoe?: TraceMoeResult | null;
  sauceNao?: SauceNaoResult | null;
  iqdb?: IqdbResult | null;
  googleLensUrl: string;
  yandexUrl: string;
  /** True when served from the local cache rather than a fresh API call. */
  cached: boolean;
}

export interface ChannelExpressionMapEntry {
  channel_id: number;
  expression: string;
}

export interface ChatSettings {
  chat_id: number;
  lewd_mode: number; // 0 = off, 1 = on
  bluetext: number; // 1 = commands tappable (default), 0 = bot deletes invoking command
  disabled_commands: string[]; // locked expression names (canonical)
}

export interface BotContext extends Context {
  // Can be extended with custom session or helper properties
}
