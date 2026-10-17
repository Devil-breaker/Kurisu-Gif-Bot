import type { SauceNaoResult } from '../types/index.js';

const SAUCENAO_URL = 'https://saucenao.com/search.php';

export interface SauceNaoApiResponse {
  header: {
    status: number;
    user_id?: number;
    account_type?: number;
    short_limit?: string;
    long_limit?: string;
    long_remaining?: number;
    short_remaining?: number;
  };
  results?: Array<{
    header: {
      similarity: string;
      thumbnail?: string;
      index_id: number;
      index_name: string;
    };
    data: {
      title?: string;
      member_name?: string;
      member_id?: string;
      source?: string;
      ext_urls?: string[];
      pixiv_id?: number;
      artist?: string;
      author_name?: string;
      author_url?: string;
    };
  }>;
}

/** Convert a successful SauceNAO response into its strongest usable match. */
export function parseSauceNaoResponse(data: SauceNaoApiResponse): SauceNaoResult | null {
  const candidates = (data.results ?? [])
    .map((r) => ({
      title: r.data.title ?? r.data.source ?? 'Unknown title',
      sourceType: r.header.index_name,
      sourceUrl: r.data.ext_urls?.[0],
      authorName: r.data.member_name ?? r.data.artist ?? r.data.author_name,
      authorUrl: r.data.author_url,
      similarity: Number(r.header.similarity),
      thumbnailUrl: r.header.thumbnail,
    }))
    .filter((r) => Number.isFinite(r.similarity) && r.similarity >= 0 && r.similarity <= 100)
    .sort((a, b) => b.similarity - a.similarity);

  return candidates[0] ?? null;
}

/**
 * Query SauceNAO with a full-resolution frame image.
 * Free tier: 100 searches/day with an API key, 25 without.
 */
export async function searchSauceNao(
  imagePath: string,
  apiKey?: string
): Promise<SauceNaoResult | null> {
  const params = new URLSearchParams({
    output_type: '2', // JSON
    numres: '4',
    db: '999',        // all databases
    api_key: apiKey ?? '',
  });

  const form = new FormData();
  form.append('file', new Blob([await import('node:fs/promises').then((fs) => fs.readFile(imagePath))], {
    type: 'image/jpeg',
  }) as unknown as File, 'frame.jpg');

  const response = await fetch(`${SAUCENAO_URL}?${params}`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(12_000),
  });

  if (!response.ok) {
    throw new Error(`SauceNAO HTTP ${response.status}: ${await response.text().catch(() => 'no body')}`);
  }

  const data = (await response.json()) as SauceNaoApiResponse;
  if (data.header.status !== 0) {
    // Treat quota/provider errors as failures so the combined negative result
    // is not cached for 24 hours. Never include the request URL or API key.
    throw new Error(`SauceNAO API status ${data.header.status}`);
  }
  if (!data.results || data.results.length === 0) {
    console.info('[sauce:saucenao] API returned no results');
    return null;
  }

  // Keep SauceNAO's top usable candidate even when it is below 85%. A fixed
  // cutoff hid valid matches; the result UI shows the score so users can judge it.
  const best = parseSauceNaoResponse(data);
  if (!best) {
    console.info(`[sauce:saucenao] no usable similarities in ${data.results.length} result(s)`);
    return null;
  }
  console.info(`[sauce:saucenao] best candidate similarity=${best.similarity}%`);
  return best;
}
