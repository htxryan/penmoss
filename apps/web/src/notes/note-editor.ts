/**
 * A note's editor in its view (T31, A1179): the note's replica opened (or its editor taken from
 * the kept-editors shelf, shown a moment ago), the TipTap body made in its own element and moved
 * into the view's slot, the title field bound to the replica, and the editor's commands pointed
 * at it. Enter pressed in the title before the body opens waits for it. A note holding node types
 * a later version wrote shows read-only, as text (A158).
 */
import {
  createCollabEditor,
  noteExtensions,
  UnsupportedContentError,
  type CollabEditor,
  type FileServices,
  type SymbolSource,
} from '@penmoss/editor';
import { formatCombo } from '@penmoss/editor/keys';
import { noteFields } from '@penmoss/editor/note-fields';
import { bindTitleField } from '@penmoss/editor/title';
import type { Yjs14Replica } from '@penmoss/sync-client/yjs14';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useCommands } from '../commands/hooks';
import { drawingServices } from '../drawing/drawings';
import { deviceStorage } from '../shell/device-pref';
import { assertFileSize } from '../store/attachments';
import type { NoteDirectory } from './directory';
import { useDirectory } from './directory-hooks';
import { localFoldState } from './folds';
import { useNotes } from './hooks';
import {
  dropEditor,
  keepEditor,
  takeEditor,
  viewMounted,
  type EditorHost,
  type NoteEditor,
} from './kept-editors';
import type { OpenNote } from './service';
import {
  fitHeight,
  growingTitle,
  queueEnter,
  typedAfterEnter,
  type QueuedEnter,
} from './title-field';

/** A note's editor as its view shows it. */
export interface NoteEditorView {
  /** The title field: bound to the note's replica once it opens. */
  readonly titleRef: RefObject<HTMLTextAreaElement | null>;
  /** The note body: the note's editor brings its own element into it (kept-editors.ts). */
  readonly slotRef: RefObject<HTMLDivElement | null>;
  /** The editor showing; null before it opens, and for a note shown read-only. */
  readonly editorRef: RefObject<CollabEditor | null>;
  /** The same editor, as state: what the view draws from it follows it. */
  readonly editor: CollabEditor | null;
  /** The note shows: in its editor, or read-only. */
  readonly ready: boolean;
  /** The open note's replica once loaded (its tags are edited there, T18). */
  readonly replica: Yjs14Replica | null;
  /** The open note (its sync state, for the status bar) once shown. */
  readonly shownNote: OpenNote | null;
  /** Why the note could not open. */
  readonly error: string | null;
  /**
   * The note holds node types a later version of Penmoss wrote (A158): it shows read-only, as
   * text, and stays as it is in the notebook for that version.
   */
  readonly unsupported: { readonly types: readonly string[]; readonly text: string } | null;
  /** Enter in the title: to the start of the body, or held until the body opens (A1179). */
  readonly enterBody: () => void;
  /** The editor is not kept for a switch back when the view closes (the note is in Trash). */
  readonly dontKeep: () => void;
}

export function useNoteEditor({
  id,
  links,
  symbols,
  onNotice,
  onCopied,
}: {
  id: string;
  /** Wikilinks (T16): titles and completion from the registry, for this note. */
  links: NoteDirectory;
  /** The person's line symbols (T44). */
  symbols: SymbolSource;
  /** Why a pasted or dropped file was not added. Never changes. */
  onNotice: (message: string | null) => void;
  /** What an explicit copy did (T15). Never changes. */
  onCopied: (text: string, ok: boolean) => void;
}): NoteEditorView {
  const notes = useNotes();
  const directory = useDirectory();
  const commands = useCommands();
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<CollabEditor | null>(null);
  /** Enter pressed in the title before the body opened (A1179): taken when it opens. */
  const queuedEnterRef = useRef<QueuedEnter | null>(null);
  const shownRef = useRef<NoteEditor | null>(null);
  const [ready, setReady] = useState(false);
  const [editor, setEditor] = useState<CollabEditor | null>(null);
  const [replica, setReplica] = useState<Yjs14Replica | null>(null);
  const [shownNote, setShownNote] = useState<OpenNote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState<{
    readonly types: readonly string[];
    readonly text: string;
  } | null>(null);
  /** Bumped when the note must open again (a restore, a later version's content), to reopen it. */
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const host: EditorHost = {
      notice: onNotice,
      copied: onCopied,
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
      setEditor(collab);
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
        setEditor(null);
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
        // Drawings (PEN-28): Excalidraw, loaded the first time one opens; its files are
        // attachments like the rest.
        const drawings = drawingServices(notes.attachments, {
          onError: (message) => created?.host?.notice(message),
          suspendShortcuts: () => commands.suspend(),
          commands,
        });
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
              drawings,
              // A right-click with nothing selected opens the block menu there (Mac and web).
              blockContextMenu: true,
              foldState: localFoldState(id, deviceStorage()),
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
      setEditor(null);
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
  }, [id, notes, commands, generation, links, directory, symbols, onNotice, onCopied]);

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

  const dontKeep = useCallback(() => {
    if (shownRef.current) shownRef.current.stale = true;
  }, []);

  return {
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
  };
}
