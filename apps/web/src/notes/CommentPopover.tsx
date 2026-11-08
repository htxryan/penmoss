/**
 * A comment floating over the note at its passage (T52 item 5, web and Mac): the composer for a
 * new thread on the selection (the toolbar's Comment, `editor.comment`), or a thread opened from
 * its passage, its marker or the Comments list. It sits below the passage, or above it when
 * there is more room there, and is placed again as the note scrolls, the window resizes and the
 * text changes. Escape (or Cancel, or ×) closes it and gives the editor its focus back; the
 * Comments tab still lists every thread.
 */
import type { PlacedThread } from '@penmoss/sync-client/comments';
import type { Yjs14Replica } from '@penmoss/sync-client/yjs14';
import {
  anchorRange,
  rangeRect,
  threadRange,
  type CollabEditor,
  type SelectionAnchor,
} from '@penmoss/editor';
import { Icon } from '@penmoss/ui/icons';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CommentDraft, CommentThread } from './CommentsPanel';
import { placePopover, type PopoverPlace } from './popover-place';

/** What floats: a new thread's composer, or a thread (`focus`: its reply takes focus). */
export type FloatingComment =
  | { readonly kind: 'draft'; readonly draft: SelectionAnchor }
  | { readonly kind: 'thread'; readonly id: string; readonly focus: boolean };

export function CommentPopover({
  editor,
  noteId,
  replica,
  threads,
  floating,
  onClose,
  onCreated,
}: {
  readonly editor: CollabEditor['editor'] | null;
  readonly noteId: string;
  readonly replica: Yjs14Replica;
  readonly threads: readonly PlacedThread[];
  readonly floating: FloatingComment;
  /** `refocus`: give the editor its focus back (Escape, Cancel, ×). */
  readonly onClose: (refocus: boolean) => void;
  readonly onCreated: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<PopoverPlace | null>(null);
  const placed =
    floating.kind === 'thread'
      ? (threads.find((each) => each.thread.id === floating.id) ?? null)
      : null;
  const gone = floating.kind === 'thread' && !placed;

  // Placed at the passage now, and again whenever anything could move it.
  useLayoutEffect(() => {
    if (!editor || gone) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const element = ref.current;
      if (!element || editor.isDestroyed) return;
      const range =
        floating.kind === 'draft'
          ? anchorRange(editor.state, floating.draft.anchor)
          : threadRange(editor.state, floating.id);
      const box = range ? rangeRect(editor.view, range.from, range.to) : null;
      // Its text went (an orphan): it stays where it was.
      if (!box) return;
      const next = placePopover(
        box,
        { width: element.offsetWidth, height: element.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      );
      setPlace((previous) =>
        previous &&
        previous.top === next.top &&
        previous.left === next.left &&
        previous.side === next.side
          ? previous
          : next,
      );
    };
    const schedule = () => {
      frame ||= requestAnimationFrame(measure);
    };
    measure();
    // Scrolling in any of the note's scrollers, and the window's size.
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    editor.on('transaction', schedule);
    const resized =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule());
    if (ref.current) resized?.observe(ref.current);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      editor.off('transaction', schedule);
      resized?.disconnect();
    };
  }, [editor, floating, gone]);

  // A thread deleted meanwhile (on another device) closes.
  useEffect(() => {
    if (gone) onClose(false);
  }, [gone, onClose]);

  // A click outside closes it (not one on another passage, which opens that one): a thread
  // always, a new thread's composer only while nothing is typed in it, so no words are lost.
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || ref.current?.contains(target) || target.closest('[data-thread]')) return;
      if (floating.kind === 'draft') {
        const typed = ref.current?.querySelector('textarea')?.value.trim() ?? '';
        if (typed !== '') return;
      }
      onClose(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [floating.kind, onClose]);

  // A thread opened by a click on its passage leaves the caret in the note: Escape there closes
  // it too (A964). ProseMirror takes every Escape in the editor (it always prevents its default),
  // so this listens first, in the capture phase, and leaves the key alone while one of the
  // editor's menus is open (the slash menu, a link's suggestions mark the editor
  // `aria-haspopup`): that menu's Escape closes the menu only.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const dom = editor.view.dom;
    const onEditorKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      if (dom.hasAttribute('aria-haspopup')) return;
      // As for a click outside: a new thread's composer only while nothing is typed in it.
      if (floating.kind === 'draft') {
        const typed = ref.current?.querySelector('textarea')?.value.trim() ?? '';
        if (typed !== '') return;
      }
      onClose(true);
    };
    dom.addEventListener('keydown', onEditorKeyDown, true);
    return () => dom.removeEventListener('keydown', onEditorKeyDown, true);
  }, [editor, floating.kind, onClose]);

  // Focus goes in, and again once it is placed: until then it is measured hidden
  // (`visibility: hidden`), and a browser gives no focus to a hidden field, so the composer's
  // own autofocus, on mount, was lost.
  const shown = place !== null;
  useEffect(() => {
    const element = ref.current;
    if (floating.kind === 'draft') element?.querySelector<HTMLElement>('textarea')?.focus();
    else if (floating.focus) {
      // Its reply, or for a resolved one its first button past Close.
      (
        element?.querySelector<HTMLElement>('textarea') ??
        element?.querySelector<HTMLElement>('.comment-thread button')
      )?.focus();
    }
  }, [floating, shown]);

  if (gone) return null;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
    event.preventDefault();
    // Not the note panel's Escape too.
    event.stopPropagation();
    onClose(true);
  };
  const label = floating.kind === 'draft' ? 'New Comment' : 'Comment Thread';
  return (
    <div
      ref={ref}
      className="comment-popover"
      role="dialog"
      aria-label={label}
      data-side={place?.side}
      data-testid="comment-popover"
      style={
        place
          ? { top: `${place.top}px`, left: `${place.left}px` }
          : // Measured before it shows, so it never flashes in the corner.
            { top: 0, left: 0, visibility: 'hidden' }
      }
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        className="icon-btn comment-popover-close"
        data-ui="dismiss"
        aria-label="Close"
        data-tip="Close"
        onClick={() => onClose(true)}
        data-testid="comment-popover-close"
      >
        <Icon name="close" size={14} />
      </button>
      {floating.kind === 'draft' ? (
        <CommentDraft
          noteId={noteId}
          replica={replica}
          draft={floating.draft}
          onCancel={() => onClose(true)}
          onCreated={onCreated}
        />
      ) : placed ? (
        <CommentThread
          placed={placed}
          noteId={noteId}
          replica={replica}
          active
          floating
          onActivate={() => undefined}
          onResolved={() => onClose(true)}
        />
      ) : null}
    </div>
  );
}
