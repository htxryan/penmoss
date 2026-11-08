import { Icon } from '@penmoss/ui/icons';
import { useId, useMemo, type ReactNode } from 'react';
import { linkHandler, notePath } from '../router';
import { useStoredCollapse } from '../shell/collapsed';
import { useEveryOpenNoteList } from '../sources/lists';
import { displayTitle } from './list';
import { NOTE_DRAG_TYPE } from './note-drag';
import { browserStorage, readOpened, recentNotes } from './recent';
import { SectionHead } from '../shell/SectionHead';

/** Whether Recent Notes is collapsed on this device (T53 item 8). */
export const RECENT_COLLAPSED_KEY = 'penmoss.sidebar.recent';

/**
 * Recent Notes in the sidebar (T53 item 8, A983): the notes opened here or changed anywhere last,
 * newest first, as many as Settings → Display says (ten unset), from the open notebooks (A752).
 * The open note is marked, not moved to the top. Collapsed or open on this device. A note dragged
 * from here to Quick Access is pinned there.
 */
export function RecentSection({
  activeId,
  count,
  tools,
}: {
  readonly activeId: string | null;
  readonly count: number;
  /** The section's drag handle and ✕ (T53 item 8). */
  readonly tools?: ReactNode;
}) {
  // Every notebook's notes (T62 item 10: the Journal's alone missed the others).
  const list = useEveryOpenNoteList();
  const [collapsed, toggle] = useStoredCollapse(RECENT_COLLAPSED_KEY);
  const id = useId();
  // Read again as the open note changes: opening one records it (NoteView).
  const notes = useMemo(
    () => recentNotes(list, readOpened(browserStorage()), null, count),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activeId: a note was opened
    [list, count, activeId],
  );
  return (
    <section
      className="sb-section sb-recent"
      aria-labelledby={`${id}-name`}
      data-testid="recent-notes"
      data-collapsed={collapsed ? 'true' : undefined}
    >
      <SectionHead
        name="Recent Notes"
        nameId={`${id}-name`}
        collapsed={collapsed}
        onToggle={toggle}
        controls={`${id}-body`}
        tools={tools}
      />
      {collapsed ? null : notes.length === 0 ? (
        <p id={`${id}-body`} className="list-empty">
          Notes you open show here.
        </p>
      ) : (
        <ul id={`${id}-body`} className="sb-quick-list" role="list">
          {notes.map((note) => (
            <li key={note.id}>
              <a
                className="sb-item"
                data-ui="item"
                href={notePath(note.id)}
                aria-current={note.id === activeId ? 'page' : undefined}
                data-testid="recent-note"
                data-note-id={note.id}
                onClick={linkHandler(notePath(note.id))}
                onDragStart={(event) => {
                  event.dataTransfer.setData(NOTE_DRAG_TYPE, note.id);
                  event.dataTransfer.effectAllowed = 'copyLink';
                }}
              >
                <Icon name="file" size={16} />
                <span className="label">{displayTitle(note.title)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
