import { describe, expect, it } from 'vitest';
import { folderNameProblem, pushedWords } from '../../src/sources/repo-words';

// The words the notebook steps' repository and folder screens use (T81, #229, A1562).

describe('the repository and folder words', () => {
  it('says when a repository was last pushed', () => {
    const now = Date.parse('2026-11-07T12:00:00Z');
    expect(pushedWords(null, now)).toBe('never pushed');
    // Core's timeAgo, as every screen says how long ago (PEN-188).
    expect(pushedWords('2026-11-07T11:30:00Z', now)).toBe('30 min ago');
    expect(pushedWords('2026-11-07T09:00:00Z', now)).toBe('3 h ago');
    expect(pushedWords('not a date', now)).toBe('');
  });

  it('checks folder names', () => {
    expect(folderNameProblem('journal')).toBeNull();
    expect(folderNameProblem('')).not.toBeNull();
    expect(folderNameProblem('a/b')).not.toBeNull();
    expect(folderNameProblem('..')).not.toBeNull();
    expect(folderNameProblem('.git')).not.toBeNull();
    expect(folderNameProblem('.hidden')).toContain('dot');
  });
});
