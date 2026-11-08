// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { CaptureForm } from '../../src/capture/CaptureForm';
import { NotesProvider } from '../../src/notes/context';
import type { Notes } from '../../src/notes/service';
import { SourcesContext } from '../../src/sources/hooks';
import type { Source, Sources, SourcesState } from '../../src/sources/registry';
import { WorkspaceContext } from '../../src/workspace/hooks';
import type { Workspace } from '../../src/workspace/service';

// T39 pass 3 delta review (A914): the quick capture's notebook, once picked, holds while the
// settings are read again (a pull, another window storing them) and while the window is shown
// again; a new capture after a save or Cancel starts where it starts.

const workspace = { settings: () => ({}) } as unknown as Workspace;
const place = (id: string, name: string) =>
  ({
    id,
    name,
    kind: 'git',
    notes: {},
    workspace,
  }) as unknown as Source;
const journal = place('git-journal', 'Journal');
const work = place('git-work', 'Work notebook');
const state = {
  all: [journal, work],
  journal,
  root: journal,
  journalPicked: true,
  loaded: true,
} as unknown as SourcesState;
const sources = { subscribe: () => () => undefined, getState: () => state } as unknown as Sources;

let root: Root | null = null;
const host = document.createElement('div');
document.body.append(host);

function render(focusKey: number, settingsKey: number) {
  act(() =>
    root!.render(
      <SourcesContext.Provider value={sources}>
        <NotesProvider notes={{} as Notes}>
          <WorkspaceContext.Provider value={workspace}>
            <CaptureForm
              onSaved={() => undefined}
              onCancel={() => undefined}
              focusKey={focusKey}
              settingsKey={settingsKey}
            />
          </WorkspaceContext.Provider>
        </NotesProvider>
      </SourcesContext.Provider>,
    ),
  );
}

const into = () => host.querySelector<HTMLSelectElement>('[data-testid="capture-into"]')!;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe('the quick capture’s notebook (A914)', () => {
  it('holds the notebook picked, through a settings change and a new show, until the capture ends', () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    root = createRoot(host);
    render(0, 0);
    expect(into().value).toBe('git-journal');
    act(() => {
      into().value = 'git-work';
      into().dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(into().value).toBe('git-work');
    // A pull, or another window storing the settings: nothing typed yet, the pick holds.
    render(0, 1);
    expect(into().value).toBe('git-work');
    // Hidden on losing focus and shown again: still the capture it was.
    render(1, 1);
    expect(into().value).toBe('git-work');
    // Cancelled, then a new capture: it starts where captures start.
    act(() => host.querySelector<HTMLButtonElement>('[data-ui="dismiss"]')!.click());
    render(2, 1);
    expect(into().value).toBe('git-journal');
  });
});

describe('the quick capture’s destination (T51 item 19, A947)', () => {
  const radio = (name: string) =>
    [...host.querySelectorAll<HTMLLabelElement>('.capture-dest label')]
      .find((label) => label.textContent?.trim() === name)!
      .querySelector('input')!;

  it('starts on the default every time; a choice in the form is for that capture only', () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const settings: Record<string, unknown> = { 'capture.destination': 'inbox' };
    (workspace as unknown as { settings: () => Record<string, unknown> }).settings = () => settings;
    try {
      root = createRoot(host);
      render(0, 0);
      expect(radio('New Note in Inbox').checked).toBe(true);
      act(() => radio('Today’s Note').click());
      expect(radio('Today’s Note').checked).toBe(true);
      // Cancelled and shown again: the default again, not the last choice.
      act(() => host.querySelector<HTMLButtonElement>('[data-ui="dismiss"]')!.click());
      render(1, 0);
      expect(radio('New Note in Inbox').checked).toBe(true);
      // Settings changed the default elsewhere: an empty form follows it.
      settings['capture.destination'] = 'daily';
      render(1, 1);
      expect(radio('Today’s Note').checked).toBe(true);
    } finally {
      (workspace as unknown as { settings: () => Record<string, unknown> }).settings = () => ({});
    }
  });
});
