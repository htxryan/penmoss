/**
 * A tag's notes are a search (finding 9 of Ryan's review of #192): choosing a tag (in the
 * sidebar's Tags section, a note's tag chips, ⌘-click on an inline #tag, a name on the Tags page)
 * opens Search with its Tag filter set and no words, which lists every note with the tag. The
 * sidebar's Notes section is left as it is. The command overlays, which own Search, open it.
 */
import { useCallback } from 'react';
import { useSource, useSourcesState } from '../sources/hooks';

export interface TagSearch {
  readonly tag: string;
  /** The notebook the tag was chosen in, which Search starts on; null: All Notebooks. */
  readonly notebookId: string | null;
}

export class TagSearchRequest {
  private current: TagSearch | null = null;
  private readonly listeners = new Set<() => void>();

  get = (): TagSearch | null => this.current;

  /** Asks for Search on `request` (null: nothing asked). */
  set(request: TagSearch | null): void {
    this.current = request;
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export const tagSearch = new TagSearchRequest();

/**
 * Shows `tag`'s notes in Search, starting on the notebook in scope here (the note's, or the
 * sidebar's active one) when there are several, otherwise on All Notebooks.
 */
export function useShowTag(): (tag: string) => void {
  const source = useSource();
  const several = (useSourcesState()?.all.length ?? 0) > 1;
  const notebookId = several ? (source?.id ?? null) : null;
  return useCallback((tag: string) => tagSearch.set({ tag, notebookId }), [notebookId]);
}
