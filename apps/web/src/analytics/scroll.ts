/**
 * `scroll <area>` (PEN-175): how far down each of the page's scrolled areas is, so a replay can
 * show what the person saw. The rules are core's (`@penmoss/core/analytics`, scroll.ts): the
 * position is the area's offset over how far it can scroll, in hundredths; it is recorded once the
 * area has been still for 300 ms, at most once a second per area (a sooner one is held, and the
 * latest recorded when the gap is up), and not when it equals the area's last one. That memory
 * goes back to the top when the area's content changes (another note, another Settings page).
 *
 * The page keeps one gate per area (`scrollGate`), whatever element is scrolled in it: a note
 * window's note is `note` too. Each scroller calls `useScrollArea` with its area, its element and
 * what it shows. A preview (`PreviewCommands`: Settings → Sidebar's, the app in miniature, the
 * badges') records nothing: `NoScrollRecording` turns the hook off inside it. This sits beside
 * the tab's own memory of its place (`useTabScroll`), which it does not replace.
 */
import { createContext, createElement, useContext, useEffect, useRef, type ReactNode } from 'react';
import { fractionOf, realScrollClock, ScrollGate, type ScrollClock } from '@penmoss/core/analytics';
import { record } from './record';

/** The areas the page records, as core's SCROLL_NAMES names them. */
export type ScrollArea =
  | 'note'
  | 'sidebar'
  | 'sidebar.folders'
  | 'sidebar.recent'
  | 'sidebar.tags'
  | 'settings'
  | 'settings.nav';

type Emit = (area: ScrollArea, position: number) => void;

const recordScroll: Emit = (area, position) => record('scroll', area, { position });

let emit: Emit = recordScroll;
let clock: ScrollClock = realScrollClock;
const gates = new Map<ScrollArea, ScrollGate>();

/** The page's gate for `area`: one per area, made the first time it is asked for. */
function scrollGate(area: ScrollArea): ScrollGate {
  let gate = gates.get(area);
  if (!gate) {
    gate = new ScrollGate((position) => emit(area, position), clock);
    gates.set(area, gate);
  }
  return gate;
}

/** Fresh gates that emit to `next` (tests); with none, the page's recorder again. */
export function resetScrollTracking(next: Emit = recordScroll, nextClock = realScrollClock): void {
  for (const gate of gates.values()) gate.stop();
  gates.clear();
  emit = next;
  clock = nextClock;
}

/** Where an element is scrolled, or the page's own scroller (`'page'`), as a fraction. */
function positionOf(element: HTMLElement | 'page'): number | null {
  const box =
    element === 'page' ? (document.scrollingElement ?? document.documentElement) : element;
  return fractionOf(box.scrollTop, box.scrollHeight, box.clientHeight);
}

const Recording = createContext(true);

/** Inside it, nothing records where it is scrolled (a preview, which is not the person's). */
export function NoScrollRecording({ children }: { readonly children: ReactNode }) {
  return createElement(Recording.Provider, { value: false }, children);
}

/**
 * Records where `target` is scrolled as `area` while the calling component is mounted: the
 * element in `ref`, or `'page'` where the page itself scrolls (Settings on a narrow window). A
 * null area records nothing. When `contentKey` changes (another note, another Settings page), the
 * area's last position is the top again and what waits is dropped. The element is read after
 * each render, so one that comes later (a note once it loads) is listened to then.
 */
export function useScrollArea(
  area: ScrollArea | null,
  target: { readonly current: HTMLElement | null } | 'page',
  contentKey: unknown,
): void {
  const recording = useContext(Recording);
  const active = recording ? area : null;
  const attached = useRef<{
    readonly area: ScrollArea;
    readonly element: HTMLElement | 'page';
    readonly detach: () => void;
  } | null>(null);

  // After each render: listen to the element now in `target`, if it changed.
  useEffect(() => {
    const element = target === 'page' ? 'page' : target.current;
    const now = attached.current;
    if (now && now.area === active && now.element === element) return;
    now?.detach();
    attached.current = null;
    if (!active || !element) return;
    const gate = scrollGate(active);
    const onScroll = () => gate.moved(positionOf(element));
    const on: HTMLElement | Window = element === 'page' ? window : element;
    on.addEventListener('scroll', onScroll, { passive: true });
    attached.current = {
      area: active,
      element,
      detach: () => on.removeEventListener('scroll', onScroll),
    };
  });

  // The content changed (or the area came): its memory goes back to the top.
  useEffect(() => {
    if (!active) return;
    const gate = scrollGate(active);
    gate.reset();
    return () => gate.stop();
  }, [active, contentKey]);

  // Gone: no more listening.
  useEffect(
    () => () => {
      attached.current?.detach();
      attached.current = null;
    },
    [],
  );
}
