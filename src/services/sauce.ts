import { loadConfig } from '../config.js';
import { getSearchCache, setSearchCache } from '../db/queries.js';
import { searchSauceNao } from './saucenao.js';
import { searchTraceMoe } from './tracemoe.js';
import { searchIqdb } from './iqdb.js';
import { extractFrames } from './ffmpeg.js';
import { rm } from 'node:fs/promises';
import type { CombinedSauceResult, IqdbResult, SauceNaoResult, TraceMoeResult } from '../types/index.js';
import { logSafeError } from './safe-log.js';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CachePayload {
  version: 5;
  traceMoe: TraceMoeResult | null;
  sauceNao: SauceNaoResult | null;
  iqdb: IqdbResult | null;
  sauceNaoConfigured: boolean;
  searchComplete: boolean;
  cachedAt: number;
}

/**
 * Read a cache row, or null if it is unusable.
 *
 * Rows are JSON written by an older build as often as by this one, so the
 * shape is checked rather than asserted: a `cachedAt` that is missing or not a
 * number used to make `Date.now() - cached.cachedAt` NaN, and `NaN < TTL` is
 * false, so a corrupt row silently cost a live API call on every /sauce
 * instead of being reported.
 */
export function parseCachePayload(json: string, now = Date.now()): CachePayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    console.warn('[sauce] cache entry is not valid JSON; running a live search');
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    console.warn('[sauce] cache entry is not an object; running a live search');
    return null;
  }

  const row = parsed as Partial<CachePayload>;
  if (row.version !== 5 || typeof row.sauceNaoConfigured !== 'boolean' || typeof row.searchComplete !== 'boolean') {
    return null;
  }
  if (typeof row.cachedAt !== 'number' || !Number.isFinite(row.cachedAt)) {
    console.warn('[sauce] cache entry has no usable cachedAt; running a live search');
    return null;
  }

  const age = now - row.cachedAt;
  if (age < 0 || age >= CACHE_TTL_MS) return null; // expired, or written by a skewed clock

  return {
    version: 5,
    traceMoe: row.traceMoe ?? null,
    sauceNao: row.sauceNao ?? null,
    iqdb: row.iqdb ?? null,
    sauceNaoConfigured: row.sauceNaoConfigured,
    searchComplete: row.searchComplete,
    cachedAt: row.cachedAt,
  };
}

/**
 * Links to the reverse-image engines' own upload pages.
 *
 * These deliberately carry no `?url=` parameter. The only URL the bot has for
 * a Telegram file is `api.telegram.org/file/bot<TOKEN>/...`, and putting that
 * in a chat message hands the bot token to every member of the chat and to the
 * search engine. A one-click lookup would need a public, token-free URL for
 * the frame (an upload to object storage or an image host); until there is
 * one, these open the engine and the user drops the GIF in.
 */
export function buildFallbackUrls(): { googleLensUrl: string; yandexUrl: string } {
  return {
    googleLensUrl: 'https://lens.google.com/',
    yandexUrl: 'https://yandex.com/images/',
  };
}

/**
 * Reverse search across trace.moe, SauceNAO, and IQDB as a final best-effort fallback,
 * with a per-file_unique_id cache to protect the free API quotas.
 */
export async function reverseSearch(
  fileUniqueId: string,
  filePath: string
): Promise<CombinedSauceResult> {
  const config = loadConfig();

  // Check cache first
  const cachedJson = await getSearchCache(fileUniqueId, 'combined');
  if (cachedJson) {
    const cached = parseCachePayload(cachedJson);
    if (cached && cached.searchComplete && cached.sauceNaoConfigured === Boolean(config.SAUCENAO_API_KEY)) {
      console.log(
        `[sauce] cache hit for ${fileUniqueId} (age ${Math.round((Date.now() - cached.cachedAt) / 1000)}s)`
      );
      return {
        traceMoe: cached.traceMoe,
        sauceNao: cached.sauceNao,
        iqdb: cached.iqdb,
        cached: true,
        ...buildFallbackUrls(),
      };
    }
  }

  const { dir, frames } = await extractFrames(filePath);
  try {
    let traceMoe: TraceMoeResult | null = null;
    let sauceNao: SauceNaoResult | null = null;
    let iqdb: IqdbResult | null = null;
    let traceMoeFailed = false;
    let sauceNaoFailed = false;
    let iqdbFailed = false;

    // Try trace.moe first for anime scenes (the most common case for GIF dumps)
    for (const frame of frames) {
      try {
        const result = await searchTraceMoe(frame);
        if (result) {
          traceMoe = result;
          break;
        }
      } catch (err) {
        traceMoeFailed = true;
        logSafeError('sauce:trace-moe', err);
        if (/trace\.moe HTTP (?:400|413)/i.test((err as Error).message)) break;
      }
    }

    // If trace.moe found nothing, try SauceNAO (better for anime *art*, fanart, etc.)
    if (!traceMoe && config.SAUCENAO_API_KEY) {
      for (const frame of frames) {
        try {
          const result = await searchSauceNao(frame, config.SAUCENAO_API_KEY);
          if (result) {
            sauceNao = result;
            break;
          }
        } catch (err) {
          sauceNaoFailed = true;
          logSafeError('sauce:saucenao', err);
        }
      }
    }

    // IQDB is an optional last resort: it can be slow when its public service is busy.
    // Try only the first frame, and let existing provider hits take priority.
    if (!traceMoe && !sauceNao && frames[0]) {
      try {
        iqdb = await searchIqdb(frames[0]);
      } catch (err) {
        iqdbFailed = true;
        logSafeError('sauce:iqdb', err);
      }
    }

    // Cache only complete provider runs. In particular, don't turn an HTTP
    // error into a 24-hour negative result. Provider configuration is part of
    // the cache shape so adding a SauceNAO key invalidates keyless misses.
    const searchComplete = !traceMoeFailed && !sauceNaoFailed && !iqdbFailed;
    if (searchComplete) {
      const payload: CachePayload = {
        version: 5,
        traceMoe,
        sauceNao,
        iqdb,
        sauceNaoConfigured: Boolean(config.SAUCENAO_API_KEY),
        searchComplete,
        cachedAt: Date.now(),
      };
      await setSearchCache(fileUniqueId, 'combined', JSON.stringify(payload));
    }

    return {
      traceMoe,
      sauceNao,
      iqdb,
      cached: false,
      ...buildFallbackUrls(),
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch((err) => {
      logSafeError('sauce:remove-frames', err);
    });
  }
}
