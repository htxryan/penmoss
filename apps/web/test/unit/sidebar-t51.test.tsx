import { QUICK_ACCESS_SETTING } from '@penmoss/core/quick-access';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/App';
import { CommandCenter, memoryBindings } from '../../src/commands/center';
import { COMMANDS } from '../../src/commands/definitions';
import { CommandsContext } from '../../src/commands/hooks';
import { NotesProvider } from '../../src/notes/context';
import { NoteDirectory } from '../../src/notes/directory';
import { DirectoryProvider } from '../../src/notes/links-context';
import type { NoteListEntry } from '../../src/notes/list';
import { pinToggled, useQuickAccess, type QuickAccess } from '../../src/notes/quick-access';
import { QUICK_ACCESS_COLLAPSED_KEY, QuickAccessSection } from '../../src/notes/QuickAccessSection';
import { mouseStep } from '../../src/shell/history';
import { HistoryNav } from '../../src/shell/HistoryNav';
import { TagPane, TAGS_COLLAPSED_KEY } from '../../src/tags/TagPane';
import { WorkspaceProvider } from '../../src/workspace/context';
import { memoryNotes } from './support/memory-notes';
import { memoryStorage } from './support/memory-storage';
import { testNotes, testWorkspace } from './support/local-sources';
import type { Notes } from '../../src/notes/service';
import type { Workspace } from '../../src/workspace/service';

// T51 items 1–4, 15 and 18 (A932, A933, A934, A935, A943, A946): the sidebar's shell.

function setup() {
  const store = memoryNotes();
  const notes = testNotes(store);
  const workspace = testWorkspace(store);
  const directory = new NoteDirectory({
    notes,
    folderOf: () => null,
    folderName: () => null,
    register: () => undefined,
    navigate: () => undefined,
  });
  const render = (pathname: string) =>
    renderToString(
      <NotesProvider notes={notes}>
        <WorkspaceProvider workspace={workspace}>
          <DirectoryProvider directory={directory}>
            <App location={{ pathname, search: '' }} />
          </DirectoryProvider>
        </WorkspaceProvider>
      </NotesProvider>,
    );
  return { render, workspace };
}

/** The HTML from `start` up to `end`. */
const between = (html: string, start: string, end: string) =>
  html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));

/** Every opening tag in `html` that has `marker`. */
const tagsWith = (html: string, marker: string) =>
  (html.match(/<(a|button)\b[^>]*>/g) ?? []).filter((tag) => tag.includes(marker));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the sidebar (T51)', () => {
  it('has New Note and the shortcuts as one row of icon buttons, each named, with its keys in its tooltip (A932, T52)', () => {
    const html = setup().render('/');
    const row = between(html, 'class="sb-shortcuts"', 'class="sb-list"');
    const items = tagsWith(row, 'data-command=');
    expect(items.map((tag) => /aria-label="([^"]*)"/.exec(tag)?.[1])).toEqual([
      'New Note',
      'Search',
      'Today',
      'This Week',
      'Graph',
      'Commands',
    ]);
    for (const tag of items) {
      expect(tag).toContain('icon-btn');
      // The keys are always in the tooltip now, not only on the rail.
      expect(tag).toMatch(/data-tip="[^"]+\([^)]+\)"/);
    }
    // Icons alone: no visible label or keys beside them.
    expect(row).not.toContain('class="label"');
    expect(row).not.toContain('<kbd');
    // New Note leads, in the accent (styles.css `.sb-shortcut.new-note`); no big button above.
    expect(items[0]).toContain('sb-shortcut new-note');
    expect(items[0]).toContain('data-command="note.new"');
    expect(html).not.toContain('btn primary new-note');
  });

  // Since T59 (D49) each notebook's section has its own heading and state (git-sources.test.ts);
  // a lone source in context has neither, and there are no personal notes.
  it('has no sync pill at its top, and no personal notes header (A933, T59)', () => {
    const html = setup().render('/');
    expect(html).not.toContain('sb-status');
    expect(html).not.toContain('sync-pill');
    expect(html).not.toContain('data-source="personal"');
    // The live region stays, outside the list (shown on the rail too).
    expect(html).toContain('data-testid="sync-alert"');
    expect(html.indexOf('data-testid="sync-alert"')).toBeLessThan(html.indexOf('class="sb-list"'));
  });

  it('has Settings and Feedback as named icons in its footer, Trash on the notebook’s row (A935, T52, T53)', () => {
    const html = setup().render('/');
    const foot = between(html, 'class="sb-foot"', '</footer>');
    expect(foot).not.toContain('class="label"');
    const items = tagsWith(foot, 'aria-label=');
    expect(items.map((tag) => /aria-label="([^"]*)"/.exec(tag)?.[1])).toEqual([
      'Settings',
      'Send Feedback',
    ]);
    for (const tag of items) expect(tag).toContain('data-tip=');
    expect(foot).toContain('data-icon="gear"');
    // Send Feedback's own icon, not the comments' bubble (T62 item 7).
    expect(foot).toContain('data-icon="feedback"');
    expect(foot).not.toContain('data-icon="trash"');
    const bar = between(html, 'class="tree-actions row-end"', 'class="sync-dot');
    const [trash] = tagsWith(bar, 'data-testid="sidebar-trash"');
    expect(trash).toContain('href="/trash"');
    expect(trash).toContain('aria-label="Trash"');
  });

  it('starts its head with Back and Forward, greyed out with nowhere to go (A943)', () => {
    const html = setup().render('/');
    const head = between(html, 'class="sb-head"', 'class="brand"');
    for (const id of ['app-back', 'app-forward']) {
      const [button] = tagsWith(head, `data-testid="${id}"`);
      expect(button, id).toBeDefined();
      expect(button).toContain('disabled=""');
    }
    expect(head).toMatch(/aria-label="Back"[^>]*data-tip="Back \(/);
    // One compact pair (T52): two halves with narrow chevrons.
    const pair = between(head, 'class="history-pair"', '</nav>');
    expect(tagsWith(pair, 'history-half')).toHaveLength(2);
    expect(pair).toContain('data-icon="navBack"');
    expect(pair).toContain('data-icon="navForward"');
    // Settings has them too, before "← Notes".
    const settings = setup().render('/settings/appearance');
    const bar = between(settings, 'class="settings-bar"', '</header>');
    expect(bar).toContain('data-testid="app-back"');
    expect(bar.indexOf('app-back')).toBeLessThan(bar.indexOf('Notes'));
  });

  it('answers the mouse back and forward buttons only (A943)', () => {
    expect(mouseStep(3)).toBe('back');
    expect(mouseStep(4)).toBe('forward');
    for (const button of [0, 1, 2]) expect(mouseStep(button)).toBeNull();
  });
});

