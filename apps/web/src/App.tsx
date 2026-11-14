import { ariaKeyShortcuts } from '@penmoss/editor/keys';
import { BrandMark, Icon } from '@penmoss/ui/icons';
import {
  lazy,
  Suspense,
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { CaptureForm } from './capture/CaptureForm';
import { desktop } from './desktop/bridge';
import { DesktopIntegration } from './desktop/DesktopIntegration';
import { KeepOnTopButton } from './desktop/KeepOnTopButton';
import { CommandOverlays, CommandsProvider } from './commands/CommandsRoot';
import { useCommand, useCommands, useKeys } from './commands/hooks';
import { graphPath } from './graph/path';
import { useNotes } from './notes/hooks';
import { browserStorage, lastOpenedNote, readOpened } from './notes/recent';
import { NoteRoute } from './notes/NoteRoute';
import { QuickAccessSection } from './notes/QuickAccessSection';
import { SyncAnnouncer } from './notes/SyncAnnouncer';
import { FullWidthCommand } from './notes/width';
import { SettingsPage } from './pages/SettingsPage';
import { usePaneSize } from './shell/pane-widths';
import { PaneResizer } from './shell/PaneResizer';
import {
  linkHandler,
  navigate,
  notePath,
  parseRoute,
  useLocation,
  type Route,
  type RouteLocation,
} from './router';
import { AppBar } from './shell/AppBar';
import { DrawerContext, withKeys, type DrawerControl } from './shell/drawer';
import { HistoryCommands, HistoryNav } from './shell/HistoryNav';
import { Home } from './shell/Home';
import { SidebarShortcuts } from './shell/SidebarShortcuts';
import { TooltipLayer } from './shell/Tooltip';
import { usePhone } from './shell/media';
import { useSidebarCollapsed } from './shell/sidebar';
import { isKeyRepeat, isRepeatedNewNote, type LastCreated } from './notes/new-note';
import { Calendar } from './journal/Calendar';
import { JournalCommands } from './journal/PeriodNav';
import { tagFilter, useTagFilter } from './tags/filter';
import { TaggedNotes } from './tags/TaggedNotes';
import { TrashView } from './trash/TrashView';
import { TagPane, TagsPageLink } from './tags/TagPane';
import { TagsPage, type ShowTag } from './tags/TagsPage';
import { TimeMachinePage } from './time-machine/TimeMachinePage';
import { FolderTree } from './workspace/FolderTree';
import { TreeActions } from './workspace/TreeActions';
import { RecentSection } from './notes/RecentSection';
import { NotebooksSection } from './sources/NotebooksSection';
import { SidebarSections } from './shell/sidebar-layout';
import { useSidebarLayout } from './shell/sidebar-layout-state';
import { useWorkspace } from './workspace/hooks';
import { RecoveredNotice } from './workspace/RecoveredNotice';
import { SidebarUpdateNotice, UpdateNotice } from './updates/UpdatesSettings';
import { useUpdateNotice } from './updates/notice';
import { TitleBarLead } from './shell/title-lead';
import { SourceScope, SourceScopeOr } from './sources/context';
import { useNoteSource, useSourcesRegistry, useSourcesState } from './sources/hooks';
import { useEveryOpenNoteList } from './sources/lists';
import type { Source } from './sources/registry';
import { JournalScope } from './sources/JournalScope';
import { NoteSourceScope } from './sources/NoteSourceScope';
import { SourceHeading, SourceSection } from './sources/SourceSection';
import { WindowBlockedToast } from './window/BlockedToast';
import { ToastStack } from './toasts/ToastStack';
import { NoteWindow } from './window/NoteWindow';
import { listenForOpenInMain } from './window/open';

// The graph (T17) loads with d3-force on first use, never with the shell.
const GraphPage = lazy(() => import('./graph/GraphPage').then((m) => ({ default: m.GraphPage })));

/** The app's routes; `location` is injectable for tests (otherwise the History API drives it). */
export function App({ location }: { location?: RouteLocation | undefined }) {
  const current = useLocation();
  const { pathname, search } = location ?? current;
  const route = parseRoute(pathname);
  const params = new URLSearchParams(search);
  // A note window asks the window that opened it to show what it does not (T45, A710).
  useEffect(() => listenForOpenInMain((path) => navigate(path)), []);

  // The Mac app opens where it was: launched, or its window reopened, on the
  // home page, it goes to the note this device opened last, once the list has
  // loaded. Only at that start, so "Close the note" still reaches home. Every notebook's
  // notes, as the last one may be in any (T62 item 10).
  const list = useEveryOpenNoteList();
  const resumed = useRef(!desktop() || route.name !== 'home');
  useEffect(() => {
    if (resumed.current) return;
    if (route.name !== 'home') {
      resumed.current = true;
      return;
    }
    if (list.length === 0) return;
    resumed.current = true;
    const last = lastOpenedNote(list, readOpened(browserStorage()));
    if (last) navigate(notePath(last), { replace: true });
  }, [list, route.name]);

  const overlaysNote = route.name === 'note' || route.name === 'window' ? route.id : null;
  const page =
    route.name === 'settings' ? (
      <SettingsPage section={route.section} item={route.item} />
    ) : route.name === 'window' ? (
      // A note in a window of its own (T45, A710): no sidebar; in its source (A862).
      <NoteSourceScope id={route.id}>
        <NoteWindow id={route.id} heading={params.get('heading')} />
      </NoteSourceScope>
    ) : route.name === 'capture' ? (
      // The web app's capture page (the Mac app shows CaptureWindow here instead, main.tsx).
      <main className="app-shell" data-testid="app-root">
        {/* Captures go to the Journal notebook (A827). */}
        <JournalScope>
          <CaptureForm onSaved={() => navigate('/')} onCancel={() => navigate('/')} />
        </JournalScope>
      </main>
    ) : (
      <NotesShell route={route} params={params} />
    );
  return (
    <CommandsProvider>
      {desktop() ? <DesktopIntegration /> : null}
      {/* Back and Forward in the main window (T51, A943); a note window has its own (T45). */}
      {route.name === 'window' ? null : <HistoryCommands />}
      <FullWidthCommand />
      {page}
      {/* The palette, the switcher and Move work in the open note's source (A826). */}
      <OverlaysScope noteId={overlaysNote}>
        <CommandOverlays currentNoteId={overlaysNote} />
      </OverlaysScope>
      <WindowBlockedToast />
      {/* Every toast in this window, at its bottom centre (PEN-63); a note window has its own. */}
      <ToastStack />
      <TooltipLayer />
    </CommandsProvider>
  );
}

/** Children in `source`'s scope, or in the app's own when there is none. */
function InSource({ source, children }: { source: Source | null; children: ReactNode }) {
  return <SourceScopeOr source={source}>{children}</SourceScopeOr>;
}

/** The open note's source for the overlays; the app's own without one. */
function OverlaysScope({ noteId, children }: { noteId: string | null; children: ReactNode }) {
  const source = useNoteSource(noteId ?? '');
  // The same tree with a note or without: the toasts under it keep their state (A862).
  return <SourceScopeOr source={noteId === null ? null : source}>{children}</SourceScopeOr>;
}

/** Which screen is showing: the drawer closes whenever it changes. */
function screenKey(route: Route, params: URLSearchParams): string {
  return `${route.name}:${route.name === 'note' ? route.id : ''}?${params.toString()}`;
}

/**
 * Sidebar with the note list, and the open note (or a home screen). On a
 * phone (T36, A181) the sidebar is a drawer behind the app bar's menu button:
 * a modal panel that closes on Escape, on the scrim, and when the screen
 * changes, giving focus back to the menu button when dismissed.
 */
function NotesShell({
  route,
  params,
}: {
  route: Exclude<Route, { name: 'settings' | 'capture' | 'window' }>;
  params: URLSearchParams;
}) {
  const heading = params.get('heading');
  const graphNote = route.name === 'graph' ? params.get('note') : null;
  const notes = useNotes();
  const workspace = useWorkspace();
  const commands = useCommands();
  const phone = usePhone();
  const sidebarKeys = useKeys('app.toggleSidebar');
  const settingsKeys = useKeys('app.settings');
  // The sidebar as an icon rail (T41, A508); a phone has its drawer instead.
  const [sidebarCollapsed, setSidebarCollapsed] = useSidebarCollapsed();
  const rail = sidebarCollapsed && !phone;
  // Its width, dragged by its edge (A1122); a phone's drawer keeps its own.
  const [sidebarWidth, setSidebarWidth] = usePaneSize('sidebar');
  const appRoot = useRef<HTMLDivElement>(null);
  const layout = useSidebarLayout();
  useCommand(
    'app.toggleSidebar',
    () => {
      // Collapsing hides the tree, the calendar and the tags: focus in them would be lost, so it
      // moves to the toggle, where the same key brings them back (T41 review). So does focus on
      // what moves (Back, Forward and the pin go to a note's title bar) or changes shape (the
      // update notice becomes an icon) on the rail (PEN-135).
      const focused = document.activeElement;
      const hidden = focused?.closest(
        '.sb-list, .sb-foot .sb-update, .sb-head .history-nav, .sb-head .keep-on-top',
      );
      if (!sidebarCollapsed && hidden && sidebar.current?.contains(hidden)) {
        sidebar.current.querySelector<HTMLElement>('[data-testid="toggle-sidebar"]')?.focus();
      }
      setSidebarCollapsed(!sidebarCollapsed);
    },
    () => !phone,
  );
  // Where new notes and folders go: the folder last chosen in the sidebar (null: top level).
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  // The git notebooks side by side (T50, A862): the section last used, the open note's, or the
  // Journal notebook's, takes new notes and answers the tree commands.
  const sourcesState = useSourcesState();
  const sourcesRegistry = useSourcesRegistry();
  const shownSources = sourcesState?.all ?? [];
  // A section per notebook, even alone (A828): its name and sync state. Without a registry
  // (tests that render one source), the source in context's tree alone.
  const multi = shownSources.length > 0;
  const [currentSource, setCurrentSource] = useState<string | null>(null);
  const openNoteSource = useNoteSource(route.name === 'note' ? route.id : '');
  // A note opened from elsewhere (Quick open, a link) in another source: that source leads.
  const openNoteSourceId = openNoteSource?.id ?? null;
  const [seenNoteSource, setSeenNoteSource] = useState(openNoteSourceId);
  if (seenNoteSource !== openNoteSourceId) {
    setSeenNoteSource(openNoteSourceId);
    if (openNoteSourceId !== null && currentSource !== null && currentSource !== openNoteSourceId) {
      setCurrentSource(null);
    }
  }
  const activeSource: Source | null = multi
    ? (shownSources.find((source) => source.id === currentSource) ??
      (route.name === 'note' ? openNoteSource : null) ??
      sourcesState?.journal ??
      null)
    : null;
  const target = useMemo(
    () => activeSource ?? { notes, workspace },
    [activeSource, notes, workspace],
  );
  const targetFolder = activeSource && activeSource.id !== currentSource ? null : currentFolder;
  const inActive = (element: ReactNode) => (
    <SourceScopeOr source={activeSource}>{element}</SourceScopeOr>
  );

  // The drawer is open for one screen: opening a note, the graph or Trash closes it.
  const screen = screenKey(route, params);
  const [drawerShown, setDrawerShown] = useState(false);
  const [drawerScreen, setDrawerScreen] = useState(screen);
  if (drawerScreen !== screen) {
    setDrawerScreen(screen);
    setDrawerShown(false);
  }
  const drawerOpen = phone && drawerShown && drawerScreen === screen;
  // The sidebar's Send Feedback: after Settings in its bottom row, above it on the rail (finding 18).
  const feedbackButton = (
    <button
      type="button"
      className="icon-btn"
      data-command="app.sendFeedback"
      data-testid="sidebar-feedback"
      aria-label="Send Feedback"
      data-tip="Send Feedback"
      onClick={() => commands.run('app.sendFeedback', { source: 'button' })}
    >
      <Icon name="feedback" size={18} />
    </button>
  );
  const sidebar = useRef<HTMLElement>(null);
  // Dismissed (not closed by opening something): focus goes back to the menu button, once
  // the page behind is no longer inert.
  const returnFocus = useRef(false);
  const dismissDrawer = () => {
    returnFocus.current = true;
    setDrawerShown(false);
  };
  const drawer: DrawerControl = {
    open: drawerOpen,
    id: 'app-sidebar',
    show: () => setDrawerShown(true),
  };
  useEffect(() => {
    if (drawerOpen) {
      sidebar.current?.querySelector<HTMLElement>('.drawer-close')?.focus();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      document.querySelector<HTMLElement>('.app-bar [aria-controls="app-sidebar"]')?.focus();
    }
  }, [drawerOpen]);
  // A tag chosen under a note's title filters the sidebar: on a phone, show it.
  const latestPhone = useRef(phone);
  useLayoutEffect(() => {
    latestPhone.current = phone;
  });
  useEffect(
    () =>
      tagFilter.subscribe(() => {
        if (tagFilter.get() !== null && latestPhone.current) setDrawerShown(true);
      }),
    [],
  );
  const onSidebarKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || !drawerOpen || event.defaultPrevented) return;
    event.preventDefault();
    dismissDrawer();
  };

  // A double click, double tap or held key makes one note, not several (T39).
  const lastCreated = useRef<LastCreated | null>(null);
  const createNote = useCallback(() => {
    // The address now, not this render's: the second click can come before React renders.
    const open = parseRoute(window.location.pathname);
    const openNote =
      open.name === 'note'
        ? {
            id: open.id,
            // From the source that holds it (A826).
            title:
              (sourcesRegistry?.sourceOfNote(open.id)?.notes ?? notes)
                .list()
                .find((entry) => entry.id === open.id)?.title ?? '',
          }
        : null;
    if (isRepeatedNewNote(lastCreated.current, openNote, Date.now())) {
      // The repeated click focused the button: give the title its focus back, so typing
      // still names the note. Before the note view mounts, its own title focus does this.
      commands.run('note.focusTitle');
      return;
    }
    const id = target.notes.create(new Date(), { folderId: targetFolder });
    lastCreated.current = { id, at: Date.now() };
    target.workspace.registerNote(id, targetFolder);
    navigate(notePath(id));
  }, [notes, sourcesRegistry, target, targetFolder, commands]);

  // ⌘⌥N on a Mac, Alt+N elsewhere, by default (T20 registry, A90; customisable in Settings).
  useCommand('note.new', (context) => {
    if (!isKeyRepeat(context)) createNote();
  });

  // The open note, for the graph command: the graph opens around it (T17).
  const openNote = route.name === 'note' ? route.id : graphNote;
  // Mod+Shift+G by default.
  useCommand('app.graph', () => navigate(graphPath(openNote)));

  const tag = useTagFilter();
  // A tag's name on the Tags page (PEN-68): its notes in the sidebar, in its notebook.
  const showTag: ShowTag = (sourceId, chosen) => {
    if (sourceId !== null && sourceId !== currentSource) {
      setCurrentSource(sourceId);
      setCurrentFolder(null);
    }
    tagFilter.set(chosen);
  };
  // The update notice: in the sidebar's bottom panel or on the rail, a toast where the sidebar
  // is a drawer (PEN-135 item 10).
  const updateNotice = useUpdateNotice();
  // Beside the rail, a note's title bar starts with Back, Forward and the pin (PEN-135 item 6);
  // Home, Trash and the graph have no title bar of their own, so the rail keeps them there.
  const navInTitleBar = rail && route.name === 'note';
  return (
    <DrawerContext.Provider value={drawer}>
      <div
        ref={appRoot}
        className="notes-app"
        data-testid="app-root"
        data-drawer={drawerOpen ? 'open' : undefined}
        data-sidebar={rail ? 'collapsed' : undefined}
        style={{ '--pm-sidebar-width': `${sidebarWidth}rem` } as CSSProperties}
      >
        <JournalScope>
          <JournalCommands />
        </JournalScope>
        <RecoveredNotice />
        {phone ? <UpdateNotice notice={updateNotice} /> : null}
        <aside
          ref={sidebar}
          id="app-sidebar"
          className="sidebar"
          aria-label="Notes"
          inert={phone && !drawerOpen}
          onKeyDown={onSidebarKeyDown}
        >
          <div className="sb-head">
            {/* Back and Forward at the start of the window's first row (T51, A943); beside the
                rail, in the note's title bar instead (PEN-135 item 6). */}
            {navInTitleBar ? null : <HistoryNav testIdPrefix="app" />}
            <h1 className="brand">
              <BrandMark />
              <span>Penmoss</span>
            </h1>
            {/* The main window's pin, in the Mac app (T46, A720). */}
            {navInTitleBar ? null : <KeepOnTopButton />}
            <button
              type="button"
              className="icon-btn sb-collapse"
              data-command="app.toggleSidebar"
              aria-label={rail ? 'Expand the Sidebar' : 'Collapse the Sidebar'}
              aria-expanded={!rail}
              aria-controls="app-sidebar"
              aria-keyshortcuts={ariaKeyShortcuts(sidebarKeys) || undefined}
              data-tip={withKeys(rail ? 'Expand the Sidebar' : 'Collapse the Sidebar', sidebarKeys)}
              data-testid="toggle-sidebar"
              onClick={() => commands.run('app.toggleSidebar')}
            >
              <Icon name="panelL" />
            </button>
            <button
              type="button"
              className="icon-btn drawer-close"
              data-ui="dismiss"
              aria-label="Close Navigation"
              data-tip="Close Navigation"
              onClick={dismissDrawer}
            >
              <Icon name="close" />
            </button>
          </div>
          {/* Read out when sync needs attention; the state itself is each section's dot (A933). */}
          <SyncAnnouncer />
          <div className="sb-actions">
            {/* New Note first, in the accent, then the shortcuts: one row of icons (T52). */}
            <SidebarShortcuts
              openNote={openNote}
              graphOpen={route.name === 'graph'}
              shownNote={route.name === 'note' ? route.id : null}
            />
          </div>
          <nav className="sb-list" aria-label="All notes">
            {/* The sections in the person's order, each hidden or shown (T53 item 8, A983). */}
            <SidebarSections
              layout={layout}
              // The Tags page from the Tags section's title row (PEN-68).
              leads={{ tags: <TagsPageLink current={route.name === 'tags'} /> }}
              render={{
                // The pinned notes (T51, A946).
                quickAccess: (tools) => (
                  <QuickAccessSection
                    activeId={route.name === 'note' ? route.id : null}
                    tools={tools}
                  />
                ),
                recent: (tools) => (
                  <RecentSection
                    activeId={route.name === 'note' ? route.id : null}
                    count={layout.recentCount}
                    tools={tools}
                  />
                ),
                notebooks: (tools) => (
                  <NotebooksSection tools={tools}>
                    {tag ? (
                      inActive(
                        <>
                          {/* Whose notes these are, and their sync state (A933). */}
                          {activeSource ? <SourceHeading source={activeSource} /> : null}
                          <TaggedNotes
                            tag={tag}
                            activeId={route.name === 'note' ? route.id : null}
                          />
                        </>,
                      )
                    ) : multi ? (
                      shownSources.map((source) => (
                        <SourceScope key={source.id} source={source}>
                          <SourceSection
                            source={source}
                            activeId={route.name === 'note' ? route.id : null}
                            currentFolder={currentSource === source.id ? currentFolder : null}
                            onCurrentFolderChange={(folderId) => {
                              setCurrentSource(source.id);
                              setCurrentFolder(folderId);
                            }}
                            active={activeSource?.id === source.id}
                            onActivate={() => {
                              if (currentSource === source.id) return;
                              setCurrentSource(source.id);
                              setCurrentFolder(null);
                            }}
                            shown={!rail}
                          />
                        </SourceScope>
                      ))
                    ) : (
                      <>
                        {/* Trash at the end of the tree's actions (T52). */}
                        <TreeActions
                          currentFolder={currentFolder}
                          onCurrentFolderChange={setCurrentFolder}
                          trash={{
                            href: '/trash',
                            testId: 'sidebar-trash',
                            current: route.name === 'trash',
                          }}
                        />
                        <FolderTree
                          activeId={route.name === 'note' ? route.id : null}
                          currentFolder={currentFolder}
                          onCurrentFolderChange={setCurrentFolder}
                          shown={!rail}
                        />
                      </>
                    )}
                  </NotebooksSection>
                ),
                // The Journal notebook's calendar (A827), whichever note is open.
                calendar: (tools) => (
                  <JournalScope>
                    <Calendar activeId={route.name === 'note' ? route.id : null} tools={tools} />
                  </JournalScope>
                ),
                tags: (tools) => inActive(<TagPane tools={tools} />),
              }}
            />
          </nav>
          {/* Icons with their names as tooltips (T51, A935); Trash is on the notebook's bar (T52).
              The update notice above them (PEN-135 item 10); on the rail, all at its foot (item 4),
              Settings last, at the very bottom (Ryan's review of #192, finding 18). In the DOM in
              the order shown, so Tab follows it. */}
          <footer className="sb-foot">
            {phone ? null : <SidebarUpdateNotice notice={updateNotice} rail={rail} />}
            {rail ? feedbackButton : null}
            <a
              className="icon-btn"
              href="/settings"
              data-command="app.settings"
              aria-label="Settings"
              aria-keyshortcuts={ariaKeyShortcuts(settingsKeys) || undefined}
              data-tip={withKeys('Settings', settingsKeys)}
              data-testid="sidebar-settings"
              onClick={linkHandler('/settings')}
            >
              <Icon name="gear" size={18} />
            </a>
            {rail ? null : feedbackButton}
          </footer>
          {rail || phone ? null : (
            <PaneResizer
              kind="sidebar"
              label="Sidebar Width"
              width={sidebarWidth}
              edge="end"
              preview={(rem) =>
                appRoot.current?.style.setProperty('--pm-sidebar-width', `${rem}rem`)
              }
              commit={setSidebarWidth}
              testId="sidebar-resizer"
            />
          )}
        </aside>
        {drawerOpen ? (
          <div className="drawer-scrim" aria-hidden="true" onClick={dismissDrawer} />
        ) : null}
        <main className="note-main" inert={drawerOpen} tabIndex={-1}>
          {route.name === 'note' ? (
            <NoteSourceScope key={route.id} id={route.id}>
              <TitleBarLead.Provider
                value={
                  navInTitleBar ? (
                    <>
                      <HistoryNav testIdPrefix="app" />
                      <KeepOnTopButton />
                    </>
                  ) : null
                }
              >
                <NoteRoute id={route.id} heading={heading} />
              </TitleBarLead.Provider>
            </NoteSourceScope>
          ) : route.name === 'graph' ? (
            <InSource
              source={
                sourcesRegistry?.sourceById(params.get('source') ?? '') ??
                (graphNote ? (sourcesRegistry?.sourceOfNote(graphNote) ?? null) : null)
              }
            >
              <AppBar title="Graph" />
              <Suspense
                fallback={
                  <p className="graph-loading" role="status">
                    <span className="spinner" aria-hidden="true" />
                    Loading the graph…
                  </p>
                }
              >
                <GraphPage note={graphNote} local={params.get('local') === '1'} />
              </Suspense>
            </InSource>
          ) : route.name === 'trash' ? (
            // Each source has its own Trash (A862): `/trash?source=<id>`.
            <InSource source={sourcesRegistry?.sourceById(params.get('source') ?? '') ?? null}>
              <AppBar
                title={
                  multi
                    ? `Trash · ${sourcesRegistry?.sourceById(params.get('source') ?? '')?.name ?? sourcesState?.root.name ?? ''}`
                    : 'Trash'
                }
              />
              <TrashView />
            </InSource>
          ) : route.name === 'tags' ? (
            <>
              <AppBar title="Tags" />
              <TagsPage onShowTag={showTag} />
            </>
          ) : route.name === 'time-machine' ? (
            // A git notebook's past (PEN-21): `/time-machine?source=<id>`, the Journal's without.
            <InSource
              source={
                sourcesRegistry?.sourceById(params.get('source') ?? '') ??
                sourcesState?.journal ??
                null
              }
            >
              <AppBar title="Time Machine" />
              <TimeMachinePage params={params} />
            </InSource>
          ) : route.name === 'not-found' ? (
            <>
              <AppBar title="Penmoss" brand />
              <div className="empty-state">
                <h2>Nothing here</h2>
                <p>
                  This address is not a note.{' '}
                  <a href="/" data-command="app.home" onClick={linkHandler('/')}>
                    Back to Your Notes
                  </a>
                </p>
              </div>
            </>
          ) : (
            <>
              <AppBar title="Penmoss" brand />
              <Home phone={phone} />
              {phone ? (
                <button
                  type="button"
                  className="fab"
                  data-command="note.new"
                  aria-label="New Note"
                  data-tip="New Note"
                  onClick={() => commands.run('note.new')}
                >
                  <Icon name="plus" size={24} />
                </button>
              ) : null}
            </>
          )}
        </main>
      </div>
    </DrawerContext.Provider>
  );
}
