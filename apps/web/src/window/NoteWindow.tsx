import { useState } from 'react';
import { useCommand } from '../commands/hooks';
import { KeepOnTopButton } from '../desktop/KeepOnTopButton';
import { useNoteList, useNotes } from '../notes/hooks';
import { isKeyRepeat } from '../notes/new-note';
import { NoteRoute } from '../notes/NoteRoute';
import { navigate, notePath } from '../router';
import { useHistoryCommands } from '../shell/history';
import { HistoryNav } from '../shell/HistoryNav';
import { useWorkspace } from '../workspace/hooks';

/**
 * A note in a window of its own (T45, D37, A710): Back and Forward, the title, the editor,
 * the ⋯ menu with the Info panel and the status bar, and no sidebar, breadcrumbs or rail.
 * It serves reference beside the main window and distraction-free writing alike.
 *
 * A link followed here opens its note here, with Back and Forward (⌘[ and ⌘] in the Mac app,
 * the browser's own keys on the web); ⌥-click opens another window. Any other page (Settings,
 * the graph, Trash) opens in the main window (router.ts). Moved to Trash, the note leaves the
 * window showing so, with the toast's Undo; Undo shows it here again.
 */
export function NoteWindow({ id, heading }: { id: string; heading: string | null }) {
  const notes = useNotes();
  const workspace = useWorkspace();
  const listed = useNoteList().some((entry) => entry.id === id);
  /** The note this window moved to Trash (it shows so until the note is back). */
  const [trashed, setTrashed] = useState<string | null>(null);

  // Back and Forward (T45; the main window's too since T51, A943).
  useHistoryCommands();

  // A new note goes beside this one and opens here.
  useCommand('note.new', (context) => {
    if (isKeyRepeat(context)) return;
    const folderId = workspace.folderOfNote(id);
    const next = notes.create(new Date(), { folderId });
    workspace.registerNote(next, folderId);
    navigate(notePath(next));
  });

  return (
    <div className="note-window" data-testid="note-window">
      <main className="note-main" tabIndex={-1}>
        {trashed === id && !listed ? (
          <div className="empty-state" data-testid="note-window-trashed">
            <WindowNav />
            <h2>In Trash</h2>
            <p>This note was moved to Trash. Undo brings it back here.</p>
          </div>
        ) : (
          <NoteRoute
            key={id}
            id={id}
            heading={heading}
            nav={<WindowNav />}
            actions={<KeepOnTopButton />}
            onDeleted={() => setTrashed(id)}
          />
        )}
      </main>
    </div>
  );
}

/** Back and Forward in the window's own history (T45). */
function WindowNav() {
  return <HistoryNav testIdPrefix="window" />;
}
