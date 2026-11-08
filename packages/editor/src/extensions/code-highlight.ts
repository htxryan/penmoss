/**
 * Highlight decorations for code blocks (T9). Only the code blocks a
 * transaction touches are re-highlighted; the rest keep their decorations,
 * mapped through the change. A block longer than `DEFER_CHARS` is highlighted
 * after a short pause in typing instead of on every keystroke, keeping its
 * mapped decorations meanwhile, so typing in a 200-line block stays smooth.
 *
 * Decorations are view-only: nothing here writes to the document (D31).
 */
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { changedNodes } from './changes';
import { codeHighlighter, resolveLanguage } from './highlight';

/** Blocks longer than this (about 40 lines) are re-highlighted after a pause. */
export const DEFER_CHARS = 2000;
/** The pause, in milliseconds, before a long block is re-highlighted. */
export const DEFER_MS = 150;

interface HighlightState {
  readonly decorations: DecorationSet;
  /** Start positions of long blocks waiting to be re-highlighted. */
  readonly stale: readonly number[];
  /** Grammars a decorated block needed but which have not loaded yet. */
  readonly missing: readonly string[];
}

type HighlightMeta = { loaded: string } | { refresh: true };

export const codeHighlightKey = new PluginKey<HighlightState>('penmossCodeHighlight');

const isCode = (node: PMNode) => node.type.name === 'codeBlock';

function decorate(node: PMNode, pos: number, missing: Set<string>): Decoration[] {
  const lang = resolveLanguage(node.attrs['language'] as string | null);
  if (!lang) return [];
  const tokens = codeHighlighter.tokens(lang.id, node.textContent);
  if (!tokens) {
    missing.add(lang.id);
    return [];
  }
  const start = pos + 1;
  return tokens.map((token) =>
    Decoration.inline(start + token.from, start + token.to, { class: token.className }),
  );
}

function allBlocks(doc: PMNode, filter: (node: PMNode) => boolean): Map<number, PMNode> {
  const blocks = new Map<number, PMNode>();
  doc.descendants((node, pos) => {
    if (isCode(node)) {
      if (filter(node)) blocks.set(pos, node);
      return false;
    }
    return !node.isTextblock;
  });
  return blocks;
}

function initialState(state: EditorState): HighlightState {
  const missing = new Set<string>();
  const decorations: Decoration[] = [];
  for (const [pos, node] of allBlocks(state.doc, () => true)) {
    decorations.push(...decorate(node, pos, missing));
  }
  return {
    decorations: DecorationSet.create(state.doc, decorations),
    stale: [],
    missing: [...missing],
  };
}

function applyHighlight(tr: Transaction, prev: HighlightState): HighlightState {
  const meta = tr.getMeta(codeHighlightKey) as HighlightMeta | undefined;
  if (!tr.docChanged && !meta) return prev.missing.length ? { ...prev, missing: [] } : prev;

  let decorations = prev.decorations.map(tr.mapping, tr.doc);
  const stale = new Set<number>();
  for (const pos of prev.stale) {
    const mapped = tr.mapping.mapResult(pos, 1);
    if (!mapped.deleted) stale.add(mapped.pos);
  }

  const now = new Map<number, PMNode>();
  const later = new Map<number, PMNode>();
  if (tr.docChanged) {
    for (const [pos, node] of changedNodes(tr.doc, [tr], isCode)) {
      (node.content.size > DEFER_CHARS ? later : now).set(pos, node);
    }
  }
  if (meta && 'loaded' in meta) {
    const blocks = allBlocks(tr.doc, (node) => {
      const lang = resolveLanguage(node.attrs['language'] as string | null);
      return lang?.id === meta.loaded;
    });
    for (const [pos, node] of blocks) now.set(pos, node);
  }
  if (meta && 'refresh' in meta) {
    for (const pos of stale) {
      const node = tr.doc.nodeAt(pos);
      if (node && isCode(node)) now.set(pos, node);
    }
    stale.clear();
  }

  const missing = new Set<string>();
  for (const [pos, node] of now) {
    later.delete(pos);
    stale.delete(pos);
    const end = pos + node.nodeSize;
    decorations = decorations.remove(decorations.find(pos, end));
    decorations = decorations.add(tr.doc, decorate(node, pos, missing));
  }
  for (const pos of later.keys()) stale.add(pos);
  return { decorations, stale: [...stale], missing: [...missing] };
}

/** Loads missing grammars and runs deferred highlighting, by dispatching meta-only transactions. */
class HighlightView {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly requested = new Set<string>();
  private destroyed = false;

  constructor(private readonly view: EditorView) {
    this.update(view, null);
  }

  update(view: EditorView, prevState: EditorState | null): void {
    const state = codeHighlightKey.getState(view.state);
    const prev = prevState ? codeHighlightKey.getState(prevState) : undefined;
    if (!state || state === prev) return;
    for (const id of state.missing) {
      if (this.requested.has(id)) continue;
      this.requested.add(id);
      codeHighlighter.load(id).then(
        () => this.dispatch({ loaded: id }),
        (error: unknown) => {
          this.requested.delete(id);
          console.warn(`[editor] could not load the ${id} grammar`, error);
        },
      );
    }
    // A new list of stale blocks means another edit: push the deferred pass back.
    if (state.stale !== prev?.stale) this.schedule(state.stale.length > 0);
  }

  private schedule(pending: boolean) {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = pending
      ? setTimeout(() => {
          this.timer = null;
          this.dispatch({ refresh: true });
        }, DEFER_MS)
      : null;
  }

  private dispatch(meta: HighlightMeta) {
    if (this.destroyed) return;
    this.view.dispatch(this.view.state.tr.setMeta(codeHighlightKey, meta));
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer !== null) clearTimeout(this.timer);
  }
}

export function codeHighlightPlugin(): Plugin<HighlightState> {
  return new Plugin<HighlightState>({
    key: codeHighlightKey,
    state: {
      init: (_config, state) => initialState(state),
      apply: (tr, prev) => applyHighlight(tr, prev),
    },
    props: {
      decorations: (state) => codeHighlightKey.getState(state)?.decorations ?? DecorationSet.empty,
    },
    view: (view) => new HighlightView(view),
  });
}
