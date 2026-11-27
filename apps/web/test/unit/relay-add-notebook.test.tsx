// @vitest-environment happy-dom
/**
 * The relay's Add Notebook (A1701): the app's own `AddNotebook`, unchanged, over the relay's
 * bridge (src/relay/bridge.ts), with the relay's words. Opening a notebook goes through the app's
 * steps (Create or Open Notebook, Pick Repository with no sign-in asked, since the relay's App
 * answers, then Setting Up until the relay's first sync), and starting one names it first.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitNotebookInfo } from '../../src/desktop/bridge';
import { relayDesktop, type RelayCall, type RelayNotebook } from '../../src/relay/bridge';
import { SourcesProvider } from '../../src/sources/context';
import { AddNotebook } from '../../src/sources/FirstRun';
import type { GitSource } from '../../src/sources/git-source';
import { MAC_WORDS, RELAY_WORDS, setHostWords } from '../../src/sources/host-words';
import { Sources } from '../../src/sources/registry';

const repo = (fullName: string, extra: Record<string, unknown> = {}) => ({
  fullName,
  owner: fullName.split('/')[0]!,
  name: fullName.split('/')[1]!,
  visibility: 'private',
  defaultBranch: 'main',
  cloneUrl: `https://github.com/${fullName}.git`,
  pushedAt: '2026-11-06T10:00:00Z',
  canPush: true,
  empty: false,
  ...extra,
});

/** The relay, as its bridge answers: the App's two repositories, one holding a notebook. */
function relay() {
  const calls: unknown[][] = [];
  const served: RelayNotebook[] = [];
  const answer: RelayCall = <T,>(name: string, args: readonly unknown[]) => {
    calls.push([name, ...args]);
    const value = ((): unknown => {
      switch (name) {
        case 'list':
          return served;
        case 'gitLogin':
          return 'htxryan';
        case 'status':
          return {
            accounts: [],
            saved: false,
            login: null,
            problem: null,
            keychain: true,
            signedIn: false,
          };
        case 'repos':
          return {
            ok: true,
            via: 'git',
            value: {
              more: false,
              repos: [repo('ryan/notes'), repo('ryan/empty', { empty: true })],
            },
          };
        case 'owners':
          return { ok: true, via: 'git', value: [{ login: 'htxryan', kind: 'user' }] };
        case 'folders':
          return {
            ok: true,
            via: 'git',
            value:
              args[0] === 'ryan/notes'
                ? {
                    empty: false,
                    truncated: false,
                    folders: [{ path: '', notebook: { id: 'NB-P', name: 'Personal' } }],
                  }
                : { empty: true, truncated: false, folders: [{ path: '', notebook: null }] },
          };
        case 'add': {
          const input = args[0] as { remote: string; name?: string; dir: string; branch: string };
          const notebookId = input.remote.includes('notes') ? 'NB-P' : 'NB-NEW';
          if (!input.remote.includes('notes') && !input.name)
            return { ok: true, value: { kind: 'needs-name' } };
          const notebook: RelayNotebook = {
            notebookId,
            name: input.name ?? 'Personal',
            remote: input.remote,
            repository: 'github.com/x',
            branch: input.branch,
            dir: input.dir,
            hasToken: false,
            syncedAt: Date.now(),
            problem: null,
          };
          served.push(notebook);
          return { ok: true, value: { kind: 'added', created: Boolean(input.name), notebook } };
        }
        default:
          return null;
      }
    })();
    return Promise.resolve(value as T);
  };
  return { answer, calls };
}

/** Every row of the tree in view (happy-dom's IntersectionObserver never answers). */
class SeeingObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    queueMicrotask(() =>
      this.callback(
        [{ target, isIntersecting: true }] as unknown as IntersectionObserverEntry[],
        this as never,
      ),
    );
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

