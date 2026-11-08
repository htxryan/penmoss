import type { ReactNode } from 'react';
import { SourceScope } from './context';
import { useNoteSource, useSourcesRegistry } from './hooks';

/**
 * A note's view in the source that holds it (T50 G3, A820, A862): `/notes/:id` and note windows
 * find the source by the id, so a link or a window opens the right source's note, and what the
 * view does (links, embeds, moves, history) stays in that source.
 */
export function NoteSourceScope({ id, children }: { id: string; children: ReactNode }) {
  const sources = useSourcesRegistry();
  const source = useNoteSource(id);
  if (!sources) return children;
  if (!source) {
    return (
      <p className="graph-loading" role="status">
        <span className="spinner" aria-hidden="true" />
        Opening the note…
      </p>
    );
  }
  return <SourceScope source={source}>{children}</SourceScope>;
}
