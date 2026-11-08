import { buildTree } from '@penmoss/core/workspace';
import { useSettingsInStep } from '../sources/settings-in-step';
import { openLightboxNow, setLightboxHooks } from '@penmoss/editor';
import { Icon } from '@penmoss/ui/icons';
import { TrashedToast } from '../trash/TrashedToast';
import { chooseTheme, resolveThemeSettings, toggleDarkMode } from '@penmoss/ui/theme';
import { WorkspaceError } from '@penmoss/sync-client/workspace';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CaptureDialog } from '../capture/CaptureDialog';
import { FeedbackDialog, type FeedbackSnapshot } from '../feedback/FeedbackDialog';
import { FeedbackToasts } from '../feedback/FeedbackToasts';
import { captureWindow, openedFromLabel, openingFacts } from '../feedback/open';
import { useFeedback } from '../feedback/service';
import { useNoteList, useNotes } from '../notes/hooks';
import { closedNotebooks } from '../workspace/notebooks';
import { RESERVED_KEYS } from '../notes/service';
import { browserStorage, readOpened, recentNotes } from '../notes/recent';
import { desktop } from '../desktop/bridge';
import { navigate, notePath, useLocation } from '../router';
import { SearchOverlay } from '../search/SearchOverlay';
import { NotebookMeaning } from '../search/meaning';
import { SearchService } from '../search/service';
import { SourcesSearch } from '../search/sources';
import { SourceScopeOr } from '../sources/context';
import { useNoteSource, useSourcesState } from '../sources/hooks';
import { JournalScope } from '../sources/JournalScope';
import { useGitNotebookCommands } from '../sources/git-commands';
import { useEveryOpenNoteList } from '../sources/lists';
import { displayTitle } from '../notes/list';
import { useSymbolCommandTitles } from '../notes/symbols';
import { FolderPicker } from '../workspace/FolderPicker';
import { moveRequest } from '../workspace/move-request';
import { moveSummary } from '../workspace/selection';
import { folderTreeOf } from '../workspace/tree';
import { useWorkspace } from '../workspace/hooks';
import { folderChoices, planMoveTo } from '../workspace/model';
import { useFolderTree } from '../workspace/tree';
import { useThemeController } from '../theme/hooks';
import { ThemePicker } from '../theme/ThemePicker';
import { settingsBindings } from './bindings';
import { CommandCenter } from './center';
import { Cheatsheet } from './Cheatsheet';
import { COMMANDS } from './definitions';
import { CommandsContext, useCommand, useCommands } from './hooks';
import { Palette, type PaletteMode } from './Palette';
import { RecentSwitcher } from './RecentSwitcher';

/**
 * The command registry for the app (T20): bindings from the Journal notebook's settings (A827),
 * and the keyboard dispatcher on the window (capture phase, ahead of the editor's own keymaps).
 */
export function CommandsProvider({ children }: { children: ReactNode }) {
  const workspace = useWorkspace();
  const center = useMemo(
    () =>
      new CommandCenter(
        COMMANDS,
        settingsBindings({
          settings: () => workspace.settings(),
          setSetting: (key, value) => workspace.setSetting(key, value),
          subscribe: (listener) => workspace.subscribe(listener),
        }),
      ),
    [workspace],
  );
  // In the commit, before the first paint (A697): a shortcut pressed as soon as its button
  // shows must find the dispatcher listening. As a passive effect it attached after the paint,
  // and Alt+N pressed at the Mac app's launch then made no note (2 launches in 40).
  useLayoutEffect(() => {
    center.start();
    window.addEventListener('keydown', center.handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', center.handleKeyDown, true);
      center.dispose();
    };
  }, [center]);
  return (
    <CommandsContext.Provider value={center}>
      <LightboxHost center={center} />
      {children}
    </CommandsContext.Provider>
  );
}

/**
 * The image lightbox is modal to the app (T51 review, A948): while it is open the keyboard
 * shortcuts wait (⌘K, ⌘[ and the rest acted behind it, and its focus trap then fought the
 * palette for focus), and a change of page closes it rather than leaving it over another page.
 */
