// @vitest-environment happy-dom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SCROLL_MIN_GAP_MS, SCROLL_NAMES, SCROLL_SETTLE_MS } from '@penmoss/core/analytics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushRecorded } from '../../src/analytics/record';
import {
  NoScrollRecording,
  resetScrollTracking,
  useScrollArea,
  type ScrollArea,
} from '../../src/analytics/scroll';
import { CommandCenter, memoryBindings } from '../../src/commands/center';
import { COMMANDS } from '../../src/commands/definitions';
import { CommandsContext } from '../../src/commands/hooks';
import { NoteView } from '../../src/notes/NoteView';
import { SettingsPage } from '../../src/pages/SettingsPage';
import { SidebarBody } from '../../src/shell/SidebarBody';
import { SidebarSettings } from '../../src/shell/SidebarSettings';
import { useSidebarLayout } from '../../src/shell/sidebar-layout-state';
import { SourcesProvider } from '../../src/sources/context';
import { useSourcesState } from '../../src/sources/hooks';
import { NoteSourceScope } from '../../src/sources/NoteSourceScope';
import { WorkspaceContext } from '../../src/workspace/hooks';
import { InSources, oneSource, type OneSource } from './support/one-source';

// PEN-175: `scroll <area>` from the page. Each scroller records how far down it is once it has
// been still for 300 ms, at most once a second per area, never the same position twice running;
// another note or Settings page starts again from the top. A preview records nothing.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AREAS: readonly ScrollArea[] = [
  'note',
  'sidebar',
  'sidebar.folders',
  'sidebar.recent',
  'sidebar.tags',
  'settings',
  'settings.nav',
];

let root: Root | null = null;
let host: HTMLDivElement;
let sent: Array<[ScrollArea, number]>;

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  resetScrollTracking((area, position) => sent.push([area, position]));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  resetScrollTracking();
  vi.useRealTimers();
});

/** Gives an element a scroll range of 1,000 px: 1,100 tall in a 100 px box. */
function scrollable(element: Element, height = 1100, box = 100): HTMLElement {
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: height });
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: box });
  Object.defineProperty(element, 'scrollTop', { configurable: true, writable: true, value: 0 });
  return element as HTMLElement;
}

/** Scrolls the element to `top` and fires its scroll event. */
function scrollTo(element: HTMLElement, top: number, on: EventTarget = element) {
  act(() => {
    element.scrollTop = top;
    on.dispatchEvent(new Event('scroll'));
  });
}

const settle = (ms = SCROLL_SETTLE_MS) => act(() => void vi.advanceTimersByTime(ms));

