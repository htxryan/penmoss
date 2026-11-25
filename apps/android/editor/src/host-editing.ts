/**
 * The editor host's editing (PEN-186, split from `host.ts`): the native formatting bar and its
 * state, links and symbols, Copy as and paste as plain text, the Markdown source, the + sheet and
 * the Block menu, Delete block's Undo and the toggles kept per note.
 */
import {
  activeSymbols,
  availableBlockItems,
  canHaveSymbols,
  canTurnInto,
  closeSymbolPicker,
  EDITOR_COMMANDS,
  filterBlockItems,
  hasPendingUpdates,
  latestUndoStep,
  indentCode,
  moveSelectedBlock,
  selectedTopLevelBlock,
  LINK_REFUSED,
  normaliseHref,
  pastePlainText,
  symbolPickerOpen,
  toggleSymbolIn,
  TURN_INTO_ITEMS,
  turnInto,
  type FoldState,
  type NativeClipboardPayload,
} from '@penmoss/editor';
import { noteFields } from '@penmoss/model/note-fields';
import type { LinkResolver } from '@penmoss/core';
import type { Editor } from '@tiptap/core';
import { redoCommand, undoCommand } from '@y/prosemirror';
import {
  BRIDGE_VERSION,
  MAX_FOLD_KEY,
  MAX_FOLDS,
  type BlockAction,
  type BlockEntry,
  type BlockPurpose,
  type CopyFormat,
  type CopyScope,
  type EditorState,
  type FormatCommand,
} from './protocol';
import {
  ACTIVE_CHECKS,
  BLOCK_COMMANDS,
  BLOCK_NAMES,
  blockEntry,
  type Captured,
  EDITED_SINCE,
  NOTHING_SELECTED,
  type OpenNote,
  type SelectionBookmark,
  SHARED_COMMANDS,
  SOURCE_DELAY_MS,
  SOURCE_PASTE,
  WAIT_FOR_SYNC,
} from './host-support';
import { HostServices } from './host-services';

export abstract class HostEditing extends HostServices {
  protected editableEditor(noteId: string): Editor | null {
    const editor = this.current?.noteId === noteId ? this.current.collab?.editor : null;
    return editor && !editor.isDestroyed && editor.isEditable ? editor : null;
  }

  /** A button of the native formatting bar (A301). */
  protected format(command: FormatCommand, href: string | undefined): void {
    const open = this.current;
    const editor = open ? this.editableEditor(open.noteId) : null;
    if (!editor) return;
    const shared = SHARED_COMMANDS[command];
    if (shared) {
      EDITOR_COMMANDS.find((each) => each.id === shared)?.run({ editor });
    } else if ((command === 'indent' || command === 'outdent') && editor.isActive('codeBlock')) {
      // In code, Tab and Shift+Tab: the soft keyboard has neither (T40 P8, ED7).
      editor.commands.focus();
      indentCode(command === 'indent' ? 'in' : 'out')(editor.state, editor.view.dispatch);
    } else if (command === 'nextCell' || command === 'previousCell') {
      // Tab and Shift+Tab between cells (T40 P8, ED6); Next cell in the last cell adds a row.
      const chain = editor.chain().focus();
      if (command === 'previousCell') chain.goToPreviousCell().run();
      else if (!editor.can().goToNextCell()) chain.addRowAfter().goToNextCell().run();
      else chain.goToNextCell().run();
    } else if (command === 'addRow') {
      editor.chain().focus().addRowAfter().run();
    } else if (command === 'addColumn') {
      editor.chain().focus().addColumnAfter().run();
    } else if (command === 'indent' || command === 'outdent') {
      const chain = () => editor.chain().focus();
      const ok =
        command === 'indent'
          ? chain().sinkListItem('listItem').run() || chain().sinkListItem('taskItem').run()
          : chain().liftListItem('listItem').run() || chain().liftListItem('taskItem').run();
      if (!ok) editor.commands.focus();
    } else if (command === 'link') {
      this.setLink(editor, href ?? '');
    }
    editor.commands.scrollIntoView();
    this.scheduleState();
  }

