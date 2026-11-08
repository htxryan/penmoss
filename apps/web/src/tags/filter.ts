/**
 * The tag the sidebar filters by (T18), one per tab: the tag pane and the
 * chips under a note's title set it, the sidebar shows the matching notes
 * while it is set. Not synced: it is a view, like a scroll position.
 */
import { useSyncExternalStore } from 'react';

export class TagFilter {
  private current: string | null = null;
  private readonly listeners = new Set<() => void>();

  get = (): string | null => this.current;

  set(tag: string | null): void {
    if (tag === this.current) return;
    this.current = tag;
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export const tagFilter = new TagFilter();

export function useTagFilter(): string | null {
  return useSyncExternalStore(tagFilter.subscribe, tagFilter.get, tagFilter.get);
}