function LightboxHost({ center }: { center: CommandCenter }) {
  useEffect(() => setLightboxHooks({ onOpen: () => center.suspend() }), [center]);
  const location = useLocation();
  useEffect(() => {
    openLightboxNow()?.close();
  }, [location]);
  return null;
}

type Overlay =
  | { readonly kind: 'palette'; readonly mode: PaletteMode }
  | { readonly kind: 'recent'; readonly index: number; readonly held: boolean }
  | { readonly kind: 'cheatsheet' }
  | { readonly kind: 'search' }
  | { readonly kind: 'themes' }
  | { readonly kind: 'capture' }
  | { readonly kind: 'move'; readonly noteIds: readonly string[] }
  | { readonly kind: 'feedback'; readonly snapshot: FeedbackSnapshot }
  | null;

/** How long "Moved to …" shows. */
const MOVED_MS = 3000;

const RECENT_LIMIT = 9;

/**
 * The palette, quick open, the recent-notes switcher and the cheat sheet,
 * with the app-level commands that open them and the settings pages.
 */
export function CommandOverlays({ currentNoteId }: { currentNoteId: string | null }) {
  const commands = useCommands();
  const notes = useNotes();
  const workspace = useWorkspace();
  const theme = useThemeController();
  // The switchers and quick open cover the open notebooks only (T43, A752), of every source
  // this window shows (A862).
  const openList = useEveryOpenNoteList();
  // One search service for the session: its index outlives the overlay (T22). The source in
  // context's alone without a registry (tests that render one source).
  const own = useMemo(
    () =>
      new SearchService({
        store: () => notes.openLocal(),
        workspace: () => workspace.getState().snapshot,
        closed: closedNotebooks,
        reserved: RESERVED_KEYS,
      }),
    [notes, workspace],
  );
  // One search across every notebook (T50, A826): each one's own index on this device.
  const sourcesState = useSourcesState();
  // The theme and the other settings are the app's own (the Journal notebook's, A827), whatever
  // source the open note is in.
  const settingsWorkspace = sourcesState?.root.workspace ?? workspace;
  // The other notebooks' settings in step with the primary's, when this Mac chose so (A1137).
  useSettingsInStep(sourcesState);
  // "Toggle Symbol ★": the symbol commands are titled by the person's glyphs (A940).
  useSymbolCommandTitles(commands, settingsWorkspace);
  // One search service per source for the window's life (a stable map, not render state).
  const [gitSearches] = useState(() => new Map<string, SearchService>());
  const search = useMemo(() => {
    const all = sourcesState?.all ?? [];
    if (all.length === 0) return own;
    const services = gitSearches;
    return new SourcesSearch(() =>
      (sourcesState?.all ?? []).map((source) => {
        let service = services.get(source.id);
        if (!service) {
          const sourceNotes = source.notes;
          // In the Mac app, meaning too (T77): the main window feeds the embedding service.
          const bridge = desktop()?.meaning;
          service = new SearchService({
            store: () => sourceNotes.openLocal(),
            workspace: () => source.workspace.getState().snapshot,
            reserved: RESERVED_KEYS,
            ...(bridge
              ? {
                  meaning: new NotebookMeaning(source.id, bridge, {
                    feed: desktop()?.window === 'main',
                    yieldToPage: () => new Promise((resolve) => setTimeout(resolve, 0)),
                  }),
                }
              : {}),
          });
          services.set(source.id, service);
          const made = service;
          source.notes.subscribe(() => made.invalidate());
        }
        return { id: source.id, name: source.name, service };
      }),
    );
  }, [own, sourcesState, gitSearches]);
  // In the Mac app, every notebook's search starts now, so the embedding service is fed its notes
  // from launch rather than from the first search (T77).
  useEffect(() => {
    if (!desktop()?.meaning || desktop()?.window !== 'main' || search === own) return;
    const timer = setTimeout(() => {
      search.refresh().catch((error: unknown) => {
        console.warn('[search] could not read this device’s notes', error);
      });
    }, 3_000);
    return () => clearTimeout(timer);
  }, [search, own]);
  const [overlay, setOverlay] = useState<Overlay>(null);
  /** Where focus was before an overlay opened, to give it back. */
  const returnFocus = useRef<HTMLElement | null>(null);
  /** The switcher's notes, fixed while it is open (the list re-sorts as notes change). */
  const [recent, setRecent] = useState<ReturnType<typeof recentNotes>>([]);
  /** What the last "Move to folder…" did, shown for a moment (T39); `ok` when it moved. */
  const [moved, setMoved] = useState<{ readonly text: string; readonly ok: boolean } | null>(null);
  useEffect(() => {
    if (!moved) return;
    const timer = setTimeout(() => setMoved(null), MOVED_MS);
    return () => clearTimeout(timer);
  }, [moved]);

  const mru = () =>
    recentNotes(openList, readOpened(browserStorage()), currentNoteId, RECENT_LIMIT);

  const open = (next: Exclude<Overlay, null>) => {
    // Recorded unless an overlay already holds where focus was. A command the palette ran
    // opens its overlay before the palette's close has rendered, and an opener that has gone
    // (a menu item) counts as nothing (T39 review).
    const held = returnFocus.current;
    if (!held || !held.isConnected) {
      const focused = document.activeElement;
      returnFocus.current =
        focused instanceof HTMLElement && focused !== document.body ? focused : null;
    }
    setOverlay(next);
  };

  /** Focus back where it was; if that has gone (a menu, the phone's note sheet), the note. */
  const close = (restore = true) => {
    setOverlay(null);
    const target = returnFocus.current;
    returnFocus.current = null;
    if (!restore) return;
    if (target?.isConnected) target.focus();
    else if (commands.editor) commands.editor.editor.view.focus();
    else commands.run('note.focusTitle');
  };

  const openNote = (id: string) => {
    close(false);
    notes.requestBodyFocus(id);
    navigate(notePath(id));
  };

  useCommand('app.palette', () => {
    if (overlay?.kind === 'palette' && overlay.mode === 'all') close();
    else open({ kind: 'palette', mode: 'all' });
  });
  useCommand('app.quickOpen', () => {
    if (overlay?.kind === 'palette' && overlay.mode === 'notes') close();
    else open({ kind: 'palette', mode: 'notes' });
  });
  useCommand('app.recent', ({ event }) => {
    if (overlay?.kind === 'recent') {
      const count = Math.max(1, recent.length);
      const step = event?.shiftKey ? -1 : 1;
      setOverlay({ ...overlay, index: (overlay.index + step + count) % count });
      return;
    }
    const notesNow = mru();
    setRecent(notesNow);
    const start = notesNow.length > 1 && notesNow[0]?.id === currentNoteId ? 1 : 0;
    open({
      kind: 'recent',
      index: start,
      held: Boolean(event && (event.metaKey || event.ctrlKey)),
    });
  });
  useCommand('app.search', () => {
    if (overlay?.kind === 'search') close();
    else open({ kind: 'search' });
  });
  useCommand('app.cheatsheet', () => {
    if (overlay?.kind === 'cheatsheet') close();
    else open({ kind: 'cheatsheet' });
  });
  useCommand('app.capture', () => {
    if (overlay?.kind === 'capture') close();
    else open({ kind: 'capture' });
  });
  useCommand('app.settings', () => navigate('/settings'));
  useCommand('app.trash', () => {
    if (overlay) close(false);
    navigate('/trash');
  });
  useCommand('journal.settings', () => {
    if (overlay) close(false);
    navigate('/settings/journal');
  });
  useCommand('app.shortcuts', () => {
    if (overlay) close(false);
    navigate('/settings/shortcuts');
  });
  useCommand(
    'app.gitNotebooks',
    () => {
      if (overlay) close(false);
      navigate('/settings/git-notebooks');
    },
    // The Mac app's git only (D48).
    () => Boolean(desktop()?.git),
  );
  useCommand(
    'app.checkForUpdates',
    () => {
      if (overlay) close(false);
      navigate('/settings/updates');
      void desktop()
        ?.updates?.check()
        .catch(() => null);
    },
    // The Mac app's (A1112).
    () => Boolean(desktop()?.updates),
  );
  useGitNotebookCommands(currentNoteId, (text, ok) => setMoved({ text, ok }));
  useCommand('app.status', () => {
    if (overlay) close(false);
    navigate('/settings/status');
  });
  useCommand('app.appearance', () => {
    if (overlay) close(false);
    navigate('/settings/appearance');
  });
  useCommand('app.display', () => {
    if (overlay) close(false);
    navigate('/settings/display');
  });
  useCommand('app.symbols', () => {
    if (overlay) close(false);
    navigate('/settings/symbols');
  });
  useCommand('theme.switch', () => {
    if (overlay?.kind === 'themes') close();
    else open({ kind: 'themes' });
  });
  useCommand('theme.toggleDark', () => toggleDarkMode(settingsWorkspace, theme.getState().variant));
  useCommand('app.home', () => navigate('/'));
  // T39. The open note, to the end of a folder chosen from a list: the keyboard's and the
  // phone's way to do what dragging in the tree does.
  useCommand(
    'note.move',
    () => {
      if (overlay?.kind === 'move') close();
      else if (currentNoteId) open({ kind: 'move', noteIds: [currentNoteId] });
    },
    () => currentNoteId !== null,
  );
  // T42 (A570): the tree's context menu moves its selection with the same picker.
  const latestOpen = useRef(open);
  useLayoutEffect(() => {
    latestOpen.current = open;
  });
  // T49 (A797): the context is read, and the Mac window captured, before the form is drawn.
  const feedback = useFeedback();
  useEffect(() => feedback?.presence.show(currentNoteId), [feedback, currentNoteId]);
  // A git notebook's note (A889): the context names it by kind only, and no window is captured.
  const currentSource = useNoteSource(currentNoteId ?? '');
  const gitNote = currentNoteId !== null && currentSource?.kind === 'git';
  const opening = useRef(false);
  useCommand(
    'app.sendFeedback',
    ({ source }) => {
      if (!feedback || opening.current || overlay?.kind === 'feedback') return;
      const facts = openingFacts({
        notes,
        workspace,
        theme,
        feedback,
        editorDoc: currentNoteId ? (commands.editor?.editor.state.doc ?? null) : null,
        openedFrom: openedFromLabel(source),
        gitNote,
        gitNames: (sourcesState?.all ?? [])
          .filter((each) => each.kind === 'git')
          .flatMap((each) => [
            each.name,
            ...each.notes.list().map((entry) => entry.title),
            ...each.workspace.getState().snapshot.folders.map((folder) => folder.name),
          ]),
      });
      opening.current = true;
      void (gitNote ? Promise.resolve(null) : captureWindow())
        .then((capture) => latestOpen.current({ kind: 'feedback', snapshot: { facts, capture } }))
        .finally(() => {
          opening.current = false;
        });
    },
    () => feedback !== null,
  );
  useEffect(
    () =>
      moveRequest.subscribe(() => {
        const noteIds = moveRequest.get();
        if (!noteIds) return;
        moveRequest.set(null);
        latestOpen.current({ kind: 'move', noteIds });
      }),
    [],
  );

  return (
    <>
      {/* Always in the page, so screen readers announce what is put in it (T39 review). */}
      <div role="status" className="toast-live">
        {moved ? (
          <p className="toast" data-testid="move-status">
            {moved.ok ? <Icon name="check" /> : null}
            {moved.text}
          </p>
        ) : null}
      </div>
      <TrashedToast />
      <FeedbackToasts />
      {renderOverlay()}
    </>
  );

  function renderOverlay() {
    if (!overlay) return null;
    switch (overlay.kind) {
      case 'palette':
        return (
          // Keyed by mode: Quick open run from the palette mounts a fresh
          // one, so it starts empty and takes focus (not the editor behind).
          <Palette
            key={overlay.mode}
            mode={overlay.mode}
            notes={recentNotes(openList, readOpened(browserStorage()), null, openList.length)}
            onClose={() => close()}
            onOpenNote={openNote}
            onRunCommand={(id) => {
              close();
              commands.run(id, { source: 'palette' });
            }}
          />
        );
      case 'recent':
        return (
          <RecentSwitcher
            notes={recent}
            currentId={currentNoteId}
            index={overlay.index}
            held={overlay.held}
            combo={commands.keysOf('app.recent')[0]}
            onIndexChange={(index) => setOverlay({ ...overlay, index })}
            onChoose={openNote}
            onClose={() => close()}
          />
        );
      case 'search':
        return (
          <SearchOverlay
            service={search}
            onOpenNote={(id, heading) => {
              close(false);
              notes.requestBodyFocus(id);
              navigate(
                heading ? `${notePath(id)}?heading=${encodeURIComponent(heading)}` : notePath(id),
              );
            }}
            onClose={() => close()}
          />
        );
      case 'themes':
        return (
          <ThemePicker
            themes={resolveThemeSettings(settingsWorkspace.settings()).all}
            currentId={theme.getState().theme.id}
            onChoose={(id) => {
              close();
              chooseTheme(settingsWorkspace, id);
            }}
            onClose={() => close()}
          />
        );
      case 'capture':
        return (
          // Captures go to the Journal notebook (A827).
          <JournalScope>
            <CaptureDialog onClose={(restore) => close(restore)} />
          </JournalScope>
        );
      case 'feedback':
        return <FeedbackDialog snapshot={overlay.snapshot} onClose={(restore) => close(restore)} />;
      case 'move':
        // In the notes' own source (A826): a tree's selection may be another section's.
        return (
          <NoteScope noteId={overlay.noteIds[0] ?? null}>
            <MoveOverlay
              noteIds={overlay.noteIds}
              onClose={() => close()}
              onMoved={(summary) => setMoved(summary)}
            />
          </NoteScope>
        );
      case 'cheatsheet':
        return (
          <Cheatsheet
            onClose={() => close()}
            onCustomise={() => {
              close(false);
              commands.run('app.shortcuts', { source: 'button' });
            }}
          />
        );
    }
  }
}