describe('the Tags panel (T51, A934)', () => {
  const renderPane = () =>
    renderToString(
      <NotesProvider notes={fakeNotes([])}>
        <WorkspaceProvider workspace={fakeWorkspace({}).workspace}>
          <TagPane />
        </WorkspaceProvider>
      </NotesProvider>,
    );

  it('has a toggle for a heading, open by default', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const html = renderPane();
    expect(html).toMatch(/<h2 class="sb-section-title"><button[^>]*aria-expanded="true"/);
    expect(html).toContain('data-icon="chevD"');
    expect(html).toContain('id="tag-pane-body"');
  });

  it('stays collapsed on this device once collapsed', () => {
    vi.stubGlobal('localStorage', memoryStorage({ [TAGS_COLLAPSED_KEY]: '1' }));
    expect(TAGS_COLLAPSED_KEY).toBe('penmoss.sidebar.tags');
    const html = renderPane();
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-icon="chevR"');
    expect(html).not.toContain('id="tag-pane-body"');
  });
});

describe('Quick Access (T51, A946)', () => {
  const entry = (id: string, title: string): NoteListEntry => ({
    id,
    title,
    excerpt: '',
    updatedAt: 0,
    unsynced: false,
    tags: [],
  });
  const list = [entry('n1', 'Garden'), entry('n2', ''), entry('n3', 'Roses')];

  const renderSection = (settings: Record<string, unknown>, activeId: string | null = null) =>
    renderToString(
      <NotesProvider notes={fakeNotes(list)}>
        <WorkspaceProvider workspace={fakeWorkspace(settings).workspace}>
          <QuickAccessSection activeId={activeId} />
        </WorkspaceProvider>
      </NotesProvider>,
    );

  it('lists the pinned notes in pin order, leaving out any not in the list (trashed)', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const html = renderSection({ [QUICK_ACCESS_SETTING]: ['n3', 'gone', 'n2', 'n1'] }, 'n1');
    expect(html).toContain('Quick Access');
    const rows = [...html.matchAll(/data-note-id="([^"]+)"/g)].map((match) => match[1]);
    expect(rows).toEqual(['n3', 'n2', 'n1']);
    expect(html).toContain('href="/notes/n3"');
    expect(html).toContain('Untitled');
    expect(html).toMatch(/aria-current="page"[^>]*data-note-id="n1"/);
  });

  it('shows with nothing pinned, asking for a dragged note (A989)', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    for (const settings of [{}, { [QUICK_ACCESS_SETTING]: ['gone'] }]) {
      const html = renderSection(settings);
      expect(html).toContain('Quick Access');
      expect(html).toContain('Drag Here to Pin');
      expect(html).not.toContain('data-note-id=');
    }
  });

  it('collapses, remembered on this device', () => {
    vi.stubGlobal('localStorage', memoryStorage({ [QUICK_ACCESS_COLLAPSED_KEY]: '1' }));
    expect(QUICK_ACCESS_COLLAPSED_KEY).toBe('penmoss.sidebar.quickAccess');
    const html = renderSection({ [QUICK_ACCESS_SETTING]: ['n1'] });
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-note-id=');
  });

  it('pins and unpins through the synced setting, refusing a 21st pin', () => {
    const { workspace, settings } = fakeWorkspace({});
    let quick: QuickAccess | null = null;
    const Probe = () => {
      quick = useQuickAccess();
      return null;
    };
    // The twenty pins below are notes this device knows (in its list or its Trash).
    const known = (id: string) => /^(n|p)\d+$/.test(id);
    const renderProbe = () =>
      renderToString(
        <NotesProvider notes={fakeNotes(list, known)}>
          <WorkspaceProvider workspace={workspace}>
            <Probe />
          </WorkspaceProvider>
        </NotesProvider>,
      );
    renderProbe();
    expect(quick!.toggle('n1')).toBe(true);
    expect(quick!.toggle('n2')).toBe(true);
    expect(settings[QUICK_ACCESS_SETTING]).toEqual(['n1', 'n2']);
    renderProbe();
    expect(quick!.ids).toEqual(['n1', 'n2']);
    expect(quick!.pinned('n2')).toBe(true);
    expect(quick!.toggle('n1')).toBe(true);
    expect(settings[QUICK_ACCESS_SETTING]).toEqual(['n2']);
    // Full: nothing changes.
    settings[QUICK_ACCESS_SETTING] = Array.from({ length: 20 }, (_, i) => `p${i}`);
    expect(quick!.toggle('n3')).toBe(false);
    expect(settings[QUICK_ACCESS_SETTING]).toHaveLength(20);
    // Unpinning the last one stores an empty list.
    settings[QUICK_ACCESS_SETTING] = ['n2'];
    expect(quick!.toggle('n2')).toBe(true);
    expect(settings[QUICK_ACCESS_SETTING]).toEqual([]);
  });

  it('makes room in a full list from pins no source knows, only when pinning (T51 review)', () => {
    const full = Array.from({ length: 20 }, (_, i) => `p${i}`);
    // p3 and p7 are known nowhere (deleted for good); p5 cannot be told yet.
    const knows = (id: string) => (id === 'p5' ? null : id !== 'p3' && id !== 'p7');
    expect(pinToggled(full, 'n1', knows)).toEqual([
      ...full.filter((id) => id !== 'p3' && id !== 'p7'),
      'n1',
    ]);
    // Every pin known, or not known yet: still full.
    expect(pinToggled(full, 'n1', () => true)).toBeNull();
    expect(pinToggled(full, 'n1', () => null)).toBeNull();
    // Unpinning drops that pin only, known or not.
    expect(pinToggled(['p3', 'n1', 'p7'], 'n1', knows)).toEqual(['p3', 'p7']);
    // With room, nothing is dropped.
    expect(pinToggled(['p3'], 'n1', knows)).toEqual(['p3', 'n1']);
  });

  it('prunes through the hook, asking every source', () => {
    const { workspace, settings } = fakeWorkspace({
      [QUICK_ACCESS_SETTING]: [...Array.from({ length: 19 }, (_, i) => `n${i}`), 'gone'],
    });
    let quick: QuickAccess | null = null;
    const Probe = () => {
      quick = useQuickAccess();
      return null;
    };
    renderToString(
      <NotesProvider notes={fakeNotes(list, (id) => id !== 'gone')}>
        <WorkspaceProvider workspace={workspace}>
          <Probe />
        </WorkspaceProvider>
      </NotesProvider>,
    );
    expect(quick!.toggle('fresh')).toBe(true);
    expect(settings[QUICK_ACCESS_SETTING]).toHaveLength(20);
    expect(settings[QUICK_ACCESS_SETTING]).not.toContain('gone');
    expect((settings[QUICK_ACCESS_SETTING] as string[]).at(-1)).toBe('fresh');
  });
});

