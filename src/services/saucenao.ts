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
  if (data.header.status !== 0 || !data.results || data.results.length === 0) {
    return null;
  }

  // Pick the best result (highest similarity, >= 85%)
  const candidates = data.results
    .map((r) => ({
      title: r.data.title ?? r.data.source ?? 'Unknown title',
      sourceType: r.header.index_name,
      sourceUrl: r.data.ext_urls?.[0],
      authorName: r.data.member_name ?? r.data.artist ?? r.data.author_name,
      authorUrl: r.data.author_url,
      similarity: Number(r.header.similarity),
      thumbnailUrl: r.header.thumbnail,
    }))
    .filter((r) => Number.isFinite(r.similarity))
    .sort((a, b) => b.similarity - a.similarity);

  const best = candidates[0];
  if (!best || best.similarity < 85) return null;
  return best;
}
