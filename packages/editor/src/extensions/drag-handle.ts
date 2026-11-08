/**
 * The block drag handle (T14): a grip beside the top-level block under the
 * pointer. Dragging it shows where the block will land and moves it there on
 * release (block-move.ts: one transaction, one undo step, safe against a
 * peer's edits mid-drag). Clicking it selects the block, so it can then be
 * moved with Alt-Shift-ArrowUp/ArrowDown, deleted or copied. Esc cancels a
 * drag. Pointer events rather than HTML drag and drop, so ProseMirror's own
 * drop handling (which re-inserts a copy taken at drag start) is never used.
 * The handle and the drop line are view-only DOM; nothing is written while
 * they show.
 */
import {
  NodeSelection,
  Plugin,
  PluginKey,
  type EditorState,
  type PluginView,
} from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { Extension } from '@tiptap/core';
import {
  blockDragKey,
  blockDragPlugin,
  moveSelectedBlock,
  cancelBlockDrag,
  dropBlock,
  startBlockDrag,
  topLevelBlocks,
} from './block-move';
import { clipOf } from './symbol-overflow';

/** A top-level block's start position and its vertical extent on screen. */
export interface BlockBox {
  readonly pos: number;
  readonly top: number;
  readonly bottom: number;
}

/** The block whose box holds `y` (with `slack` pixels of margin), by binary search. */
export function blockAtY(boxes: readonly BlockBox[], y: number, slack = 6): BlockBox | null {
  let low = 0;
  let high = boxes.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const box = boxes[mid]!;
    if (y < box.top - slack) high = mid - 1;
    else if (y > box.bottom + slack) low = mid + 1;
    else return box;
  }
  return null;
}

/**
 * Where a block dropped at `y` lands: before the first block whose middle is
 * below `y`, or at `end` (the end of the note). Returns the boundary position
 * and the index of the block it sits before (`boxes.length` at the end).
 */
export function dropTarget(
  boxes: readonly BlockBox[],
  y: number,
  end: number,
): { pos: number; index: number } {
  let low = 0;
  let high = boxes.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const box = boxes[mid]!;
    if ((box.top + box.bottom) / 2 > y) high = mid;
    else low = mid + 1;
  }
  return { pos: boxes[low]?.pos ?? end, index: low };
}

/**
 * The start of the top-level block at a hit-test result (`posAtCoords`):
 * the block around `pos`, the atom `inside` points at, or the block next to a
 * boundary between blocks. Null in an empty document.
 */
export function topLevelBlockAt(doc: PMNode, pos: number, inside: number): number | null {
  const at = inside >= 0 ? inside : pos;
  const $at = doc.resolve(Math.min(Math.max(at, 0), doc.content.size));
  if ($at.depth > 0) return $at.before(1);
  if ($at.nodeAfter) return $at.pos;
  if ($at.nodeBefore) return $at.pos - $at.nodeBefore.nodeSize;
  return null;
}

const EDGE = 48;
const SCROLL_STEP = 16;

/** The nearest ancestor that scrolls vertically (or the page). */
function scrollParent(element: HTMLElement): HTMLElement {
  for (let at = element.parentElement; at; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if ((overflowY === 'auto' || overflowY === 'scroll') && at.scrollHeight > at.clientHeight) {
      return at;
    }
  }
  return (
    (element.ownerDocument.scrollingElement as HTMLElement | null) ?? element.ownerDocument.body
  );
}

export class DragHandleView implements PluginView {
  private readonly container: HTMLElement;
  private readonly handle: HTMLButtonElement;
  private readonly indicator: HTMLDivElement;
  /** The block the handle stands beside: its position and node (to find it again after edits). */
  private hovered: { pos: number; node: PMNode } | null = null;
  private drag: { pointerId: number; startY: number; moved: boolean } | null = null;
  /** Block boxes measured once per drag, and again only after a change or a scroll. */
  private boxCache: BlockBox[] | null = null;
  private frame = 0;

  constructor(private readonly view: EditorView) {
    const doc = view.dom.ownerDocument;
    this.container = view.dom.parentElement ?? view.dom;
    this.handle = doc.createElement('button');
    this.handle.type = 'button';
    this.handle.className = 'pm-drag-handle';
    this.handle.tabIndex = -1;
    this.handle.textContent = '⠿';
    this.handle.setAttribute('aria-label', 'Drag to Move Block');
    this.handle.setAttribute('aria-keyshortcuts', 'Alt+Shift+ArrowUp Alt+Shift+ArrowDown');
    this.handle.title = 'Drag to move. Click to select the block (Alt+Shift+↑/↓ moves it).';
    this.handle.dataset['testid'] = 'drag-handle';
    this.handle.hidden = true;
    this.indicator = doc.createElement('div');
    this.indicator.className = 'pm-drop-indicator';
    this.indicator.setAttribute('aria-hidden', 'true');
    this.indicator.hidden = true;
    this.container.append(this.handle, this.indicator);

    this.container.addEventListener('mousemove', this.onHover);
    this.container.addEventListener('mouseleave', this.onLeave);
    this.handle.addEventListener('pointerdown', this.onPointerDown);
  }

