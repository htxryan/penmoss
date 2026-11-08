import { fuzzyFilter } from '@penmoss/core/fuzzy';
import type { DocJson } from '@penmoss/core/links';
import { vi } from 'vitest';
import type { LinkServices, OpenWhere } from '../../src/extensions/wikilink';

/** An in-memory note registry for link tests. */
export function fakeLinks(
  initial: Record<string, string>,
  headings: Record<string, string[]> = {},
  options: { noteId?: string; bodies?: Record<string, DocJson> } = {},
) {
  const notes = new Map(Object.entries(initial));
  const listeners = new Set<() => void>();
  const bodies = new Map(Object.entries(options.bodies ?? {}));
  const watchers = new Map<string, Set<() => void>>();
  let created = 0;
  const services = {
    title: (id: string) => notes.get(id) ?? null,
    search: (query: string, limit: number) =>
      fuzzyFilter(
        [...notes].map(([id, title]) => ({ id, title })),
        query,
        (note) => note.title,
        limit,
      ),
    resolve: (title: string) =>
      [...notes].find(([, value]) => value.toLowerCase() === title.toLowerCase())?.[0] ?? null,
    create: vi.fn((title: string) => {
      const id = `new${(created += 1)}`;
      notes.set(id, title);
      return id;
    }),
    open: vi.fn<(id: string, heading: string | null, where?: OpenWhere) => void>(),
    headings: (id: string) => Promise.resolve(headings[id] ?? []),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    noteId: options.noteId ?? null,
    body: vi.fn((id: string) => Promise.resolve(bodies.get(id) ?? null)),
    watch: vi.fn((id: string, listener: () => void) => {
      const set = watchers.get(id) ?? new Set();
      watchers.set(id, set);
      set.add(listener);
      return () => set.delete(listener);
    }),
  } satisfies LinkServices;
  return {
    services,
    /** Notes currently watched by an embed. */
    watched: () => [...watchers].filter(([, set]) => set.size > 0).map(([id]) => id),
    /** Replaces a note's body, as an edit synced from elsewhere would. */
    edit(id: string, body: DocJson) {
      bodies.set(id, body);
      for (const listener of watchers.get(id) ?? []) listener();
    },
    /** The note list changed without any title changing (an edit elsewhere). */
    touch() {
      for (const listener of listeners) listener();
    },
    rename(id: string, title: string | null) {
      if (title === null) notes.delete(id);
      else notes.set(id, title);
      for (const listener of listeners) listener();
    },
  };
}
