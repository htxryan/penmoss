// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DesktopGit, GitNotebookInfo } from '../../src/desktop/bridge';
import { GitNotebooksSettings } from '../../src/sources/GitNotebooksSettings';
import { requestGitControl } from '../../src/sources/git-commands';
import { SourcesContext } from '../../src/sources/hooks';
import type { Source, Sources, SourcesState } from '../../src/sources/registry';

// PEN-146: All Notebooks (the list, one Primary picker, Between Notebooks, this Mac's commits)
// and a notebook's page in three tabs, Overview, Sync and Git, the tab in the URL.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = '01JB00000000000000000000AA';
const B = '01JB00000000000000000000BB';

const info = (id: string, name: string): GitNotebookInfo => ({
  localId: `local-${id}`,
  notebookId: id,
  name,
  create: false,
  remote: `https://github.com/me/${name.toLowerCase()}.git`,
  repository: `github.com/me/${name.toLowerCase()}`,
  host: 'github.com',
  branch: 'main',
  dir: '',
  pushDelayS: 12,
  pullEveryMin: 1,
  sign: true,
  author: null,
  hasToken: false,
  filterIgnored: false,
});

function workspace() {
  const settings: Record<string, unknown> = {};
  const state = { loaded: true };
  return {
    settings: () => settings,
    setSetting: (key: string, value: unknown) => {
      if (value === undefined) delete settings[key];
      else settings[key] = value;
    },
    subscribe: () => () => undefined,
    getState: () => state,
  };
}

function notebook(id: string, name: string, notes: number) {
  const status = {
    phase: 'synced',
    detail: null,
    hostMessage: null,
    code: null,
    pending: [],
    handEdits: [],
    skipped: {},
    lastSyncAt: Date.now() - 2 * 60_000,
    nextRetryAt: null,
    head: null,
    here: true,
  };
  return {
    id,
    name,
    kind: 'git',
    info: info(id, name),
    onInfo: () => () => undefined,
    feed: { subscribe: () => () => undefined, status, shown: status },
    notes: {
      subscribe: () => () => undefined,
      list: () => Array.from({ length: notes }, (_, at) => ({ id: `${id}${at}` })),
    },
    workspace: workspace(),
    syncNow: () => undefined,
  } as unknown as Source;
}

let journal: string[] = [];
let host: HTMLElement | null = null;
let unmount: (() => void) | null = null;

function setUp() {
  journal = [];
  const personal = notebook(A, 'Personal', 2140);
  const quanta = notebook(B, 'Quanta', 1);
  const state = {
    all: [personal, quanta],
    journal: personal,
    journalPicked: true,
    loaded: true,
  } as unknown as SourcesState;
  const sources = {
    subscribe: () => () => undefined,
    getState: () => state,
    setJournal: (id: string) => journal.push(id),
    refresh: () => Promise.resolve(),
  } as unknown as Sources;
  const git = {
    identity: () => Promise.resolve({ name: 'Ryan Henderson', email: 'ryan@example.com' }),
    onChange: () => () => undefined,
    list: () => Promise.resolve([]),
  } as unknown as DesktopGit;
  (window as unknown as { penmossDesktop: unknown }).penmossDesktop = { git };
  return sources;
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const frame = () =>
  act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
async function mount(sources: Sources, element: React.ReactElement): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(<SourcesContext.Provider value={sources}>{element}</SourcesContext.Provider>),
  );
  unmount = () => root.unmount();
  await settle();
  return host;
}

const find = (root: ParentNode, id: string) =>
  root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const settings = (root: ParentNode) =>
  [...root.querySelectorAll<HTMLElement>('[data-setting]')].map((row) => row.dataset['setting']);
const click = async (element: HTMLElement | null) => {
  if (!element) throw new Error('not found');
  act(() => element.click());
  await settle();
};

beforeEach(() => history.replaceState(null, '', '/settings/git-notebooks'));
afterEach(() => {
  if (unmount) act(unmount);
  unmount = null;
  host?.remove();
  host = null;
  delete (window as unknown as { penmossDesktop?: unknown }).penmossDesktop;
});

