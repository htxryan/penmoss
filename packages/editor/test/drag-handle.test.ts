import { describe, expect, it, vi } from 'vitest';
import type { Replica } from '@penmoss/sync-client';
import { blockDragKey } from '../src/extensions/block-move';
import {
  blockAtY,
  dropTarget,
  topLevelBlockAt,
  type BlockBox,
} from '../src/extensions/drag-handle';
import { openEditor, paragraph } from './support/editor';

// Three blocks: 0–20, 30–80 and 90–100 on screen, starting at positions 0, 5 and 12.
const boxes: BlockBox[] = [
  { pos: 0, top: 0, bottom: 20 },
  { pos: 5, top: 30, bottom: 80 },
  { pos: 12, top: 90, bottom: 100 },
];

describe('blockAtY', () => {
  it('finds the block under the pointer, with a little slack between blocks', () => {
    expect(blockAtY(boxes, 10)?.pos).toBe(0);
    expect(blockAtY(boxes, 55)?.pos).toBe(5);
    expect(blockAtY(boxes, 22)?.pos).toBe(0);
    expect(blockAtY(boxes, 28)?.pos).toBe(5);
    expect(blockAtY(boxes, 95)?.pos).toBe(12);
  });

  it('finds nothing far above or below the blocks, or in an empty note', () => {
    expect(blockAtY(boxes, -20)).toBeNull();
    expect(blockAtY(boxes, 130)).toBeNull();
    expect(blockAtY([], 10)).toBeNull();
  });
});

describe('dropTarget', () => {
  it('lands before the first block whose middle is below the pointer', () => {
    expect(dropTarget(boxes, -5, 20)).toEqual({ pos: 0, index: 0 });
    expect(dropTarget(boxes, 9, 20)).toEqual({ pos: 0, index: 0 });
    expect(dropTarget(boxes, 11, 20)).toEqual({ pos: 5, index: 1 });
    expect(dropTarget(boxes, 54, 20)).toEqual({ pos: 5, index: 1 });
    expect(dropTarget(boxes, 56, 20)).toEqual({ pos: 12, index: 2 });
  });

  it('lands at the end of the note below the last block’s middle', () => {
    expect(dropTarget(boxes, 96, 20)).toEqual({ pos: 20, index: 3 });
    expect(dropTarget(boxes, 500, 20)).toEqual({ pos: 20, index: 3 });
    expect(dropTarget([], 0, 2)).toEqual({ pos: 2, index: 0 });
  });
});

describe('drag handle view', () => {
  it('adds a labelled, hidden handle and drop line beside the editor, writing nothing', () => {
    const collab = openEditor([paragraph('a'), paragraph('b')]);
    const updates: Uint8Array[] = [];
    collab.replica.onUpdate((update) => updates.push(update));
    const container = collab.editor.view.dom.parentElement!;
    const handle = container.querySelector<HTMLButtonElement>('.pm-drag-handle')!;
    expect(handle.getAttribute('aria-label')).toBe('Drag to Move Block');
    expect(handle.getAttribute('aria-keyshortcuts')).toBe('Alt+Shift+ArrowUp Alt+Shift+ArrowDown');
    expect(handle.hidden).toBe(true);
    expect(container.querySelector('.pm-drop-indicator')!.getAttribute('aria-hidden')).toBe('true');
    container.dispatchEvent(new MouseEvent('mousemove', { clientX: 5, clientY: 5, bubbles: true }));
    expect(updates).toEqual([]);
    collab.destroy();
    expect(container.querySelector('.pm-drag-handle')).toBeNull();
  });
});

describe('topLevelBlockAt', () => {
  it('finds the top-level block around a position, a nested one, or an atom', () => {
    const collab = openEditor([
      paragraph('a'),
      { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('item')] }] },
      { type: 'blockMath', attrs: { latex: 'x' } },
    ]);
    const { doc } = collab.editor.state;
    // paragraph 0–3, list 3–13, formula 13–14, trailing paragraph 14–16.
    expect(topLevelBlockAt(doc, 1, -1)).toBe(0);
    expect(topLevelBlockAt(doc, 7, 5)).toBe(3);
    expect(topLevelBlockAt(doc, 13, 13)).toBe(13);
    expect(topLevelBlockAt(doc, 3, -1)).toBe(3);
    expect(topLevelBlockAt(doc, doc.content.size, -1)).toBe(14);
  });
});

