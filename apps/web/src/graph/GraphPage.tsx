/**
 * The graph page (T17, `/graph`, `?note=<id>&local=1` for a local graph).
 * Loaded lazily (App.tsx), with d3-force and its styles, so the shell never
 * pays for it.
 */
import { GraphView } from '@penmoss/ui/graph/GraphView';
import { useMemo, useState } from 'react';
import { useNoteList, useNotes } from '../notes/hooks';
import { displayTitle } from '../notes/list';
import { navigate, notePath } from '../router';
import { useClosedNotebooks } from '../workspace/notebooks';
import { useWorkspaceState } from '../workspace/hooks';
import { GraphInputCache } from './data';
import { graphPath } from './path';
import './graph.css';

export interface GraphPageProps {
  readonly note: string | null;
  readonly local: boolean;
}

export function GraphPage({ note, local }: GraphPageProps) {
  const notes = useNotes();
  // The list changes whenever a note's title or content does; links are read with it.
  const list = useNoteList();
  const { snapshot } = useWorkspaceState();
  const closed = useClosedNotebooks();
  const [cache] = useState(() => new GraphInputCache());
  const input = useMemo(
    () =>
      cache.get(notes.localLinks(), {
        folders: snapshot.folders,
        registry: snapshot.notes,
        rootSortMode: snapshot.rootSortMode,
        closed,
      }),
    // `list` stands for the note store's state, which localLinks reads. The cache keeps the
    // same input (so no new layout) unless notes, titles, links or groups changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [notes, list, snapshot, cache, closed],
  );
  const known = note !== null && input.notes.some((entry) => entry.id === note);
  const title = known ? displayTitle(list.find((entry) => entry.id === note)?.title ?? '') : null;

  return (
    <div className="graph-page">
      <h2 className="pm-visually-hidden">Graph</h2>
      <GraphView
        notes={input.notes}
        groups={input.groups}
        note={known ? note : null}
        noteTitle={title}
        local={local && known}
        onLocalChange={(next) => navigate(graphPath(note, next), { replace: true })}
        onOpen={(id, newTab) => {
          if (newTab) window.open(notePath(id), '_blank', 'noopener');
          else navigate(notePath(id));
        }}
      />
    </div>
  );
}
