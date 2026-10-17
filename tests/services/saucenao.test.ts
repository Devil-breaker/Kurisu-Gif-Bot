import { describe, expect, it } from 'vitest';
import { parseSauceNaoResponse, type SauceNaoApiResponse } from '../../src/services/saucenao.js';

function result(similarity: string, title: string) {
  return {
    header: { similarity, index_id: 5, index_name: 'Test Index' },
    data: { title, ext_urls: [`https://example.com/${title}`] },
  };
}

function response(results: SauceNaoApiResponse['results']): SauceNaoApiResponse {
  return { header: { status: 0 }, results };
}

describe('parseSauceNaoResponse', () => {
  it('returns the highest-similarity candidate even below the former 85% cutoff', () => {
    const parsed = parseSauceNaoResponse(response([
      result('72.4', 'Likely match'),
      result('68.1', 'Weaker match'),
    ]));

    expect(parsed).toMatchObject({ title: 'Likely match', similarity: 72.4 });
  });

  it('ignores invalid scores and picks the highest usable candidate', () => {
    const parsed = parseSauceNaoResponse(response([
      result('NaN', 'Invalid'),
      result('-1', 'Out of range'),
      result('91.2', 'Best match'),
      result('100.5', 'Out of range high'),
    ]));

    expect(parsed).toMatchObject({ title: 'Best match', similarity: 91.2 });
  });

  it('returns null when no results have a usable similarity score', () => {
    expect(parseSauceNaoResponse(response([result('NaN', 'Invalid')]))).toBeNull();
    expect(parseSauceNaoResponse(response([]))).toBeNull();
    expect(parseSauceNaoResponse({ header: { status: 0 } })).toBeNull();
  });
});