/** The source of a note, for what works on it (A826); as it is outside any source. */
function NoteScope({ noteId, children }: { noteId: string | null; children: ReactNode }) {
  const source = useNoteSource(noteId ?? '');
  return <SourceScopeOr source={noteId === null ? null : source}>{children}</SourceScopeOr>;
}

/** "Move to folder…" (T39, A570): the picker, and the moves, in the notes' source. */
function MoveOverlay({
  noteIds,
  onClose,
  onMoved,
}: {
  noteIds: readonly string[];
  onClose: () => void;
  onMoved: (summary: ReturnType<typeof moveSummary>) => void;
}) {
  const workspace = useWorkspace();
  const list = useNoteList();
  /** The folder tree, built only while the folder picker is open (not on every edit). */
  const tree = useFolderTree(true)?.tree ?? null;
  const close = onClose;
  const setMoved = onMoved;
  /** Moves every note to the end of one folder, in order; says what happened. */
  const moveNotes = (
    tree: ReturnType<typeof buildTree>,
    noteIds: readonly string[],
    folderId: string | null,
  ) => {
    close();
    const where = folderChoices(tree).find((choice) => choice.id === folderId)?.path ?? 'Top level';
    let moved = 0;
    let refused = 0;
    let problem: string | null = null;
    for (const noteId of noteIds) {
      // Each move from the tree as the last one left it, so they keep their order.
      const plan = planMoveTo(
        folderTreeOf(workspace.getState().snapshot, list).tree,
        noteId,
        folderId,
      );
      if (plan.type === 'refused') {
        problem = plan.reason;
        refused++;
        continue;
      }
      if (plan.type === 'noop') continue;
      try {
        workspace.apply(plan);
        moved++;
      } catch (error) {
        if (!(error instanceof WorkspaceError)) throw error;
        problem = `${error.message}.`;
        refused++;
      }
    }
    setMoved(moveSummary({ asked: noteIds.length, moved, refused, problem, where }));
  };

  if (!tree) return null;
  const folderOf = (noteId: string) =>
    [...tree.byId.values()].find((folder) => folder.notes.some((note) => note.id === noteId))?.id ??
    null;
  const places = new Set(noteIds.map(folderOf));
  const titles = noteIds.map((noteId) =>
    displayTitle(list.find((note) => note.id === noteId)?.title ?? ''),
  );
  return (
    <FolderPicker
      title={titles.length === 1 ? titles[0]! : `${titles.length} notes`}
      count={titles.length}
      choices={folderChoices(tree)}
      // Several notes in different folders: none of them is "here".
      currentId={places.size === 1 ? [...places][0]! : undefined}
      onChoose={(folderId) => moveNotes(tree, noteIds, folderId)}
      onClose={() => close()}
    />
  );
}
