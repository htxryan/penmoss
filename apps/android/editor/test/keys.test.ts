/**
 * The page's keyboard dispatcher (T40 P9, PL9, A493): a hardware keyboard's shortcuts in the
 * note, with the synced bindings, as the web's dispatcher runs them (A70, A90). Editor commands
 * run here; the app's go to the app as `command`; a rebound editor default stops acting; a
 * binding A90 forbids is never taken, and nothing without Ctrl, Alt or an F-key is considered.
 */
import { EDITOR_COMMANDS } from '@penmoss/editor';
import { NOTE_ROOT } from '@penmoss/sync-client';
import { initNote } from '@penmoss/sync-client/note';
import { createYjs14Replica } from '@penmoss/sync-client/yjs14';
import * as Y from '@y/y';
import { toBase64 } from 'lib0/buffer';
import { afterEach, describe, expect, it } from 'vitest';
import shortcuts from '../../contract/shortcuts-v1.json';
import { EditorHost } from '../src/host';
import { KEY_COMMANDS } from '../src/keys';
import type { FromEditor, ToEditor } from '../src/protocol';

const NOTE = '01JD2Z7Q8R4T6Y8W0E2R4T6YB1';
const hosts: EditorHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.close();
  document.body.replaceChildren();
});

function openNote(editable = true) {
  const root = document.createElement('main');
  const title = document.createElement('textarea');
  const body = document.createElement('div');
  const unsupported = document.createElement('pre');
  root.append(title, body, unsupported);
  document.body.append(root);
  const sent: FromEditor[] = [];
  const host = new EditorHost({ root, title, body, unsupported }, (message) => sent.push(message));
  hosts.push(host);
  const replica = createYjs14Replica();
  initNote(replica.doc, { id: NOTE, created: '2026-10-23T10:00:00-05:00', kind: 'note' }, 'Plan');
  replica.doc.transact(() => {
    const paragraph = new Y.Node('paragraph');
    replica.doc.get(NOTE_ROOT).push([paragraph]);
    paragraph.insert(0, 'some words here');
  });
  host.handle({
    v: 1,
    type: 'open',
    noteId: NOTE,
    synced: [{ id: 's0', update: toBase64(replica.encodeStateAsUpdate()) }],
    pending: [],
    editable,
  });
  const editor = host.editor!.editor;
  editor.commands.focus();
  editor.commands.setTextSelection({ from: 1, to: 5 });
  return { host, sent, editor, title };
}

const keys = (
  bindings: Record<string, string[]>,
  app: string[],
): Extract<ToEditor, { type: 'keys' }> => ({ v: 1, type: 'keys', bindings, app });

/**
 * A keydown at `target` as a hardware keyboard sends it; returns whether the dispatcher took
 * it: it stops the key in the capture phase, so the target (and ProseMirror) never sees it.
 */
function press(
  target: EventTarget,
  code: string,
  key: string,
  mods: {
    ctrl?: boolean;
    alt?: boolean;
    shift?: boolean;
    repeat?: boolean;
    location?: number;
  } = {},
  type: 'keydown' | 'keyup' = 'keydown',
): boolean {
  const event = new KeyboardEvent(type, {
    code,
    key,
    ctrlKey: mods.ctrl ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
    repeat: mods.repeat ?? false,
    location: mods.location ?? 0,
    bubbles: true,
    cancelable: true,
  });
  // happy-dom reports AltGraph for any Alt; a hardware keyboard's left Alt is not AltGr.
  Object.defineProperty(event, 'getModifierState', { value: () => false });
  let reached = false;
  const seen = () => (reached = true);
  target.addEventListener(type, seen);
  target.dispatchEvent(event);
  target.removeEventListener(type, seen);
  return !reached && event.defaultPrevented;
}

const commands = (sent: FromEditor[]) =>
  sent.filter((message) => message.type === 'command').map((message) => message.id);

