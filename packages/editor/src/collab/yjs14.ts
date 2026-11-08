/**
 * TipTap bound to a Yjs 14 replica through @y/prosemirror 2. TipTap's
 * Collaboration extension wraps the old binding, so the sync and undo
 * plugins are added directly, as in y-prosemirror's own TipTap demo.
 */
import { NOTE_ROOT } from '@penmoss/sync-client';
import { createYjs14Replica, type Yjs14Replica } from '@penmoss/sync-client/yjs14';
import { Editor, Extension, type AnyExtension } from '@tiptap/core';
import { Plugin, type EditorState, type PluginSpec } from '@tiptap/pm/state';
import * as Y from '@y/y';
import {
  configureYProsemirror,
  pauseSync,
  redoCommand,
  syncPlugin,
  undoCommand,
  ySyncPluginKey,
  yUndoPlugin,
} from '@y/prosemirror';
import { isBindingTransaction } from './binding';
import type { CollabEditor } from './types';
import { UnsupportedContentError, unknownNodeTypes, type DeltaNode } from './unsupported';

export interface Yjs14EditorOptions {
  readonly element: HTMLElement;
  readonly extensions: AnyExtension[];
  readonly replica?: Yjs14Replica;
  /**
   * A change arrived holding node types this editor does not know (A158): the
   * editor has stopped syncing and turned read-only, and the note should be
   * shown as `UnsupportedContentError` describes.
   */
  readonly onUnsupported?: (nodeTypes: readonly string[]) => void;
}

/**
 * Throws `UnsupportedContentError`, before anything is mounted or written,
 * when the note holds node types the extensions' schema does not have (A158).
 */
export function createYjs14Editor(options: Yjs14EditorOptions): CollabEditor {
  const replica = options.replica ?? createYjs14Replica();
  const ytype = replica.doc.get(NOTE_ROOT);
  // An empty origin set tracks the sync plugin's own writes: only this editor's edits are undoable.
  const undoManager = new Y.UndoManager(ytype, {
    trackedOrigins: new Set(),
    deleteFilter: keepsLastBlock(ytype),
  });

  const YSync = Extension.create({
    name: 'ySync',
    addProseMirrorPlugins: () => [syncPlugin()],
  });
  const YUndo = Extension.create({
    name: 'yUndo',
    addProseMirrorPlugins: () => [yUndoPlugin(undoManager)],
    addKeyboardShortcuts() {
      const run = (command: typeof undoCommand) => () =>
        command(this.editor.state, this.editor.view.dispatch);
      return {
        'Mod-z': run(undoCommand),
        'Mod-y': run(redoCommand),
        'Mod-Shift-z': run(redoCommand),
      };
    },
  });

  // Not mounted yet (no element): the content check below uses the editor's own schema.
  const editor = new GuardedEditor({
    extensions: [...options.extensions, YSync, YUndo],
    // Pasted markdown is parsed by the core codec (clipboard/paste.ts). TipTap's paste
    // rules would restyle text after it (`2 * 3 * 4` in italics, links in plain pastes).
    enablePasteRules: false,
  });
  // The type's own delta, which the binding reads next anyway (T31): no second deep copy.
  const unknown = unknownNodeTypes(ytype.delta, editor.schema);
  if (unknown.length > 0) {
    editor.destroy();
    undoManager.destroy();
    ytype.clearCache(); // Never bound: nothing should keep that delta current.
    throw new UnsupportedContentError(unknown);
  }
  editor.setOptions({ element: options.element });
  editor.mount(options.element);
  // A change bringing node types the editor does not know (a later version's): the binding
  // would throw from inside Yjs and then overwrite what it could not show, so syncing stops
  // first (this listener precedes the binding's) and the note turns read-only (A158).
  let stopped = false;
  const guard = (change: DeltaNode) => {
    if (stopped) return;
    const types = unknownNodeTypes(change, editor.schema);
    if (types.length === 0) return;
    stopped = true;
    pauseSync(editor.state, editor.view.dispatch);
    editor.setEditable(false);
    options.onUnsupported?.(types);
  };
  ytype.on('delta', guard);
  const destroy = () => {
    ytype.off('delta', guard);
    editor.destroy();
    undoManager.destroy();
  };
  try {
    // The Yjs type is the source of truth: binding replaces the editor content with it.
    configureYProsemirror({ ytype })(editor.state, editor.view.dispatch);
  } catch (error) {
    // Never leave a half-bound editor mounted (A158): the caller shows the error instead.
    destroy();
    throw error;
  }

  return {
    editor,
    replica,
    undo: () => !stopped && undoCommand(editor.state, editor.view.dispatch),
    redo: () => !stopped && redoCommand(editor.state, editor.view.dispatch),
    destroy,
  };
}

/**
 * An undo never empties the note (T39 pass 2, A520). In a new note the first keystroke
 * writes the paragraph and its text as one step, so undoing it emptied the Yjs type. The
 * editor then showed the empty paragraph ProseMirror needs and wrote it into Yjs, outside
 * the step: Redo put the text back in a second paragraph after it, or, when Yjs filed the
 * write as a step of its own, the first Redo only removed it and seemed to do nothing. The
 * note's last block is kept instead, with what it is made of when that is one block in
 * one (a list's item and its paragraph): only the text goes, so one Redo puts it back where
 * it was. So are the attributes those blocks were made with (a heading's level): without
 * them the editor wrote the defaults back, outside the step. A later change to an attribute
 * has an earlier value to its left, and is undone as usual.
 */
