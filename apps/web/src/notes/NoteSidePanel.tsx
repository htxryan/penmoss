/**
 * A note's side panel (T51, A936; T53 item 9, A985): its four tabs (Metadata, Comments, History
 * and Local Graph) as vertical tabs down the note's right edge, the open one beside them (or over
 * the note's text in a narrow pane), and the edge that resizes it (A1122). The note view holds
 * which tab shows and whether the panel is open, since its commands and menus change them.
 */
import { ariaKeyShortcuts } from '@penmoss/editor/keys';
import type { PlacedThread } from '@penmoss/model/comments';
import type { Yjs14Replica } from '@penmoss/model/yjs14';
import { Icon } from '@penmoss/ui/icons';
import { lazy, Suspense, useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';
import { useKeys } from '../commands/hooks';
import { AboutVersions } from '../history/AboutVersions';
import { HistoryPanel } from '../history/HistoryPanel';
import { withKeys } from '../shell/drawer';
import { NOTE_MIN_REM, PANE_LIMITS } from '../shell/pane-widths';
import { PaneResizer } from '../shell/PaneResizer';
import { CommentsPanel } from './CommentsPanel';
import type { NotePanelTab } from './NoteActions';
import { InfoPanel } from './NoteInfo';
import type { NoteStats } from './note-stats';
import { PANEL_TABS } from './panel-tabs';

/** The Local Graph tab draws with d3-force: loaded the first time it shows (T51, as GraphPage). */
const NoteGraph = lazy(() =>
  import('../graph/NoteGraph').then((module) => ({ default: module.NoteGraph })),
);

export function NoteSidePanel({
  id,
  tab,
  open,
  over,
  width,
  onWidth,
  columnsRef,
  tabFocus,
  onOpenTab,
  onToggleTab,
  onClose,
  replica,
  folder,
  stats,
  addingTag,
  onAddingTag,
  threads,
  activeThread,
  onActiveThread,
  noteDraft,
  onNoteDraftDone,
  floatingThread,
}: {
  id: string;
  /** The tab shown, or shown last while the panel is closed. */
  tab: NotePanelTab;
  open: boolean;
  /** The open panel lies over the note's text: a narrow pane has no room beside it. */
  over: boolean;
  /** The panel's width in rem, and its edge's drag (A1122). */
  width: number;
  onWidth: (rem: number) => void;
  /** The note's columns, which take the width as the edge is dragged. */
  columnsRef: RefObject<HTMLDivElement | null>;
  /**
   * Bumped when a command opened the panel (a key, the palette, a menu, a bar button): the tab it
   * shows then takes focus, so a screen reader names it (T51 review, A936).
   */
  tabFocus: number;
  /** Opens the panel on a tab. */
  onOpenTab: (tab: NotePanelTab) => void;
  /** A tab's icon: it opens its tab, or closes the panel while that tab shows. */
  onToggleTab: (tab: NotePanelTab) => void;
  onClose: () => void;
  replica: Yjs14Replica | null;
  /** The folders the note is in, outermost first. */
  folder: readonly string[];
  stats: NoteStats;
  /** The Metadata tab's tag field. */
  addingTag: boolean;
  onAddingTag: (adding: boolean) => void;
  threads: readonly PlacedThread[];
  activeThread: string | null;
  /** A thread was picked in the Comments tab (`reveal`: scroll the note to its passage). */
  onActiveThread: (thread: string | null, reveal: boolean) => void;
  /** Add Note Comment: a thread on the note as a whole being written in the Comments tab. */
  noteDraft: boolean;
  onNoteDraftDone: () => void;
  /** The thread floating over the note, if one does. */
  floatingThread: string | null;
}) {
  const infoKeys = useKeys('note.backlinks');
  const commentKeys = useKeys('note.comments');
  const historyKeys = useKeys('note.history');
  const graphKeys = useKeys('note.localGraph');
  const tabKeys: Record<NotePanelTab, readonly string[]> = {
    info: infoKeys,
    comments: commentKeys,
    history: historyKeys,
    graph: graphKeys,
  };
  /** The strip of tab icons (vertical tabs, T53 item 9), for arrow keys between them. */
  const tabsRef = useRef<HTMLDivElement>(null);
  const openThreads = threads.filter((placed) => placed.thread.status === 'open').length;

  // After the render that shows it, and after a menu that ran the command gave focus back to
  // its own button: the tab's icon, so a screen reader names it.
  useEffect(() => {
    if (tabFocus === 0) return;
    tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }, [tabFocus]);
  /** Puts focus on the strip: its tab's icon, else the first (a phone hides the strip while closed). */
  const focusStrip = () => {
    const strip = tabsRef.current;
    const target =
      strip?.querySelector<HTMLElement>(`[data-tab="${tab}"]`) ??
      strip?.querySelector<HTMLElement>('[role="tab"]');
    target?.focus();
  };
  /**
   * Escape in the panel, when nothing inside took it (a field, a picker): the panel closes and
   * focus goes back to its tab's icon (T51 review, A936).
   */
  const onPanelKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onClose();
    focusStrip();
  };
  /**
   * ↑ and ↓, Home and End move between the tabs and open each (the ARIA tabs pattern). Escape on
   * a tab closes the open panel, as it does inside it: a click on a tab leaves focus there (T53
   * pass).
   */
  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      if (!open || event.defaultPrevented || event.nativeEvent.isComposing) return;
      event.preventDefault();
      onClose();
      return;
    }
    const keys: Record<string, (at: number) => number> = {
      ArrowDown: (at) => (at + 1) % PANEL_TABS.length,
      ArrowUp: (at) => (at - 1 + PANEL_TABS.length) % PANEL_TABS.length,
      Home: () => 0,
      End: () => PANEL_TABS.length - 1,
    };
    const move = keys[event.key];
    if (!move) return;
    event.preventDefault();
    const focused = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]')?.dataset[
      'tab'
    ];
    const at = PANEL_TABS.findIndex((entry) => entry.tab === focused);
    const next = PANEL_TABS[move(Math.max(at, 0))]!;
    onOpenTab(next.tab);
    tabsRef.current?.querySelector<HTMLElement>(`[data-tab="${next.tab}"]`)?.focus();
  };

  const tabLabel = PANEL_TABS.find((entry) => entry.tab === tab)?.label;
  return (
    <>
      {open ? (
        // Named after the tab it shows, as the Info and Comments panels were (T41, T48); beside
        // the strip, or over the note's text in a narrow pane.
        <aside
          className="note-side"
          id={`note-side-${id}`}
          aria-label={tabLabel}
          onKeyDown={onPanelKeyDown}
        >
          {/* Its name and Close; on a phone the panel covers the note, the strip beside it. */}
          <div className="note-side-head">
            <h2>{tabLabel}</h2>
            {/* History's ⓘ: how versions are made (Ryan's review of #192, finding 13). */}
            {tab === 'history' ? <AboutVersions /> : null}
            <button
              type="button"
              className="icon-btn"
              data-ui="dismiss"
              aria-label="Close Panel"
              data-tip="Close Panel (Esc)"
              onClick={onClose}
              data-testid="note-panel-close"
            >
              <Icon name="close" size={16} />
            </button>
          </div>
          <div
            className="note-tabpanel"
            role="tabpanel"
            id={`note-tabpanel-${id}`}
            aria-labelledby={`note-tab-${id}-${tab}`}
            data-tab={tab}
          >
            {tab === 'info' ? (
              <InfoPanel
                noteId={id}
                replica={replica}
                folder={folder}
                stats={stats}
                addingTag={addingTag}
                onAddingTag={onAddingTag}
              />
            ) : tab === 'comments' ? (
              <CommentsPanel
                noteId={id}
                replica={replica}
                threads={threads}
                active={activeThread}
                onActive={onActiveThread}
                noteDraft={noteDraft}
                onNoteDraftDone={onNoteDraftDone}
                floating={floatingThread}
              />
            ) : tab === 'history' ? (
              <HistoryPanel noteId={id} />
            ) : (
              <Suspense
                fallback={
                  <p className="muted note-graph-loading" role="status">
                    Loading the graph…
                  </p>
                }
              >
                <NoteGraph noteId={id} />
              </Suspense>
            )}
          </div>
        </aside>
      ) : null}
      {open && !over ? (
        <PaneResizer
          kind="panel"
          label="Panel Width"
          width={width}
          edge="start"
          room={() => {
            const main = columnsRef.current?.closest<HTMLElement>('.note-main');
            const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
            // As wide as leaves the note its room beside it, so a drag never moves it over the text.
            return main ? main.offsetWidth / rem - NOTE_MIN_REM : PANE_LIMITS.panel.max;
          }}
          preview={(rem) => columnsRef.current?.style.setProperty('--pm-panel-width', `${rem}rem`)}
          commit={onWidth}
          testId="panel-resizer"
        />
      ) : null}
      {/* The four tabs' icons down the note's right edge, as vertical tabs (T53 item 9): one
          opens its tab beside them, the open one closes it. */}
      <aside className="note-rail" aria-label="Note Panel" data-testid="note-rail">
        <div
          ref={tabsRef}
          className="note-rail-icons"
          role="tablist"
          aria-label="Note panel"
          aria-orientation="vertical"
          onKeyDown={onTabKeyDown}
        >
          {PANEL_TABS.map((entry, index) => {
            const selected = open && tab === entry.tab;
            const keys = tabKeys[entry.tab];
            return (
              <button
                key={entry.tab}
                type="button"
                role="tab"
                className="icon-btn note-rail-btn"
                id={`note-tab-${id}-${entry.tab}`}
                aria-selected={selected}
                aria-controls={selected ? `note-tabpanel-${id}` : undefined}
                aria-label={
                  entry.tab === 'comments' && openThreads > 0
                    ? `Comments, ${openThreads} open`
                    : entry.label
                }
                aria-keyshortcuts={ariaKeyShortcuts(keys) || undefined}
                tabIndex={(open ? tab === entry.tab : index === 0) ? 0 : -1}
                data-tab={entry.tab}
                data-command={entry.command}
                data-tip={withKeys(selected ? `Close ${entry.label}` : entry.label, keys)}
                data-testid={`note-tab-${entry.tab}`}
                onClick={() => onToggleTab(entry.tab)}
              >
                <Icon name={entry.icon} size={18} />
                {entry.tab === 'comments' && openThreads > 0 ? (
                  <span className="note-tab-count" aria-hidden="true" data-testid="comments-count">
                    {openThreads}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </aside>
    </>
  );
}
