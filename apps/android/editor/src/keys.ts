/**
 * The page's keyboard dispatcher (T40 P9, PL9, A493): a hardware keyboard's shortcuts while the
 * note has focus, as the web's `CommandCenter` dispatches them (A70), with the user's synced
 * bindings (`keys.<id>`, sent by the app in `keys`) over the defaults. It listens on the window
 * in the capture phase, ahead of ProseMirror's own keymaps. For a combination it tries the
 * commands bound to it, the editor's first while the note body has focus, then the app's: an
 * editor command runs here; one of the app's (the `app` list the app sends: Search, Settings,
 * Today, Version history and the rest) goes to the app as `command`, which runs it natively. A
 * command that declines passes the key on (A42: Ctrl+K links selected text, else is the app's).
 * A key nothing takes keeps its meaning, except an editor default whose command was rebound
 * away: that one is swallowed in the note, as on the web.
 *
 * Only keys with Ctrl or Alt, or F-keys, are considered (A90): never one the keyboard types or
 * the IME needs, and never AltGr. On Android AltGr is the right Alt key, reported as plain Alt
 * (`altKey`, no Ctrl, no `AltGraph` state), so the page follows the right Alt key itself, and an
 * Alt press whose layout typed a letter or a dead accent (ń, the ~ for ñ) is typing too (T40 P9
 * review B1). A held key's repeats never run one of the app's commands again (review S11). Commands, scopes and default keys are the web's registry as
 * `contract/shortcuts-v1.json` holds it (off Apple platforms: Mod is Ctrl); folder-tree
 * commands act on the app's own rows, never here.
 */
import { EDITOR_COMMANDS } from '@penmoss/editor';
import { comboFromEvent, isAltGraph, usableBindings } from '@penmoss/editor/keys';
import type { Editor } from '@tiptap/core';
import shortcuts from '../../contract/shortcuts-v1.json';

/** A command as the registry defines it (`contract/shortcuts-v1.json`). */
export interface KeyCommand {
  readonly id: string;
  readonly scope: string;
  readonly keys: readonly string[];
  readonly yields?: boolean;
  readonly pending?: string;
}

/** Every command of the web's registry, off Apple platforms. */
export const KEY_COMMANDS: readonly KeyCommand[] = shortcuts.commands;

const DEFAULTS = new Map(KEY_COMMANDS.map((command) => [command.id, command.keys]));
const EDITOR = new Map(EDITOR_COMMANDS.map((command) => [command.id, command]));
const SPECIFIC_FIRST: Readonly<Record<string, number>> = { editor: 0, global: 1 };
const FUNCTION_KEY = /^F\d{1,2}$/;

/** What the dispatcher needs from the page. */
export interface KeyHost {
  /** The open note's editor while it takes typing, else null. */
  editor(): Editor | null;
  /** The open note, for `command`. */
  noteId(): string | null;
  /** Sends one of the app's commands to the app. */
  command(id: string): void;
}

/**
 * Whether an Alt press typed (review B1): its layout gave it a letter other than its key's, a
 * combining accent, or a dead key, as AltGr does on Android and Alt on its generic layout.
 */
export function typesCharacter(event: KeyboardEvent): boolean {
  if (!event.altKey || event.ctrlKey || event.metaKey) return false;
  if (event.key === 'Dead') return true;
  if ([...event.key].length !== 1) return false;
  if (/\p{M}/u.test(event.key)) return true;
  if (!/\p{L}/u.test(event.key)) return false;
  const letter = /^Key([A-Z])$/.exec(event.code)?.[1];
  return letter === undefined || event.key.toUpperCase() !== letter;
}

/** The right Alt key: AltGr on Android's keyboard layouts. */
const isRightAlt = (event: KeyboardEvent) =>
  event.code === 'AltRight' || (event.key === 'Alt' && event.location === 2);

export class PageKeys {
  private bindings: Readonly<Record<string, readonly string[]>> = {};
  private app: ReadonlySet<string> = new Set();
  /** The right Alt key is down: what is pressed with it types (review B1). */
  private altGraph = false;

  constructor(private readonly host: KeyHost) {}

  /** The user's bindings as synced (A90 is applied here) and the app's commands now. */
  set(raw: Readonly<Record<string, readonly string[]>>, app: readonly string[]): void {
    this.bindings = usableBindings(raw, (id) => DEFAULTS.get(id), false);
    this.app = new Set(app);
  }

  /** The combinations bound to a command now: the user's, else the defaults. */
  keysOf(id: string): readonly string[] {
    return this.bindings[id] ?? DEFAULTS.get(id) ?? [];
  }

  /** The dispatcher, for `keydown` in the capture phase; returns whether a command took it. */
  handleKeyDown = (event: KeyboardEvent): boolean => {
    if (isRightAlt(event)) this.altGraph = true;
    // With no note open the page shows nothing to act on.
    if (this.host.noteId() === null) return false;
    if (event.defaultPrevented || event.isComposing || isAltGraph(event)) return false;
    // AltGr (the right Alt) and an Alt the layout types with: a character, never a command.
    if (event.altKey && !event.ctrlKey && this.altGraph) return false;
    if (typesCharacter(event)) return false;
    // Ctrl, Alt or an F-key: never a key that types or that the IME needs (A90).
    if (!event.ctrlKey && !event.altKey && !FUNCTION_KEY.test(event.code)) return false;
    const combo = comboFromEvent(event, false);
    if (!combo || !this.dispatch(combo, event.target, event.repeat)) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  /** For `keyup` in the capture phase: the right Alt key let go. */
  handleKeyUp = (event: KeyboardEvent): void => {
    if (isRightAlt(event)) this.altGraph = false;
  };

  /** The page lost focus: a right Alt let go elsewhere is not still down. */
  handleBlur = (): void => {
    this.altGraph = false;
  };

  private dispatch(combo: string, target: EventTarget | null, repeat = false): boolean {
    const editor = this.host.editor();
    const inEditor = Boolean(editor && target instanceof Node && editor.view.dom.contains(target));
    const candidates = KEY_COMMANDS.filter(
      (command) =>
        !command.pending &&
        (command.scope === 'global' || (command.scope === 'editor' && inEditor)) &&
        this.keysOf(command.id).includes(combo),
    ).sort((a, b) => (SPECIFIC_FIRST[a.scope] ?? 1) - (SPECIFIC_FIRST[b.scope] ?? 1));
    for (const command of candidates) {
      if (command.scope === 'editor') {
        const run = EDITOR.get(command.id);
        if (editor && run?.run({ editor, source: 'key' })) return true;
        continue;
      }
      if (this.app.has(command.id)) {
        // A held key: the command ran on the first press; its repeats are taken, not sent.
        if (!repeat) this.host.command(command.id);
        return true;
      }
    }
    // The editor's own keymap still has the default: it must not act on a key moved elsewhere.
    return inEditor && this.reboundEditorDefault(combo);
  }

  private reboundEditorDefault(combo: string): boolean {
    return EDITOR_COMMANDS.some(
      (command) => command.keys.includes(combo) && !this.keysOf(command.id).includes(combo),
    );
  }
}
