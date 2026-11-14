// @vitest-environment happy-dom
/**
 * The first run (T59, A1030; Ryan's review of #192, findings 2–4, First Run C): with no git
 * notebook on this Mac the app has nothing to open, so the window shows the first run, one step
 * per screen. Once a notebook is set up (its first sync done), the app opens it; its views are
 * mounted only then, with a root and a Journal notebook.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DesktopGit,
  DesktopGitHubBrowse,
  GitHubAnswer,
  GitHubRepo,
  GitNotebookInfo,
  PenmossDesktop,
  RepoFolders,
  RepoList,
} from '../../src/desktop/bridge';
import type { GitSyncStatus } from '../../src/sources/engine-host';
import { FirstRunGate } from '../../src/sources/FirstRun';
import { nameFromRepo, repoNameOf } from '../../src/sources/first-run-flow';
import { SourcesProvider } from '../../src/sources/context';
import { useSourcesState } from '../../src/sources/hooks';
import { Sources, type Source } from '../../src/sources/registry';

const info = (notebookId: string): GitNotebookInfo => ({
  localId: `${notebookId}-local`,
  notebookId,
  name: `Notebook ${notebookId}`,
  create: false,
  remote: 'git@github.com:me/notes.git',
  repository: 'github.com/me/notes',
  host: 'github.com',
  branch: 'main',
  dir: '',
  pushDelayS: 30,
  pullEveryMin: 5,
  sign: false,
  author: null,
  hasToken: false,
  filterIgnored: false,
});

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

/** Main's GitHub calls, answering as `options` say. */
function github(
  options: {
    repos?: GitHubAnswer<RepoList>;
    folders?: Record<string, RepoFolders>;
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
      return Promise.resolve({
        ok: true,
        via: 'git',
        value: options.folders?.[fullName] ?? {
          empty: false,
          truncated: false,
          folders: [{ path: '', notebook: null }],
        },
      });
    },
    owners: () =>
      Promise.resolve({
        ok: true,
        via: 'git',
        value: [
          { login: 'ryan', kind: 'user' },
          { login: 'acme', kind: 'org' },
        ],
      }),
    create: (owner, name) => {
      calls.push(['create', owner.login, name]);
      return Promise.resolve(
        name === 'used'
          ? {
              ok: false,
              error: { reason: 'exists', message: 'ryan/used is there already.' },
            }
          : { ok: true, via: 'git', value: repo(name, { empty: true }) },
      );
    },
  };
  return { browse, calls };
}

/** The Mac's git, with no notebook until `add` makes one; a GitHub stand-in when given one. */
function macGit(browse?: DesktopGitHubBrowse) {
  const listed: GitNotebookInfo[] = [];
  const listeners = new Set<() => void>();
  const add = vi.fn(
    (input: { readonly remote: string; readonly dir: string; readonly name?: string }) => {
      if (input.remote.includes('kept')) {
        const notebook = { ...info('NB1'), name: 'Kept', dir: input.dir };
        listed.push(notebook);
        return Promise.resolve({ ok: true, value: { kind: 'added', notebook, created: false } });
      }
      if (!input.name) return Promise.resolve({ ok: true, value: { kind: 'needs-name' } });
      const notebook = { ...info('NB1'), name: input.name, create: true };
      listed.push(notebook);
      for (const listener of listeners) listener();
      return Promise.resolve({ ok: true, value: { kind: 'added', notebook, created: true } });
    },
  );
  const git = {
    list: vi.fn(() => Promise.resolve([...listed])),
    onChange: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    add,
    ...(browse ? { github: browse } : {}),
  } as unknown as DesktopGit;
  return { git, add };
}

