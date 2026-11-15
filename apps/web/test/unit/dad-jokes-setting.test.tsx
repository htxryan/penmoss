// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DadJokesSetting } from '../../src/shell/DadJokesSetting';
import type { Notes } from '../../src/notes/service';
import { SourcesProvider } from '../../src/sources/context';
import { WorkspaceContext } from '../../src/workspace/hooks';
import type { Workspace } from '../../src/workspace/service';
import { standInSources } from './support/one-source';

// Settings → Appearance → Dad Jokes (A1598): on unless turned off, the synced `home.dadJokes`.

let root: Root | null = null;
let host: HTMLDivElement;
let settings: Record<string, unknown>;
let writes: Array<[string, unknown]>;
let state: { loaded: boolean };
const listeners = new Set<() => void>();

const notify = () => {
  state = { ...state };
  for (const listener of listeners) listener();
};

const workspace = {
  settings: () => ({ ...settings }),
  setSetting: (key: string, value: unknown) => {
    writes.push([key, value]);
    settings[key] = value;
    notify();
  },
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getState: () => state,
} as unknown as Workspace;

/** The window's sources: one notebook, whose settings are the app's own. */
const { sources } = standInSources({ notes: {} as Notes, workspace });

function render() {
  act(() =>
    root!.render(
      <SourcesProvider sources={sources}>
        <WorkspaceContext.Provider value={workspace}>
          <DadJokesSetting />
        </WorkspaceContext.Provider>
      </SourcesProvider>,
    ),
  );
}

const toggle = () => document.querySelector<HTMLInputElement>('[data-testid="dad-jokes"]')!;

beforeEach(() => {
  settings = {};
  writes = [];
  state = { loaded: true };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  listeners.clear();
});

describe('Settings → Appearance → Dad Jokes', () => {
  it('is on by default: a switch in a row Search Settings finds, its help describing it', () => {
    render();
    expect(toggle().getAttribute('role')).toBe('switch');
    expect(toggle().checked).toBe(true);
    expect(toggle().labels?.[0]?.textContent).toContain('Dad Jokes');
    const row = toggle().closest('.lf-row')!;
    expect(row.getAttribute('data-setting')).toBe('dad-jokes');
    const help = row.querySelector('.lf-row-help')!;
    expect(help.textContent).toBe('A joke in place of the heading when no note is open.');
    expect(toggle().getAttribute('aria-describedby')).toBe(help.id);
  });

  it('writes home.dadJokes when switched, and follows a change synced from elsewhere', () => {
    render();
    act(() => toggle().click());
    expect(writes).toEqual([['home.dadJokes', false]]);
    expect(toggle().checked).toBe(false);
    act(() => {
      settings['home.dadJokes'] = true;
      notify();
    });
    expect(toggle().checked).toBe(true);
  });

  it('cannot change until this device’s settings are read', () => {
    state = { loaded: false };
    render();
    expect(toggle().disabled).toBe(true);
  });
});
