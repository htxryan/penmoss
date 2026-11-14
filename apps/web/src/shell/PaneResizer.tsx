import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { clampPane, PANE_LIMITS, type PaneKind } from './pane-widths';

const rootRem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

/**
 * The edge a pane is resized by (A1122): a drag moves it, live, and keeps the width when the
 * pointer lets go; from the keyboard (it is a focusable separator) ← and → move it by a rem,
 * four with Shift, and Home and End go to the narrowest and widest; a double-click goes back to
 * the pane's first width. `edge` is the pane's side it is on: the sidebar's end, the panel's
 * start, so dragging away from the pane widens it either way. A `horizontal` one (History's
 * split, Ryan's review of #192, finding 13) sizes a pane's height the same way, with ↑ and ↓; its
 * edge `start` is the pane's top.
 */
export function PaneResizer({
  kind,
  label,
  width,
  room,
  edge,
  preview,
  commit,
  testId,
  orientation = 'vertical',
}: {
  kind: PaneKind;
  label: string;
  /** The pane's width now, in rem. */
  width: number;
  /** A narrower widest than the kind's own, in rem: the room the window leaves, asked as a drag starts. */
  room?: () => number;
  edge: 'end' | 'start';
  /** Shows a width while it is dragged, without keeping it. */
  preview: (rem: number) => void;
  /** Keeps a width. */
  commit: (rem: number) => void;
  testId: string;
  /** `vertical` (a width, the default) or `horizontal` (a height). */
  orientation?: 'vertical' | 'horizontal';
}) {
  const rows = orientation === 'horizontal';
  const at = (event: PointerEvent<HTMLDivElement>) => (rows ? event.clientY : event.clientX);
  const limits = PANE_LIMITS[kind];
  const widest = () => Math.max(limits.min, Math.min(limits.max, room?.() ?? limits.max));
  const fit = (rem: number, most = widest()) => Math.min(most, clampPane(kind, rem));
  const drag = useRef<{
    x: number;
    from: number;
    rem: number;
    most: number;
    at: number;
  } | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: at(event), from: width, rem: rootRem(), most: widest(), at: width };
    document.documentElement.dataset['resizing'] = rows ? 'rows' : '';
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    const moved = (at(event) - state.x) / state.rem;
    state.at = fit(state.from + (edge === 'end' ? moved : -moved), state.most);
    preview(state.at);
  };
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    delete document.documentElement.dataset['resizing'];
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (state.at !== state.from) commit(state.at);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 4 : 1;
    const [forward, back] = rows ? ['ArrowDown', 'ArrowUp'] : ['ArrowRight', 'ArrowLeft'];
    const wider = edge === 'end' ? forward : back;
    const narrower = edge === 'end' ? back : forward;
    let next: number | null = null;
    if (event.key === wider) next = width + step;
    else if (event.key === narrower) next = width - step;
    else if (event.key === 'Home') next = limits.min;
    else if (event.key === 'End') next = widest();
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    commit(fit(next));
  };

  return (
    // A focusable separator is the ARIA pattern for a splitter, and handles its own keys.
    <div
      role="separator"
      aria-orientation={rows ? 'horizontal' : 'vertical'}
      aria-label={label}
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      aria-valuenow={width}
      aria-valuetext={`${Math.round(width * 16)} pixels ${rows ? 'tall' : 'wide'}`}
      tabIndex={0}
      className="pane-resizer"
      data-edge={edge}
      data-orientation={orientation}
      data-testid={testId}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onDoubleClick={() => commit(fit(limits.initial))}
      onKeyDown={onKeyDown}
    />
  );
}
