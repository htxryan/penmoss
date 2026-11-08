/**
 * The command registry at run time (T20): which commands can run now, their
 * effective key bindings (the user's synced bindings over the defaults),
 * conflict detection, and the one keyboard dispatcher.
 *
 * The dispatcher listens on the window in the capture phase, so it sees a
 * key before the editor's own keymaps do. For a combination it tries the
 * commands bound to it, most specific scope first (the editor or the folder
 * tree, then global); a command whose handler returns false passes the key
 * on (A42: Mod+K links selected text, else opens the palette). A key nothing
 * takes keeps its usual meaning, except an editor default whose command was
 * rebound away: that one is swallowed in the editor, so the old key stops
 * working as the user expects.
 */
import type { CollabEditor } from '@penmoss/editor';
import { EDITOR_COMMANDS, type EditorCommandContext } from '@penmoss/editor/commands';
import {
  bindingProblem,
  comboFromEvent,
  type BindingProblem,
  isAltGraph,
  normaliseCombo,
} from '@penmoss/editor/keys';
import { usableBindings } from './bindings';
import type { CommandDefinition, CommandScope } from './definitions';

export type RunSource = 'key' | 'palette' | 'button' | 'menu';

export interface RunContext {
  readonly source: RunSource;
  readonly event?: KeyboardEvent;
}

export interface CommandHandler {
  /** Runs the command; false means it does not apply now (a key then falls through). */
  run(context: RunContext): boolean | void;
  /** Whether it can run now (absent: always while registered). */
  enabled?(): boolean;
  /**
   * When it cannot run, the one registered before it may (T50, A862): each source's folder tree
   * in the sidebar registers the tree's commands, and the one in use answers them.
   */
  readonly yields?: boolean;
}

/** Where the user's bindings live (the WorkspaceDoc's per-user settings, so they sync). */
export interface BindingStore {
  /** Command id → combinations, for commands the user rebound ([] means no shortcut). */
  read(): Readonly<Record<string, readonly string[]>>;
  /** Sets one command's bindings; undefined restores the defaults. */
  write(id: string, keys: readonly string[] | undefined): void;
  subscribe(listener: () => void): () => void;
}

export interface ActiveEditor {
  readonly editor: CollabEditor['editor'];
  readonly images?: EditorCommandContext['images'];
}

