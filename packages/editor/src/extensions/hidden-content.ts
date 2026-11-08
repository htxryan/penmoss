/**
 * Content that a node view hides stays in the document: a Mermaid diagram in
 * preview hides its source, a folded toggle hides its body. Left alone,
 * ProseMirror would join the next paragraph into that hidden text on
 * Backspace, or move the caret into it with the arrow keys, and the edit
 * would be invisible (and sync to other devices). Here a hidden block acts
 * like an atom: Backspace, Delete and the arrows next to it select the whole
 * block, and Enter on the selected block shows its content (the diagram's
 * source, the toggle's body). A caret that lands inside anyway (undo, a
 * search) shows the content too. Showing is view state: the node view
 * switches mode or opens the toggle, and nothing is written to the note.
 */
import { Extension } from '@tiptap/core';
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/** The DOM event a node view handles by showing its hidden content. */
export const REVEAL_EVENT = 'pm-reveal';

/** Whether the node at `pos` currently hides its content. */
function conceals(view: EditorView, pos: number, node: PMNode): boolean {
  if (node.type.name !== 'codeBlock' && node.type.name !== 'callout') return false;
  const dom = view.nodeDOM(pos);
  if (!(dom instanceof HTMLElement)) return false;
  if (node.type.name === 'callout') return dom.dataset['open'] === 'false';
  // An invalid diagram shows its source, with Mermaid's message.
  return dom.dataset['mode'] === 'preview' && dom.dataset['diagram'] !== 'error';
}

/** The outermost hidden block around `$pos`, if any. */
function hiddenAround(view: EditorView, $pos: ResolvedPos): number | null {
  for (let depth = 1; depth <= $pos.depth; depth += 1) {
    const pos = $pos.before(depth);
    if (conceals(view, pos, $pos.node(depth))) return pos;
  }
  return null;
}

/**
 * The hidden block a join or caret move from the edge of `$pos`'s textblock
 * would enter: the nearest block before (or after) it, or the last (first)
 * block nested at that edge of it.
 */
function hiddenNext(view: EditorView, $pos: ResolvedPos, dir: -1 | 1): number | null {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const index = $pos.index(depth - 1);
    const parent = $pos.node(depth - 1);
    if (dir < 0 ? index === 0 : index === parent.childCount - 1) continue;
    let pos = dir < 0 ? $pos.before(depth) : $pos.after(depth);
    let node = parent.child(index + dir);
    if (dir < 0) pos -= node.nodeSize;
    for (;;) {
      if (conceals(view, pos, node)) return pos;
      const child = dir < 0 ? node.lastChild : node.firstChild;
      if (node.isTextblock || !child) return null;
      pos = dir < 0 ? pos + node.nodeSize - 1 - child.nodeSize : pos + 1;
      node = child;
    }
  }
  return null;
}

/** Whether the caret would leave its textblock: at its start/end, or for up/down on its first/last line. */
function atEdge(view: EditorView, $pos: ResolvedPos, key: string): boolean {
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    if ($pos.parentOffset === (key === 'ArrowUp' ? 0 : $pos.parent.content.size)) return true;
    try {
      return view.endOfTextblock(key === 'ArrowUp' ? 'up' : 'down');
    } catch {
      return false;
    }
  }
  const start = key === 'Backspace' || key === 'ArrowLeft';
  return $pos.parentOffset === (start ? 0 : $pos.parent.content.size);
}

const BACKWARD = new Set(['Backspace', 'ArrowLeft', 'ArrowUp']);
const KEYS = new Set([...BACKWARD, 'Delete', 'ArrowRight', 'ArrowDown']);

function selectBlock(view: EditorView, pos: number): true {
  view.dispatch(
    view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)).scrollIntoView(),
  );
  return true;
}

/** Shows a hidden block's content and puts the caret in it. */
function reveal(view: EditorView, pos: number, node: PMNode): true {
  view.nodeDOM(pos)?.dispatchEvent(new CustomEvent(REVEAL_EVENT));
  const { doc } = view.state;
  const caret =
    node.type.name === 'codeBlock'
      ? TextSelection.create(doc, pos + node.nodeSize - 1)
      : (Selection.findFrom(doc.resolve(pos + 1), 1, true) ?? Selection.near(doc.resolve(pos + 1)));
  view.dispatch(view.state.tr.setSelection(caret).scrollIntoView());
  return true;
}

function handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
  if (!KEYS.has(event.key) && event.key !== 'Enter') return false;
  const { selection } = view.state;
  const arrow = event.key.startsWith('Arrow');
  if (selection instanceof NodeSelection) {
    if (!conceals(view, selection.from, selection.node)) return false;
    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey)
      return reveal(view, selection.from, selection.node);
    // The arrows step over the selected block, never into its hidden content.
    if (!arrow || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
    const back = BACKWARD.has(event.key);
    const $edge = back ? selection.$from : selection.$to;
    const next = Selection.findFrom($edge, back ? -1 : 1, true);
    if (!next) return false;
    const hidden = hiddenAround(view, next.$from);
    if (hidden !== null) return selectBlock(view, hidden);
    view.dispatch(view.state.tr.setSelection(next).scrollIntoView());
    return true;
  }
  if (event.key === 'Enter' || !selection.empty) return false;
  if (arrow && (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey)) return false;
  const { $head } = selection;
  if (!$head.parent.isTextblock || !atEdge(view, $head, event.key)) return false;
  const hidden = hiddenNext(view, $head, BACKWARD.has(event.key) ? -1 : 1);
  return hidden === null ? false : selectBlock(view, hidden);
}

/** A caret that lands in hidden content anyway shows that content. */
function revealSelection(view: EditorView) {
  const { selection } = view.state;
  if (selection instanceof NodeSelection) return;
  for (const $pos of [selection.$from, selection.$to]) {
    const pos = hiddenAround(view, $pos);
    if (pos !== null) view.nodeDOM(pos)?.dispatchEvent(new CustomEvent(REVEAL_EVENT));
  }
}

export const HiddenContent = Extension.create({
  name: 'hiddenContent',
  // Before the keymaps that would join into, or move into, the hidden content.
  priority: 1000,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('hiddenContent'),
        props: { handleKeyDown },
        view: () => ({
          update(view, previous) {
            if (!view.state.selection.eq(previous.selection)) revealSelection(view);
          },
        }),
      }),
    ];
  },
});
