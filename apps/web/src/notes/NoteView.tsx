import {
  ARROW_UP_INTO_TITLE,
  BACKSPACE_INTO_TITLE,
  COMMENT_ADD_EVENT,
  COMMENT_OPEN_EVENT,
  noteLayoutChanged,
  revealThread,
  selectionAnchor,
  showCommentThreads,
  showPendingComment,
  type BackspaceIntoTitleDetail,
} from '@penmoss/editor';
import { findHeading } from '@penmoss/core/line-symbols';
import {
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
import { useCommand, useKeys } from '../commands/hooks';
import { Kbd } from '../commands/Kbd';
import { navigate } from '../router';
import { PinnedMetadata, StatusBar } from './NoteInfo';
import { useNoteMetadataSettings } from './metadata-state';
import { CommentPopover, type FloatingComment } from './CommentPopover';
import { floats, shownInNote, useGoneDeliveries, useThreads } from './comments';
import { COPIED_AGENT_REFERENCE, useCopyAgentReference } from './agent-reference';
import { showToast } from '../toasts/toasts';
import { NoteStats } from './note-stats';
import { useNoteList, useNotes } from './hooks';
import { useDirectory } from './directory-hooks';
import { markdownDoc, noteMarkdown } from './markdown';
import { MarkdownSource } from './MarkdownSource';
import { rememberOpened } from './recent';
import { pastedTitle } from '@penmoss/model/title';
import { caretOnLastLine, fitHeight, isLineBreak } from './title-field';
import { useNoteEditor } from './note-editor';
import { PeriodNav } from '../journal/PeriodNav';
import { WeekChangesLink } from '../time-machine/WeekChangesLink';
import { UnsupportedNote } from './UnsupportedNote';
import { AppBar } from '../shell/AppBar';
import { deviceStorage } from '../shell/device-pref';
import { useNarrowWindow } from '../shell/media';
import { TitleBarLead } from '../shell/title-lead';
import { NoteActions, type NotePanelTab } from './NoteActions';
import { NoteTopBar } from './NoteTopBar';
import { NoteSidePanel } from './NoteSidePanel';
import { panelTabPref } from './panel-tabs';
import { useNotePanelInTab } from './panel-in-tab';
import { usePaneWidth } from './panel-mode';
import { usePaneSize } from '../shell/pane-widths';
import { useQuickAccess } from './quick-access';
import { MAX_QUICK_ACCESS } from '@penmoss/core/quick-access';
import { useNoteFolders } from '../workspace/tree';
import { useSource, useSourcesState } from '../sources/hooks';
import { PhoneFormatBar } from './PhoneFormatBar';
import { useShowTag } from '../search/show-tag';
import { useFullWidth } from './width';
import { trashedNote } from '../trash/trashed';
import { useStripEnd } from '../tabs/hooks';
import { useTabScroll } from '../tabs/page';
import { closeTabsOfTrashed } from '../tabs/trash';
import { openNoteWindow } from '../window/open';
import { symbolSource } from './symbols';
import { useWorkspace } from '../workspace/hooks';

/** "Copied as Markdown" after an explicit copy (T15), in the window's toast stack (PEN-63). */
function showCopied(text: string, ok: boolean): void {
  showToast({ text, tone: ok ? 'done' : 'error', testId: 'copy-status', ms: COPIED_MS });
}

/** How long a copy's toast shows. */
const COPIED_MS = 2500;

/** The whole note, copied from the actions menu or the palette (T15). */
type CopyFormat = 'markdown' | 'rich';

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
  // In a tab (PEN-140, A1500): its own panel and scroll position, seeded from this note's and
  // this device's memory the first time the note shows in it, and written back to both.
  const { tabPage, panelMode, setPanelMode, panelTab, setPanelTab } = useNotePanelInTab(
    id,
    startedWide ?? true,
  );
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
  /** The note's text, scrolled on its own: its place is kept by the tab. */
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Where the note's bar buttons go in the main window: the tab strip's end (A1505). */
  const stripEnd = useStripEnd();
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
  const showTag = useShowTag();
  // The person's line symbols (T44), one live source for every editor of this workspace.
  const workspace = useWorkspace();
  const symbols = useMemo(() => symbolSource(workspace), [workspace]);
  /** Quick Access (T51, A946): whether this note is pinned, and the ⋯ menu's Pin or Unpin. */
  const quickAccess = useQuickAccess();
  const pinned = quickAccess.pinned(id);
  const sourceKeys = useKeys('note.toggleSource');
  const [fullWidth] = useFullWidth();
  /** `note.addTag` asked for the tag field (in the Info panel, T41). */
  const [addingTag, setAddingTag] = useState(false);
  /** Tags pinned under the title (T62 item 4): Add a Tag works there, and the panel's is its own. */
  const tagsPinned = useNoteMetadataSettings().underTitle.includes('tags');
  const [panelAddingTag, setPanelAddingTag] = useState(false);
  /** Word and character counts, taken after typing pauses (T41, A505). */
  const stats = useMemo(() => new NoteStats(), []);
  const phone = useNarrowWindow();
  // The app bar's title on a phone: the note's title as the list has it.
  const title = useNoteList().find((entry) => entry.id === id)?.title ?? '';
  const trail = useNoteFolders(id);
  // A note at the top level: the phone's app bar names its notebook (T52).
  const noteSource = useSource();
  const topNotebook = noteSource?.name;
  // With two notebooks or more open, the breadcrumb starts with the note's (T64 item 5).
  const openSources = useSourcesState();
  const sourceCrumb = openSources.all.length > 1 && noteSource ? noteSource.name : null;
  /** Why a pasted or dropped file was not added; cleared after a while. */
  const [notice, setNotice] = useState<string | null>(null);
  const {
    titleRef,
    slotRef,
    editorRef,
    editor,
    ready,
    replica,
    shownNote,
    error,
    unsupported,
    enterBody,
    dontKeep,
  } = useNoteEditor({ id, links, symbols, onNotice: setNotice, onCopied: showCopied });
  const threads = useThreads(replica);
  useGoneDeliveries(replica, noteSource?.workspace ?? null);
  /** The read-only markdown source view (T11): null while the editor shows. */
  const [source, setSource] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  /**
   * Bumped when a command opened the panel (a key, the palette, a menu, a bar button): the tab it
   * shows then takes focus, so a screen reader names it (T51 review, A936).
   */
  const [tabFocus, setTabFocus] = useState(0);

  // A note created here takes focus in its title at once, before it has loaded,
  // so typing never lands on the New note button (and creates another note).
  useLayoutEffect(() => {
    if (notes.takeTitleFocus(id)) titleRef.current?.focus();
  }, [id, notes, titleRef]);

  // The recent-notes switcher (T20) orders notes by when this device last opened them.
  useEffect(() => rememberOpened(deviceStorage(), id, Date.now()), [id]);

  // The window (or tab) is named after the note, so Mission Control and the
  // Window menu can tell notes apart.
  useEffect(() => {
    document.title = `${title.trim() || 'Untitled'} – Penmoss`;
    return () => {
      document.title = 'Penmoss';
    };
  }, [title]);

  /** Opens the panel on a tab; set below, after the commands. */
  const openTabRef = useRef<(tab: NotePanelTab) => void>(() => undefined);
  /** Opens the panel on Comments. */
  const showComments = useCallback(() => openTabRef.current('comments'), []);

  // Comment threads (T48): the editor draws the open ones and picks out the active one; its
  // Comment (the toolbar, the command) and a click on a passage open a comment floating over the
  // note there (T52 item 5).
  useEffect(() => {
    const collab = editorRef.current;
    if (!ready || !collab) return;
    showCommentThreads(collab.editor, shownInNote(threads, activeThread), activeThread);
  }, [ready, threads, activeThread, editorRef]);
  // Another note in this view: no thread is picked out or floating, and no note comment is
  // being written.
  const [commentsFor, setCommentsFor] = useState(id);
  if (commentsFor !== id) {
    setCommentsFor(id);
    setActiveThread(null);
    setFloating(null);
    setNoteDraft(false);
  }
  // A new thread's passage is marked while its composer floats (T52), until it is sent or not.
  const pendingAnchor = floating?.kind === 'draft' ? floating.draft.anchor : null;
  useEffect(() => {
    const editor = editorRef.current?.editor;
    if (!ready || !editor || !pendingAnchor) return;
    showPendingComment(editor, pendingAnchor);
    // Gone once it is sent or cancelled, and from a kept editor when another note opens.
    return () => showPendingComment(editor, null);
  }, [ready, pendingAnchor, editorRef]);
  /** Closes the floating comment; `refocus`: the editor takes focus again (Escape, Cancel). */
  const floatingRef = useRef(floating);
  useLayoutEffect(() => {
    floatingRef.current = floating;
  });
  const closeFloating = useCallback(
    (refocus: boolean) => {
      // A thread closed is no longer the one picked out in the note.
      if (floatingRef.current?.kind === 'thread') setActiveThread(null);
      setFloating(null);
      if (refocus) editorRef.current?.editor.view.focus();
    },
    [editorRef],
  );
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
  }, [showComments, editorRef, slotRef]);

  // The counts follow the note's editor while it shows (T41).
  useEffect(() => {
    const collab = editorRef.current;
    if (!ready || !collab) return;
    return stats.attach(collab.editor);
  }, [ready, stats, editorRef]);

  // The tab's place in the note, unless a heading was asked for (PEN-140, A1500).
  useTabScroll(tabPage, scrollRef, ready, heading !== null);

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
  }, [ready, heading, editorRef]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const copyNote = (format: CopyFormat) => {
    editorRef.current?.editor.commands.copyNoteAs(format);
  };

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
  }, [enterBody, titleRef]);

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
  }, [slotRef, titleRef]);

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
  }, [showSource, ready, id, links, editorRef]);

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
    dontKeep();
    const done = notes.deleteNote(id);
    if (onDeleted) onDeleted();
    // Its tabs close (PEN-140, A1501); with none (no tabs here), the app goes home.
    else if (!closeTabsOfTrashed([id])) navigate('/');
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
    void copyAgentReference(id).then((done) =>
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
  const openTab = (tab: NotePanelTab) => {
    setPanelTab(tab);
    panelTabPref.write(tab);
    if (!showPanel) setPanelMode('open');
  };
  useLayoutEffect(() => {
    openTabRef.current = openTab;
  });
  /** A tab's icon or command: it opens its tab, or closes the panel while that tab shows. */
  const togglePanel = (tab: NotePanelTab) => {
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
  /** A thread picked in the Comments tab; one with a passage floats there (T52 item 5). */
  const onActiveThread = (thread: string | null, reveal: boolean) => {
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
  };
  return (
    <article
      ref={articleRef}
      className="note"
      data-testid="note-view"
      data-ready={ready ? 'true' : 'false'}
      data-width={fullWidth ? 'full' : undefined}
    >
      <AppBar
        title={title}
        path={trail}
        {...(topNotebook !== undefined ? { notebook: topNotebook } : {})}
      >
        {/* Below 700 px the top bar hides: the app bar carries its actions (a note window's pin). */}
        {actions}
        <NoteActions source={showSource} tab={shownTab} pinned={pinned} />
      </AppBar>
      <NoteTopBar
        lead={lead}
        nav={nav}
        sourceCrumb={sourceCrumb}
        trail={trail}
        title={title}
        actions={actions}
        showSource={showSource}
        shownTab={shownTab}
        pinned={pinned}
        fullWidth={fullWidth}
      />
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
        <div ref={scrollRef} className="note-scroll" data-testid="note-scroll">
          {showSource ? (
            <div className="doc note-source">
              {/* The body is edited here; the frontmatter is the note's fields (A1133). */}
              <p className="note-source-hint" data-testid="note-markdown-hint">
                {editor?.editor.isEditable === false
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
                editable={editor?.editor.isEditable !== false}
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
                // ⌘-click (Ctrl-click) on an inline #tag shows the notes with it in Search (T18;
                // finding 9 of Ryan's review of #192).
                if (!(event.metaKey || event.ctrlKey)) return;
                const tag = (event.target as HTMLElement).closest<HTMLElement>('.pm-tag')?.dataset[
                  'tag'
                ];
                if (tag) showTag(tag);
              }}
            />
            {/* T52 item 5: a new thread, or one opened, floating over the note at its passage. */}
            {floating && replica && ready && !showSource ? (
              <CommentPopover
                key={
                  floating.kind === 'thread' ? floating.id : JSON.stringify(floating.draft.anchor)
                }
                editor={editor?.editor ?? null}
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
        <NoteSidePanel
          id={id}
          tab={panelTab}
          open={showPanel}
          over={panelOver}
          width={panelWidth}
          onWidth={setPanelWidth}
          columnsRef={columnsRef}
          tabFocus={tabFocus}
          onOpenTab={openTab}
          onToggleTab={togglePanel}
          onClose={() => setPanelMode('closed')}
          replica={replica}
          folder={trail}
          stats={stats}
          addingTag={tagsPinned ? panelAddingTag : addingTag}
          onAddingTag={tagsPinned ? setPanelAddingTag : setAddingTag}
          threads={threads}
          activeThread={activeThread}
          onActiveThread={onActiveThread}
          noteDraft={noteDraft}
          onNoteDraftDone={() => setNoteDraft(false)}
          floatingThread={floating?.kind === 'thread' ? floating.id : null}
        />
      </div>
      {phone ? null : (
        <StatusBar
          noteId={id}
          note={shownNote}
          replica={replica}
          folder={trail}
          stats={stats}
          // The folder path, where the title row showed it (A1505): a click reveals the note.
          place={
            stripEnd && noteSource
              ? { source: sourceCrumb, folders: trail, notebook: noteSource.name }
              : null
          }
        />
      )}
      {phone && ready && !unsupported && !showSource ? <PhoneFormatBar /> : null}
    </article>
  );
}
