import { isShortNoteRef } from '@penmoss/core/note-ref';
import { useEffect, useState, type ReactNode } from 'react';
import { navigate, notePath } from '../router';
import { SourceScope } from './context';
import { useAllSources, useNoteSource, useSourcesRegistry } from './hooks';
import { noteOfShortRef, type ShortRefTarget } from './short-ref';

/**
 * A note's view in the source that holds it (T50 G3, A820, A862): `/notes/:id` and note windows
 * find the source by the id, so a link or a window opens the right source's note, and what the
 * view does (links, embeds, moves, history) stays in that source. A short reference (PEN-69,
 * `/notes/K7QD-9HTF2CXA`) is replaced by the note's own path once its notebook names the note.
 */
export function NoteSourceScope({ id, children }: { id: string; children: ReactNode }) {
  if (isShortNoteRef(id)) return <ShortRef id={id} />;
  return <ById id={id}>{children}</ById>;
}

function ById({ id, children }: { id: string; children: ReactNode }) {
  const sources = useSourcesRegistry();
  const source = useNoteSource(id);
  if (!sources) return children;
  if (!source) return <Opening />;
  return <SourceScope source={source}>{children}</SourceScope>;
}

function Opening() {
  return (
    <p className="graph-loading" role="status">
      <span className="spinner" aria-hidden="true" />
      Opening the note…
    </p>
  );
}

/** Finds the note a short reference names, then opens it by its id. */
function ShortRef({ id }: { id: string }) {
  const state = useAllSources();
  const [target, setTarget] = useState<ShortRefTarget | null>(null);
  useEffect(() => {
    const all = state?.all ?? [];
    const check = () => setTarget(noteOfShortRef(id, all));
    check();
    // A notebook's notes are read after it opens: check again as they come.
    const offs = all.map((source) => source.workspace.subscribe(check));
    return () => offs.forEach((off) => off());
  }, [id, state]);
  useEffect(() => {
    if (target?.kind === 'note') navigate(notePath(target.id), { replace: true });
  }, [target]);
  if (state?.loaded && target?.kind === 'no-notebook') {
    return (
      <p className="graph-loading" role="status">
        No notebook on this Mac holds the note {id}.
      </p>
    );
  }
  return <Opening />;
}
