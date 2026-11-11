import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEAVE_MS, MAX_TOASTS, TOAST_MS, Toasts, type ToastEntry } from '../../src/toasts/toasts';

// PEN-63: one stack of toasts per window, newest at the bottom, at most three.
const texts = (entries: readonly ToastEntry[]) =>
  entries.map((entry) => (entry.kind === 'text' ? entry.text : `slot ${entry.id}`));

describe('Toasts (PEN-63)', () => {
  let toasts: Toasts;
  beforeEach(() => {
    vi.useFakeTimers();
    toasts = new Toasts();
  });
  afterEach(() => vi.useRealTimers());

  it('stacks newest last, with a tone and a test id', () => {
    toasts.show({ text: 'One', tone: 'done', testId: 'a' });
    toasts.show({ text: 'Two', tone: 'error' });
    expect(texts(toasts.shown())).toEqual(['One', 'Two']);
    expect(toasts.shown()[0]).toMatchObject({ tone: 'done', testId: 'a' });
    expect(toasts.shown()[1]).toMatchObject({ tone: 'error' });
    expect(toasts.shown()[1]).not.toHaveProperty('testId');
  });

  it('shows at most three: a fourth drops the oldest', () => {
    expect(MAX_TOASTS).toBe(3);
    for (const text of ['One', 'Two', 'Three', 'Four']) toasts.show({ text });
    expect(texts(toasts.shown())).toEqual(['Two', 'Three', 'Four']);
    expect(texts(toasts.all())).toEqual(['Two', 'Three', 'Four']);
  });

  it('goes after its time, fading for a moment first', () => {
    toasts.show({ text: 'Default' });
    toasts.show({ text: 'Short', ms: 1000 });
    vi.advanceTimersByTime(1000);
    expect(toasts.shown()[1]).toMatchObject({ text: 'Short', leaving: true });
    vi.advanceTimersByTime(LEAVE_MS);
    expect(texts(toasts.shown())).toEqual(['Default']);
    vi.advanceTimersByTime(TOAST_MS - 1000 - LEAVE_MS - 1);
    expect(texts(toasts.shown())).toEqual(['Default']);
    vi.advanceTimersByTime(1 + LEAVE_MS);
    expect(toasts.shown()).toEqual([]);
  });

  it('replaces an older toast with the same test id, and moves it to the bottom', () => {
    toasts.show({ text: 'Moved', testId: 'tree-message' });
    toasts.show({ text: 'Copied', testId: 'copy-status' });
    toasts.show({ text: 'Refused', testId: 'tree-message', tone: 'error' });
    expect(texts(toasts.shown())).toEqual(['Copied', 'Refused']);
    // The replaced one's timer no longer runs: the new one keeps its full time.
    vi.advanceTimersByTime(TOAST_MS - 1);
    expect(texts(toasts.shown())).toContain('Refused');
  });

  it('dismisses through what show returns', () => {
    const dismiss = toasts.show({ text: 'One' });
    dismiss();
    vi.advanceTimersByTime(LEAVE_MS);
    expect(toasts.shown()).toEqual([]);
  });

  it('keeps a slot in order; past the cap it waits, a text toast goes', () => {
    toasts.show({ text: 'One' });
    const slot = toasts.hold();
    toasts.show({ text: 'Two' });
    expect(texts(toasts.shown())).toEqual(['One', `slot ${slot}`, 'Two']);
    toasts.show({ text: 'Three' });
    expect(texts(toasts.shown())).toEqual([`slot ${slot}`, 'Two', 'Three']);
    // Slots have no timer: they go when their component says.
    vi.advanceTimersByTime(TOAST_MS + LEAVE_MS);
    expect(texts(toasts.shown())).toEqual([`slot ${slot}`]);
    toasts.dismiss(slot);
    expect(toasts.shown()).toEqual([]);
  });

  it('lets an older slot wait past the cap rather than drop it', () => {
    const slots = [toasts.hold(), toasts.hold(), toasts.hold(), toasts.hold()];
    expect(texts(toasts.shown())).toEqual(slots.slice(1).map((id) => `slot ${id}`));
    toasts.dismiss(slots[3]!);
    expect(texts(toasts.shown())).toEqual(slots.slice(0, 3).map((id) => `slot ${id}`));
  });

  it('tells its listeners of each change', () => {
    const listener = vi.fn();
    const stop = toasts.subscribe(listener);
    toasts.show({ text: 'One' });
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    toasts.show({ text: 'Two' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
