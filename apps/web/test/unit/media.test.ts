import { describe, expect, it } from 'vitest';
import { mediaStore, PHONE_QUERY } from '../../src/shell/media';

function fakeMedia(initial: boolean) {
  const listeners = new Set<() => void>();
  const list = {
    matches: initial,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  const queries: string[] = [];
  return {
    listeners,
    queries,
    set(matches: boolean) {
      list.matches = matches;
      for (const listener of listeners) listener();
    },
    matchMedia: (query: string) => {
      queries.push(query);
      return list as unknown as MediaQueryList;
    },
  };
}

describe('mediaStore (T36)', () => {
  it('reads the query and follows its changes', () => {
    const media = fakeMedia(false);
    const store = mediaStore(PHONE_QUERY, media.matchMedia);
    expect(media.queries).toEqual(['(max-width: 700px)']);
    expect(store.getSnapshot()).toBe(false);
    let changes = 0;
    const off = store.subscribe(() => changes++);
    media.set(true);
    expect(store.getSnapshot()).toBe(true);
    expect(changes).toBe(1);
    off();
    expect(media.listeners.size).toBe(0);
    media.set(false);
    expect(changes).toBe(1);
  });

  it('never matches without matchMedia (server rendering)', () => {
    const store = mediaStore(PHONE_QUERY, undefined);
    expect(store.getSnapshot()).toBe(false);
    const off = store.subscribe(() => undefined);
    expect(() => off()).not.toThrow();
  });
});
