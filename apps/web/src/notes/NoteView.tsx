import {
  ARROW_UP_INTO_TITLE,
  BACKSPACE_INTO_TITLE,
  COMMENT_ADD_EVENT,
  COMMENT_OPEN_EVENT,
  createCollabEditor,
  noteExtensions,
  noteLayoutChanged,
  revealThread,
  selectionAnchor,
  showCommentThreads,
  showPendingComment,
  UnsupportedContentError,
  type BackspaceIntoTitleDetail,
  type CollabEditor,
  type FileServices,
} from '@penmoss/editor';
import { assertFileSize } from '@penmoss/sync-client/attachments';
import { ariaKeyShortcuts, formatCombo } from '@penmoss/editor/keys';
import { findHeading } from '@penmoss/core/line-symbols';
import { Icon } from '@penmoss/ui/icons';
import {
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useCommand, useCommands, useKeys } from '../commands/hooks';
import { Kbd } from '../commands/Kbd';
import { navigate } from '../router';
import { InfoPanel, PinnedMetadata, StatusBar } from './NoteInfo';
import { useNoteMetadataSettings } from './metadata-state';
import { CommentsPanel } from './CommentsPanel';
import { CommentPopover, type FloatingComment } from './CommentPopover';
import { floats, shownInNote, useGoneDeliveries, useThreads } from './comments';
import { COPIED_AGENT_REFERENCE, useCopyAgentReference } from './agent-reference';
import { showToast } from '../toasts/toasts';
import { NoteStats } from './note-stats';
import { HistoryPanel } from '../history/HistoryPanel';
import { browserFoldStorage, localFoldState } from './folds';
import { useNoteList, useNotes } from './hooks';
import { useDirectory } from './directory-hooks';
import { markdownDoc, noteFields, noteMarkdown } from './markdown';
import { MarkdownSource } from './MarkdownSource';
import { NoteBarButtonView } from './NoteBarButton';
import { useNoteBar } from './note-bar';
import { browserStorage, rememberOpened } from './recent';
import { bindTitleField, pastedTitle } from './title';
import {
  caretOnLastLine,
  fitHeight,
  growingTitle,
  isLineBreak,
  queueEnter,
  typedAfterEnter,
  type QueuedEnter,
} from './title-field';
import { PeriodNav } from '../journal/PeriodNav';
import { WeekChangesLink } from '../time-machine/WeekChangesLink';
import { UnsupportedNote } from './UnsupportedNote';
import { AppBar } from '../shell/AppBar';
import { withKeys } from '../shell/drawer';
import { usePhone } from '../shell/media';
import { TitleBarLead } from '../shell/title-lead';
import { NoteActions, type NotePanelTab } from './NoteActions';
import { useNotePanelMode, usePaneWidth } from './panel-mode';
import { NOTE_MIN_REM, PANE_LIMITS, usePaneSize } from '../shell/pane-widths';
import { PaneResizer } from '../shell/PaneResizer';
import { useQuickAccess } from './quick-access';
import { MAX_QUICK_ACCESS } from '@penmoss/core/quick-access';
import {
  dropEditor,
  keepEditor,
  takeEditor,
  viewMounted,
  type EditorHost,
  type NoteEditor,
} from './kept-editors';
import { useNoteNotebook } from '../workspace/notebooks';
import { useNoteFolders } from '../workspace/tree';
import { useSource, useSourcesState } from '../sources/hooks';
import { defaultNotebookName } from '@penmoss/sync-client/workspace';
import { PhoneFormatBar } from './PhoneFormatBar';
import { tagFilter } from '../tags/filter';
import type { Yjs14Replica } from '@penmoss/sync-client/yjs14';
import type { OpenNote } from './service';
import { useFullWidth } from './width';
import { trashedNote } from '../trash/trashed';
import { openNoteWindow } from '../window/open';
import { symbolSource } from './symbols';
import { useWorkspace, useWorkspaceState } from '../workspace/hooks';

/** "Copied as Markdown" after an explicit copy (T15), in the window's toast stack (PEN-63). */
function showCopied(text: string, ok: boolean): void {
  showToast({ text, tone: ok ? 'done' : 'error', testId: 'copy-status', ms: COPIED_MS });
}

/** How long a copy's toast shows. */
const COPIED_MS = 2500;

/** The whole note, copied from the actions menu or the palette (T15). */
type CopyFormat = 'markdown' | 'rich';

/**
 * What the side panel shows (T51, A936): the note's Metadata (`info`, the Info panel of T41),
 * its Comments (T48), its Version History (T21) or its Local Graph (T17). The last one shown is
 * remembered per device.
 */
type SidePanel = NotePanelTab;
const PANEL_TAB_KEY = 'penmoss.notePanelTab';

/** The side panel's tabs in order: each with its command, which opens it or closes the panel. */
const PANEL_TABS: ReadonlyArray<{
  readonly tab: SidePanel;
  readonly label: string;
  readonly icon: 'info' | 'comment' | 'history' | 'graph';
  readonly command: string;
}> = [
  { tab: 'info', label: 'Metadata', icon: 'info', command: 'note.backlinks' },
  { tab: 'comments', label: 'Comments', icon: 'comment', command: 'note.comments' },
  { tab: 'history', label: 'History', icon: 'history', command: 'note.history' },
  { tab: 'graph', label: 'Local Graph', icon: 'graph', command: 'note.localGraph' },
];

function readPanelTab(): SidePanel {
  try {
    const stored = localStorage.getItem(PANEL_TAB_KEY);
    return PANEL_TABS.find((entry) => entry.tab === stored)?.tab ?? 'info';
  } catch {
    return 'info';
  }
}

/** The Local Graph tab draws with d3-force: loaded the first time it shows (T51, as GraphPage). */
const NoteGraph = lazy(() =>
  import('../graph/NoteGraph').then((module) => ({ default: module.NoteGraph })),
);