function Scroller({
  area,
  contentKey = 'one',
}: {
  readonly area: ScrollArea | null;
  readonly contentKey?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useScrollArea(area, ref, contentKey);
  return <div ref={ref} data-testid="scroller" />;
}

const render = (node: React.ReactNode) => act(() => root!.render(node));
const scroller = () => scrollable(host.querySelector('[data-testid="scroller"]')!);

describe('useScrollArea (PEN-175)', () => {
  it('names only areas core catalogues', () => {
    expect([...AREAS].sort()).toEqual([...SCROLL_NAMES].sort());
  });

  for (const area of AREAS) {
    it(`records ${area}’s position once it has been still for 300 ms`, () => {
      render(<Scroller area={area} />);
      const element = scroller();
      scrollTo(element, 100);
      scrollTo(element, 300);
      scrollTo(element, 420);
      settle(SCROLL_SETTLE_MS - 1);
      expect(sent).toEqual([]);
      settle(1);
      expect(sent).toEqual([[area, 0.42]]);
    });
  }

  it('records through the page’s recorder as `scroll <area> {position}`, which core’s check accepts', () => {
    resetScrollTracking();
    window.__penmossAnalytics = [];
    render(<Scroller area="note" />);
    scrollTo(scroller(), 735);
    settle();
    flushRecorded();
    expect(window.__penmossAnalytics).toEqual([
      expect.objectContaining({ kind: 'scroll', name: 'note', props: { position: 0.74 } }),
    ]);
  });

  it('holds a position that settles within a second of the last, and records the latest', () => {
    render(<Scroller area="sidebar" />);
    const element = scroller();
    scrollTo(element, 200);
    settle();
    scrollTo(element, 500);
    settle();
    scrollTo(element, 600);
    settle();
    expect(sent).toEqual([['sidebar', 0.2]]);
    settle(SCROLL_MIN_GAP_MS);
    expect(sent).toEqual([
      ['sidebar', 0.2],
      ['sidebar', 0.6],
    ]);
  });

  it('drops a position equal to the last one recorded', () => {
    render(<Scroller area="settings" />);
    const element = scroller();
    scrollTo(element, 420);
    settle(SCROLL_MIN_GAP_MS);
    scrollTo(element, 421);
    settle(SCROLL_MIN_GAP_MS);
    expect(sent).toEqual([['settings', 0.42]]);
  });

  it('starts again from the top when the content changes: the same place records again, the top records nothing', () => {
    render(<Scroller area="note" contentKey="first" />);
    const element = scroller();
    scrollTo(element, 420);
    settle(SCROLL_MIN_GAP_MS);
    // Another note, which opens at the top: nothing.
    render(<Scroller area="note" contentKey="second" />);
    scrollTo(element, 0);
    settle(SCROLL_MIN_GAP_MS);
    expect(sent).toEqual([['note', 0.42]]);
    // Scrolled to where the first note was: recorded, since this note began at the top.
    scrollTo(element, 420);
    settle(SCROLL_MIN_GAP_MS);
    expect(sent).toEqual([
      ['note', 0.42],
      ['note', 0.42],
    ]);
  });

  it('drops what waits when the content changes or the area goes', () => {
    render(<Scroller area="settings" contentKey="appearance" />);
    const element = scroller();
    scrollTo(element, 300);
    render(<Scroller area="settings" contentKey="privacy" />);
    settle(SCROLL_MIN_GAP_MS);
    expect(sent).toEqual([]);
    scrollTo(element, 300);
    render(null);
    settle(SCROLL_MIN_GAP_MS);
    expect(sent).toEqual([]);
  });

  it('records nothing where the area can’t scroll', () => {
    render(<Scroller area="sidebar.tags" />);
    const element = scrollable(host.querySelector('[data-testid="scroller"]')!, 100, 100);
    scrollTo(element, 0);
    settle(SCROLL_MIN_GAP_MS);
    expect(sent).toEqual([]);
  });

  it('records the page’s own scroll where the page scrolls (Settings on a narrow window)', () => {
    function Page() {
      useScrollArea('settings', 'page', 'appearance');
      return null;
    }
    render(<Page />);
    const page = scrollable(document.scrollingElement ?? document.documentElement, 2000, 1000);
    scrollTo(page, 250, window);
    settle();
    expect(sent).toEqual([['settings', 0.25]]);
  });

  it('records nothing for a null area or inside a preview', () => {
    render(
      <>
        <Scroller area={null} />
        <NoScrollRecording>
          <Scroller area="note" />
        </NoScrollRecording>
      </>,
    );
    for (const element of host.querySelectorAll('[data-testid="scroller"]')) {
      scrollTo(scrollable(element), 420);
    }
    settle(SCROLL_MIN_GAP_MS);
    expect(sent).toEqual([]);
  });

  it('listens to an element that comes after the first render (a note once it loads)', () => {
    function Later({ shown }: { readonly shown: boolean }) {
      const ref = useRef<HTMLDivElement>(null);
      useScrollArea('note', ref, 'n');
      return shown ? <div ref={ref} data-testid="scroller" /> : null;
    }
    render(<Later shown={false} />);
    render(<Later shown />);
    scrollTo(scroller(), 500);
    settle();
    expect(sent).toEqual([['note', 0.5]]);
  });
});

describe('the app’s scrollers (PEN-175)', () => {
  let one: OneSource;
  const center = new CommandCenter(COMMANDS, memoryBindings());

  beforeEach(async () => {
    vi.useRealTimers();
    one = await oneSource();
    one.source.workspace.createFolder('Garden', null);
    vi.useFakeTimers();
  });

  afterEach(() => one.stop());

  function inApp(children: React.ReactNode) {
    render(
      <CommandsContext.Provider value={center}>
        <SourcesProvider sources={one.sources}>
          <WorkspaceContext.Provider value={one.source.workspace}>
            {children}
          </WorkspaceContext.Provider>
        </SourcesProvider>
      </CommandsContext.Provider>,
    );
  }

  /** A note's view as the main window or a note window shows it (or a preview's). */
  async function showNote(id: string, preview = false) {
    const before = Date.now();
    vi.useRealTimers();
    // Rendered, then given time to open the note and lay out its editor.
    await act(() => {
      root!.render(
        <CommandsContext.Provider value={center}>
          <InSources sources={one.sources}>
            <WorkspaceContext.Provider value={one.source.workspace}>
              <NoteSourceScope id={id}>
                <NoteView key={id} id={id} preview={preview} />
              </NoteSourceScope>
            </WorkspaceContext.Provider>
          </InSources>
        </CommandsContext.Provider>,
      );
      return new Promise((done) => setTimeout(done, 100));
    });
    vi.useFakeTimers();
    // The fake clock starts again at the real time, which may be behind the fake one it left.
    vi.setSystemTime(Math.max(Date.now(), before));
    const element = host.querySelector('[data-testid="note-scroll"]');
    expect(element).not.toBeNull();
    return scrollable(element!);
  }

  const newNote = async (title: string) => {
    await one.source.notes.start();
    return one.source.notes.create(new Date(), { title });
  };

  it('records the note as `note`, and another note starts again from the top', async () => {
    const first = await newNote('First');
    const second = await newNote('Second');
    scrollTo(await showNote(first), 420);
    settle(SCROLL_MIN_GAP_MS);
    expect(sent).toEqual([['note', 0.42]]);
    // Another note at the same place: recorded, since it opened at the top.
    scrollTo(await showNote(second), 420);
    settle(SCROLL_MIN_GAP_MS);
    expect(sent).toEqual([
      ['note', 0.42],
      ['note', 0.42],
    ]);
  });

  it('records nothing from a note drawn as a preview', async () => {
    const id = await newNote('Previewed');
    scrollTo(await showNote(id, true), 420);
    settle(SCROLL_MIN_GAP_MS);
    expect(sent).toEqual([]);
  });

  it('records Settings’ page as `settings` and its list of pages as `settings.nav`', () => {
    inApp(<SettingsPage section="appearance" />);
    scrollTo(scrollable(host.querySelector('.settings-content')!), 300);
    scrollTo(scrollable(host.querySelector('.settings-nav')!), 600);
    settle();
    expect(sent).toEqual([
      ['settings', 0.3],
      ['settings.nav', 0.6],
    ]);
    // Another page starts again from the top: the same place records again; the list is the same.
    inApp(<SettingsPage section="privacy" />);
    scrollTo(scrollable(host.querySelector('.settings-content')!), 300);
    scrollTo(scrollable(host.querySelector('.settings-nav')!), 600);
    settle(SCROLL_MIN_GAP_MS);
    expect(sent).toEqual([
      ['settings', 0.3],
      ['settings.nav', 0.6],
      ['settings', 0.3],
    ]);
  });

  /** The main window's sidebar, as App.tsx draws it. */
  function Sidebar() {
    const layout = useSidebarLayout();
    const sources = useSourcesState();
    return (
      <aside className="sidebar">
        <SidebarBody
          layout={layout}
          place={{ activeId: null, openNote: null, graphOpen: false, tagsOpen: false }}
          notebooks={{
            shown: sources.all,
            active: sources.journal,
            current: null,
            currentFolder: null,
            onCurrentFolderChange: () => undefined,
            onActivate: () => undefined,
          }}
          rail={false}
        />
      </aside>
    );
  }

  /** Each scroller the sidebar has, by the area it records. */
  const scrollers = (within: ParentNode) =>
    ({
      sidebar: within.querySelector('.sb-list'),
      'sidebar.folders': within.querySelector('.sb-notebooks-body'),
      'sidebar.recent': within.querySelector('.sb-part[data-section="recent"]'),
      'sidebar.tags': within.querySelector('.sb-part[data-section="tags"]'),
    }) as const;

  it('records the list, the folder tree, Recent Notes and Tags each as its own area', () => {
    inApp(<Sidebar />);
    const found = scrollers(host);
    const expected: Array<[ScrollArea, number]> = [];
    let top = 100;
    for (const [area, element] of Object.entries(found)) {
      expect(element, area).not.toBeNull();
      scrollTo(scrollable(element!), top);
      expected.push([area as ScrollArea, top / 1000]);
      top += 100;
    }
    settle();
    expect(sent).toEqual(expected);
  });

  it('records nothing from Settings → Sidebar’s preview of it', () => {
    inApp(<SidebarSettings />);
    const preview = host.querySelector('.lf-sidebar-preview');
    expect(preview).not.toBeNull();
    const found = scrollers(preview!);
    expect(found.sidebar).not.toBeNull();
    expect(found['sidebar.folders']).not.toBeNull();
    for (const element of Object.values(found)) {
      if (element) scrollTo(scrollable(element), 420);
    }
    settle(SCROLL_MIN_GAP_MS);
    expect(sent).toEqual([]);
  });
});
