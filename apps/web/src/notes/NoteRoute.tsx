import { useSyncExternalStore, type ComponentProps } from 'react';
import { linkHandler } from '../router';
import { AppBar } from '../shell/AppBar';
import { useNotes } from './hooks';
import { NoteView } from './NoteView';

/**
 * A note's page, once the id is known to be a note (B12): a mistyped or stale
 * link, or a note deleted for good, says so instead of making an empty note.
 * The main window and a note window (T45) show notes through it.
 */
export function NoteRoute(props: ComponentProps<typeof NoteView>) {
  const { id } = props;
  const notes = useNotes();
  const knows = () => notes.knows(id);
  const known = useSyncExternalStore(notes.subscribe, knows, knows);
  if (known === null) {
    return (
      <p className="graph-loading" role="status">
        <span className="spinner" aria-hidden="true" />
        Opening the note…
      </p>
    );
  }
  if (!known) {
    return (
      <>
        <AppBar title="Penmoss" brand />
        <div className="empty-state" data-testid="note-not-found">
          <h2>Note not found</h2>
          <p>
            No note has this address: it may have been deleted for good, or the link is mistyped.{' '}
            <a href="/" data-command="app.home" onClick={linkHandler('/')}>
              Back to Your Notes
            </a>
          </p>
        </div>
      </>
    );
  }
  return <NoteView {...props} />;
}
