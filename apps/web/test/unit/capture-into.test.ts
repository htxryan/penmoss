import { describe, expect, it } from 'vitest';
import { captureStart } from '../../src/capture/into';
import type { Source } from '../../src/sources/registry';

// T39 pass 3 review (A914): the Mac's quick capture names its notebook and lets it be changed, as
// Android's capture sheet does (A888): where it starts. Git notebooks only since T59 (D49).

const source = (id: string) => ({ id }) as unknown as Source;
const work = source('git-work');
const home = source('git-home');

describe('where a quick capture starts (A888, A914)', () => {
  it('in the only notebook there is, with nothing to choose', () => {
    expect(captureStart({ all: [work], journal: work, journalPicked: false })).toBe('git-work');
  });

  it('in the Journal notebook picked here', () => {
    expect(captureStart({ all: [work, home], journal: home, journalPicked: true })).toBe(
      'git-home',
    );
  });

  it('with several notebooks and none picked: in none, never the first silently', () => {
    expect(captureStart({ all: [work, home], journal: work, journalPicked: false })).toBeNull();
  });
});