/** A sync feed the test drives: the notebook's first sync, as its engine would tell it. */
function feed() {
  const listeners = new Set<() => void>();
  let status = { phase: 'starting', detail: null } as unknown as GitSyncStatus;
  return {
    feed: {
      get status() {
        return status;
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    set(phase: GitSyncStatus['phase'], detail: string | null = null) {
      status = { ...status, phase, detail };
      for (const listener of listeners) listener();
    },
  };
}

/** A notebook source as the app would make it (its engine is not this test's). */
const fakeSource =
  (sync?: ReturnType<typeof feed>, syncNow = vi.fn()) =>
  (each: GitNotebookInfo) =>
    ({
      kind: 'git',
      id: each.notebookId,
      name: each.name,
      info: each,
      ...(sync ? { feed: sync.feed, syncNow } : {}),
      notes: { knows: () => false, list: () => [], onStored: () => () => undefined },
      start: () => undefined,
      stop: () => undefined,
      setInfo: () => undefined,
      storedElsewhere: () => Promise.resolve(),
    }) as unknown as Source;

/** What the app shows once open: its root and Journal notebook, never missing. */
function TheApp() {
  const state = useSourcesState();
  return (
    <p data-testid="the-app">
      {state ? `${state.root.id} ${state.journal.id}` : 'no notebook in the app'}
    </p>
  );
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  Reflect.deleteProperty(window, 'penmossDesktop');
});

function render(sources: Sources | null, capture = false) {
  const gate = (
    <FirstRunGate capture={capture}>
      <TheApp />
    </FirstRunGate>
  );
  act(() =>
    root.render(sources ? <SourcesProvider sources={sources}>{gate}</SourcesProvider> : gate),
  );
}

const $ = (testId: string) => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const $$ = (testId: string) => [...host.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const screen = () => host.querySelector('[data-screen]')?.getAttribute('data-screen');

async function type(testId: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  if (!input) throw new Error(`no ${testId}`);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

/** Clicks a button; one that submits a form submits it (Return in its fields does the same). */
async function press(target: string | HTMLElement) {
  const button = typeof target === 'string' ? $(target) : target;
  if (!button) throw new Error(`no ${typeof target === 'string' ? target : 'button'}`);
  const form = button.getAttribute('form');
  await act(async () => {
    if (form) (document.getElementById(form) as HTMLFormElement).requestSubmit();
    else button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await settle();
}

/** Picks a radio choice (its row's input). */
async function choose(testId: string) {
  const input = $(testId)?.querySelector('input');
  if (!input) throw new Error(`no ${testId}`);
  act(() => input.click());
  await settle();
}

async function start(browse?: DesktopGitHubBrowse, sync?: ReturnType<typeof feed>) {
  const made = macGit(browse);
  Object.assign(window, { penmossDesktop: { git: made.git } as unknown as PenmossDesktop });
  const sources = new Sources({ git: made.git, makeGit: fakeSource(sync) });
  await sources.load();
  render(sources);
  return made;
}

describe('the first run (A1030, First Run C)', () => {
  it('waits while the list is read, without mounting the app', () => {
    const { git } = macGit();
    const sources = new Sources({ git, makeGit: fakeSource() });
    render(sources);
    expect(host.textContent).toContain('Opening Penmoss…');
    expect($('the-app')).toBeNull();
    expect($('first-run')).toBeNull();
  });

  it('welcomes in a line, then one step per screen, with Back', async () => {
    await start();
    expect($('first-run')).not.toBeNull();
    expect($('the-app')).toBeNull();
    // The welcome is short (finding 2): one heading, one line, Get Started.
    expect(screen()).toBe('welcome');
    expect(host.querySelector('h2')?.textContent).toBe('Welcome to Penmoss');
    expect(document.activeElement).toBe(host.querySelector('h2'));
    expect($('first-run-welcome')!.querySelector('.fr-lead')?.textContent).toBe(
      'Notes in a git repository you own. Three short steps and you’re writing.',
    );
    expect($('first-run-back')).toBeNull();
    await press('first-run-start');
    expect(screen()).toBe('goal');
    expect(host.textContent).toContain('Step 1 of 3');
    expect(host.querySelector('h2')?.textContent).toBe('Create or Open Notebook');
    await press('first-run-back');
    expect(screen()).toBe('welcome');
  });

  it('without GitHub, a new notebook is a pasted address, named, then the app opens it', async () => {
    const { add } = await start();
    await press('first-run-start');
    await press('first-run-continue');
    // No GitHub browsing in this window: straight to Paste a URL.
    expect(screen()).toBe('url');
    expect(host.textContent).toContain('Step 2 of 3');
    await type('first-run-url-input', 'git@github.com:me/field-notes.git');
    await press('first-run-continue');
    // It holds no notebook: name the new one, offered from the repository's name.
    expect(screen()).toBe('name');
    expect(host.textContent).toContain('Step 3 of 3');
    expect($('first-run-name-input')).toHaveProperty('value', 'Field Notes');
    expect($('first-run-place')!.textContent).toContain('git@github.com:me/field-notes.git');
    expect($('first-run-place')!.textContent).toContain('Root');
    await type('first-run-name-input', 'Journal');
    await press('first-run-make');
    await vi.waitFor(() => expect($('the-app')?.textContent).toBe('NB1 NB1'));
    expect($('first-run')).toBeNull();
    expect(add).toHaveBeenLastCalledWith(
      expect.objectContaining({ remote: 'git@github.com:me/field-notes.git', name: 'Journal' }),
    );
  });

  it('says what git refused, in place, and Try Again asks again', async () => {
    const { add } = await start();
    add.mockResolvedValueOnce({
      ok: false,
      error: { code: 'auth', message: 'The host refused the sign-in.', hostMessage: 'denied' },
    } as never);
    await press('first-run-start');
    await press('first-run-continue');
    await type('first-run-url-input', 'git@example.com:me/notes.git');
    await press('first-run-continue');
    expect($('first-run-url-problem')?.textContent).toBe(
      'The host refused the sign-in. The host said: denied',
    );
    expect($('first-run-continue')?.textContent).toBe('Try Again');
    await press('first-run-continue');
    expect(screen()).toBe('name');
  });

  it('with git missing, says Penmoss needs git', async () => {
    const { add } = await start();
    add.mockResolvedValueOnce({
      ok: false,
      error: { code: 'git_missing', message: 'git is not installed.' },
    } as never);
    await press('first-run-start');
    await press('first-run-continue');
    await type('first-run-url-input', 'git@example.com:me/notes.git');
    await press('first-run-continue');
    expect(screen()).toBe('git-missing');
    expect(host.textContent).toContain('xcode-select --install');
    await press('first-run-retry');
    expect(screen()).toBe('url');
  });

  it('an address that holds a notebook opens it, with no name asked', async () => {
    const { add } = await start();
    await press('first-run-start');
    await choose('first-run-existing');
    await press('first-run-continue');
    await type('first-run-url-input', 'git@github.com:me/kept.git');
    await press('first-run-continue');
    await vi.waitFor(() => expect($('the-app')?.textContent).toBe('NB1 NB1'));
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]![0]).not.toHaveProperty('name');
  });

  it('Create New Repo names the repository after the notebook, owner as words, then makes it', async () => {
    const { browse, calls } = github();
    const { add } = await start(browse);
    await press('first-run-start');
    await press('first-run-continue');
    // Pick Repository: three ways, Create New Repo first and picked.
    expect(screen()).toBe('way');
    expect($('first-run-way-create')!.textContent).toContain('Recommended');
    expect($('first-run-way-create')!.querySelector('input')).toHaveProperty('checked', true);
    await press('first-run-continue');
    expect(screen()).toBe('create');
    // The owner is words, not a disabled field; Change offers the others.
    expect($('first-run-create-owner-label')?.textContent).toBe('ryan /');
    expect($('first-run-create-owner')).toBeNull();
    expect(host.textContent).not.toContain('follows');
    await type('first-run-create-notebook', 'Work Log');
    expect($('first-run-create-repo')).toHaveProperty('value', 'work-log-notes');
    // A name GitHub has already: it says so, and offers another.
    await type('first-run-create-repo', 'used');
    await press('first-run-create-submit');
    expect($('first-run-create-taken')?.textContent).toContain('ryan/used already exists.');
    await press('first-run-create-suggest');
    expect($('first-run-create-repo')).toHaveProperty('value', 'used-2');
    await press('first-run-create-change');
    expect($('first-run-create-owner')).not.toBeNull();
    await press('first-run-create-submit');
    await vi.waitFor(() => expect($('the-app')?.textContent).toBe('NB1 NB1'));
    expect(calls).toContainEqual(['create', 'ryan', 'used-2']);
    expect(add).toHaveBeenLastCalledWith(
      expect.objectContaining({
        remote: 'https://github.com/ryan/used-2.git',
        dir: '',
        name: 'Work Log',
      }),
    );
  });

  it('Use Existing Repo lists repositories with their notebooks beneath; Open opens one', async () => {
    const { browse } = github({
      repos: {
        ok: true,
        via: 'git',
        value: {
          more: false,
          repos: [
            repo('kept'),
            repo('fresh', { empty: true }),
            repo('wiki', { owner: 'acme', fullName: 'acme/wiki', canPush: false }),
          ],
        },
      },
      folders: {
        'ryan/kept': {
          empty: false,
          truncated: false,
          folders: [
            { path: '', notebook: null },
            { path: 'work', notebook: { id: '01JBNOTEBOOK00000000000001', name: 'Work' } },
            { path: 'home', notebook: { id: '01JBNOTEBOOK00000000000002', name: 'Home' } },
          ],
        },
      },
    });
    const { add } = await start(browse);
    await press('first-run-start');
    await choose('first-run-existing');
    await press('first-run-continue');
    await vi.waitFor(() => expect(screen()).toBe('list'));
    const repos = $$('first-run-tree-repo');
    expect(repos.map((each) => each.dataset['repo'])).toEqual([
      'ryan/kept',
      'ryan/fresh',
      'acme/wiki',
    ]);
    // The notebooks under their repository, each with where it is; no "in " before the line.
    const notebooks = $$('first-run-notebook');
    expect(notebooks.map((each) => each.textContent)).toEqual(['Workwork/Open', 'Homehome/Open']);
    expect(repos[1]!.textContent).toContain('No notebook yet');
    expect(repos[2]!.textContent).toContain('Read Only');
    expect($('first-run-via')?.textContent).toContain('Signed in to GitHub as ryan');
    // The filter narrows repositories and notebooks.
    await type('first-run-filter', 'home');
    expect($$('first-run-notebook').map((each) => each.dataset['dir'])).toEqual(['home']);
    expect($('first-run-filter-count')?.textContent).toBe('1 of 3 match.');
    await press($$('first-run-notebook-open')[0]!);
    await vi.waitFor(() => expect($('the-app')?.textContent).toBe('NB1 NB1'));
    expect(add).toHaveBeenLastCalledWith(
      expect.objectContaining({ remote: 'https://github.com/ryan/kept.git', dir: 'home' }),
    );
    expect(add.mock.calls.at(-1)![0]).not.toHaveProperty('name');
  });

  it('a repository picked: empty starts at its root, other files ask for a folder', async () => {
    const { browse } = github({
      repos: {
        ok: true,
        via: 'git',
        value: { more: false, repos: [repo('code'), repo('fresh', { empty: true })] },
      },
      folders: {
        'ryan/code': {
          empty: false,
          truncated: false,
          folders: [
            { path: '', notebook: null },
            { path: 'docs', notebook: null },
            { path: 'docs/guide', notebook: null },
          ],
        },
        'ryan/fresh': { empty: true, truncated: false, folders: [{ path: '', notebook: null }] },
      },
    });
    await start(browse);
    await press('first-run-start');
    await press('first-run-continue');
    await choose('first-run-way-existing');
    await press('first-run-continue');
    await vi.waitFor(() => expect(screen()).toBe('list'));
    // A new notebook wants an empty repository: those first.
    expect($$('first-run-tree-repo').map((each) => each.dataset['repo'])).toEqual([
      'ryan/fresh',
      'ryan/code',
    ]);
    await press($$('first-run-repo-pick')[0]!);
    expect(screen()).toBe('repo');
    expect(host.querySelector('h2')?.textContent).toBe('Empty Repository');
    expect($('first-run-place')?.textContent).toContain('ryan/fresh');
    await press('first-run-back');
    await press($$('first-run-repo-pick')[1]!);
    expect(host.querySelector('h2')?.textContent).toBe('Pick Folder');
    // Root carries the repository's name; each folder its icon.
    const folders = $$('first-run-folder-option');
    expect(folders.map((each) => each.dataset['path'])).toEqual(['', 'docs', 'docs/guide']);
    expect(folders[0]!.textContent).toContain('Root');
    expect(folders[0]!.textContent).toContain('ryan/code');
    act(() => folders[1]!.querySelector('input')!.click());
    await type('first-run-new-folder', 'a/b');
    await press('first-run-new-folder-add');
    expect($('first-run-new-folder-problem')?.textContent).toContain('no slashes');
    await type('first-run-new-folder', 'notes');
    await press('first-run-new-folder-add');
    expect(host.querySelector<HTMLInputElement>('[data-path="docs/notes"] input')?.checked).toBe(
      true,
    );
    await press('first-run-continue');
    expect(screen()).toBe('name');
    expect($('first-run-name-input')).toHaveProperty('value', 'Notes');
    expect($('first-run-place')?.textContent).toContain('docs/notes/');
  });

  it('a repository holding one notebook offers to open it, never a second one silently', async () => {
    const { browse } = github({
      repos: { ok: true, via: 'git', value: { more: false, repos: [repo('kept')] } },
      folders: {
        'ryan/kept': {
          empty: false,
          truncated: false,
          folders: [{ path: '', notebook: { id: '01JBNOTEBOOK00000000000001', name: 'Personal' } }],
        },
      },
    });
    await start(browse);
    await press('first-run-start');
    await choose('first-run-existing');
    await press('first-run-continue');
    await vi.waitFor(() => expect(screen()).toBe('list'));
    await press($$('first-run-repo-pick')[0]!);
    expect(host.querySelector('h2')?.textContent).toBe('Personal Is Already Here');
    expect($('first-run-open')?.textContent).toBe('Open Personal');
    // At the root, so there is no folder beside it for another.
    expect($('first-run-another')).toBeNull();
  });

  it('with no GitHub sign-in in git, offers Paste a URL Instead', async () => {
    const { browse } = github({
      repos: { ok: false, error: { reason: 'no_credential', message: 'none' } },
    });
    await start(browse);
    await press('first-run-start');
    await press('first-run-continue');
    await press('first-run-continue');
    await vi.waitFor(() => expect($('first-run-github')?.dataset['state']).toBe('signed-out'));
    expect(host.querySelector('h2')?.textContent).toBe('Sign In to GitHub');
    expect($('first-run-gh-hint')?.textContent).toContain('gh auth login');
    await press('first-run-url-instead');
    expect(screen()).toBe('url');
    // Back goes to Pick Repository, not to the sign-in.
    await press('first-run-back');
    expect(screen()).toBe('way');
  });

  it('stays on Setting Up until the first sync, and a failed one offers Retry and Open Anyway', async () => {
    const sync = feed();
    const syncNow = vi.fn();
    const made = macGit();
    Object.assign(window, { penmossDesktop: { git: made.git } as unknown as PenmossDesktop });
    const sources = new Sources({ git: made.git, makeGit: fakeSource(sync, syncNow) });
    await sources.load();
    render(sources);
    await press('first-run-start');
    await press('first-run-continue');
    await type('first-run-url-input', 'git@github.com:me/notes.git');
    await press('first-run-continue');
    await press('first-run-make');
    await vi.waitFor(() => expect($('first-run-setup')?.dataset['state']).toBe('syncing'));
    expect(host.querySelector('h2')?.textContent).toBe('Making Notes');
    expect($$('first-run-step').map((each) => each.textContent)).toEqual([
      'Set up the notebook',
      'First sync…',
    ]);
    // The list has the notebook, but the first run stays until it syncs.
    expect($('the-app')).toBeNull();
    act(() => sync.set('offline', 'Could not reach the git host.'));
    expect(host.querySelector('h2')?.textContent).toBe('Couldn’t Finish Setting Up');
    expect($$('first-run-step')[1]!.textContent).toBe(
      'First sync failed: Could not reach the git host.',
    );
    expect(host.textContent).toContain('Nothing is lost.');
    await press('first-run-retry');
    expect(syncNow).toHaveBeenCalled();
    expect($('first-run-setup')?.dataset['state']).toBe('syncing');
    act(() => sync.set('synced'));
    await vi.waitFor(() => expect($('the-app')?.textContent).toBe('NB1 NB1'));
  });

  it('says to open the Mac app where there is no git', () => {
    render(new Sources({ git: null }));
    expect($('first-run-no-mac')).not.toBeNull();
    expect($('the-app')).toBeNull();
  });

  it('in the capture window, says where to add one instead', async () => {
    const { git } = macGit();
    const sources = new Sources({ git, makeGit: fakeSource() });
    await sources.load();
    render(sources, true);
    expect($('first-run-capture')).not.toBeNull();
    expect($('first-run')).toBeNull();
  });

  it('opens the app at once when there is a notebook, its root the Journal notebook', async () => {
    const { git, add } = macGit();
    await add({ remote: 'x', dir: '', name: 'Work' });
    const sources = new Sources({ git, makeGit: fakeSource() });
    await sources.load();
    render(sources);
    expect($('the-app')?.textContent).toBe('NB1 NB1');
    expect($('first-run')).toBeNull();
  });

  it('gets out of the way without a registry (a view rendered over one source)', () => {
    render(null);
    expect($('the-app')?.textContent).toBe('no notebook in the app');
  });
});

describe('the words the first run takes from a repository', () => {
  it('names a notebook after its repository', () => {
    expect(nameFromRepo('field-notes')).toBe('Field Notes');
    expect(nameFromRepo('work_log.git')).toBe('Work Log');
    expect(repoNameOf('git@github.com:me/field-notes.git')).toBe('field-notes');
    expect(repoNameOf('https://example.com/a/b/notes/')).toBe('notes');
  });
});