export function keepsLastBlock(ytype: Y.Node): (item: Y.Item) => boolean {
  interface Node {
    readonly parent: Node | null;
    readonly length: number;
  }
  const root = ytype as unknown as Node;
  /** The note, or a block that is the only one in a block kept this way. */
  const kept = (node: Node | null): boolean =>
    node !== null &&
    (node === root || (node.parent !== null && node.parent.length === 1 && kept(node.parent)));
  return (item) => {
    const parent = item.parent as unknown as Node | null;
    if (item.parentSub !== null) return !(item.left === null && parent !== root && kept(parent));
    const content: unknown = item.content;
    return !(
      content instanceof Y.ContentType &&
      parent !== null &&
      parent.length === 1 &&
      kept(parent)
    );
  };
}

/**
 * A TipTap editor whose every plugin carries the repair guard below: the
 * extensions' plugins once the view exists (`mount`), and any plugin added
 * later through `registerPlugin` (menus and other late plugins). TipTap
 * builds the plugin list in exactly these two places.
 */
class GuardedEditor extends Editor {
  override mount(element: Parameters<Editor['mount']>[0]): void {
    super.mount(element);
    const plugins = this.state.plugins.map(skipRepairsOfBindingChanges);
    if (plugins.some((plugin, i) => plugin !== this.state.plugins[i])) {
      this.view.updateState(this.state.reconfigure({ plugins }));
    }
  }

  override registerPlugin(
    plugin: Plugin,
    handlePlugins?: (newPlugin: Plugin, plugins: Plugin[]) => Plugin[],
  ): EditorState {
    return super.registerPlugin(skipRepairsOfBindingChanges(plugin), handlePlugins);
  }
}

/** Plugins that already carry the guard (or never need it), so wrapping is idempotent. */
const guarded = new WeakSet<Plugin>();

/**
 * A plugin whose `appendTransaction` only ever moves the selection, never the document (T44:
 * the caret out of a line's symbols, A745), says so with `selectionOnly: true` in its spec. It
 * cannot write a repair into Yjs, so it is left unguarded: it must see a click and an arrow key
 * (transactions that change nothing), and the binding's own changes.
 */
export interface SelectionOnlySpec {
  readonly selectionOnly?: boolean;
}

const movesSelectionOnly = (spec: object) => (spec as SelectionOnlySpec).selectionOnly === true;

/**
 * Stops plugins from "repairing" content the binding just rendered
 * (prosemirror-tables' fixTables, TrailingNode, autolink). Without this, two
 * peers that add a row and a column concurrently both pad the ragged row,
 * write the padding into Yjs and answer each other's padding forever: one
 * extra column per sync round (T4 finding). Local edits are still repaired,
 * once, by their author. Mirrors guards.js in y-prosemirror's TipTap demo;
 * see its CAVEATS.md ("Editor plugins that repair the document").
 * `GuardedEditor` applies it to every plugin, including late ones.
 *
 * Only a batch that changed the document is repaired (A152). A repair
 * plugin's state is worked out from every transaction, the binding's too:
 * TrailingNode's said "add a paragraph" once the binding rendered a note
 * ending in a list or a quote, and the next transaction that changed
 * nothing (a click, focus, the agent highlight's decoration) then wrote an
 * empty paragraph into Yjs as the reader's edit, a "No text changes"
 * version in History.
 */
export function skipRepairsOfBindingChanges<T>(plugin: Plugin<T>): Plugin<T> {
  if (guarded.has(plugin)) return plugin;
  const spec: PluginSpec<T> = plugin.spec;
  const { appendTransaction } = spec;
  if (!appendTransaction || spec.key === ySyncPluginKey) {
    guarded.add(plugin);
    return plugin;
  }
  if (movesSelectionOnly(spec)) {
    // Held to its word (T44 review): a transaction from it that changes the document would
    // be the repair the guard exists to stop, so it is refused and reported.
    const checked = new Plugin<T>({
      ...spec,
      appendTransaction(transactions, oldState, newState) {
        const tr = appendTransaction.call(this, transactions, oldState, newState);
        if (!tr?.docChanged) return tr;
        console.error(
          `A selectionOnly plugin (${(spec.key as unknown as { key?: string } | undefined)?.key ?? 'unnamed'}) tried to change the document; refused.`,
        );
        return null;
      },
    });
    guarded.add(checked);
    return checked;
  }
  const wrapped = new Plugin<T>({
    ...spec,
    appendTransaction(transactions, oldState, newState) {
      if (transactions.some(isBindingTransaction)) return null;
      if (!transactions.some((transaction) => transaction.docChanged)) return null;
      return appendTransaction.call(this, transactions, oldState, newState);
    },
  });
  guarded.add(wrapped);
  return wrapped;
}
