import { readFile } from 'node:fs/promises';
import type { TraceMoeResult } from '../types/index.js';
import { getAniListMediaMetadata } from './anilist.js';

const TRACEMOE_URL = 'https://api.trace.moe/search';

interface TraceMoeApiResponse {
  result: Array<{
    anilist: {
      id: number;
      title: {
        romaji: string;
        english: string | null;
        native: string;
      };
      synonyms?: string[];
      isAdult: boolean;
    } | number;
    filename: string;
    episode: number | null;
    from: number;
    to: number;
    at?: number;
    duration?: number;
    similarity: number;
    video: string;
    image: string;
  }>;
  error?: string;
}

/**
 * Query trace.moe with a resized JPEG frame image.
 * Free tier: ~20-50 searches per 2 days (roughly 1 per minute sustained).
 */
export async function searchTraceMoe(imagePath: string): Promise<TraceMoeResult | null> {
  const imageBuffer = await readFile(imagePath);
  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(imageBuffer)], { type: 'image/jpeg' }),
    'frame.jpg',
  );

  const response = await fetch(`${TRACEMOE_URL}?anilistInfo&cutBorders`, {
    method: 'POST',
    // The public API supports image uploads as multipart/form-data. Let fetch
    // set the boundary; sending a bare base64 string loses the image MIME type.
    body: form,
    signal: AbortSignal.timeout(12_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'no body');
    throw new Error(`trace.moe HTTP ${response.status}: ${text}`);
  }

  const data = (await response.json()) as TraceMoeApiResponse;
  if (!data.result || data.result.length === 0) {
    return null;
  }

  // Pick best result with >= 87% similarity
  const sorted = [...data.result].sort((a, b) => b.similarity - a.similarity);
  const best = sorted[0];
  if (!best || best.similarity < 0.87) return null;

  const anilist = typeof best.anilist === 'number' ? null : best.anilist;
  const title =
    anilist?.title.english ?? anilist?.title.romaji ?? anilist?.title.native ?? best.filename;
  const metadata = anilist?.id ? await getAniListMediaMetadata(anilist.id) : null;

  return {
    animeTitle: title,
    animeRomaji: anilist?.title.romaji,
    animeNative: anilist?.title.native,
    episode: best.episode,
    similarity: best.similarity,
    from: best.from,
    to: best.to,
    at: best.at,
    sourceDuration: best.duration,
    year: metadata?.year,
    format: metadata?.format,
    anidbUrl: metadata?.anidbUrl,
    videoUrl: best.video,
    imageUrl: best.image,
    anilistId: anilist?.id,
    malId: metadata?.malId,
  };
}

/** Format seconds as m:ss (e.g., 725 -> "12:05") */
export function formatTimestamp(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