  update(view: EditorView, previous: EditorState): void {
    if (this.drag && !blockDragKey.getState(view.state)) {
      // The block went away mid-drag (a peer deleted it): stop following the pointer.
      this.endDrag();
    }
    if (view.state.doc === previous.doc) return;
    this.boxCache = null;
    if (this.drag || !this.hovered) return;
    // Keep the handle beside its block while the block itself is unchanged, wherever it moved.
    const { node } = this.hovered;
    let found: number | null = null;
    view.state.doc.forEach((child, pos) => {
      if (child === node) found = pos;
    });
    if (found === null) this.hide();
    else this.show(found);
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    this.endDrag();
    this.container.removeEventListener('mousemove', this.onHover);
    this.container.removeEventListener('mouseleave', this.onLeave);
    this.handle.remove();
    this.indicator.remove();
  }

  /** Screen boxes of the top-level blocks, in document order (cached during a drag). */
  private boxes(): BlockBox[] {
    if (this.drag && this.boxCache) return this.boxCache;
    const boxes: BlockBox[] = [];
    for (const { pos } of topLevelBlocks(this.view.state.doc)) {
      const dom = this.view.nodeDOM(pos);
      if (!(dom instanceof HTMLElement)) continue;
      const rect = dom.getBoundingClientRect();
      if (rect.height === 0 && rect.width === 0) continue;
      boxes.push({ pos, top: rect.top, bottom: rect.bottom });
    }
    if (this.drag) this.boxCache = boxes;
    return boxes;
  }

