/**
 * The editor page's side of the Android bridge (T32, A282; T33): it owns the
 * open note's Yjs document, built from the update bytes the app stores, and
 * hands every local change back to the app as bytes. It never touches the
 * network or the device token; the app syncs through `/sync/batch` and passes
 * what the server sent with `remote`.
 *
 * T33 adds what long-form writing on the phone needs: the native formatting
 * bar's commands and the state it shows (A301), Back closing the editor's own
 * menus first (A302), wikilink titles and `[[` completion from the phone's
 * note list (A303), pictures pasted, picked or shown through the app (A304),
 * the chosen theme (A305), conflict copies built here for the app (A306), and
 * the IME and scrolling care the T2 spike found (A307).
 *
 * T38 adds New note made here, offline included (`create`), and the note's
 * frontmatter tags, read and set here as the web's tag chips do (`tags`,
 * `setTag`): tags live in the note's document, which only the page reads.
 *
 * T40 P8 adds the editor's parity with the web: Copy as Markdown and rich
 * text through the app's clipboard (`copy`, `clipboard`), paste and match
 * style (`insertPlain`), the Markdown source (`source`), the + sheet and the
 * Block menu (`blocks`, `insert`, `turnInto`, `block`), the table and code
 * buttons, toggles remembered per note (`folds`) and the counts (`counts`).
 * Files through the app (`file`, `fileStored`, `insertFiles`, `fileInfo`,
 * `openFile`) and pictures from web addresses on the page's own origin
 * (`webPictures`, `/remote`), ED12 and ED13.
 *
 * T40 P7 adds `[[Title#` headings and live embeds from other notes' stored
 * updates (`noteContent`, `watchNote`, `noteChanged`; `linked.ts`), links
 * followed to a heading (`openNote` with `heading`, `showHeading`), and the
 * note's details for the Info sheet (`noteInfo`).
 *
 * T48 adds comment threads (`comments.ts`, `comments-protocol.ts`): the note's threads for the
 * Comments sheet, drawn in the note, and written here as the sheet asks.
 */
import { openLightboxNow } from '@penmoss/editor';
import {
  INTERFACE_FONT_SETTING,
  NOTE_FONT_SETTING,
  NOTE_FONT_SIZE_SETTING,
} from '@penmoss/core/fonts';
import { BRIDGE_VERSION, type Compacted, type ToEditor } from './protocol';
import { compact } from './host-support';
import { HostNoteActions } from './host-note-actions';

export {
  EDIT_IDLE_MS,
  EDIT_MAX_WAIT_MS,
  TEXT_IDLE_MS,
  ATTACHMENT_URL_PREFIX,
  REMOTE_PICTURE_PATH,
  HOLD_MAX_MS,
  COUNT_DELAY_MS,
  SELECTION_COUNT_MS,
  SOURCE_DELAY_MS,
  INFO_EVERY_MS,
  HEADING_MARK_MS,
  INVALID_TAG,
  SOURCE_PASTE,
  NOTHING_SELECTED,
  EDITED_SINCE,
  WAIT_FOR_SYNC,
  type HostElements,
} from './host-support';

