/**
 * The app's toasts (PEN-63): one stack at the bottom centre of the window, newest at the
 * bottom, at most three. Plain messages go through `showToast`; a toast with its own state
 * and controls (Trash's Undo, Feedback's link) keeps its logic and renders into the stack
 * through a `ToastSlot`, which takes its place in the same order.
 */
import { useSyncExternalStore } from 'react';

/** What a toast reports: a success (a check), a refusal or failure (a warning), or neither. */
export type ToastTone = 'done' | 'error' | 'info';

/** At most this many show at once; a fourth drops the oldest. */
export const MAX_TOASTS = 3;

/** How long a text toast shows unless it says otherwise. */
export const TOAST_MS = 6000;

/** How long a text toast takes to fade out (the stylesheet's `--pm-fast`). */
export const LEAVE_MS = 120;

export interface TextToast {
  readonly kind: 'text';
  readonly id: number;
  readonly text: string;
  readonly tone: ToastTone;
  readonly testId?: string;
  /** Fading out, for `LEAVE_MS`, before it goes. */
  readonly leaving?: boolean;
}

/** A place in the stack held by a component that renders its own toast. */
export interface SlotToast {
  readonly kind: 'slot';
  readonly id: number;
}

export type ToastEntry = TextToast | SlotToast;

export interface ShowToast {
  readonly text: string;
  readonly tone?: ToastTone;
  /** The toast's `data-testid`; a newer toast with the same one replaces it. */
  readonly testId?: string;
  /** How long it shows, in milliseconds. */
  readonly ms?: number;
}

export class Toasts {
  private entries: readonly ToastEntry[] = [];
  private next = 1;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<() => void>();

  /** Every entry, oldest first, those past the cap included (a slot waits its turn). */
  all = (): readonly ToastEntry[] => this.entries;

  /** What shows: the newest `MAX_TOASTS`, oldest first. */
  shown = (): readonly ToastEntry[] => this.shownCache;
  private shownCache: readonly ToastEntry[] = [];

  /** Shows `toast` at the bottom of the stack; returns a function that takes it away. */
  show(toast: ShowToast): () => void {
    const id = this.next++;
    const kept = toast.testId
      ? this.entries.filter((each) => !(each.kind === 'text' && each.testId === toast.testId))
      : this.entries;
    for (const each of this.entries) if (!kept.includes(each)) this.clearTimer(each.id);
    const entry: TextToast = {
      kind: 'text',
      id,
      text: toast.text,
      tone: toast.tone ?? 'info',
      ...(toast.testId ? { testId: toast.testId } : {}),
    };
    this.timers.set(
      id,
      setTimeout(() => this.dismiss(id), toast.ms ?? TOAST_MS),
    );
    this.update([...kept, entry]);
    return () => this.dismiss(id);
  }

  /** An id for a slot to hold its place by. */
  reserve(): number {
    return this.next++;
  }

  /** Holds a place at the bottom for a component's own toast; returns its id. */
  hold(id: number = this.reserve()): number {
    const kept = this.entries.filter((each) => each.id !== id);
    this.update([...kept, { kind: 'slot', id }]);
    return id;
  }

  /** Takes a toast away: a text toast fades first, a slot goes at once. */
  dismiss(id: number): void {
    this.clearTimer(id);
    const entry = this.entries.find((each) => each.id === id);
    if (!entry) return;
    if (entry.kind === 'text' && !entry.leaving) {
      this.timers.set(
        id,
        setTimeout(() => this.remove(id), LEAVE_MS),
      );
      this.update(
        this.entries.map((each) => (each === entry ? { ...entry, leaving: true } : each)),
      );
      return;
    }
    this.remove(id);
  }

  private remove(id: number): void {
    this.clearTimer(id);
    if (!this.entries.some((each) => each.id === id)) return;
    this.update(this.entries.filter((each) => each.id !== id));
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private clearTimer(id: number): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(id);
  }

  private update(entries: readonly ToastEntry[]): void {
    // Past the cap, the oldest text toasts go; a slot past it waits until there is room.
    let over = entries.length - MAX_TOASTS;
    const kept: ToastEntry[] = [];
    for (const each of entries) {
      if (over > 0 && each.kind === 'text') {
        over--;
        this.clearTimer(each.id);
        continue;
      }
      kept.push(each);
    }
    this.entries = kept;
    this.shownCache = kept.slice(-MAX_TOASTS);
    for (const listener of this.listeners) listener();
  }
}

/** This window's toasts: each window (a note window too) has its own stack. */
export const toasts = new Toasts();

/** Shows a toast at the bottom centre of this window (PEN-63). */
export function showToast(toast: ShowToast): () => void {
  return toasts.show(toast);
}

export function useShownToasts(): readonly ToastEntry[] {
  return useSyncExternalStore(toasts.subscribe, toasts.shown, toasts.shown);
}

/** Where each slot renders: its place in the stack, by id, while it shows. */
class SlotElements {
  private readonly elements = new Map<number, HTMLElement>();
  private readonly listeners = new Set<() => void>();
  get = (id: number): HTMLElement | null => this.elements.get(id) ?? null;
  set(id: number, element: HTMLElement | null): void {
    if ((this.elements.get(id) ?? null) === element) return;
    if (element) this.elements.set(id, element);
    else this.elements.delete(id);
    for (const listener of this.listeners) listener();
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export const slotElements = new SlotElements();

export function useSlotElement(id: number | null): HTMLElement | null {
  const get = () => (id === null ? null : slotElements.get(id));
  return useSyncExternalStore(slotElements.subscribe, get, get);
}
