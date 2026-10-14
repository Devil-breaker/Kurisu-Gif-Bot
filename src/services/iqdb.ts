import { readFile } from 'node:fs/promises';
import { defaultConfig, makeSearchFunc } from 'iqdb-client';
import type { IqdbMatch, IqdbResult } from '../types/index.js';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_MATCHES = 3;

/** Search IQDB.org's existing booru indexes using one extracted frame. */
export async function searchIqdb(imagePath: string): Promise<IqdbResult | null> {
  const image = await readFile(imagePath);
  const search = makeSearchFunc({
    ...defaultConfig,
    // Create a fresh signal per request; a module-level signal would expire once.
    fetchOptions: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  });
  const response = await search(image, { lib: 'www', fileName: 'frame.jpg' });

  if (response.err) throw new Error(`IQDB ${response.err}`);
  const matches: IqdbMatch[] = (response.data ?? [])
    .filter((item) => item.head !== 'Your image' && item.sourceUrl && item.similarity !== null)
    .map((item) => {
      const sourceUrl = new URL(item.sourceUrl!, 'https://iqdb.org').toString();
      if (sourceUrl !== 'https://iqdb.org' && !/^https:\/\//i.test(sourceUrl)) {
        throw new Error('IQDB returned an unsupported source URL');
      }
      return {
        sourceUrl,
        sources: item.source ?? [],
        similarity: item.similarity!,
        rating: item.type,
      };
    })
    .filter((item) => Number.isFinite(item.similarity))
    .slice(0, MAX_MATCHES);

  return matches.length ? { matches } : null;
}