export class EditorHost extends HostNoteActions {
  handle(message: ToEditor): void {
    switch (message.type) {
      case 'open':
        this.open(message);
        return;
      case 'remote':
        this.remote(message.noteId, message.update);
        return;
      case 'flush':
        if (this.current?.noteId === message.noteId) this.flush();
        return;
      case 'close':
        if (this.current?.noteId === message.noteId) {
          // A drawing open over the note goes with it, as Cancel (PEN-189).
          this.drawings.finish('cancel');
          this.close();
        }
        // Said even when that note was not open, so the app never waits in vain.
        this.post({ v: BRIDGE_VERSION, type: 'closed', noteId: message.noteId });
        return;
      case 'compact': {
        // Merging needs no open document: Yjs merges the bytes as they are.
        let compacted: Compacted | null;
        try {
          compacted = compact(message.updates);
        } catch (error) {
          this.fail(message.noteId, `Stored edits could not be merged: ${String(error)}`);
          return;
        }
        if (compacted) {
          this.post({ v: BRIDGE_VERSION, type: 'compacted', noteId: message.noteId, compacted });
        }
        return;
      }
      case 'format':
        if (this.current?.noteId === message.noteId) this.format(message.command, message.href);
        return;
      case 'dismiss':
        if (this.current?.noteId === message.noteId) this.dismiss();
        return;
      case 'focus': {
        const editor = this.editableEditor(message.noteId);
        editor?.commands.focus(undefined, { scrollIntoView: true });
        return;
      }
      case 'focusTitle': {
        // Rename from a list (T40 P4, NT10): the caret goes in the title, as for a new note.
        if (this.current?.noteId !== message.noteId) return;
        const field = this.elements.title;
        if (!field.readOnly) field.focus();
        return;
      }
      case 'insertImages':
        this.insertImages(message.noteId, message.paths);
        return;
      case 'copyConflicts':
        this.copyConflicts(message.noteId, message.base, message.edits, message.into);
        return;
      case 'attachmentStored': {
        const waiting = this.storing.get(message.path);
        this.storing.delete(message.path);
        for (const done of waiting ?? []) done(message.ok);
        return;
      }
      case 'theme':
        this.applyTheme(message.theme, message.variant);
        return;
      case 'fonts':
        // The person's fonts over the theme's (T51, A944), as the web lays them.
        this.fonts = {
          [INTERFACE_FONT_SETTING]: message.interface,
          [NOTE_FONT_SETTING]: message.note,
          [NOTE_FONT_SIZE_SETTING]: message.noteSize,
        };
        this.applyAppearance();
        return;
      case 'preview':
        this.preview();
        return;
      case 'closeLightbox':
        // The phone's back gesture (T51, A948): the lightbox goes, the note stays.
        openLightboxNow()?.close();
        return;
      case 'drawing':
        // The note screen's drawing bar (PEN-189): Done (the back gesture too) or Cancel.
        this.drawings.finish(message.action);
        return;
      case 'drawingScene': {
        const waiting = this.scenes.get(message.path);
        this.scenes.delete(message.path);
        for (const done of waiting ?? []) done(message.text);
        return;
      }
      case 'ime':
        // Whether the keyboard is up (T40 P6 review S8): hiding it does not blur the note.
        this.imeVisible = message.visible;
        return;
      case 'underTitle':
        this.descriptionShown = message.description;
        this.showDescription();
        return;
      case 'width':
        // Full width lifts only the theme's cap, as on the web (A501); the gutters stay.
        if (message.full) this.elements.root.dataset['width'] = 'full';
        else delete this.elements.root.dataset['width'];
        return;
      case 'symbols':
        // A change in Settings → Symbols, here or synced: open notes redraw (A741).
        if (JSON.stringify(message.symbols) === JSON.stringify(this.symbols)) return;
        this.symbols = message.symbols;
        for (const listener of [...this.symbolListeners]) listener();
        this.scheduleState();
        return;
      case 'commentAuthor':
        // This phone's device actor, as the server names it: new comments are written as it.
        this.commentAuthor = { id: message.id, kind: 'device', label: message.label };
        return;
      case 'symbol':
        this.toggleSymbol(message.noteId, message.index);
        return;
      case 'directory':
        this.setDirectory(message.notes);
        return;
      case 'create':
        this.create(message.noteId);
        return;
      case 'createPeriodic':
        this.createPeriodic(message);
        return;
      case 'periodicNav':
        this.periodicNav(message.noteId);
        return;
      case 'keys':
        this.keys.set(message.bindings, message.app);
        return;
      case 'setDescription':
      case 'setAiDescription':
      case 'answerDescription':
        this.describe(message);
        break;
      case 'setTag':
        this.setTag(message.noteId, message.tag, message.on);
        return;
      case 'copy':
        this.copy(message.noteId, message.format, message.scope);
        return;
      case 'insertPlain':
        this.insertPlain(message.noteId, message.text);
        return;
      case 'captureSelection':
        this.capture(message.noteId);
        return;
      case 'undoDelete':
        this.undoDelete(message.noteId);
        return;
      case 'source':
        this.showSource(message.noteId, message.on);
        return;
      case 'blocks':
        this.blocks(message.noteId, message.purpose, message.query);
        return;
      case 'insert':
        this.insertBlock(message.noteId, message.item);
        return;
      case 'turnInto':
        this.turnInto(message.noteId, message.item);
        return;
      case 'block':
        this.blockAction(message.noteId, message.action);
        return;
      case 'folds':
        this.folds = { noteId: message.noteId, folds: { ...message.folds } };
        return;
      case 'fileStored': {
        const waiting = this.storing.get(message.path);
        this.storing.delete(message.path);
        for (const done of waiting ?? []) done(message.ok);
        return;
      }
      case 'insertFiles':
        this.insertFileEntries(message.noteId, message.files);
        return;
      case 'fileInfo': {
        const waiting = this.asking.get(message.path);
        this.asking.delete(message.path);
        for (const done of waiting ?? []) done(message.info);
        return;
      }
      case 'webPictures':
        this.webPictures = { noteId: message.noteId, mode: message.mode };
        return;
      case 'noteContent':
        this.linked.received(message);
        return;
      case 'noteChanged':
        this.linked.changed(message.noteId);
        return;
      case 'showHeading':
        this.showHeading(message.noteId, message.heading);
        return;
      case 'commentDraft':
      case 'commentCreate':
      case 'commentReply':
      case 'commentEdit':
      case 'commentDelete':
      case 'commentDeleteThread':
      case 'commentStatus':
      case 'commentTarget':
      case 'commentActive':
      case 'commentSessions':
        this.comment(message);
        return;
    }
  }
}
