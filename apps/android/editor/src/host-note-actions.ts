/**
 * The editor host's note actions (PEN-186, split from `host.ts`): daily and weekly notes, new
 * notes, tags and descriptions, typing care, and updates from the app held while a word is
 * composed.
 */
import { normaliseTag } from '@penmoss/core/tags';
import {
  addDays,
  addWeeks,
  DEFAULT_TIME_ZONE,
  isoWeek,
  isTimeZone,
  longDate,
  parseIsoWeek,
  parsePlainDate,
  todayIn,
  weekDays,
  weekMonday,
} from '@penmoss/core/periodic';
import { initNote, isoWithOffset, readIdentity } from '@penmoss/model/note';
import { setFrontmatterTag } from '@penmoss/model/tags';
import {
  answerDescriptionAsk,
  readAiSetting,
  readDescription,
  setAiSetting,
  setHandDescription,
} from '@penmoss/model/description';
import { createYjs14Replica } from '@penmoss/model/yjs14';
import type { Editor } from '@tiptap/core';
import { fromBase64, toBase64 } from 'lib0/buffer';
import {
  BRIDGE_VERSION,
  type NavTarget,
  type NewNote,
  type PeriodicNav,
  type ToEditor,
} from './protocol';
import { CARET_MARGIN, FROM_APP, HOLD_MAX_MS, INVALID_TAG, type OpenNote } from './host-support';
import { HostNotes } from './host-notes';

export abstract class HostNoteActions extends HostNotes {
  /**
   * A daily or weekly note (T40 P5), as the web makes one: the period comes
   * from `day`, or from today in the synced time zone when null (never the
   * phone's zone), and the note is built with the deterministic
   * `periodicNote`, so a note made offline merges with one copy of the
   * template. The app stores it as one pending edit and files it through the
   * daily intent. A note already held is just opened: building it again
   * writes the same bytes under the same id.
   */
  protected createPeriodic(message: Extract<ToEditor, { type: 'createPeriodic' }>): void {
    void this.makePeriodic(message);
  }

  /**
   * [createPeriodic]'s work. The period resolves with core's small periodic module; the note's
   * codec and template filler load only now, as the web loads them (`ensurePeriodic`), so a
   * note's page never parses all of core at startup (T40 P5 review S5).
   */
  protected async makePeriodic(
    message: Extract<ToEditor, { type: 'createPeriodic' }>,
  ): Promise<void> {
    const { kind, day, at, timeZone, template, request } = message;
    try {
      const zone = isTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
      let atDay;
      if (day !== null) {
        atDay = parsePlainDate(day);
        if (!atDay) throw new RangeError(`Not a day: ${day}`);
      } else {
        atDay = todayIn(zone, new Date(at));
      }
      const period = kind === 'daily' ? atDay.toString() : isoWeek(atDay).toString();
      const date = kind === 'daily' ? atDay.toString() : weekMonday(isoWeek(atDay)).toString();
      const [{ periodicNote }, codec] = await Promise.all([
        import('@penmoss/model/periodic'),
        import('@penmoss/core'),
      ]);
      const note = periodicNote(codec, kind, period, template);
      const made: NewNote = { id: note.id, title: note.period, update: toBase64(note.update) };
      this.post({ v: BRIDGE_VERSION, type: 'createdPeriodic', note: made, kind, period, date });
    } catch (error) {
      this.fail(null, `The ${kind} note could not be made: ${String(error)}`, request);
    }
  }

  /**
   * What period the open note is, and what surrounds it (T40 P5, JR4): read
   * from its own document, with core's functions only. Null when it is no
   * periodic note, or nothing is open.
   */
  protected periodicNav(noteId: string): void {
    const open = this.current;
    if (!open || open.noteId !== noteId) {
      this.post({ v: BRIDGE_VERSION, type: 'periodicNav', noteId, nav: null });
      return;
    }
    const { kind, period } = readIdentity(open.replica.doc);
    let nav: PeriodicNav | null = null;
    try {
      if (kind === 'daily' && period) {
        const date = parsePlainDate(period);
        if (date) {
          const day = (step: number): NavTarget => {
            const at = addDays(date, step);
            return {
              date: at.toString(),
              label: at.toString(),
              full: longDate(at),
              period: at.toString(),
            };
          };
          const monday = weekMonday(isoWeek(date));
          nav = {
            kind,
            period,
            label: longDate(date),
            prev: day(-1),
            next: day(1),
            week: {
              date: monday.toString(),
              label: `Week ${isoWeek(date).toString()}`,
              full: `Week of ${longDate(monday)}`,
              period: isoWeek(date).toString(),
            },
            days: null,
          };
        }
      } else if (kind === 'weekly' && period) {
        const week = parseIsoWeek(period);
        if (week) {
          const at = (step: number): NavTarget => {
            const target = addWeeks(week, step);
            const monday = weekMonday(target);
            return {
              date: monday.toString(),
              label: target.toString(),
              full: `Week of ${longDate(monday)}`,
              period: target.toString(),
            };
          };
          nav = {
            kind,
            period,
            label: `Week ${period}`,
            prev: at(-1),
            next: at(1),
            week: null,
            days: weekDays(week).map((date) => ({
              date: date.toString(),
              label: `${longDate(date).slice(0, 3)} ${date.day}`,
              full: longDate(date),
              period: date.toString(),
            })),
          };
        }
      }
    } catch {
      nav = null;
    }
    this.post({ v: BRIDGE_VERSION, type: 'periodicNav', noteId, nav });
  }