/** In memory only (tests, and before sign-in). */
export function memoryBindings(initial: Record<string, readonly string[]> = {}): BindingStore {
  let current: Record<string, readonly string[]> = { ...initial };
  const listeners = new Set<() => void>();
  return {
    read: () => current,
    write(id, keys) {
      const next = { ...current };
      if (keys === undefined) delete next[id];
      else next[id] = keys;
      current = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Why a combination cannot be bound, in words (A90). */
export const BINDING_PROBLEMS: Readonly<Record<BindingProblem, (combo: string) => string>> = {
  types: (combo) => `${combo} would type a character`,
  altgr: (combo) => `${combo} is AltGr on many keyboards, which types a character`,
  reserved: (combo) => `${combo} is kept for the clipboard and editing text`,
};

const SPECIFIC_FIRST: Readonly<Record<CommandScope, number>> = { editor: 0, tree: 0, global: 1 };

/** A menu shortcut this soon after the page saw the same key is that key, reported again. */
const MENU_ECHO_MS = 1000;
const now = () => (typeof performance === 'undefined' ? Date.now() : performance.now());

/** Whether two commands' keys can act at the same moment (the editor and the tree never do). */
const scopesOverlap = (a: CommandScope, b: CommandScope) =>
  a === b || a === 'global' || b === 'global';

export class CommandCenter {
  /** The commands as defined, before any title the person's settings give them. */
  private readonly defined: ReadonlyMap<string, CommandDefinition>;
  private titled: ReadonlyMap<string, CommandDefinition>;
  private readonly editorCommands = new Map(
    EDITOR_COMMANDS.map((command) => [command.id, command]),
  );
  private readonly handlers = new Map<string, CommandHandler[]>();
  private readonly listeners = new Set<() => void>();
  private active: ActiveEditor | null = null;
  private bindings: Readonly<Record<string, readonly string[]>>;
  private revision = 0;
  /** Bumped when a handler's `enabled` answer changes (the Mac menus follow it, A526). */
  private availabilityRevision = 0;
  private readonly availabilityListeners = new Set<() => void>();
  /** While the shortcut editor records keys, the dispatcher stands aside. */
  private suspended = 0;
  private offStore: (() => void) | null = null;
  /** The latest combination the page saw, and when (a native menu may report it again, T29). */
  private lastKey: { readonly combo: string; readonly at: number } | null = null;

  constructor(
    definitions: readonly CommandDefinition[],
    private readonly store: BindingStore,
  ) {
    this.defined = new Map(definitions.map((definition) => [definition.id, definition]));
    this.titled = this.defined;
    this.bindings = this.readStore();
    this.start();
  }

  /** Follows the binding store (again, after `dispose`: React StrictMode remounts). Idempotent. */
  start(): void {
    if (this.offStore) return;
    const refresh = () => {
      const next = this.readStore();
      if (JSON.stringify(next) === JSON.stringify(this.bindings)) return;
      this.bindings = next;
      this.changed();
    };
    this.offStore = this.store.subscribe(refresh);
    refresh();
  }

  /** The store's bindings this device can use (bad ones arrive by sync too, A90). */
  private readStore(): Readonly<Record<string, readonly string[]>> {
    return usableBindings(this.store.read(), (id) => this.definitions.get(id)?.keys);
  }

  dispose(): void {
    this.offStore?.();
    this.offStore = null;
  }

  /** Bumped on every change to bindings, handlers or the editor (for useSyncExternalStore). */
  get version(): number {
    return this.revision;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.revision;

  /**
   * A registered handler's `enabled` now answers differently (useCommand checks after each
   * render). The palette and buttons ask when they render; the Mac menus, built once per
   * change, listen for this (A526).
   */
  availabilityChanged(): void {
    this.availabilityRevision++;
    for (const listener of this.availabilityListeners) listener();
  }

  subscribeAvailability = (listener: () => void): (() => void) => {
    this.availabilityListeners.add(listener);
    return () => this.availabilityListeners.delete(listener);
  };

  getAvailability = (): number => this.availabilityRevision;

  /** The note editor commands act on (null while no note is open). */
  setEditor(active: ActiveEditor | null): void {
    if (this.active === active) return;
    this.active = active;
    this.changed();
  }

  get editor(): ActiveEditor | null {
    return this.active;
  }

  /** Every command, with the titles `setTitles` gives some of them. */
  get definitions(): ReadonlyMap<string, CommandDefinition> {
    return this.titled;
  }

  /**
   * Titles that follow the person's settings (T51 item 12, A940: "Toggle Symbol ★" for the
   * symbol in slot 1): `titles` answers a command's title, or undefined for its own. Told
   * again whenever they may have changed; listeners hear only of a real change.
   */
  setTitles(titles: (id: string) => string | undefined): void {
    let changed = false;
    const next = new Map<string, CommandDefinition>();
    for (const [id, definition] of this.defined) {
      const title = titles(id) ?? definition.title;
      if (title !== this.titled.get(id)?.title) changed = true;
      next.set(id, title === definition.title ? definition : { ...definition, title });
    }
    if (!changed) return;
    this.titled = next;
    this.changed();
  }

  /** Registers what runs a command; the latest registration wins until it is removed. */
  register(id: string, handler: CommandHandler): () => void {
    if (!this.definitions.has(id)) throw new Error(`Unknown command ${id}`);
    const stack = this.handlers.get(id) ?? [];
    stack.push(handler);
    this.handlers.set(id, stack);
    this.changed();
    return () => {
      const current = this.handlers.get(id);
      const index = current?.lastIndexOf(handler) ?? -1;
      if (current && index >= 0) current.splice(index, 1);
      this.changed();
    };
  }

  /** The combinations bound to a command now (the user's, else the defaults). */
  keysOf(id: string): readonly string[] {
    const own = this.bindings[id];
    if (own) return own;
    return this.definitions.get(id)?.keys ?? [];
  }

  /** Whether the user changed this command's keys. */
  isCustom(id: string): boolean {
    return this.bindings[id] !== undefined;
  }

  /** Whether the command can run now (palette, buttons). */
  available(id: string): boolean {
    const definition = this.definitions.get(id);
    if (!definition || definition.pending) return false;
    if (definition.scope === 'editor') {
      const command = this.editorCommands.get(id);
      if (!command || !this.active) return false;
      return !(id === 'editor.insert.image' && !this.active.images);
    }
    const handler = this.handlerOf(id);
    return handler !== undefined && (handler.enabled?.() ?? true);
  }

  /** The handler that answers `id`: the latest, unless it cannot run now and yields (A862). */
  private handlerOf(id: string): CommandHandler | undefined {
    const stack = this.handlers.get(id) ?? [];
    for (let i = stack.length - 1; i >= 0; i--) {
      const handler = stack[i]!;
      if (!handler.yields || (handler.enabled?.() ?? true) || i === 0) return handler;
    }
    return undefined;
  }

  /** Runs a command; false when it is unavailable or declined. */
  run(id: string, context: RunContext = { source: 'button' }): boolean {
    if (!this.available(id)) return false;
    const definition = this.definitions.get(id)!;
    if (definition.scope === 'editor') {
      const command = this.editorCommands.get(id)!;
      const active = this.active!;
      return command.run({ editor: active.editor, images: active.images, source: context.source });
    }
    const result = this.handlerOf(id)!.run(context);
    return result !== false;
  }

  /** Commands (other than `id`) that `combo` would clash with if bound to `id`. */
  conflicts(id: string, combo: string): CommandDefinition[] {
    const own = this.definitions.get(id);
    if (!own) return [];
    const wanted = normaliseCombo(combo);
    return [...this.definitions.values()].filter((other) => {
      if (other.id === id || !scopesOverlap(own.scope, other.scope)) return false;
      if (!this.keysOf(other.id).some((key) => normaliseCombo(key) === wanted)) return false;
      // A yielding command shares its keys with a command of a wider scope by design (A42).
      const yields = (own.yields || other.yields) && own.scope !== other.scope;
      return !yields;
    });
  }

  /** Every clash among the current bindings, as pairs of command ids and the combination. */
  allConflicts(): Array<{ readonly combo: string; readonly ids: readonly [string, string] }> {
    const found: Array<{ combo: string; ids: [string, string] }> = [];
    const seen = new Set<string>();
    for (const definition of this.definitions.values()) {
      for (const combo of this.keysOf(definition.id)) {
        for (const other of this.conflicts(definition.id, combo)) {
          const key = [definition.id, other.id].sort().join(' ') + combo;
          if (seen.has(key)) continue;
          seen.add(key);
          found.push({ combo, ids: [definition.id, other.id] });
        }
      }
    }
    return found;
  }

  /** Sets a command's combinations ([] removes its shortcut); syncs through the store. */
  rebind(id: string, keys: readonly string[]): void {
    const combos = keys.map((key) => normaliseCombo(key));
    const defaults = this.definitions.get(id)?.keys ?? [];
    for (const combo of combos) {
      const problem = defaults.includes(combo) ? null : bindingProblem(combo);
      if (problem) throw new Error(BINDING_PROBLEMS[problem](combo));
    }
    this.store.write(id, combos);
  }

  /** Restores a command's default combinations. */
  reset(id: string): void {
    this.store.write(id, undefined);
  }

  /** Stops dispatching keys (while the shortcut editor records one); returns the undo. */
  suspend(): () => void {
    this.suspended++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.suspended--;
    };
  }

  /** The keyboard dispatcher; returns whether a command took the key. */
  handleKeyDown = (event: KeyboardEvent): boolean => {
    const combo = comboFromEvent(event);
    if (combo) this.lastKey = { combo, at: now() };
    if (this.suspended > 0 || event.defaultPrevented || event.isComposing) return false;
    // AltGr types a character (Windows reports it as Ctrl+Alt): never a shortcut.
    if (isAltGraph(event)) return false;
    if (!combo) return false;
    if (!this.dispatch(combo, event.target, event)) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  /**
   * A shortcut a native menu took (the Mac app, T29): acts as the key would
   * where focus is now, unless the page saw that key itself a moment ago (it
   * then ran or declined it already, so the menu must not run it again).
   */
  dispatchMenuShortcut(combo: string, target: EventTarget | null): boolean {
    const wanted = normaliseCombo(combo);
    const seen = this.lastKey;
    if (seen && seen.combo === wanted && now() - seen.at < MENU_ECHO_MS) return false;
    if (this.suspended > 0) return false;
    return this.dispatch(wanted, target);
  }

  /** Runs what `combo` means with focus at `target`; returns whether a command took it. */
  private dispatch(combo: string, target: EventTarget | null, event?: KeyboardEvent): boolean {
    const inEditor = this.targetInEditor(target);
    const candidates = [...this.definitions.values()]
      .filter((definition) => !definition.pending && this.keysOf(definition.id).includes(combo))
      .filter((definition) => definition.scope !== 'editor' || inEditor)
      .sort((a, b) => SPECIFIC_FIRST[a.scope] - SPECIFIC_FIRST[b.scope]);
    for (const definition of candidates) {
      if (!this.available(definition.id)) continue;
      const context: RunContext = event ? { source: 'key', event } : { source: 'menu' };
      if (this.run(definition.id, context)) return true;
    }
    // The editor's own keymap still has the default: it must not act on a key moved elsewhere.
    return inEditor && this.reboundEditorDefault(combo);
  }

  private reboundEditorDefault(combo: string): boolean {
    for (const command of EDITOR_COMMANDS) {
      if (command.keys.includes(combo) && !this.keysOf(command.id).includes(combo)) return true;
    }
    return false;
  }

  private targetInEditor(target: EventTarget | null): boolean {
    const dom = this.active?.editor.view.dom;
    const node = target as Node | null;
    return Boolean(dom && node && dom.contains(node));
  }

  private changed(): void {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
}
