export interface AniListMediaMetadata {
  year?: number;
  format?: string;
  malId?: number;
  anidbUrl?: string;
}

interface AniListResponse {
  data?: {
    Media?: {
      seasonYear?: number | null;
      format?: string | null;
      idMal?: number | null;
      externalLinks?: Array<{ site: string; url: string }>;
    } | null;
  };
}

const MEDIA_QUERY = `
  query ($id: Int!) {
    Media(id: $id, type: ANIME) {
      seasonYear
      format
      idMal
      externalLinks { site url }
    }
  }
`;

/** Fetch small catalog fields used to enrich the trace.moe match card. */
export async function getAniListMediaMetadata(id: number): Promise<AniListMediaMetadata | null> {
  try {
    const response = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: MEDIA_QUERY, variables: { id } }),
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as AniListResponse;
    const media = payload.data?.Media;
    if (!media) return null;

    const anidb = media.externalLinks?.find((link) => link.site.toLowerCase() === 'anidb');
    const safeAniDbUrl = anidb && /^https:\/\/anidb\.net\/anime\/\d+\/?$/i.test(anidb.url)
      ? anidb.url
      : undefined;
    return {
      year: media.seasonYear ?? undefined,
      format: media.format ?? undefined,
      malId: media.idMal ?? undefined,
      anidbUrl: safeAniDbUrl,
    };
  } catch (err) {
    console.warn('[sauce] AniList metadata lookup failed:', (err as Error).message);
    return null;
  }
}
