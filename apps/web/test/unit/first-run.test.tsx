// @vitest-environment happy-dom
/**
 * The first run (T59, A1030): with no git notebook on this Mac the app has nothing to open, so
 * the window shows Settings → Notebooks' Add form; once a notebook is listed, the app opens
 * it, and its views are mounted only then, with a root and a Journal notebook.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopGit, GitNotebookInfo, PenmossDesktop } from '../../src/desktop/bridge';
import { FirstRunGate } from '../../src/sources/FirstRun';
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

/** The Mac's git, with no notebook until `add` makes one. */
function macGit() {
  const listed: GitNotebookInfo[] = [];
  const listeners = new Set<() => void>();
  const add = vi.fn((input: { readonly name?: string }) => {
    if (!input.name) return Promise.resolve({ ok: true, value: { kind: 'needs-name' } });
    const notebook = { ...info('NB1'), name: input.name, create: true };
    listed.push(notebook);
    return Promise.resolve({ ok: true, value: { kind: 'added', notebook, created: true } });
  });
  const git = {
    list: vi.fn(() => Promise.resolve([...listed])),
    onChange: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    add,
  } as unknown as DesktopGit;
  return { git, add };
}

/** A notebook source as the app would make it (its engine is not this test's). */
const fakeSource = (each: GitNotebookInfo) =>
  ({
    kind: 'git',
    id: each.notebookId,
    name: each.name,
    info: each,
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

function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the first run (A1030)', () => {
  it('waits while the list is read, without mounting the app', () => {
    const { git } = macGit();
    const sources = new Sources({ git, makeGit: fakeSource });
    render(sources);
    expect(host.textContent).toContain('Opening Penmoss…');
    expect($('the-app')).toBeNull();
    expect($('first-run')).toBeNull();
  });

  it('asks for a git notebook when there is none, then opens the app with it', async () => {
    const { git, add } = macGit();
    Object.assign(window, { penmossDesktop: { git } as unknown as PenmossDesktop });
    const sources = new Sources({ git, makeGit: fakeSource });
    await sources.load();
    render(sources);
    expect($('first-run')).not.toBeNull();
    expect($('the-app')).toBeNull();
    // A welcome first (T69, A1146), with two ways on; the form comes after one is chosen.
    expect(host.textContent).toContain('Welcome to Penmoss');
    expect($('git-add')).toBeNull();
    act(() => $('first-run-existing')!.click());
    // Settings → Notebooks' own Add form.
    expect($('git-add')).not.toBeNull();
    // Its name only once the repository turns out to hold no notebook.
    expect($('git-add-name')).toBeNull();

    type(
      host.querySelector<HTMLInputElement>('[data-testid="git-add-remote"]')!,
      'git@github.com:me/notes.git',
    );
    await act(async () => {
      host.querySelector<HTMLFormElement>('[data-testid="git-add"]')!.requestSubmit();
      await Promise.resolve();
    });
    // The repository holds none: name the new one.
    await vi.waitFor(() => expect(host.textContent).toContain('name the new one'));
    const name = host.querySelector<HTMLInputElement>('[data-testid="git-add-name"]');
    expect(name).not.toBeNull();
    type(name!, 'Journal');
    await act(async () => {
      host.querySelector<HTMLFormElement>('[data-testid="git-add"]')!.requestSubmit();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect($('the-app')?.textContent).toBe('NB1 NB1'));
    expect($('first-run')).toBeNull();
    expect(add).toHaveBeenLastCalledWith(
      expect.objectContaining({ remote: 'git@github.com:me/notes.git', name: 'Journal' }),
    );
  });

  it('says to open the Mac app where there is no git', () => {
    render(new Sources({ git: null }));
    expect($('first-run-no-mac')).not.toBeNull();
    expect($('git-add')).toBeNull();
    expect($('the-app')).toBeNull();
  });

  it('in the capture window, says where to add one instead of the form', async () => {
    const { git } = macGit();
    const sources = new Sources({ git, makeGit: fakeSource });
    await sources.load();
    render(sources, true);
    expect($('first-run-capture')).not.toBeNull();
    expect($('git-add')).toBeNull();
  });

  it('opens the app at once when there is a notebook, its root the Journal notebook', async () => {
    const { git, add } = macGit();
    await add({ name: 'Work' });
    const sources = new Sources({ git, makeGit: fakeSource });
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