  private readonly onHover = (event: MouseEvent) => {
    if (this.drag || !this.view.editable) return;
    const { clientX, clientY } = event;
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      if (this.drag) return;
      if (event.target instanceof Node && this.handle.contains(event.target)) return;
      // Hit-test inside the text column, so the gutter (where the handle sits) finds its block.
      const column = this.view.dom.getBoundingClientRect();
      const left = Math.min(
        Math.max(clientX, column.left + 2),
        Math.max(column.left + 2, column.right - 2),
      );
      const hit = this.view.posAtCoords({ left, top: clientY });
      const pos = hit && topLevelBlockAt(this.view.state.doc, hit.pos, hit.inside);
      if (pos == null) this.hide();
      else this.show(pos);
    });
  };

  private readonly onLeave = () => {
    if (!this.drag) this.hide();
  };

  /** Puts the handle beside the top-level block at `pos`, measuring only that block. */
  private show(pos: number) {
    const node = this.view.state.doc.nodeAt(pos);
    const dom = this.view.nodeDOM(pos);
    if (!node || !(dom instanceof HTMLElement)) {
      this.hide();
      return;
    }
    this.hovered = { pos, node };
    const rect = dom.getBoundingClientRect();
    const origin = this.container.getBoundingClientRect();
    const editor = this.view.dom.getBoundingClientRect();
    const line = Math.min(rect.height, 28);
    this.handle.hidden = false;
    this.handle.style.top = `${rect.top - origin.top + this.container.scrollTop + (line - 24) / 2}px`;
    let left = editor.left - origin.left - 28;
    // One margin for both (T44, A745): beside a first line's symbols, the handle goes left of them.
    const symbols = dom.querySelector<HTMLElement>('.pm-symbols');
    if (symbols) {
      const box = symbols.getBoundingClientRect();
      if (box.right <= editor.left + 1 && box.top < rect.top + Math.max(line, 24)) {
        left = Math.min(left, box.left - origin.left - 24);
        // Never past the pane's edge, into the sidebar (T52 item 3): a full-width note's gutter
        // may hold the symbols only, and the handle then sits over their start.
        const clip = clipOf(this.view.dom);
        if (clip) left = Math.max(left, clip.getBoundingClientRect().left - origin.left);
      }
    }
    this.handle.style.left = `${left}px`;
    this.handle.dataset['block'] = dom.nodeName.toLowerCase();
  }

  private hide() {
    this.hovered = null;
    this.handle.hidden = true;
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || this.hovered === null || !this.view.editable) return;
    event.preventDefault();
    if (!startBlockDrag(this.view, this.hovered.pos)) return;
    this.boxCache = null;
    this.drag = { pointerId: event.pointerId, startY: event.clientY, moved: false };
    this.handle.setPointerCapture?.(event.pointerId);
    this.handle.classList.add('is-dragging');
    this.handle.addEventListener('pointermove', this.onPointerMove);
    this.handle.addEventListener('pointerup', this.onPointerUp);
    this.handle.addEventListener('pointercancel', this.onPointerCancel);
    this.view.dom.ownerDocument.addEventListener('keydown', this.onKeyDown, true);
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    if (Math.abs(event.clientY - this.drag.startY) > 3) this.drag.moved = true;
    if (!this.drag.moved) return;
    this.autoScroll(event.clientY);
    this.showIndicator(event.clientY);
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    const { moved } = this.drag;
    const from = blockDragKey.getState(this.view.state)?.from ?? null;
    if (moved) {
      // Positions are read now, from the document as it is, peers' edits included.
      dropBlock(this.view, dropTarget(this.boxes(), event.clientY, this.end).pos);
    } else {
      cancelBlockDrag(this.view);
      if (from !== null) {
        const { state } = this.view;
        this.view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, from)));
      }
    }
    this.endDrag();
    this.view.focus();
  };

  private readonly onPointerCancel = () => {
    cancelBlockDrag(this.view);
    this.endDrag();
  };

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !this.drag) return;
    event.preventDefault();
    event.stopPropagation();
    cancelBlockDrag(this.view);
    this.endDrag();
  };

  private get end(): number {
    return this.view.state.doc.content.size;
  }

  private showIndicator(y: number) {
    const boxes = this.boxes();
    const target = dropTarget(boxes, y, this.end);
    const from = blockDragKey.getState(this.view.state)?.from;
    const source = boxes.findIndex((box) => box.pos === from);
    // Dropping right above or below itself would not move the block.
    if (source >= 0 && (target.index === source || target.index === source + 1)) {
      this.indicator.hidden = true;
      return;
    }
    const origin = this.container.getBoundingClientRect();
    const editor = this.view.dom.getBoundingClientRect();
    const before = boxes[target.index - 1];
    const after = boxes[target.index];
    const line =
      before && after
        ? (before.bottom + after.top) / 2
        : after
          ? after.top - 2
          : before!.bottom + 2;
    this.indicator.hidden = false;
    this.indicator.style.top = `${line - origin.top + this.container.scrollTop - 1}px`;
    this.indicator.style.left = `${editor.left - origin.left}px`;
    this.indicator.style.width = `${editor.width}px`;
  }

  private autoScroll(y: number) {
    const scroller = scrollParent(this.view.dom);
    const isPage = scroller === scroller.ownerDocument.scrollingElement;
    const top = isPage ? 0 : scroller.getBoundingClientRect().top;
    const bottom = isPage
      ? scroller.ownerDocument.defaultView!.innerHeight
      : scroller.getBoundingClientRect().bottom;
    const was = scroller.scrollTop;
    if (y < top + EDGE) scroller.scrollTop -= SCROLL_STEP;
    else if (y > bottom - EDGE) scroller.scrollTop += SCROLL_STEP;
    if (scroller.scrollTop !== was) this.boxCache = null;
  }

  private endDrag() {
    if (this.drag && this.handle.hasPointerCapture?.(this.drag.pointerId)) {
      this.handle.releasePointerCapture(this.drag.pointerId);
    }
    this.drag = null;
    this.boxCache = null;
    this.indicator.hidden = true;
    this.handle.classList.remove('is-dragging');
    this.handle.removeEventListener('pointermove', this.onPointerMove);
    this.handle.removeEventListener('pointerup', this.onPointerUp);
    this.handle.removeEventListener('pointercancel', this.onPointerCancel);
    this.view.dom.ownerDocument.removeEventListener('keydown', this.onKeyDown, true);
  }
}

export const dragHandleKey = new PluginKey('penmossDragHandle');

/** The handle and drop line, for editable views. */
export function dragHandlePlugin(): Plugin {
  return new Plugin({
    key: dragHandleKey,
    view: (view) => new DragHandleView(view),
  });
}

/** Moving top-level blocks: the drag handle, and Alt-Shift-ArrowUp/ArrowDown for the caret's block. */
export const BlockMove = Extension.create({
  name: 'blockMove',

  addKeyboardShortcuts() {
    const run = (dir: -1 | 1) => () =>
      moveSelectedBlock(dir)(this.editor.state, this.editor.view.dispatch, this.editor.view);
    return { 'Alt-Shift-ArrowUp': run(-1), 'Alt-Shift-ArrowDown': run(1) };
  },

  addProseMirrorPlugins() {
    return [blockDragPlugin, dragHandlePlugin()];
  },
});
