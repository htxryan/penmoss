// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  DesktopGitHubBrowse,
  GitHubAnswer,
  GitHubRepo,
  RepoFolders,
  RepoList,
} from '../../src/desktop/bridge';
import { RepoFolderStep, type FolderChoice } from '../../src/sources/RepoFolderStep';
import { RepoPicker } from '../../src/sources/RepoPicker';
import { folderNameProblem, pushedWords } from '../../src/sources/repo-words';

// T81 (#229, A1166, A1167): the repository and folder steps of Add a Git Notebook, against a
// stand-in for main's GitHub calls.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const repo = (name: string, extra: Partial<GitHubRepo> = {}): GitHubRepo => ({
  fullName: `ryan/${name}`,
  owner: 'ryan',
  name,
  visibility: 'private',
  defaultBranch: 'main',
  cloneUrl: `https://github.com/ryan/${name}.git`,
  pushedAt: '2026-11-06T10:00:00Z',
  canPush: true,
  empty: false,
  ...extra,
});

function github(
  options: {
    repos?: GitHubAnswer<RepoList>;
    folders?: GitHubAnswer<RepoFolders>;
  } = {},
) {
  const calls: unknown[][] = [];
  const browse: DesktopGitHubBrowse = {
    repos: () => {
      calls.push(['repos']);
      return Promise.resolve(
        options.repos ?? { ok: true, via: 'git', value: { repos: [], more: false } },
      );
    },
    folders: (fullName, branch) => {
      calls.push(['folders', fullName, branch]);
      return Promise.resolve(
        options.folders ?? {
          ok: true,
          via: 'git',
          value: { empty: false, truncated: false, folders: [{ path: '', notebook: null }] },
        },
      );
    },
    owners: () =>
      Promise.resolve({ ok: true, via: 'git', value: [{ login: 'ryan', kind: 'user' }] }),
    create: (owner, name) => {
      calls.push(['create', owner, name]);
      return Promise.resolve({ ok: true, via: 'git', value: repo(name, { empty: true }) });
    },
  };
  return { browse, calls };
}

let host: HTMLElement | null = null;
let unmount: (() => void) | null = null;
afterEach(() => {
  if (unmount) act(unmount);
  unmount = null;
  host?.remove();
  host = null;
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
async function mount(element: React.ReactElement): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(element));
  unmount = () => root.unmount();
  await settle();
  return host;
}
const all = (root: HTMLElement, id: string) => [
  ...root.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
];
const find = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const type = async (input: HTMLElement | null, value: string) => {
  if (!(input instanceof HTMLInputElement)) throw new Error('no input');
  act(() => {
    Reflect.set(HTMLInputElement.prototype, 'value', value, input);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
};
const key = async (element: HTMLElement, name: string) => {
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  });
  await settle();
};

describe('the repository step', () => {
  const list: GitHubAnswer<RepoList> = {
    ok: true,
    via: 'git',
    value: {
      more: false,
      repos: [
        repo('notes'),
        repo('site', { visibility: 'public' }),
        repo('wiki', {
          owner: 'acme',
          fullName: 'acme/wiki',
          visibility: 'internal',
          canPush: false,
        }),
        repo('fresh', { empty: true, pushedAt: '2026-01-01T00:00:00Z' }),
      ],
    },
  };

  it('labels each repository, greys read-only ones, and picks with a click', async () => {
    const { browse } = github({ repos: list });
    const picked: string[] = [];
    const root = await mount(
      <RepoPicker
        github={browse}
        startNew={false}
        picked={null}
        onPick={(each) => picked.push(each.fullName)}
        onCreated={() => undefined}
        onTypeAddress={() => undefined}
      />,
    );
    const rows = all(root, 'repo-row');
    expect(rows.map((row) => row.dataset['repo'])).toEqual([
      'ryan/notes',
      'ryan/site',
      'acme/wiki',
      'ryan/fresh',
    ]);
    expect(rows[1]!.textContent).toContain('Public');
    expect(rows[2]!.textContent).toContain('Read only');
    expect(rows[2]!.getAttribute('aria-disabled')).toBe('true');
    act(() => rows[2]!.click());
    act(() => rows[0]!.click());
    expect(picked).toEqual(['ryan/notes']);
  });

  it('searches as you type, Escape clears it, and the arrow keys skip read-only rows', async () => {
    const { browse } = github({ repos: list });
    const root = await mount(
      <RepoPicker
        github={browse}
        startNew={false}
        picked={null}
        onPick={() => undefined}
        onCreated={() => undefined}
        onTypeAddress={() => undefined}
      />,
    );
    const search = find(root, 'repo-picker-search')!;
    await type(search, 'site');
    expect(all(root, 'repo-row').map((row) => row.dataset['repo'])).toEqual(['ryan/site']);
    await key(search, 'Escape');
    expect((search as HTMLInputElement).value).toBe('');
    await key(search, 'ArrowDown');
    expect(document.activeElement?.getAttribute('data-repo')).toBe('ryan/notes');
    const listbox = find(root, 'repo-list')!;
    await key(listbox, 'ArrowDown');
    await key(listbox, 'ArrowDown');
    // acme/wiki is read-only: the next one is ryan/fresh.
    expect(document.activeElement?.getAttribute('data-repo')).toBe('ryan/fresh');
  });

  it('lists empty repositories first in Start New, and names a new one after the notebook', async () => {
    const { browse, calls } = github({ repos: list });
    const created: string[] = [];
    const root = await mount(
      <RepoPicker
        github={browse}
        startNew
        picked={null}
        onPick={() => undefined}
        onCreated={(each, name) => created.push(`${each.fullName} as ${name}`)}
        onTypeAddress={() => undefined}
      />,
    );
    expect(all(root, 'repo-row')[0]!.dataset['repo']).toBe('ryan/fresh');
    await type(find(root, 'repo-create-notebook'), 'Work Log');
    expect((find(root, 'repo-create-name') as HTMLInputElement).value).toBe('work-log-notes');
    act(() => find(root, 'repo-create-submit')!.click());
    await settle();
    expect(calls).toContainEqual(['create', { login: 'ryan', kind: 'user' }, 'work-log-notes']);
    expect(created).toEqual(['ryan/work-log-notes as Work Log']);
  });

  it('hands a missing sign-in to the form, and says offline itself', async () => {
    const signedOut: string[] = [];
    const none = github({
      repos: { ok: false, error: { reason: 'no_credential', message: 'none' } },
    });
    await mount(
      <RepoPicker
        github={none.browse}
        startNew={false}
        picked={null}
        onPick={() => undefined}
        onCreated={() => undefined}
        onTypeAddress={() => undefined}
        onSignedOut={(error) => signedOut.push(error.reason)}
      />,
    );
    expect(signedOut).toEqual(['no_credential']);
    act(unmount!);
    unmount = null;
    const offline = github({
      repos: { ok: false, error: { reason: 'offline', message: 'Can’t reach GitHub.' } },
    });
    const root = await mount(
      <RepoPicker
        github={offline.browse}
        startNew={false}
        picked={null}
        onPick={() => undefined}
        onCreated={() => undefined}
        onTypeAddress={() => undefined}
        onSignedOut={() => signedOut.push('again')}
      />,
    );
    expect(find(root, 'repo-picker-problem')!.textContent).toContain('Can’t reach GitHub.');
    expect(find(root, 'repo-picker-retry')).not.toBeNull();
    expect(signedOut).toEqual(['no_credential']);
  });

  it('says when a repository was last pushed', () => {
    const now = Date.parse('2026-11-07T12:00:00Z');
    expect(pushedWords(null, now)).toBe('never pushed');
    expect(pushedWords('2026-11-07T11:30:00Z', now)).toBe('30 minutes ago');
    expect(pushedWords('2026-11-06T12:00:00Z', now)).toBe('yesterday');
    expect(pushedWords('2026-10-29T12:00:00Z', now)).toBe('last week');
  });
});