function writePanelTab(tab: SidePanel): void {
  try {
    localStorage.setItem(PANEL_TAB_KEY, tab);
  } catch {
    // Private mode: as above.
  }
}

/**
 * One open note: the title field above the TipTap body, both bound to the
 * note's replica. The replica is restored from IndexedDB before the editor
 * mounts, and syncing starts only after that, so a reload shows the note
 * without waiting for the network (A7). Pasted and dropped images are stored
 * on this device first and upload in the background (T10).
 */
export function NoteView({
  id,
  heading = null,
  nav,
  actions,
  onDeleted,
}: {
  id: string;
  heading?: string | null;
  /** In place of the breadcrumbs: a note window's Back and Forward (T45, A710). */
  nav?: ReactNode;
  /** Before the top bar's and the app bar's own actions: a note window's pin in the Mac app (T46, A720). */
  actions?: ReactNode;
  /** After Move to Trash; by default the app goes home (a note window stays, T45). */
  onDeleted?: () => void;
}) {
  const notes = useNotes();
  const directory = useDirectory();
  const lead = useContext(TitleBarLead);
  // Wikilinks (T16): titles and completion from the registry; new notes are filed beside this one.
  const links = useMemo(() => directory.forNote(id), [directory, id]);
  // T53 item 9 (A985): the panel is open on one tab beside the note's strip of tab icons, or
  // closed, this note's own or the device's default; in a narrow pane it lies over the text, and
  // starts closed there unless this note was left open.
  /** The note's article, in the pane whose width decides whether the panel fits beside it. */
  const articleRef = useRef<HTMLElement>(null);
  // The panel's width, dragged by its edge (A1122): the pane is wide when both fit.
  const [panelWidth, setPanelWidth] = usePaneSize('panel');
  const columnsRef = useRef<HTMLDivElement>(null);
  const pane = usePaneWidth(articleRef, panelWidth);
  const wide = pane.wide;
  // The pane's width as the note opened (measured before the first paint), for the default.
  const [startedWide, setStartedWide] = useState<boolean | null>(null);
  if (pane.measured && startedWide === null) setStartedWide(pane.wide);
  const [panelMode, setPanelMode] = useNotePanelMode(id, startedWide ?? true);
  const showPanel = panelMode === 'open';
  /** The open panel lies over the note's text: a narrow pane has no room beside it. */
  const panelOver = showPanel && !wide;
  // The panel coming or going moves the text column, in a wide window without changing its
  // width: the line symbols' margins are fitted to the gutter again (T52 items 3 and 6).
  const layoutKey = `${panelMode} ${wide}`;
  const laidOut = useRef(layoutKey);
  useLayoutEffect(() => {
    if (laidOut.current === layoutKey) return;
    laidOut.current = layoutKey;
    noteLayoutChanged();
  }, [layoutKey]);
  const [panelTab, setPanelTab] = useState<SidePanel>(readPanelTab);
  /** The thread picked in the panel or the note (T48). */
  const [activeThread, setActiveThread] = useState<string | null>(null);
  /**
   * A comment floating over the note at its passage (T52 item 5): a new thread on the selection
   * the editor's Comment was asked on, or a thread opened from its passage or the list.
   */
  const [floating, setFloating] = useState<FloatingComment | null>(null);
  /** Add Note Comment: a thread on the note as a whole being written in the Comments tab. */
  const [noteDraft, setNoteDraft] = useState(false);
  const copyAgentReference = useCopyAgentReference();
  const commands = useCommands();
  // The person's line symbols (T44), one live source for every editor of this workspace.
  const workspace = useWorkspace();
  const symbols = useMemo(() => symbolSource(workspace), [workspace]);
  const infoKeys = useKeys('note.backlinks');
  const commentKeys = useKeys('note.comments');
  const historyKeys = useKeys('note.history');
  const graphKeys = useKeys('note.localGraph');
  const tabKeys: Record<SidePanel, readonly string[]> = {
    info: infoKeys,
    comments: commentKeys,
    history: historyKeys,
    graph: graphKeys,
  };
  /** Quick Access (T51, A946): whether this note is pinned, and the ⋯ menu's Pin or Unpin. */
  const quickAccess = useQuickAccess();
  const pinned = quickAccess.pinned(id);
  const noteBar = useNoteBar();
  const sourceKeys = useKeys('note.toggleSource');
  const [fullWidth] = useFullWidth();
  /** The open note (its sync state, for the status bar) once shown. */
  const [shownNote, setShownNote] = useState<OpenNote | null>(null);
  /** `note.addTag` asked for the tag field (in the Info panel, T41). */
  const [addingTag, setAddingTag] = useState(false);
  /** Tags pinned under the title (T62 item 4): Add a Tag works there, and the panel's is its own. */
  const tagsPinned = useNoteMetadataSettings().underTitle.includes('tags');
  const [panelAddingTag, setPanelAddingTag] = useState(false);
  /** Word and character counts, taken after typing pauses (T41, A505). */
  const stats = useMemo(() => new NoteStats(), []);
  const phone = usePhone();
  // The app bar's title on a phone: the note's title as the list has it.
  const title = useNoteList().find((entry) => entry.id === id)?.title ?? '';
  const trail = useNoteFolders(id);
  // A note in a notebook names it first in its breadcrumb (T43, A752), closed or not.
  const notebook = useNoteNotebook(id);
  // A note at the top level: the phone's app bar names its notebook (T52), the default one's
  // current name or a git notebook's.
  const { snapshot: workspaceSnapshot } = useWorkspaceState();
  const noteSource = useSource();
  const topNotebook =
    noteSource?.kind === 'git' ? noteSource.name : defaultNotebookName(workspaceSnapshot);
  // With two notebooks or more open, the breadcrumb starts with the note's (T64 item 5).
  const openSources = useSourcesState();
  const sourceCrumb =
    openSources && openSources.all.length > 1 && noteSource ? noteSource.name : null;
  const titleRef = useRef<HTMLTextAreaElement>(null);
  /** The note body: the note's editor brings its own element into it (kept-editors.ts). */
  const slotRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<CollabEditor | null>(null);
  /** Enter pressed in the title before the body opened (A1179): taken when it opens. */
  const queuedEnterRef = useRef<QueuedEnter | null>(null);
  const shownRef = useRef<NoteEditor | null>(null);
  const [ready, setReady] = useState(false);
  /** The open note's replica once loaded (its tags are edited there, T18). */
  const [replica, setReplica] = useState<Yjs14Replica | null>(null);
  const threads = useThreads(replica);
  useGoneDeliveries(replica, noteSource?.workspace ?? null);
  const openThreads = threads.filter((placed) => placed.thread.status === 'open').length;
  const [error, setError] = useState<string | null>(null);
  /**
   * The note holds node types a later version of Penmoss wrote (A158): it shows
   * read-only, as text, and stays as it is on the server for that version.
   */
  const [unsupported, setUnsupported] = useState<{
    readonly types: readonly string[];
    readonly text: string;
  } | null>(null);
  /** Why a pasted or dropped file was not added; cleared after a while. */
  const [notice, setNotice] = useState<string | null>(null);
  /** The conflict copy made when this note was restored on the server (A525), until dismissed. */
  /** Bumped when the server's copy replaced the local one (A5), to reopen the note. */
  const [generation, setGeneration] = useState(0);
  /** The read-only markdown source view (T11): null while the editor shows. */
  const [source, setSource] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  /** The strip of tab icons (vertical tabs, T53 item 9), for arrow keys between them. */
  const tabsRef = useRef<HTMLDivElement>(null);
  /**
   * Bumped when a command opened the panel (a key, the palette, a menu, a bar button): the tab it
   * shows then takes focus, so a screen reader names it (T51 review, A936).
   */
  const [tabFocus, setTabFocus] = useState(0);

  // A note created here takes focus in its title at once, before it has loaded,
  // so typing never lands on the New note button (and creates another note).
  useLayoutEffect(() => {
    if (notes.takeTitleFocus(id)) titleRef.current?.focus();
  }, [id, notes]);

  // The recent-notes switcher (T20) orders notes by when this device last opened them.
  useEffect(() => rememberOpened(browserStorage(), id, Date.now()), [id]);

  // The window (or tab) is named after the note, so Mission Control and the
  // Window menu can tell notes apart.
  useEffect(() => {
    document.title = `${title.trim() || 'Untitled'} – Penmoss`;
    return () => {
      document.title = 'Penmoss';
    };
  }, [title]);

  useEffect(() => {
    const host: EditorHost = {
      notice: setNotice,
      copied: showCopied,
      reopen: () => setGeneration((value) => value + 1),
    };
    const unmounted = viewMounted(notes);
    let cancelled = false;
    let teardown: (() => void) | null = null;

    /** Puts the note's editor in this view, bound to the title field and the commands. */
    const show = (shown: NoteEditor, title: HTMLTextAreaElement, slot: HTMLElement) => {
      const { note, collab, files } = shown;
      slot.append(shown.element);
      shown.host = host;
      shownRef.current = shown;
      editorRef.current = collab;
      // Editor commands (formatting, inserts) act on this note while it is open (T20).
      const active = { editor: collab.editor, images: files };
      commands.setEditor(active);
      // The selection toolbar shows the user's bindings, not only the defaults.
      const toolbar = (
        collab.editor.storage as unknown as {
          selectionToolbar?: {
            toolbar: { keysFor: ((id: string) => readonly string[]) | null } | null;
          };
        }
      ).selectionToolbar?.toolbar;
      if (toolbar) toolbar.keysFor = (commandId) => commands.keysOf(commandId);
      // Enter pressed in the title before the body opened (A1179) is done now: what was typed
      // after it goes from the title to the start of the body, as it would have at once.
      const queued = queuedEnterRef.current;
      queuedEnterRef.current = null;
      const typed = queued ? typedAfterEnter(queued, title.value) : null;
      if (queued && typed) {
        title.value = queued.title;
        fitHeight(title);
      }
      const unbindTitle = bindTitleField(growingTitle(title), note.replica);
      // Shown again from the shelf, its caret is where it was; the page's selection is not.
      // Focused by Tab or a command, it goes on there (a click places the caret anyway).
      const view = collab.editor.view;
      if (queued) {
        collab.editor.commands.setTextSelection(0);
        if (typed) view.dispatch(view.state.tr.insertText(typed));
      }
      const restoreCaret = () => view.focus();
      if (shown.shown > 0) view.dom.addEventListener('focus', restoreCaret, { once: true });
      // The browser reports a caret moved by a key a moment later, and a click elsewhere
      // can come first: the editor would never read where the caret went, and come back
      // from the shelf with an older one. Read it as focus leaves, while it is still here.
      const readCaret = () => {
        const selection = view.dom.ownerDocument.getSelection();
        const { anchorNode, focusNode } = selection ?? {};
        if (!selection || !anchorNode || !focusNode) return;
        if (!view.dom.contains(anchorNode) || !view.dom.contains(focusNode)) return;
        try {
          const anchor = view.posAtDOM(anchorNode, selection.anchorOffset);
          const head = view.posAtDOM(focusNode, selection.focusOffset);
          const { from, to } = view.state.selection;
          if (Math.min(anchor, head) !== from || Math.max(anchor, head) !== to) {
            collab.editor.commands.setTextSelection({ from: anchor, to: head });
          }
        } catch {
          // Not a text position (a node view's inside): the editor's own selection stays.
        }
      };
      view.dom.addEventListener('blur', readCaret);
      shown.shown++;
      setReplica(note.replica);
      setShownNote(note);
      setReady(true);
      // Asked for the body (a note opened from the palette or the switcher, T20): once this
      // commit's effects are done, before the next key. Asked then, not now: React's
      // StrictMode shows a kept editor twice in a row, and only the second showing stays.
      let showing = true;
      queueMicrotask(() => {
        if (!showing) return;
        if (queued) {
          view.focus();
          return;
        }
        if (!notes.takeBodyFocus(id)) return;
        collab.editor.commands.setTextSelection(1);
        view.focus();
      });
      teardown = () => {
        showing = false;
        view.dom.removeEventListener('focus', restoreCaret);
        view.dom.removeEventListener('blur', readCaret);
        unbindTitle();
        title.value = ''; // The closed replica's title: never written into the reopened one.
        fitHeight(title);
        if (commands.editor === active) commands.setEditor(null);
        editorRef.current = null;
        shownRef.current = null;
        keepEditor(notes, shown);
      };
    };

    // Shown a moment ago: its editor is kept, current, and shows at once (T31).
    const kept = takeEditor(notes, id, directory);
    const title = titleRef.current;
    const slot = slotRef.current;
    if (kept && title && slot) {
      show(kept, title, slot);
      return () => {
        setReady(false);
        setReplica(null);
        setShownNote(null);
        teardown?.();
        unmounted();
      };
    }
    kept?.dispose();

    const note = notes.openNote(id);
    let created: NoteEditor | null = null;
    /** Its view must open the note again, or a kept editor of it closes. */
    const invalidate = () => {
      if (!created) return setGeneration((value) => value + 1);
      created.stale = true;
      if (created.host) created.host.reopen();
      else dropEditor(notes, created);
    };
    note.ready
      .then(() => {
        const title = titleRef.current;
        const slot = slotRef.current;
        if (cancelled || !title || !slot) return;
        // Images (T10) and other files (T13): this device's attachment store (A1032).
        const files: FileServices = {
          add: (bytes) => notes.attachments.add(bytes),
          addFile: async (file) => {
            assertFileSize(file.name, file.size); // Before reading 50 MB into memory.
            return notes.attachments.addFile(new Uint8Array(await file.arrayBuffer()), file.name);
          },
          info: (src) => notes.attachments.info(src),
          resolve: (src, signal) => notes.attachments.url(src, signal),
          release: (src) => notes.attachments.release(src),
          onError: (message) => created?.host?.notice(message),
        };
        // The editor's own element: it moves to whichever view shows the note next. In the
        // page before the editor is made, as node views may measure.
        const element = document.createElement('div');
        element.className = 'note-editor';
        slot.append(element);
        let collab: CollabEditor;
        try {
          collab = createCollabEditor({
            element,
            // Toggles remember being open or closed on this device only (T11).
            extensions: noteExtensions({
              images: files,
              files,
              foldState: localFoldState(id, browserFoldStorage()),
              links,
              // Line symbols (T44): the synced list, Settings → Symbols, and each slot's keys.
              symbols,
              // Comment threads (T48): their passages, and the selection toolbar's Comment.
              comments: true,
              onEditSymbols: () => commands.run('app.symbols', { source: 'menu' }),
              symbolShortcut: (index) => {
                const combo = commands.keysOf(`editor.symbol${index + 1}`)[0];
                return combo ? formatCombo(combo) : null;
              },
              // Copy as Markdown of a whole note carries its frontmatter, like the source view (T15).
              clipboard: {
                note: () => noteFields(id, note.replica),
                onCopy: (format, ok) =>
                  created?.host?.copied(
                    ok
                      ? `Copied as ${format === 'markdown' ? 'Markdown' : 'rich text'}`
                      : "Copying wasn't allowed here",
                    ok,
                  ),
              },
            }),
            replica: note.replica,
            // A later version's content arrived while open: reopen, read-only (A158).
            onUnsupported: invalidate,
          });
        } catch (caught) {
          element.remove();
          if (!(caught instanceof UnsupportedContentError)) throw caught;
          const unbindTitle = bindTitleField(growingTitle(title), note.replica);
          title.readOnly = true;
          const show = () =>
            setUnsupported({ types: caught.nodeTypes, text: note.replica.plainText() });
          show();
          const offUpdate = note.replica.onUpdate(show);
          setReplica(note.replica);
          setShownNote(note);
          setReady(true);
          teardown = () => {
            offUpdate();
            unbindTitle();
            // The field shows the closed replica's title: reopened (a restore, A262), it is not
            // text typed before the binding, which bindTitleField would write in a second time.
            title.value = '';
            fitHeight(title);
            title.readOnly = false;
            setUnsupported(null);
            note.close();
          };
          return;
        }
        collab.editor.view.dom.setAttribute('aria-label', 'Note body');
        created = {
          id,
          directory,
          note,
          collab,
          files,
          element,
          host: null,
          stale: false,
          shown: 0,
          dispose: () => {
            collab.destroy();
            note.close();
          },
        };
        show(created, title, slot);
      })
      .catch((caught: unknown) => {
        console.error('[notes] could not open the note', caught);
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      cancelled = true;
      setReady(false);
      setReplica(null);
      setShownNote(null);
      if (teardown) {
        teardown();
      } else if (created) {
        created.dispose();
      } else {
        note.close();
      }
      unmounted();
    };
  }, [id, notes, commands, generation, links, directory, symbols]);

  /** Opens the panel on a tab; set below, after the commands. */
  const openTabRef = useRef<(tab: SidePanel) => void>(() => undefined);
  /** Opens the panel on Comments. */
  const showComments = useCallback(() => openTabRef.current('comments'), []);

  // Comment threads (T48): the editor draws the open ones and picks out the active one; its
  // Comment (the toolbar, the command) and a click on a passage open a comment floating over the
  // note there (T52 item 5).
  useEffect(() => {
    const collab = editorRef.current;
    if (!ready || !collab) return;
    showCommentThreads(collab.editor, shownInNote(threads, activeThread), activeThread);
  }, [ready, threads, activeThread]);
  useEffect(() => {
    setActiveThread(null);
    setFloating(null);
    setNoteDraft(false);
  }, [id]);
  // A new thread's passage is marked while its composer floats (T52), until it is sent or not.
  const pendingAnchor = floating?.kind === 'draft' ? floating.draft.anchor : null;
  useEffect(() => {
    const editor = editorRef.current?.editor;
    if (!ready || !editor || !pendingAnchor) return;
    showPendingComment(editor, pendingAnchor);
    // Gone once it is sent or cancelled, and from a kept editor when another note opens.
    return () => showPendingComment(editor, null);
  }, [ready, pendingAnchor]);
  /** Closes the floating comment; `refocus`: the editor takes focus again (Escape, Cancel). */
  const floatingRef = useRef(floating);
  useLayoutEffect(() => {
    floatingRef.current = floating;
  });
  const closeFloating = useCallback((refocus: boolean) => {
    // A thread closed is no longer the one picked out in the note.
    if (floatingRef.current?.kind === 'thread') setActiveThread(null);
    setFloating(null);
    if (refocus) editorRef.current?.editor.view.focus();
  }, []);
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const onAdd = () => {
      const editor = editorRef.current?.editor;
      if (!editor) return;
      const anchor = selectionAnchor(editor.state);
      if (!anchor) return;
      setActiveThread(null);
      setFloating({ kind: 'draft', draft: anchor });
    };
    const onOpen = (event: Event) => {
      const threadId = (event as CustomEvent<{ threadId?: string }>).detail.threadId;
      if (!threadId) return;
      setActiveThread(threadId);
      // From a point's marker by keyboard, the thread takes focus; a click leaves the caret.
      const marker = document.activeElement?.classList.contains('pm-comment-marker') === true;
      setFloating({ kind: 'thread', id: threadId, focus: marker });
    };
    slot.addEventListener(COMMENT_ADD_EVENT, onAdd);
    slot.addEventListener(COMMENT_OPEN_EVENT, onOpen);
    return () => {
      slot.removeEventListener(COMMENT_ADD_EVENT, onAdd);
      slot.removeEventListener(COMMENT_OPEN_EVENT, onOpen);
    };
  }, [showComments]);

  // The counts follow the note's editor while it shows (T41).
  useEffect(() => {
    const collab = editorRef.current;
    if (!ready || !collab) return;
    return stats.attach(collab.editor);
  }, [ready, stats]);

  // A link to a heading (`[[Note#Heading]]`) scrolls to it once the note shows.
  useEffect(() => {
    const collab = editorRef.current;
    if (!ready || !heading || !collab) return;
    // With or without its leading symbols (T44, A748): `## ? Open questions` is "Open questions".
    const headings: Array<{ offset: number; text: string }> = [];
    collab.editor.state.doc.forEach((node, offset) => {
      if (node.type.name === 'heading') headings.push({ offset, text: node.textContent });
    });
    const index = findHeading(
      headings.map((entry) => entry.text),
      heading,
    );
    if (index < 0) return;
    const found = headings[index]!.offset;
    const dom = collab.editor.view.nodeDOM(found);
    if (!(dom instanceof HTMLElement)) return;
    dom.scrollIntoView({ block: 'start' });
    dom.classList.add('pm-heading-target');
    const timer = setTimeout(() => dom.classList.remove('pm-heading-target'), 2000);
    return () => clearTimeout(timer);
  }, [ready, heading]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const copyNote = (format: CopyFormat) => {
    editorRef.current?.editor.commands.copyNoteAs(format);
  };

  /** Enter in the title goes to the start of the body. */
  const enterBody = useCallback(() => {
    const editor = editorRef.current?.editor;
    if (!editor) {
      // The body has not opened yet (A1179): the Enter waits for it, not dropped.
      const field = titleRef.current;
      if (field && !queuedEnterRef.current) queuedEnterRef.current = queueEnter(field);
      return;
    }
    // Synchronously: TipTap's focus command waits a frame, and keys typed meanwhile would land in the title.
    editor.commands.setTextSelection(0);
    editor.view.focus();
  }, []);

  // The title is one line: pasted line breaks become spaces, and nothing but text goes in.
  const onTitlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const text = event.clipboardData.getData('text/plain');
    event.preventDefault();
    const field = event.currentTarget;
    // As typing: one step of the field's own undo, and its input event.
    if (document.execCommand('insertText', false, pastedTitle(text))) return;
    field.setRangeText(
      pastedTitle(text),
      field.selectionStart ?? field.value.length,
      field.selectionEnd ?? field.value.length,
      'end',
    );
    field.dispatchEvent(new Event('input', { bubbles: true }));
  };

  // Dropped text goes in as pasted text does: on one line.
  const onTitleDrop = (event: DragEvent<HTMLTextAreaElement>) => {
    const text = event.dataTransfer.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    const field = event.currentTarget;
    field.focus();
    if (document.execCommand('insertText', false, pastedTitle(text))) return;
    field.setRangeText(pastedTitle(text), field.selectionStart, field.selectionEnd, 'end');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  };

  // The title is shown wrapped, as a textarea, but stays one line (T39): a line break from
  // an on-screen keyboard that sends no Enter key moves to the body as Enter does; the
  // field's height follows its width.
  useEffect(() => {
    const field = titleRef.current;
    if (!field) return;
    const onBeforeInput = (event: InputEvent) => {
      if (!isLineBreak(event.inputType)) return;
      event.preventDefault();
      enterBody();
    };
    field.addEventListener('beforeinput', onBeforeInput);
    const resized =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => fitHeight(field));
    resized?.observe(field);
    return () => {
      field.removeEventListener('beforeinput', onBeforeInput);
      resized?.disconnect();
    };
  }, [enterBody]);

  // Backspace at the start of the note's first line (T64 item 6): the line joins the title and
  // the caret goes to the join. The editor asks through its element, which sits in the slot.
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const onBackspace = (event: Event) => {
      const field = titleRef.current;
      if (!field || field.readOnly) return;
      event.preventDefault();
      const { text } = (event as CustomEvent<BackspaceIntoTitleDetail>).detail;
      const at = field.value.length;
      if (text) {
        field.setRangeText(pastedTitle(text), at, at, 'start');
        field.dispatchEvent(new Event('input', { bubbles: true }));
      }
      field.focus();
      field.setSelectionRange(at, at);
    };
    // ↑ on the note's first line goes to the end of the title (PEN-135), as ↓ comes back.
    const onArrowUp = (event: Event) => {
      const field = titleRef.current;
      if (!field) return;
      event.preventDefault();
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    };
    slot.addEventListener(BACKSPACE_INTO_TITLE, onBackspace);
    slot.addEventListener(ARROW_UP_INTO_TITLE, onArrowUp);
    return () => {
      slot.removeEventListener(BACKSPACE_INTO_TITLE, onBackspace);
      slot.removeEventListener(ARROW_UP_INTO_TITLE, onArrowUp);
    };
  }, []);

  // The markdown source view follows the note (body and title, local and remote) while open.
  useEffect(() => {
    const collab = editorRef.current;
    if (!showSource || !ready || !collab) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const render = () => {
      timer = null;
      noteMarkdown(id, collab.replica, collab.editor.getJSON(), links.linkResolver()).then(
        (markdown) => {
          if (current) setSource(markdown);
        },
        (caught: unknown) => {
          console.error('[notes] could not render markdown', caught);
          if (current) setSource(`Could not render markdown: ${String(caught)}`);
        },
      );
    };
    // Coalesce a burst of updates (typing) into one render.
    const schedule = () => {
      timer ??= setTimeout(render, 50);
    };
    render();
    collab.replica.doc.on('update', schedule);
    return () => {
      current = false;
      if (timer !== null) clearTimeout(timer);
      collab.replica.doc.off('update', schedule);
    };
  }, [showSource, ready, id, links]);

  /** Applies the source view's edited body to the note (A1133). */
  const applySource = (body: string) => {
    const collab = editorRef.current;
    if (!collab || !collab.editor.isEditable) return;
    markdownDoc(body, links.linkResolver()).then(
      (doc) => {
        if (editorRef.current !== collab) return;
        if (JSON.stringify(doc) === JSON.stringify(collab.editor.getJSON())) return;
        collab.editor.commands.setContent(
          doc as Parameters<typeof collab.editor.commands.setContent>[0],
          {
            emitUpdate: true,
          },
        );
      },
      (caught: unknown) => console.error('[notes] could not read the markdown', caught),
    );
  };

  const toggleSource = () => {
    setSource(null);
    setShowSource((value) => !value);
  };
  const toggleSourceRef = useRef(toggleSource);
  useLayoutEffect(() => {
    toggleSourceRef.current = toggleSource;
  });

  const onDelete = () => {
    // Not kept for a switch back: it is in Trash.
    if (shownRef.current) shownRef.current.stale = true;
    const done = notes.deleteNote(id);
    if (onDeleted) onDeleted();
    else navigate('/');
    // With Undo, and focus on it (A524); Undo waits for the move to finish.
    trashedNote.set({
      notes: [{ id, title: titleRef.current?.value ?? title }],
      done,
      from: notes,
    });
  };

  // ⌘⇧M / Ctrl+Shift+M by default (as in the prototype), through the command registry (T20).
  useCommand('note.toggleSource', () => toggleSourceRef.current());
  useCommand('note.delete', onDelete);
  useCommand('note.focusTitle', () => titleRef.current?.focus());
  // The header's Copy menu (T15) copies the whole note; the palette runs the same commands.
  useCommand('note.copyMarkdown', () => copyNote('markdown'));
  useCommand('note.copyRich', () => copyNote('rich'));
  // T52 item 4: what an agent needs to find this note through the Penmoss MCP server.
  useCommand('note.copyAgentReference', () => {
    void copyAgentReference(id, titleRef.current?.value ?? title).then((done) =>
      showCopied(done ? COPIED_AGENT_REFERENCE : 'Could not copy the agent reference', done),
    );
  });
  // T52 item 5: a thread on the note as a whole, written at the top of the Comments tab.
  useCommand(
    'note.addNoteComment',
    () => {
      setFloating(null);
      setNoteDraft(true);
      showComments();
    },
    () => replica !== null,
  );
  // The panel's four tabs (T51, A936): Metadata (T16's Backlinks panel, T41's Info), Comments
  // (T48), Version History (T21) and Local Graph (T17), as vertical tabs down the note's right
  // edge: one open beside them, or none (T53 item 9, A985).
  /** Opens the panel on `tab`, remembered for this note (open) and this device (the tab). */
  const openTab = (tab: SidePanel) => {
    setPanelTab(tab);
    writePanelTab(tab);
    if (!showPanel) setPanelMode('open');
  };
  useLayoutEffect(() => {
    openTabRef.current = openTab;
  });
  /** A tab's icon or command: it opens its tab, or closes the panel while that tab shows. */
  const togglePanel = (tab: SidePanel) => {
    if (showPanel && panelTab === tab) {
      setPanelMode('closed');
      return;
    }
    openTab(tab);
    setTabFocus((count) => count + 1);
  };
  /** `note.togglePanel`: the panel opens on the tab shown last, or closes. */
  const flipPanel = () => {
    if (showPanel) setPanelMode('closed');
    else openTab(panelTab);
  };
  const togglePanelRef = useRef(togglePanel);
  const flipPanelRef = useRef(flipPanel);
  useLayoutEffect(() => {
    togglePanelRef.current = togglePanel;
    flipPanelRef.current = flipPanel;
  });
  useCommand('note.togglePanel', () => flipPanelRef.current());
  useCommand('note.backlinks', () => togglePanelRef.current('info'));
  useCommand('note.comments', () => togglePanelRef.current('comments'));
  useCommand('note.history', () => togglePanelRef.current('history'));
  useCommand('note.localGraph', () => togglePanelRef.current('graph'));
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
      strip?.querySelector<HTMLElement>(`[data-tab="${panelTab}"]`) ??
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
    setPanelMode('closed');
    focusStrip();
  };
  /**
   * ↑ and ↓, Home and End move between the tabs and open each (the ARIA tabs pattern). Escape on
   * a tab closes the open panel, as it does inside it: a click on a tab leaves focus there (T53
   * pass).
   */
  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      if (!showPanel || event.defaultPrevented || event.nativeEvent.isComposing) return;
      event.preventDefault();
      setPanelMode('closed');
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
    openTab(next.tab);
    tabsRef.current?.querySelector<HTMLElement>(`[data-tab="${next.tab}"]`)?.focus();
  };
  // Tags are edited in the Info panel (T41): adding one opens it, unless they are pinned under
  // the title (T62 item 4), where the field opens instead.
  useCommand(
    'note.addTag',
    () => {
      if (!tagsPinned) openTab('info');
      setAddingTag(true);
    },
    () => replica !== null,
  );
  // T51 (A946): pinned at the end of Quick Access, or out of it; a full list says so.
  useCommand(
    'note.pinQuickAccess',
    () => {
      if (!quickAccess.toggle(id)) {
        setNotice(
          `Quick Access is full: it holds ${MAX_QUICK_ACCESS} notes. Unpin one to pin this note.`,
        );
      }
    },
    () => quickAccess.canChange,
  );
  // T45 (A710): always a new window, so several can show this note.
  useCommand('note.openInNewWindow', () => openNoteWindow(id));

  const onTitleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      enterBody();
      return;
    }
    // ↓ on the title's last line goes to the start of the note's first line, as Enter does
    // (PEN-135, A1360); with Shift, ⌥, ⌘ or Ctrl it keeps its meaning in the title.
    if (event.key !== 'ArrowDown' || event.shiftKey || event.altKey || event.metaKey) return;
    if (event.ctrlKey || !caretOnLastLine(event.currentTarget)) return;
    event.preventDefault();
    enterBody();
  };

  /** The tab showing, or null while the panel is closed. */
  const shownTab = showPanel ? panelTab : null;
  const tabLabel = PANEL_TABS.find((entry) => entry.tab === panelTab)?.label;
  const panelBody = (
    <div
      className="note-tabpanel"
      role="tabpanel"
      id={`note-tabpanel-${id}`}
      aria-labelledby={`note-tab-${id}-${panelTab}`}
      data-tab={panelTab}
    >
      {panelTab === 'info' ? (
        <InfoPanel
          noteId={id}
          replica={replica}
          folder={trail}
          stats={stats}
          addingTag={tagsPinned ? panelAddingTag : addingTag}
          onAddingTag={tagsPinned ? setPanelAddingTag : setAddingTag}
        />
      ) : panelTab === 'comments' ? (
        <CommentsPanel
          noteId={id}
          replica={replica}
          threads={threads}
          active={activeThread}
          onActive={(thread, reveal) => {
            setActiveThread(thread);
            const editor = editorRef.current?.editor;
            if (!thread || !reveal || !editor) return;
            revealThread(editor, thread);
            // A thread with a passage opens floating there (T52 item 5); one with no passage
            // stays in the list.
            const placed = threads.find((each) => each.thread.id === thread);
            if (showPanel && placed && floats(placed)) {
              setFloating({ kind: 'thread', id: thread, focus: true });
            }
          }}
          noteDraft={noteDraft}
          onNoteDraftDone={() => setNoteDraft(false)}
          floating={floating?.kind === 'thread' ? floating.id : null}
        />
      ) : panelTab === 'history' ? (
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
  );
  return (
    <article
      ref={articleRef}
      className="note"
      data-testid="note-view"
      data-ready={ready ? 'true' : 'false'}
      data-width={fullWidth ? 'full' : undefined}
    >
      <AppBar title={title} path={trail} notebook={topNotebook}>
        {/* Below 700 px the top bar hides: the app bar carries its actions (a note window's pin). */}
        {actions}
        <NoteActions source={showSource} tab={shownTab} pinned={pinned} />
      </AppBar>
      <header className="note-top">
        {/* Back, Forward and the pin, beside the rail (PEN-135 item 6). */}
        {lead ? (
          <div className="note-top-lead" data-testid="note-top-lead">
            {lead}
          </div>
        ) : null}
        {nav ?? (
          <nav className="crumbs" aria-label="Breadcrumb">
            <ol>
              {sourceCrumb !== null ? (
                <li className="crumb-notebook" data-testid="note-source-crumb">
                  <Icon name="notebook" size={12} />
                  {sourceCrumb}
                  <Icon name="chevR" size={12} />
                </li>
              ) : null}
              {trail.map((name, index) =>
                index === 0 && notebook ? (
                  <li key={index} className="crumb-notebook" data-testid="note-notebook">
                    <Icon name="notebook" size={12} />
                    {name}
                    <Icon name="chevR" size={12} />
                  </li>
                ) : (
                  <li key={index}>
                    {name}
                    <Icon name="chevR" size={12} />
                  </li>
                ),
              )}
              <li aria-current="page">{title || 'Untitled'}</li>
            </ol>
          </nav>
        )}
        <div className="note-actions">
          {actions}
          {/* The buttons chosen in Settings → Display, each also in ⋯ (A1134). */}
          {noteBar.shown.map((button) => (
            <NoteBarButtonView
              key={button}
              button={button}
              pressed={
                button === 'fullWidth'
                  ? fullWidth
                  : button === 'toggleSource'
                    ? showSource
                    : button === 'pinQuickAccess'
                      ? pinned
                      : undefined
              }
              label={
                button === 'fullWidth' && fullWidth
                  ? 'Back to the Theme’s Width'
                  : button === 'pinQuickAccess' && pinned
                    ? 'Unpin from Quick Access'
                    : undefined
              }
            />
          ))}
          {/* Comments is a tab of the panel alone since T53 (item 9): no button here. */}
          <NoteActions
            source={showSource}
            tab={shownTab}
            pinned={pinned}
            fullWidth={fullWidth}
            variant="bar"
          />
        </div>
      </header>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="notice" role="status" data-testid="note-notice">
          {notice}
        </p>
      ) : null}
      <div
        ref={columnsRef}
        className="note-columns"
        data-panel={showPanel ? 'open' : 'closed'}
        data-over={panelOver ? '' : undefined}
        data-tab={shownTab ?? undefined}
        style={{ '--pm-panel-width': `${panelWidth}rem` } as CSSProperties}
      >
        {/* The note's text scrolls on its own, its scrollbar at the text's edge, left of the
            panel and its tabs (Quanta feedback 3, item 1; A1132). */}
        <div className="note-scroll" data-testid="note-scroll">
          {showSource ? (
            <div className="doc note-source">
              {/* The body is edited here; the frontmatter is the note's fields (A1133). */}
              <p className="note-source-hint" data-testid="note-markdown-hint">
                {editorRef.current?.editor.isEditable === false
                  ? 'Read-only.'
                  : 'Edit the markdown below. The frontmatter comes from the note’s title and fields.'}{' '}
                {sourceKeys[0] ? (
                  <>
                    <Kbd combo={sourceKeys[0]} /> goes back to the editor.
                  </>
                ) : null}
              </p>
              <MarkdownSource
                markdown={source ?? ''}
                editable={editorRef.current?.editor.isEditable !== false}
                onEdit={applySource}
              />
            </div>
          ) : null}
          <div className="doc" hidden={showSource}>
            <PeriodNav replica={replica} />
            <textarea
              ref={titleRef}
              className="doc-title"
              rows={1}
              aria-label="Title"
              aria-multiline="false"
              placeholder="Untitled"
              autoComplete="off"
              spellCheck
              onKeyDown={onTitleKeyDown}
              onPaste={onTitlePaste}
              onDrop={onTitleDrop}
              onInput={(event) => fitHeight(event.currentTarget)}
              data-testid="note-title"
            />
            {/* A weekly note's week in the Time Machine (PEN-21). */}
            <WeekChangesLink replica={replica} />
            {/* The fields pinned under the title in Settings → Display (T62 item 4). */}
            <PinnedMetadata
              noteId={id}
              replica={replica}
              folder={trail}
              stats={stats}
              addingTag={tagsPinned && addingTag}
              onAddingTag={setAddingTag}
            />
            {unsupported ? (
              <UnsupportedNote types={unsupported.types} text={unsupported.text} />
            ) : null}
            <div
              ref={slotRef}
              hidden={unsupported !== null}
              className="note-body"
              data-testid="note-body"
              onClick={(event) => {
                // ⌘-click (Ctrl-click) on an inline #tag shows the notes with it (T18).
                if (!(event.metaKey || event.ctrlKey)) return;
                const tag = (event.target as HTMLElement).closest<HTMLElement>('.pm-tag')?.dataset[
                  'tag'
                ];
                if (tag) tagFilter.set(tag);
              }}
            />
            {/* T52 item 5: a new thread, or one opened, floating over the note at its passage. */}
            {floating && replica && ready && !showSource ? (
              <CommentPopover
                key={
                  floating.kind === 'thread' ? floating.id : JSON.stringify(floating.draft.anchor)
                }
                editor={editorRef.current?.editor ?? null}
                noteId={id}
                replica={replica}
                threads={threads}
                floating={floating}
                onClose={closeFloating}
                onCreated={(thread) => {
                  closeFloating(true);
                  setActiveThread(thread);
                }}
              />
            ) : null}
          </div>
        </div>
        {showPanel ? (
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
              <button
                type="button"
                className="icon-btn"
                data-ui="dismiss"
                aria-label="Close Panel"
                data-tip="Close Panel (Esc)"
                onClick={() => setPanelMode('closed')}
                data-testid="note-panel-close"
              >
                <Icon name="close" size={16} />
              </button>
            </div>
            {panelBody}
          </aside>
        ) : null}
        {showPanel && !panelOver ? (
          <PaneResizer
            kind="panel"
            label="Panel Width"
            width={panelWidth}
            edge="start"
            room={() => {
              const main = columnsRef.current?.closest<HTMLElement>('.note-main');
              const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
              // As wide as leaves the note its room beside it, so a drag never moves it over the text.
              return main ? main.offsetWidth / rem - NOTE_MIN_REM : PANE_LIMITS.panel.max;
            }}
            preview={(rem) =>
              columnsRef.current?.style.setProperty('--pm-panel-width', `${rem}rem`)
            }
            commit={setPanelWidth}
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
              const selected = showPanel && panelTab === entry.tab;
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
                  tabIndex={(showPanel ? panelTab === entry.tab : index === 0) ? 0 : -1}
                  data-tab={entry.tab}
                  data-command={entry.command}
                  data-tip={withKeys(selected ? `Close ${entry.label}` : entry.label, keys)}
                  data-testid={`note-tab-${entry.tab}`}
                  onClick={() => togglePanel(entry.tab)}
                >
                  <Icon name={entry.icon} size={18} />
                  {entry.tab === 'comments' && openThreads > 0 ? (
                    <span
                      className="note-tab-count"
                      aria-hidden="true"
                      data-testid="comments-count"
                    >
                      {openThreads}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </aside>
      </div>
      {phone ? null : (
        <StatusBar noteId={id} note={shownNote} replica={replica} folder={trail} stats={stats} />
      )}
      {phone && ready && !unsupported && !showSource ? <PhoneFormatBar /> : null}
    </article>
  );
}
