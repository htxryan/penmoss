import { describe, expect, it } from 'vitest';
import { repositoryLink } from '../../src/sources/repository-link';

// Quanta feedback 3, item 12 (A1128): a git notebook's repository is a link.
describe('repositoryLink', () => {
  it('opens a GitHub repository at the notebook’s branch and folder', () => {
    expect(
      repositoryLink({
        repository: 'github.com/quantaservices/ryan-henderson-scratch',
        host: 'github.com',
        branch: 'dev',
        dir: 'penmoss',
      }),
    ).toBe('https://github.com/quantaservices/ryan-henderson-scratch/tree/dev/penmoss');
    expect(
      repositoryLink({
        repository: 'github.com/me/notes.git',
        host: 'github.com',
        branch: 'main',
        dir: '',
      }),
    ).toBe('https://github.com/me/notes/tree/main');
    expect(
      repositoryLink({
        repository: 'github.com/me/notes',
        host: 'github.com',
        branch: 'feature/x',
        dir: 'a b/c',
      }),
    ).toBe('https://github.com/me/notes/tree/feature%2Fx/a%20b/c');
  });

  it('opens another host’s repository page, and none on this Mac', () => {
    expect(
      repositoryLink({
        repository: 'gitlab.com/me/notes',
        host: 'gitlab.com',
        branch: 'main',
        dir: '',
      }),
    ).toBe('https://gitlab.com/me/notes');
    expect(
      repositoryLink({
        repository: 'this Mac: /Users/me/notes.git',
        host: 'this Mac',
        branch: 'main',
        dir: '',
      }),
    ).toBeNull();
  });
});