/** A notebook as Setting Up watches it: synced at once. */
const synced = (info: GitNotebookInfo) =>
  ({
    kind: 'git',
    id: info.notebookId,
    name: info.name,
    info,
    feed: { status: { phase: 'synced', detail: null }, subscribe: () => () => undefined },
    syncNow: () => undefined,
    notes: { knows: () => false, list: () => [], onStored: () => () => undefined },
    start: () => undefined,
    stop: () => undefined,
    setInfo: () => undefined,
    storedElsewhere: () => Promise.resolve(),
  }) as unknown as GitSource;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('IntersectionObserver', SeeingObserver);
  setHostWords(RELAY_WORDS);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setHostWords(MAC_WORDS);
  Reflect.deleteProperty(window, 'penmossDesktop');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const $ = (testId: string) => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const $$ = (testId: string) => [...host.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const screen = () => host.querySelector('[data-screen]')?.getAttribute('data-screen');
const title = () => host.querySelector('h2')?.textContent;

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

async function choose(testId: string) {
  const input = $(testId)?.querySelector('input');
  if (!input) throw new Error(`no ${testId}`);
  act(() => input.click());
  await settle();
}

async function type(testId: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  if (!input) throw new Error(`no ${testId}`);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

async function open() {
  const made = relay();
  const bridge = relayDesktop(made.answer);
  Object.assign(window, { penmossDesktop: bridge.desktop });
  const sources = new Sources({ git: bridge.git, makeGit: synced });
  await sources.load();
  const added = vi.fn();
  const closed = vi.fn();
  act(() =>
    root.render(
      <SourcesProvider sources={sources}>
        <AddNotebook git={bridge.git} onClose={closed} onAdded={added} />
      </SourcesProvider>,
    ),
  );
  await settle();
  return { ...made, added, closed };
}

describe('the relay’s Add Notebook (A1701)', () => {
  it('is the app’s Add Notebook: open a notebook through the App, then the first sync', async () => {
    const { calls, added } = await open();
    expect(screen()).toBe('goal');
    expect(title()).toBe('Create or Open Notebook');
    await choose('first-run-existing');
    await press('first-run-continue');
    await settle();
    // The relay's App answers as a Mac's git sign-in would: no sign-in screen.
    expect(screen()).toBe('list');
    expect($('first-run-via')?.textContent).toBe('htxryan');
    await settle();
    await settle();
    const notebooks = $$('first-run-notebook');
    expect(notebooks.map((each) => each.querySelector('strong')?.textContent)).toEqual([
      'Personal',
    ]);
    await press(
      notebooks[0]!.querySelector<HTMLElement>('[data-testid="first-run-notebook-open"]')!,
    );
    await settle();
    expect(calls).toContainEqual([
      'add',
      { remote: 'https://github.com/ryan/notes.git', branch: 'main', dir: '' },
    ]);
    expect(added).toHaveBeenCalledWith('NB-P');
  });

  it('starts a new notebook in an empty repository, named on the app’s Name Your Notebook', async () => {
    const { calls, added } = await open();
    await press('first-run-continue');
    expect(screen()).toBe('way');
    expect($('first-run-way-url')?.textContent).toContain(
      'Any GitHub repository this relay can reach',
    );
    await choose('first-run-way-existing');
    await press('first-run-continue');
    await settle();
    expect(screen()).toBe('list');
    await press($$('first-run-repo-pick')[0]!);
    expect(screen()).toBe('repo');
    expect(title()).toBe('Empty Repository');
    await press('first-run-continue');
    expect(screen()).toBe('name');
    await type('first-run-name-input', 'Scratch');
    await press('first-run-make');
    await settle();
    expect(calls).toContainEqual([
      'add',
      { remote: 'https://github.com/ryan/empty.git', branch: 'main', dir: '', name: 'Scratch' },
    ]);
    expect(added).toHaveBeenCalledWith('NB-NEW');
  });

  it('takes a token for another account on the app’s GitHub Accounts, in the relay’s words', async () => {
    const { calls } = await open();
    await choose('first-run-existing');
    await press('first-run-continue');
    await settle();
    await press('first-run-account-switcher');
    await press('first-run-switch-manage');
    expect(screen()).toBe('accounts');
    expect(title()).toBe('GitHub Accounts');
    expect($('github-token-input')).not.toBeNull();
    expect($('github-token')?.textContent).toContain(
      'A fine-grained token with Contents (read and write) on your notebooks’ repositories',
    );
    expect($('github-token')?.textContent).not.toContain('penmoss with Issues');
    expect(calls).toContainEqual(['status']);
  });

  it('cancels back to the Notebooks page', async () => {
    const { closed } = await open();
    await press('first-run-cancel');
    expect(closed).toHaveBeenCalled();
  });
});
