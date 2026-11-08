/**
 * One search across every source (T50 G4, #152; A826): each git notebook's own search, asked in
 * the mode the box asks (T77: meaning too, in the Mac app); hits labelled with their notebook.
 * Git notebooks only since T59 (D49).
 */
import { describe, expect, it } from 'vitest';
import type { SearchHit, SearchOutcome, SearchRequest } from '../../src/search/service';
import { SourcesSearch, type SourceSearch } from '../../src/search/sources';

const hit = (id: string): SearchHit => ({
  id,
  title: id,
  titleHighlighted: id,
  snippet: '',
  heading: null,
  tags: [],
  updatedAt: 0,
  sources: ['full-text'],
});

function source(id: string, outcome: SearchOutcome): SourceSearch & { asked: SearchRequest[] } {
  const asked: SearchRequest[] = [];
  return {
    id,
    name: `Notebook ${id}`,
    asked,
    service: {
      invalidate: () => undefined,
      refresh: () => Promise.resolve(),
      typing: (request) => {
        asked.push(request);
        return Promise.resolve(outcome);
      },
      search: (request) => {
        asked.push(request);
        return Promise.resolve(outcome);
      },
    },
  };
}

const request: SearchRequest = {
  input: 'plan',
  mode: 'hybrid',
  filters: { folderId: null, tag: null, updatedAfter: null },
};

describe('search across sources (A826)', () => {
  it('asks each notebook in the mode asked, and labels every hit with its notebook', async () => {
    const work = source('W', { source: 'device', hits: [hit('G1')], notice: null });
    const home = source('H', { source: 'device', hits: [hit('G2')], notice: null });
    const outcome = await new SourcesSearch(() => [work, home]).search(request);
    expect(work.asked[0]!.mode).toBe('hybrid');
    expect(home.asked[0]!.mode).toBe('hybrid');
    expect(outcome.source).toBe('device');
    expect(outcome.hits.map((each) => [each.id, each.notebook])).toEqual([
      ['G1', 'Notebook W'],
      ['G2', 'Notebook H'],
    ]);
    expect(outcome.wordsOnly).toBeUndefined();
  });

  it('says Words only, a notice and a preview as one notebook would (A1156)', async () => {
    const work = source('W', {
      source: 'device',
      hits: [hit('G1')],
      notice: 'Meaning covers 1 of 2 notes so far.',
      preview: true,
    });
    const home = source('H', { source: 'device', hits: [], notice: null, wordsOnly: 'Why' });
    const both = await new SourcesSearch(() => [work, home]).search(request);
    expect(both).toMatchObject({
      notice: 'Meaning covers 1 of 2 notes so far.',
      wordsOnly: 'Why',
      preview: true,
    });
    const alone = await new SourcesSearch(() => [work]).search(request);
    expect(alone.hits[0]!.notebook).toBeUndefined();
    expect(alone.preview).toBe(true);
  });
});