describe('All Notebooks (PEN-146)', () => {
  it('lists the notebooks, then one Primary picker, Between Notebooks and this Mac’s commits', async () => {
    const root = await mount(setUp(), <GitNotebooksSettings />);
    expect(root.querySelector('h1')?.textContent).toBe('All Notebooks');
    const rows = [...root.querySelectorAll<HTMLElement>('[data-testid="git-notebook-row"]')];
    expect(rows.map((row) => row.getAttribute('href'))).toEqual([
      `/settings/git-notebooks/${A}`,
      `/settings/git-notebooks/${B}`,
    ]);
    expect(find(rows[0]!, 'git-row-primary')?.textContent).toBe('Primary');
    expect(find(rows[1]!, 'git-row-primary')).toBeNull();
    expect(find(rows[0]!, 'git-row-state')?.textContent).toBe(
      'github.com/me/personal · Synced 2 min ago',
    );
    expect(settings(root)).toEqual([
      'add-notebook',
      'primary-notebook',
      'keep-settings-in-step',
      'copy-tags-when-copying-notes',
      'copy-settings',
      'commit-identity',
    ]);
    // A1558: Primary Notebook is Between Notebooks' first row, not a group of its own.
    const between = find(root, 'git-primary')!.closest('.lf-group')!;
    expect(between.previousElementSibling?.textContent).toBe('Between Notebooks');
    expect(
      [...between.querySelectorAll<HTMLElement>('[data-setting]')].map(
        (row) => row.dataset['setting'],
      ),
    ).toEqual([
      'primary-notebook',
      'keep-settings-in-step',
      'copy-tags-when-copying-notes',
      'copy-settings',
    ]);
    const picker = find(root, 'git-primary-picker') as HTMLSelectElement;
    expect(picker.value).toBe(A);
    act(() => {
      picker.value = B;
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(journal).toEqual([B]);
    expect(find(root, 'git-identity')?.textContent).toContain('Ryan Henderson');
    expect(find(root, 'git-identity')?.textContent).toContain('ryan@example.com');
  });

  it('copies one notebook’s settings to another, once', async () => {
    const sources = setUp();
    const state = sources.getState();
    (state.all[0]!.workspace as unknown as ReturnType<typeof workspace>).setSetting('a', 1);
    const root = await mount(sources, <GitNotebooksSettings />);
    await click(find(root, 'git-copy-settings-open'));
    const panel = find(root, 'git-settings-copy')!;
    expect((find(panel, 'git-copy-from') as HTMLSelectElement).value).toBe(A);
    expect((find(panel, 'git-copy-to') as HTMLSelectElement).value).toBe(B);
    await click(find(panel, 'git-copy-settings'));
    expect(find(panel, 'git-copy-settings-done')?.textContent).toBe(
      'Copied Personal’s settings to Quanta.',
    );
    expect(state.all[1]!.workspace.settings()).toEqual({ a: 1 });
    await click(find(panel, 'git-copy-settings'));
    expect(find(panel, 'git-copy-settings-done')?.textContent).toBe(
      'Quanta already had these settings.',
    );
  });
});

describe('A notebook’s page (PEN-146)', () => {
  it('has a header with Sync Now, then Overview, Sync and Git, the tab in the URL', async () => {
    history.replaceState(null, '', `/settings/git-notebooks/${A}`);
    const root = await mount(setUp(), <GitNotebooksSettings item={A} />);
    const page = find(root, 'git-notebook')!;
    // The chip beside the title, not in it: the heading is the notebook's name (A1560).
    expect(page.querySelector('h1')?.textContent).toBe('Personal');
    expect(find(page, 'git-primary-chip')?.textContent).toBe('Primary');
    expect(find(page, 'git-status')?.textContent).toBe('Synced 2 min ago');
    expect(
      [...page.querySelectorAll('[role="tab"]')].map((tab) => [
        tab.textContent,
        tab.getAttribute('aria-selected'),
      ]),
    ).toEqual([
      ['Overview', 'true'],
      ['Sync', 'false'],
      ['Git', 'false'],
    ]);
    expect(settings(find(page, 'git-panel-overview')!)).toEqual([
      'notebook-name',
      // Its badge (PEN-140), right after its name.
      'badge',
      'badge-colour',
      'badge-shows',
      'badge-letter',
      'repository',
      'notebook-notes',
      'notebook-copy-settings',
      'remove-from-this-mac',
    ]);
    expect(find(page, 'git-note-count')?.textContent).toContain('2,140 notes');
    expect(find(page, 'git-repository-link')?.textContent).toBe('Open on GitHub');
    expect(find(page, 'git-remove')?.textContent).toBe('Remove from This Mac…');
    // No agents here: they are Settings → Agents, and what they did Agent Activity.
    expect(page.textContent).not.toContain('Agent Activity');

    await click(find(page, 'git-tab-sync'));
    expect(location.search).toBe('?tab=sync');
    expect(settings(find(page, 'git-panel-sync')!)).toEqual([
      'push-changes',
      'pull-changes',
      'sync-status',
    ]);
    const push = find(page, 'git-push-delay') as HTMLSelectElement;
    expect(push.selectedOptions[0]?.textContent).toBe('After 12 Seconds');
    expect(
      (find(page, 'git-pull-interval') as HTMLSelectElement).selectedOptions[0]?.textContent,
    ).toBe('Every Minute');
    expect(find(page, 'git-details')?.hasAttribute('open')).toBe(false);

    await click(find(page, 'git-tab-git'));
    expect(location.search).toBe('?tab=git');
    expect(settings(find(page, 'git-panel-git')!)).toEqual([
      'commit-name-and-email',
      'sign-commits',
      'sign-in',
    ]);
  });

  it('opens the tab of the control a command asks for, and focuses it (#170 F5)', async () => {
    history.replaceState(null, '', `/settings/git-notebooks/${A}`);
    const root = await mount(setUp(), <GitNotebooksSettings item={A} />);
    act(() => requestGitControl(A, 'git-author-email'));
    await settle();
    await frame();
    expect(location.search).toBe('?tab=git');
    expect(document.activeElement).toBe(find(root, 'git-author-email'));
  });
});
