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
    ).toEqual({
      url: 'https://github.com/quantaservices/ryan-henderson-scratch/tree/dev/penmoss',
      github: true,
    });
    expect(
      repositoryLink({
        repository: 'github.com/me/notes.git',
        host: 'github.com',
        branch: 'main',
        dir: '',
      })?.url,
    ).toBe('https://github.com/me/notes/tree/main');
    expect(
      repositoryLink({
        repository: 'github.com/me/notes',
        host: 'github.com',
        branch: 'feature/x',
        dir: 'a b/c',
      })?.url,
    ).toBe('https://github.com/me/notes/tree/feature%2Fx/a%20b/c');
  });

  it('opens an SSH alias’s repository on its real host (A1565)', () => {
    // `git@github-quanta:…`, with `Host github-quanta` / `HostName github.com` in ~/.ssh/config.
    expect(
      repositoryLink({
        repository: 'github-quanta/quantaservices/ryan-henderson-scratch',
        host: 'github-quanta',
        webHost: 'github.com',
        branch: 'dev',
        dir: 'penmoss',
      }),
    ).toEqual({
      url: 'https://github.com/quantaservices/ryan-henderson-scratch/tree/dev/penmoss',
      github: true,
    });
    // An alias for another host: that host's page.
    expect(
      repositoryLink({
        repository: 'work-git/team/notes.git',
        host: 'work-git',
        webHost: 'git.example.com',
        branch: 'main',
        dir: '',
      }),
    ).toEqual({ url: 'https://git.example.com/team/notes', github: false });
  });

  it('opens another host’s repository page, and none on this Mac', () => {
    expect(
      repositoryLink({
        repository: 'gitlab.com/me/notes',
        host: 'gitlab.com',
        branch: 'main',
        dir: '',
      }),
    ).toEqual({ url: 'https://gitlab.com/me/notes', github: false });
    expect(
      repositoryLink({
        repository: 'this Mac: /Users/me/notes.git',
        host: 'this Mac',
        webHost: '',
        branch: 'main',
        dir: '',
      }),
    ).toBeNull();
  });
});