describe('Back and Forward (T45; T51, A943)', () => {
  it('names each button, with its keys in its tooltip', () => {
    const html = renderToString(
      <CommandsContext.Provider value={new CommandCenter(COMMANDS, memoryBindings())}>
        <HistoryNav testIdPrefix="app" />
      </CommandsContext.Provider>,
    );
    expect(html).toContain('class="history-nav"');
    expect(html).toContain('data-command="window.back"');
    expect(html).toContain('data-command="window.forward"');
    expect(html).toMatch(/aria-label="Forward"[^>]*data-tip="Forward \(/);
  });
});

function fakeNotes(
  list: NoteListEntry[],
  knows: (id: string) => boolean | null = (id) => list.some((entry) => entry.id === id),
): Notes {
  return {
    subscribe: () => () => undefined,
    list: () => list,
    knows,
  } as unknown as Notes;
}

function fakeWorkspace(initial: Record<string, unknown>) {
  const settings: Record<string, unknown> = { ...initial };
  const state = { loaded: true };
  const workspace = {
    subscribe: () => () => undefined,
    getState: () => state,
    settings: () => ({ ...settings }),
    setSetting: (key: string, value: unknown) => {
      settings[key] = value;
    },
  } as unknown as Workspace;
  return { workspace, settings };
}