describe('the folder step', () => {
  const folders: GitHubAnswer<RepoFolders> = {
    ok: true,
    via: 'git',
    value: {
      empty: false,
      truncated: true,
      folders: [
        { path: '', notebook: null },
        { path: 'docs', notebook: null },
        { path: 'docs/notes', notebook: { id: '01JBNOTEBOOK00000000000042', name: 'Team notes' } },
        { path: 'home', notebook: { id: '01JBNOTEBOOK00000000000043', name: 'Home' } },
      ],
    },
  };

  function step(
    added: ReadonlySet<string>,
    chosen: FolderChoice,
    onChoose: (choice: FolderChoice) => void,
  ) {
    const { browse, calls } = github({ folders });
    return {
      calls,
      element: (
        <RepoFolderStep
          github={browse}
          repo={repo('code')}
          branch="trunk"
          added={added}
          chosen={chosen}
          onChoose={onChoose}
        />
      ),
    };
  }

  it('lists the root first with badges, marks Already Added, and says when folders are missing', async () => {
    const chosen: FolderChoice[] = [];
    const { element, calls } = step(
      new Set(['01JBNOTEBOOK00000000000043']),
      { dir: '', notebook: null },
      (each) => chosen.push(each),
    );
    const root = await mount(element);
    expect(calls).toEqual([['folders', 'ryan/code', 'trunk']]);
    const rows = all(root, 'repo-folder');
    expect(rows.map((row) => row.dataset['path'])).toEqual(['', 'docs', 'docs/notes', 'home']);
    expect(rows[0]!.getAttribute('aria-selected')).toBe('true');
    expect(rows[2]!.textContent).toContain('Notebook · Team notes');
    expect(rows[3]!.textContent).toContain('Already Added');
    act(() => rows[3]!.click());
    act(() => rows[2]!.click());
    expect(chosen).toEqual([
      { dir: 'docs/notes', notebook: { id: '01JBNOTEBOOK00000000000042', name: 'Team notes' } },
    ]);
    expect(root.textContent).toContain('Some folders aren’t shown');
  });

  it('adds a new folder under the chosen one, by the typed folder’s rules', async () => {
    const chosen: FolderChoice[] = [];
    const { element } = step(new Set(), { dir: 'docs', notebook: null }, (each) =>
      chosen.push(each),
    );
    const root = await mount(element);
    await type(find(root, 'repo-new-folder'), '.hidden');
    act(() => find(root, 'repo-new-folder-add')!.click());
    await settle();
    expect(find(root, 'repo-new-folder-message')!.textContent).toContain('dot');
    await type(find(root, 'repo-new-folder'), 'journal');
    act(() => find(root, 'repo-new-folder-add')!.click());
    await settle();
    expect(chosen).toEqual([{ dir: 'docs/journal', notebook: null }]);
    expect(all(root, 'repo-folder').map((row) => row.dataset['path'])).toContain('docs/journal');
  });

  it('checks folder names', () => {
    expect(folderNameProblem('journal')).toBeNull();
    expect(folderNameProblem('')).not.toBeNull();
    expect(folderNameProblem('a/b')).not.toBeNull();
    expect(folderNameProblem('..')).not.toBeNull();
    expect(folderNameProblem('.git')).not.toBeNull();
  });
});