describe('the page’s keyboard dispatcher', () => {
  it('knows the web’s registry: the page runs exactly the contract’s editor commands', () => {
    expect(KEY_COMMANDS).toHaveLength(shortcuts.commands.length);
    // Android lists every editor command as the page's (A497): each must run here, and the
    // page must have none the contract lacks (review S13).
    const contract = KEY_COMMANDS.filter((command) => command.scope === 'editor').map((c) => c.id);
    expect([...contract].sort()).toEqual(EDITOR_COMMANDS.map((command) => command.id).sort());
    expect(KEY_COMMANDS.map((command) => command.id)).toContain('app.search');
  });

  it('runs an editor command with its default keys, in the note only', () => {
    const { host, editor, title } = openNote();
    host.handle(keys({}, []));
    expect(press(editor.view.dom, 'KeyB', 'b', { ctrl: true })).toBe(true);
    expect(editor.isActive('bold')).toBe(true);
    // In the title, Ctrl+B is not the note's: nothing takes it.
    expect(press(title, 'KeyB', 'b', { ctrl: true })).toBe(false);
  });

  it('runs a rebound editor command, and its old key no longer acts in the note', () => {
    const { host, editor } = openNote();
    host.handle(keys({ 'editor.bold': ['Mod+Shift+1'], 'editor.heading1': [] }, []));
    expect(press(editor.view.dom, 'Digit1', '!', { ctrl: true, shift: true })).toBe(true);
    expect(editor.isActive('bold')).toBe(true);
    // The old default is swallowed, so TipTap's keymap does not bold the text again.
    expect(press(editor.view.dom, 'KeyB', 'b', { ctrl: true })).toBe(true);
    expect(editor.isActive('bold')).toBe(true);
  });

  it('sends the app’s commands to the app, with the user’s keys, in the note and the title', () => {
    const { host, sent, editor, title } = openNote();
    host.handle(keys({ 'app.search': ['Mod+J'] }, ['app.search', 'journal.today', 'note.new']));
    expect(press(editor.view.dom, 'KeyJ', 'j', { ctrl: true })).toBe(true);
    expect(press(title, 'KeyD', 'd', { ctrl: true })).toBe(true);
    expect(press(editor.view.dom, 'KeyN', 'n', { alt: true })).toBe(true);
    // Search's own default moved to Mod+J: Ctrl+Shift+F is nobody's now.
    expect(press(editor.view.dom, 'KeyF', 'F', { ctrl: true, shift: true })).toBe(false);
    expect(commands(sent)).toEqual(['app.search', 'journal.today', 'note.new']);
    expect(sent.filter((message) => message.type === 'command')[0]).toEqual({
      v: 1,
      type: 'command',
      noteId: NOTE,
      id: 'app.search',
    });
  });

  it('leaves a key to the page when the app does not run its command here', () => {
    const { host, sent, editor } = openNote();
    host.handle(keys({}, ['app.search']));
    expect(press(editor.view.dom, 'KeyD', 'd', { ctrl: true })).toBe(false);
    expect(commands(sent)).toEqual([]);
  });

  it('lets Ctrl+K link selected text, and gives it to the app otherwise (A42)', () => {
    const { host, sent, editor } = openNote();
    host.handle(keys({}, ['app.palette']));
    expect(press(editor.view.dom, 'KeyK', 'k', { ctrl: true })).toBe(true);
    expect(commands(sent)).toEqual([]);
    editor.commands.setTextSelection(3);
    expect(press(editor.view.dom, 'KeyK', 'k', { ctrl: true })).toBe(true);
    expect(commands(sent)).toEqual(['app.palette']);
  });

  it('refuses a binding A90 forbids: AltGr’s Ctrl+Alt+N, a plain letter, the clipboard’s keys', () => {
    const { host, sent, editor } = openNote();
    host.handle(
      keys({ 'note.new': ['Mod+Alt+N'], 'app.search': ['Shift+K'], 'app.settings': ['Mod+C'] }, [
        'note.new',
        'app.search',
        'app.settings',
      ]),
    );
    expect(press(editor.view.dom, 'KeyN', 'ñ', { ctrl: true, alt: true })).toBe(false);
    expect(press(editor.view.dom, 'KeyK', 'K', { shift: true })).toBe(false);
    expect(press(editor.view.dom, 'KeyC', 'c', { ctrl: true })).toBe(false);
    // Each command left with nothing usable keeps its defaults (A90).
    expect(press(editor.view.dom, 'KeyN', 'n', { alt: true })).toBe(true);
    expect(press(editor.view.dom, 'Comma', ',', { ctrl: true })).toBe(true);
    expect(commands(sent)).toEqual(['note.new', 'app.settings']);
  });

  it('never takes a key while the IME composes', () => {
    const { host, sent, editor } = openNote();
    host.handle(keys({}, ['journal.today']));
    const composing = new KeyboardEvent('keydown', {
      code: 'KeyD',
      key: 'd',
      ctrlKey: true,
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    editor.view.dom.dispatchEvent(composing);
    expect(composing.defaultPrevented).toBe(false);
    expect(commands(sent)).toEqual([]);
  });

  it('types with AltGr, the right Alt on Android, never running Alt+ shortcuts (review B1)', () => {
    const { host, sent, editor, title } = openNote();
    // Bound on a US keyboard: Alt+N (New note), Alt+C (Code block), and Alt+Q given to Search.
    host.handle(keys({ 'app.search': ['Alt+Q'] }, ['note.new', 'app.search']));
    // Polish: AltGr+N types ń, AltGr+C ć. Chrome on Android sends Alt, no Ctrl, no AltGraph.
    expect(press(editor.view.dom, 'AltRight', 'Alt', { alt: true, location: 2 })).toBe(false);
    expect(press(editor.view.dom, 'KeyN', 'ń', { alt: true })).toBe(false);
    expect(press(editor.view.dom, 'KeyC', 'ć', { alt: true })).toBe(false);
    expect(press(title, 'KeyN', 'ń', { alt: true })).toBe(false);
    // German: AltGr+Q types @, AltGr+7 {: the key reads as Q and 7, so only the held right Alt
    // says they type.
    expect(press(editor.view.dom, 'KeyQ', '@', { alt: true })).toBe(false);
    expect(press(editor.view.dom, 'Digit7', '{', { alt: true })).toBe(false);
    press(editor.view.dom, 'AltRight', 'Alt', { location: 2 }, 'keyup');
    expect(commands(sent)).toEqual([]);
    expect(editor.isActive('codeBlock')).toBe(false);
    // The left Alt on a US layout is still a shortcut.
    expect(press(editor.view.dom, 'KeyN', 'n', { alt: true })).toBe(true);
    expect(press(editor.view.dom, 'KeyQ', 'q', { alt: true })).toBe(true);
    expect(commands(sent)).toEqual(['note.new', 'app.search']);
  });

  it('types a letter or a dead accent an Alt layout gives, even with the left Alt (review B1)', () => {
    const { host, sent, editor } = openNote();
    host.handle(keys({}, ['note.new']));
    // Android's generic layout: Alt+N is the dead ~ for ñ; another layout's Alt+N a letter.
    expect(press(editor.view.dom, 'KeyN', 'Dead', { alt: true })).toBe(false);
    expect(press(editor.view.dom, 'KeyN', '\u0303', { alt: true })).toBe(false);
    expect(press(editor.view.dom, 'KeyN', 'ñ', { alt: true })).toBe(false);
    expect(commands(sent)).toEqual([]);
    expect(press(editor.view.dom, 'KeyN', 'N', { alt: true, shift: false })).toBe(true);
    expect(commands(sent)).toEqual(['note.new']);
  });

  it('runs an app command once for a held key, and takes its repeats (review S11)', () => {
    const { host, sent, editor } = openNote();
    host.handle(keys({}, ['note.new']));
    expect(press(editor.view.dom, 'KeyN', 'n', { alt: true })).toBe(true);
    expect(press(editor.view.dom, 'KeyN', 'n', { alt: true, repeat: true })).toBe(true);
    expect(press(editor.view.dom, 'KeyN', 'n', { alt: true, repeat: true })).toBe(true);
    expect(commands(sent)).toEqual(['note.new']);
  });

  it('runs no editor command in a read-only note, but the app’s still go', () => {
    const { host, sent, editor } = openNote(false);
    host.handle(keys({}, ['note.history']));
    expect(press(editor.view.dom, 'KeyB', 'b', { ctrl: true })).toBe(false);
    expect(press(editor.view.dom, 'KeyH', 'H', { alt: true, shift: true })).toBe(true);
    expect(commands(sent)).toEqual(['note.history']);
  });
});
