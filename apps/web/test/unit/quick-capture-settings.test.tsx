// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PenmossDesktop } from '../../src/desktop/bridge';
import { QuickCaptureSettings } from '../../src/journal/QuickCaptureSettings';
import { SourcesContext } from '../../src/sources/hooks';
import type { Sources, SourcesState } from '../../src/sources/registry';
import { WorkspaceContext } from '../../src/workspace/hooks';
import type { Workspace } from '../../src/workspace/service';

// PEN-146 (option B): Quick Capture has its own page in the Writing group, as on Android: where
// a capture saves (synced, A947) as radio rows with a line of help each, the notebook it files
// into with a link to it, and, in the Mac app only, the hotkey and the menu bar icon.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let host: HTMLDivElement;
let settings: Record<string, unknown>;
let writes: Array<[string, unknown]>;
let state = {};
const listeners = new Set<() => void>();

const workspace = {
  settings: () => ({ ...settings }),
  setSetting: (key: string, value: unknown) => {
    writes.push([key, value]);
    settings[key] = value;
    state = {};
    listeners.forEach((listener) => listener());
  },
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getState: () => state,
} as unknown as Workspace;

const NOTEBOOK = '01JZ0000000000000000000001';
const sourcesState = {
  all: [],
  journal: { id: NOTEBOOK, name: 'Personal' },
  journalPicked: true,
  loaded: true,
} as unknown as SourcesState;
const sources = {
  subscribe: () => () => undefined,
  getState: () => sourcesState,
} as unknown as Sources;

const render = () =>
  act(async () => {
    root!.render(
      <SourcesContext.Provider value={sources}>
        <WorkspaceContext.Provider value={workspace}>
          <QuickCaptureSettings />
        </WorkspaceContext.Provider>
      </SourcesContext.Provider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

beforeEach(() => {
  settings = {};
  writes = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  Reflect.deleteProperty(window, 'penmossDesktop');
});

const radio = (setting: string) =>
  host.querySelector<HTMLInputElement>(`[data-setting="${setting}"] input[type="radio"]`)!;

describe('Settings → Quick Capture', () => {
  it('chooses where a capture saves, Today’s Note by default', async () => {
    await render();
    expect(host.querySelector('h1')?.textContent).toBe('Quick Capture');
    expect(radio('todays-note').checked).toBe(true);
    expect(host.querySelector('[data-setting="todays-note"]')?.textContent).toContain(
      'At the end of ## Captures, with the time',
    );
    expect(host.querySelector('[data-setting="new-note-in-inbox"]')?.textContent).toContain(
      'Titled by its first line',
    );
    act(() => radio('new-note-in-inbox').click());
    expect(writes).toEqual([['capture.destination', 'inbox']]);
    expect(radio('new-note-in-inbox').checked).toBe(true);
  });

  it('names the notebook captures go to, with a link to its page', async () => {
    await render();
    const link = host.querySelector<HTMLAnchorElement>('[data-setting="notebook"] a')!;
    expect(link.textContent).toBe('Personal');
    expect(link.getAttribute('href')).toBe(`/settings/git-notebooks/${NOTEBOOK}`);
  });

  it('has no This Mac group outside the Mac app', async () => {
    await render();
    expect(host.querySelector('[data-testid="capture-this-mac"]')).toBeNull();
    expect(host.textContent).not.toContain('This Mac');
  });

  it('shows the hotkey and the menu bar icon under This Mac in the Mac app', async () => {
    const bridge = {
      platform: 'darwin',
      window: 'main',
      capture: {
        hotkey: () =>
          Promise.resolve({
            accelerator: 'Control+Alt+Command+N',
            registered: true,
            certain: false,
          }),
        setHotkey: () => Promise.resolve(null),
      },
      menuBar: {
        shown: () => Promise.resolve(true),
        setShown: () => Promise.resolve(true),
        setQuickAccess: () => undefined,
      },
    } as unknown as PenmossDesktop;
    Object.assign(window, { penmossDesktop: bridge });
    await render();
    const group = host.querySelector('[data-testid="capture-this-mac"]')!;
    expect(group.querySelector('[data-setting="shortcut-from-any-app"]')).not.toBeNull();
    expect(group.querySelector('[data-setting="show-in-the-menu-bar"]')).not.toBeNull();
    expect(group.querySelector<HTMLInputElement>('[data-testid="menu-bar-icon"]')?.checked).toBe(
      true,
    );
  });
});