/** Two editors on one note; the first gets a stubbed hit test (happy-dom has no layout). */
function hoverable(texts: string[]) {
  const a = openEditor(texts.map((text) => paragraph(text)));
  const b = openEditor();
  const sync = (from: Replica, to: Replica) =>
    to.applyUpdate(from.encodeStateAsUpdate(to.encodeStateVector()), 'remote');
  sync(a.replica, b.replica);
  const view = a.editor.view;
  const container = view.dom.parentElement!;
  const handle = container.querySelector<HTMLButtonElement>('.pm-drag-handle')!;
  const hover = async (pos: number) => {
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos, inside: -1 });
    container.dispatchEvent(new MouseEvent('mousemove', { clientX: 5, clientY: 5, bubbles: true }));
    await vi.waitFor(() => expect(handle.hidden).toBe(false));
  };
  return { a, b, view, container, handle, hover, sync };
}

describe('drag handle view: hover and remote edits', () => {
  it('measures only the hovered block, not every block', async () => {
    const { view, hover } = hoverable(['one', 'two', 'three', 'four']);
    const blocks = new Set<Element>();
    view.state.doc.forEach((_node, pos) => blocks.add(view.nodeDOM(pos) as Element));
    const measured: Element[] = [];
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        measured.push(this);
        return new DOMRect(0, 0, 0, 0);
      });
    try {
      await hover(6);
      expect(measured.filter((element) => blocks.has(element))).toHaveLength(1);
    } finally {
      rect.mockRestore();
    }
  });

  it('stays beside its block through a remote edit elsewhere, and hides when its block changes', async () => {
    const { a, b, handle, hover, sync } = hoverable(['one', 'two', 'three']);
    await hover(6); // in "two"
    // A peer types into "one", above the hovered block.
    b.editor.chain().setTextSelection(2).insertContent('!').run();
    sync(b.replica, a.replica);
    expect(a.editor.state.doc.firstChild!.textContent).toBe('o!ne');
    expect(handle.hidden).toBe(false);
    // A peer edits the hovered block itself.
    b.editor.chain().setTextSelection(8).insertContent('?').run();
    sync(b.replica, a.replica);
    expect(handle.hidden).toBe(true);
  });
});

describe('drag handle view: teardown', () => {
  it('leaves no handle, drop line or listeners when the editor is destroyed mid-drag', async () => {
    const { a, view, container, handle, hover } = hoverable(['one', 'two']);
    await hover(1);
    const removedFromDocument: string[] = [];
    const remove = vi.spyOn(document, 'removeEventListener').mockImplementation(function (
      this: Document,
      ...args: Parameters<Document['removeEventListener']>
    ) {
      removedFromDocument.push(args[0]);
      return EventTarget.prototype.removeEventListener.apply(this, args);
    });
    const removedFromContainer: string[] = [];
    const removeHere = vi.spyOn(container, 'removeEventListener').mockImplementation(function (
      this: HTMLElement,
      ...args: Parameters<HTMLElement['removeEventListener']>
    ) {
      removedFromContainer.push(args[0]);
      return EventTarget.prototype.removeEventListener.apply(this, args);
    });
    try {
      handle.dispatchEvent(
        new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientY: 5, bubbles: true }),
      );
      expect(blockDragKey.getState(view.state)).not.toBeNull();
      a.destroy();
      expect(container.querySelector('.pm-drag-handle')).toBeNull();
      expect(container.querySelector('.pm-drop-indicator')).toBeNull();
      expect(removedFromDocument).toContain('keydown');
      expect(removedFromContainer).toEqual(expect.arrayContaining(['mousemove', 'mouseleave']));
    } finally {
      remove.mockRestore();
      removeHere.mockRestore();
    }
  });
});