  /**
   * New note (T38), as the web makes one: an empty note with this id, built
   * here because only the page writes Yjs. The app stores it as one pending
   * edit, so it uploads when it can and opens offline at once.
   */
  protected create(noteId: string): void {
    const now = this.now();
    const replica = createYjs14Replica();
    let note: NewNote;
    try {
      initNote(replica.doc, { id: noteId, created: isoWithOffset(now), kind: 'note' });
      note = { id: noteId, title: '', update: toBase64(replica.encodeStateAsUpdate()) };
    } finally {
      replica.destroy();
    }
    this.focusTitleOf = noteId;
    this.post({ v: BRIDGE_VERSION, type: 'created', noteId, note });
  }

  /**
   * Adds or removes one frontmatter tag on the open note (T38), exactly as the
   * web's tag chips do (`setFrontmatterTag`): an attribute per tag, so two
   * devices tagging at once keep both. The change goes to the app as any edit
   * does, and the new list follows as `tags`. A read-only note is left alone.
   */
  protected setTag(noteId: string, raw: string, on: boolean): void {
    const open = this.current;
    // Opened read-only, or holding content this editor cannot show (A158).
    const editable = this.editableEditor(noteId) !== null && !this.elements.title.readOnly;
    if (!open || open.noteId !== noteId || !editable) {
      this.notice(noteId, 'This note cannot be changed here');
      return;
    }
    const tag = normaliseTag(raw);
    if (!tag) {
      this.notice(noteId, INVALID_TAG);
      return;
    }
    setFrontmatterTag(open.replica.doc, tag, on);
  }

  /**
   * The Info sheet's description and AI Description (PEN-161), on the open note's document: the
   * change goes to the app as any edit does, and noteInfo follows with the new values.
   */
  protected describe(
    message: Extract<
      ToEditor,
      { type: 'setDescription' | 'setAiDescription' | 'answerDescription' }
    >,
  ): void {
    const open = this.current;
    const editable = this.editableEditor(message.noteId) !== null && !this.elements.title.readOnly;
    if (!open || open.noteId !== message.noteId || !editable) {
      this.notice(message.noteId, 'This note cannot be changed here');
      return;
    }
    const doc = open.replica.doc;
    if (message.type === 'setDescription') {
      // Asked about only while AI Descriptions could rewrite it: the page asks whenever the note
      // itself does not say Off, and the sheet shows the question only while it comes to On.
      setHandDescription(doc, message.text, {
        ask: readAiSetting(doc) !== 'off' && message.text.trim() !== '',
      });
    } else if (message.type === 'setAiDescription') {
      setAiSetting(doc, message.value);
    } else {
      answerDescriptionAsk(doc, message.answer);
    }
  }

  /** Settings → Note's Description Under the Title (PEN-161). */
  protected descriptionShown = false;
  protected descriptionLine: HTMLElement | null = null;

  /** The open note's description under its title, when that is on and it has one. */
  protected showDescription(): void {
    const doc = this.current?.replica.doc;
    const text = this.descriptionShown && doc ? (readDescription(doc) ?? '') : '';
    if (!this.descriptionLine) {
      if (text === '') return;
      const line = document.createElement('p');
      line.className = 'doc-meta-description';
      line.dataset['testid'] = 'note-description';
      this.elements.title.insertAdjacentElement('afterend', line);
      this.descriptionLine = line;
    }
    this.descriptionLine.textContent = text;
    this.descriptionLine.hidden = text === '';
  }