  /** Links the selection (or the link the caret is in) to `raw`; empty removes the link. */
  protected setLink(editor: Editor, raw: string): void {
    const chain = editor.chain().focus().extendMarkRange('link');
    if (!raw.trim()) {
      chain.unsetLink().run();
      return;
    }
    const href = normaliseHref(raw);
    if (!href) {
      this.notice(this.current?.noteId ?? null, LINK_REFUSED);
      return;
    }
    const { empty } = editor.state.selection;
    if (empty && !editor.isActive('link')) {
      // Nothing selected: the address itself becomes the linked text.
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'text',
          text: raw.trim(),
          marks: [{ type: 'link', attrs: { href } }],
        })
        .unsetMark('link')
        .run();
      return;
    }
    chain.setLink({ href }).run();
  }

  /** The bar's symbol sheet (T44, A747): one toggle on the selection's lines, its own undo step. */
  protected toggleSymbol(noteId: string, index: number): void {
    const editor = this.editableEditor(noteId);
    if (!editor) return;
    toggleSymbolIn(editor.view, index);
    editor.commands.focus();
    editor.commands.scrollIntoView();
    this.scheduleState();
  }

  /** Back while a menu is open closes the menu, as Escape does (A302). */
  protected dismiss(): void {
    const editor = this.current?.collab?.editor;
    if (editor && closeSymbolPicker(editor)) {
      this.scheduleState();
      return;
    }
    if (!editor || !this.menuOpen()) return;
    editor.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
    this.scheduleState();
  }

  protected menuOpen(): boolean {
    const editor = this.current?.collab?.editor;
    if (editor && !editor.isDestroyed && symbolPickerOpen(editor)) return true;
    return this.elements.root.ownerDocument.querySelector('.pm-slash-menu') !== null;
  }

  protected scheduleState(): void {
    if (this.stateTimer !== null) return;
    // After the transaction, once the menus' views have updated.
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.sendState();
    }, 0);
  }

  /** What the formatting bar shows, sent when it changed (A301). */
  protected sendState(): void {
    const open = this.current;
    const editor = open?.collab?.editor;
    if (!open || !editor || editor.isDestroyed) return;
    const { state } = editor;
    const inCode = editor.isActive('codeBlock');
    const can = (run: () => boolean) => {
      try {
        return editor.isEditable && run();
      } catch {
        return false;
      }
    };
    const current: EditorState = {
      active: ACTIVE_CHECKS.filter(([, name, attrs]) => editor.isActive(name, attrs)).map(
        ([command]) => command,
      ),
      canUndo: can(() => undoCommand(state)),
      canRedo: can(() => redoCommand(state)),
      canIndent: can(
        () =>
          inCode || editor.can().sinkListItem('listItem') || editor.can().sinkListItem('taskItem'),
      ),
      canOutdent: can(
        () =>
          (inCode && indentCode('out')(state)) ||
          editor.can().liftListItem('listItem') ||
          editor.can().liftListItem('taskItem'),
      ),
      href: editor.isActive('link')
        ? ((editor.getAttributes('link')['href'] as string | undefined) ?? null)
        : null,
      menu: this.menuOpen(),
      inTable: editor.isActive('table'),
      inCode,
      canMoveUp: can(() => moveSelectedBlock(-1)(state)),
      canMoveDown: can(() => moveSelectedBlock(1)(state)),
      canTurnInto: can(() => canTurnInto(editor)),
      inTitle: this.elements.root.ownerDocument.activeElement === this.elements.title,
      symbols: activeSymbols(state),
      canSymbol: can(() => canHaveSymbols(state)),
    };
    const text = JSON.stringify(current);
    if (text === this.lastState) return;
    this.lastState = text;
    this.post({ v: BRIDGE_VERSION, type: 'state', noteId: open.noteId, ...current });
  }

  /**
   * Copy as Markdown or rich text (T40 P8, ED9): the editor's own commands,
   * so the payload is exactly the web's (`clipboardPayload`), handed to the
   * app through the native clipboard writer. A read-only note copies too.
   */
  protected copy(noteId: string, format: CopyFormat, scope: CopyScope): void {
    const editor = this.current?.noteId === noteId ? this.current.collab?.editor : null;
    const captured = this.take(noteId);
    if (!editor || editor.isDestroyed) {
      this.notice(noteId, 'This note cannot be copied here');
      return;
    }
    if (scope === 'note') {
      editor.commands.copyNoteAs(format);
      return;
    }
    // The selection the menu was opened on: a field's or the source's text as it is.
    if (captured && captured.kind !== 'body') {
      const text =
        captured.kind === 'source'
          ? captured.text
          : captured.field.value.slice(captured.start, captured.end);
      if (!text) this.notice(noteId, NOTHING_SELECTED);
      else this.post({ v: BRIDGE_VERSION, type: 'clipboard', noteId, format: 'text', text });
      return;
    }
    // The body's, put back if the WebView cleared it, and never the whole note instead.
    const selection = captured ? this.restore(editor, captured.bookmark) : editor.state.selection;
    if (!selection || selection.empty) {
      this.notice(noteId, NOTHING_SELECTED);
      return;
    }
    if (format === 'markdown') editor.commands.copyAsMarkdown();
    else editor.commands.copyAsRichText();
  }

  /**
   * Keeps what is selected now and where (B2): the selection menu has opened,
   * and the WebView clears the selection as it closes, before the menu's
   * message arrives. The body's is a bookmark, mapped through edits meanwhile.
   */
  protected capture(noteId: string): void {
    const open = this.current;
    if (!open || open.noteId !== noteId) return;
    const doc = this.elements.root.ownerDocument;
    const active = doc.activeElement;
    const editor = open.collab?.editor;
    let at: Captured | null = null;
    if (open.sourceOff) {
      at = { kind: 'source', text: doc.getSelection()?.toString() ?? '' };
    } else if (
      (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
      (active === this.elements.title || this.elements.body.contains(active))
    ) {
      at = {
        kind: 'field',
        field: active,
        start: active.selectionStart ?? active.value.length,
        end: active.selectionEnd ?? active.value.length,
      };
    } else if (editor && !editor.isDestroyed) {
      at = { kind: 'body', bookmark: editor.state.selection.getBookmark() };
    }
    this.captured = at ? { noteId, at } : null;
  }

  /** The capture for this note, used once. */
  protected take(noteId: string): Captured | null {
    const captured = this.captured?.noteId === noteId ? this.captured.at : null;
    this.captured = null;
    return captured;
  }

  /** Puts a captured body selection back (mapped through edits since), or null if it no longer fits. */
  protected restore(editor: Editor, bookmark: SelectionBookmark) {
    try {
      const selection = bookmark.resolve(editor.state.doc);
      if (!selection.eq(editor.state.selection)) {
        editor.view.dispatch(editor.state.tr.setSelection(selection));
      }
      return selection;
    } catch {
      return null;
    }
  }

  /**
   * Paste and match style (ED11) where the menu was opened (B2): into the
   * title or a callout's title as typed text, over the body's selection as
   * ⌘⇧V pastes, and never into the source view.
   */
  protected insertPlain(noteId: string, text: string): void {
    const captured = this.take(noteId);
    const open = this.current?.noteId === noteId ? this.current : null;
    if (open?.sourceOff || captured?.kind === 'source') {
      this.notice(noteId, SOURCE_PASTE);
      return;
    }
    if (captured?.kind === 'field') {
      const { field, start, end } = captured;
      if (!field.isConnected || field.readOnly || field.disabled) {
        this.notice(noteId, 'This note cannot be changed here');
        return;
      }
      field.focus();
      field.setRangeText(text, start, end, 'end');
      // As typing does: the title's binding stores it on input, a callout's title on change.
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    const editor = this.editableEditor(noteId);
    if (!editor) {
      this.notice(noteId, 'This note cannot be changed here');
      return;
    }
    if (captured) this.restore(editor, captured.bookmark);
    pastePlainText(editor.view, text);
    editor.commands.focus(undefined, { scrollIntoView: true });
    this.scheduleState();
  }

  /** A clipboard write from the editor (a copy, a code block's Copy): the app writes it. */
  protected toClipboard(open: OpenNote, payload: NativeClipboardPayload): boolean {
    if (this.current !== open) return false;
    const format =
      payload.html !== undefined ? 'rich' : payload.markdown !== undefined ? 'markdown' : 'text';
    this.post({
      v: BRIDGE_VERSION,
      type: 'clipboard',
      noteId: open.noteId,
      format,
      text: payload.text,
      ...(payload.html !== undefined ? { html: payload.html } : {}),
    });
    return true;
  }

  /**
   * The note's stored markdown, read-only, in place of the editor (T40 P8,
   * ED17), as the web's source view shows it: the frontmatter, then the body
   * by the core codec, following edits from elsewhere. `on: false` shows the
   * note again.
   */
  protected showSource(noteId: string, on: boolean): void {
    const open = this.current;
    if (!open || open.noteId !== noteId) return;
    if (!on) {
      open.sourceOff?.();
      this.post({ v: BRIDGE_VERSION, type: 'source', noteId, on: false });
      return;
    }
    const editor = open.collab?.editor;
    if (open.sourceOff || !editor) {
      if (!editor) this.notice(noteId, 'This note has no Markdown source to show here');
      // What shows, so the app's menu and bar follow it (S6).
      this.post({ v: BRIDGE_VERSION, type: 'source', noteId, on: open.sourceOff !== null });
      return;
    }
    const { root, body } = this.elements;
    const page = root.ownerDocument;
    const frame = page.createElement('div');
    frame.className = 'doc note-source';
    const pre = page.createElement('pre');
    pre.setAttribute('aria-label', 'Markdown source');
    pre.tabIndex = 0;
    frame.append(pre);
    body.after(frame);
    body.hidden = true;
    editor.commands.blur();
    // The codec loads on first use, as for daily notes (it is not in the first paint).
    let codec: typeof import('@penmoss/core') | null = null;
    const render = () => {
      timer = null;
      if (!codec) return;
      try {
        const frontmatter = codec.createFrontmatter(noteFields(noteId, open.replica));
        const doc = codec.schema.nodeFromJSON(editor.getJSON());
        pre.textContent = codec.serializeMarkdown(
          { frontmatter, doc },
          { links: this.linkResolver() },
        );
      } catch (error) {
        pre.textContent = `Could not render markdown: ${String(error)}`;
      }
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      timer ??= setTimeout(render, SOURCE_DELAY_MS);
    };
    const off = open.replica.onUpdate(schedule);
    const stop = () => {
      open.sourceOff = null;
      if (timer !== null) clearTimeout(timer);
      off();
      frame.remove();
      body.hidden = false;
    };
    open.sourceOff = stop;
    pre.textContent = 'Loading…';
    import('@penmoss/core').then(
      (loaded) => {
        codec = loaded;
        if (open.sourceOff === stop) render();
      },
      (error: unknown) => {
        if (open.sourceOff === stop)
          pre.textContent = `Could not render markdown: ${String(error)}`;
      },
    );
    this.post({ v: BRIDGE_VERSION, type: 'source', noteId, on: true });
  }

  /** How the codec writes wikilinks in the source view: each target's current title (T16). */
  protected linkResolver(): LinkResolver {
    const title = (noteId: string) => this.notesById.get(noteId)?.title.trim() || null;
    return {
      resolve: (target) => {
        const wanted = target.trim().toLowerCase();
        return wanted
          ? (this.notes.find((entry) => entry.title.trim().toLowerCase() === wanted)?.id ?? null)
          : null;
      },
      linkText: title,
      title,
    };
  }

  /**
   * The + sheet's entries (the slash menu's, for the caret's place and this
   * note's services) or Turn into's, filtered and ranked as the slash menu
   * filters (T40 P8, ED4, ED5). Empty when the note cannot be changed here.
   */
  protected blocks(noteId: string, purpose: BlockPurpose, query: string): void {
    const open = this.current;
    const editor = open && !open.sourceOff ? this.editableEditor(noteId) : null;
    let items: BlockEntry[] = [];
    if (open && editor) {
      if (purpose === 'insert') {
        items = filterBlockItems(
          availableBlockItems(editor, open.images, open.links, open.files),
          query,
        ).map(blockEntry);
      } else if (canTurnInto(editor)) {
        items = filterBlockItems(TURN_INTO_ITEMS, query).map((item) => ({
          ...blockEntry(item),
          active: item.isActive?.(editor) ?? false,
        }));
      }
    }
    this.post({ v: BRIDGE_VERSION, type: 'blocks', noteId, purpose, query, items });
  }

  /** Inserts a catalogue block at the caret, as its slash-menu item and `Insert:` command do. */
  protected insertBlock(noteId: string, id: string): void {
    const open = this.current;
    const editor = open && !open.sourceOff ? this.editableEditor(noteId) : null;
    if (!open || !editor) return;
    const item = availableBlockItems(editor, open.images, open.links, open.files).find(
      (each) => each.id === id,
    );
    if (!item) {
      this.notice(noteId, 'That block cannot go here');
      return;
    }
    const { from } = editor.state.selection;
    item.insert({
      editor,
      range: { from, to: from },
      images: open.images,
      links: open.links,
      files: open.files,
    });
    editor.commands.scrollIntoView();
    this.scheduleState();
  }

  /** Turns the selected blocks into a kind, as the web's selection toolbar does (ED5). */
  protected turnInto(noteId: string, id: string): void {
    const open = this.current;
    const editor = open && !open.sourceOff ? this.editableEditor(noteId) : null;
    const item = TURN_INTO_ITEMS.find((each) => each.id === id);
    if (!editor || !item) return;
    if (!turnInto(editor, item)) this.notice(noteId, 'That block cannot be turned into this');
    editor.commands.scrollIntoView();
    this.scheduleState();
  }

  /** One of the Block menu's actions, by the shared editor command of its name (ED5). */
  protected blockAction(noteId: string, action: BlockAction): void {
    const open = this.current;
    const editor = open && !open.sourceOff ? this.editableEditor(noteId) : null;
    if (!editor) return;
    if (!editor.view.hasFocus()) editor.view.focus();
    // Refused while another device's update waits for what it builds on: say so (S4).
    if (hasPendingUpdates(editor.state)) {
      this.notice(noteId, WAIT_FOR_SYNC);
      return;
    }
    const at = selectedTopLevelBlock(editor.state);
    const node = at === null ? null : editor.state.doc.nodeAt(at);
    const before = editor.state.doc;
    EDITOR_COMMANDS.find((each) => each.id === BLOCK_COMMANDS[action])?.run({ editor });
    if (action === 'delete' && node && editor.state.doc !== before) {
      // A tap removes a whole list or table: the app offers Undo, naming what went (S4).
      const kind = node.type.name;
      const label =
        kind === 'callout' && node.attrs['foldable'] ? 'Toggle' : (BLOCK_NAMES[kind] ?? 'Block');
      const step = latestUndoStep(editor.state);
      this.deletion = step ? { noteId, step } : null;
      this.post({ v: BRIDGE_VERSION, type: 'blockDeleted', noteId, label });
    }
    editor.commands.scrollIntoView();
    this.scheduleState();
  }

  /**
   * The snackbar's Undo after Delete block: undoes that delete while it is
   * still this editor's newest undo step; after typing (or another undo), it
   * says so instead of undoing something else.
   */
  protected undoDelete(noteId: string): void {
    const deletion = this.deletion?.noteId === noteId ? this.deletion : null;
    this.deletion = null;
    const open = this.current;
    const editor = open && !open.sourceOff ? this.editableEditor(noteId) : null;
    if (!editor || !deletion) return;
    if (latestUndoStep(editor.state) !== deletion.step) {
      this.notice(noteId, EDITED_SINCE);
      return;
    }
    EDITOR_COMMANDS.find((each) => each.id === 'editor.undo')?.run({ editor });
    editor.commands.scrollIntoView();
    this.scheduleState();
  }

  /**
   * Where the note's toggles remember being open (T40 P8, ED8): what the app
   * sent before the note opened, and each change sent back for the app to
   * keep in Room. The same rules as the web's `localFoldState`: the newest
   * MAX_FOLDS toggles per note are kept.
   */
  protected foldState(noteId: string): FoldState {
    let folds: Record<string, boolean> =
      this.folds?.noteId === noteId ? { ...this.folds.folds } : {};
    const unkept: Record<string, boolean> = {};
    return {
      isOpen: (key) => (key.length > MAX_FOLD_KEY ? unkept[key] : folds[key]),
      setOpen: (key, open) => {
        // A key longer than the app keeps (a toggle with a very long title) is kept while the
        // note is open only: sending it would have the app refuse every toggle of the note.
        if (key.length > MAX_FOLD_KEY) {
          unkept[key] = open;
          return;
        }
        const merged = { ...folds };
        delete merged[key];
        const entries = Object.entries(merged).slice(-(MAX_FOLDS - 1));
        folds = { ...Object.fromEntries(entries), [key]: open };
        this.folds = { noteId, folds: { ...folds } };
        this.post({ v: BRIDGE_VERSION, type: 'folds', noteId, folds: { ...folds } });
      },
    };
  }
}