  /**
   * What the T2 spike found typing on a phone needs (A307): the keyboard's own
   * corrections, room for the caret above the bar, updates from other devices
   * held while a word is being composed, and the bar's state kept current.
   */
  protected prepareForTyping(open: OpenNote, editor: Editor): () => void {
    const dom = editor.view.dom;
    dom.setAttribute('autocapitalize', 'sentences');
    dom.setAttribute('autocorrect', 'on');
    dom.setAttribute('spellcheck', 'true');
    editor.view.setProps({ scrollThreshold: CARET_MARGIN, scrollMargin: CARET_MARGIN });
    // Other devices' changes land between words, never inside the keyboard's composition.
    const release = () => setTimeout(() => this.releaseHeld(open), 0);
    dom.addEventListener('compositionend', release);
    dom.addEventListener('blur', release);
    const changed = () => this.scheduleState();
    editor.on('transaction', changed);
    editor.on('focus', changed);
    editor.on('blur', changed);
    this.scheduleState();
    return () => {
      dom.removeEventListener('compositionend', release);
      dom.removeEventListener('blur', release);
      editor.off('transaction', changed);
      editor.off('focus', changed);
      editor.off('blur', changed);
    };
  }

  /**
   * Inline `#tags` open their notes (T40 P6, TG5, A469): a tap while reading (the keyboard down,
   * or the note read-only), or a Ctrl-tap from a hardware keyboard as the web's ⌘-click. While
   * typing, a tap on a tag places the caret in it, as anywhere else in the text. The reading tap
   * is kept from focusing the note, so the keyboard does not rise as the app leaves the note.
   */
  protected tagTaps(noteId: string, editor: Editor): () => void {
    const dom = editor.view.dom;
    const tagAt = (event: MouseEvent): string | null => {
      if (event.button !== 0 || !(event.target instanceof Element)) return null;
      const tag = event.target.closest<HTMLElement>('.pm-tag')?.dataset['tag'];
      return tag && normaliseTag(tag) === tag ? tag : null;
    };
    // Reading: the keyboard is down (the app says so; hiding it leaves the note focused), or,
    // before the app has said, the note has no focus. Read-only notes are always read.
    const opens = (event: MouseEvent) =>
      event.ctrlKey ||
      event.metaKey ||
      !editor.isEditable ||
      !editor.view.hasFocus() ||
      this.imeVisible === false;
    let chosen: string | null = null;
    const down = (event: MouseEvent) => {
      const tag = tagAt(event);
      chosen = tag && opens(event) ? tag : null;
      // ProseMirror skips an event already handled, and the browser then neither focuses nor
      // moves the caret.
      if (chosen) event.preventDefault();
    };
    const click = (event: MouseEvent) => {
      const tag = tagAt(event);
      if (!tag || tag !== chosen) return;
      chosen = null;
      event.preventDefault();
      this.post({ v: BRIDGE_VERSION, type: 'openTag', noteId, tag });
    };
    dom.addEventListener('mousedown', down, true);
    dom.addEventListener('click', click);
    return () => {
      dom.removeEventListener('mousedown', down, true);
      dom.removeEventListener('click', click);
    };
  }

  protected remote(noteId: string, update: string): void {
    const open = this.current;
    // A late reply for a note that has since closed: the app has stored it already.
    if (!open || open.noteId !== noteId) return;
    if (open.collab?.editor.view.composing) {
      open.held.push(update);
      open.holdTimer ??= setTimeout(() => this.releaseHeld(open, true), HOLD_MAX_MS);
      return;
    }
    this.releaseHeld(open);
    this.applyFromApp(open, update);
  }

  /**
   * Applies the updates held while the keyboard was composing, oldest first;
   * `force` once they have waited too long for the word to end.
   */
  protected releaseHeld(open: OpenNote, force = false): void {
    if (this.current !== open || (!force && open.collab?.editor.view.composing)) return;
    if (open.holdTimer !== null) clearTimeout(open.holdTimer);
    open.holdTimer = null;
    for (const update of open.held.splice(0)) this.applyFromApp(open, update);
  }

  protected applyFromApp(open: OpenNote, update: string): void {
    try {
      open.replica.applyUpdate(fromBase64(update), FROM_APP);
    } catch (error) {
      this.fail(open.noteId, `An update from the server could not be applied: ${String(error)}`);
    }
  }

  /**
   * A tap on the blank page below the note's text: the caret goes to the note's end (A527).
   * Only a tap on the page itself counts; anything drawn on it (the slash and `[[` menus, which
   * sit on the page's body and close as they apply a choice, a link, a field) keeps its tap.
   */
  protected tappedBelow(event: MouseEvent): void {
    if (event.defaultPrevented || event.button !== 0) return;
    const { root, body } = this.elements;
    const page = root.ownerDocument;
    const target = event.target;
    if (target !== page.documentElement && target !== page.body && target !== root) return;
    const open = this.current;
    const editor = open ? this.editableEditor(open.noteId) : null;
    if (!editor || event.clientY < body.getBoundingClientRect().bottom) return;
    editor.chain().focus('end').scrollIntoView().run();
  }
}
