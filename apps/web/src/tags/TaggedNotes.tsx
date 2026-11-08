import { Icon } from '@penmoss/ui/icons';
import { tagMatches } from '@penmoss/core/tags';
import { useCommand, useCommands } from '../commands/hooks';
import { useOpenNoteList } from '../workspace/notebooks';
import { folderTrail } from '../notes/crumbs';
import { noteRowTip } from '../notes/row-tip';
import { useWorkspaceState } from '../workspace/hooks';
import { displayTitle } from '../notes/list';
import { linkHandler, notePath } from '../router';
import { tagFilter } from './filter';

/**
 * The sidebar while a tag filter is on (T18): the notes carrying the tag or a
 * tag nested under it, newest first, from the local replica (offline too).
 */
export function TaggedNotes({ tag, activeId }: { tag: string; activeId: string | null }) {
  const commands = useCommands();
  // The open notebooks' notes only (T43, A752).
  const list = useOpenNoteList();
  const notes = list.filter((entry) => entry.tags.some((each) => tagMatches(each, tag)));
  const { snapshot } = useWorkspaceState();
  /** Where a note is, which this list does not show (A573, A1119). */
  const tipOf = (id: string) =>
    noteRowTip(
      folderTrail(
        snapshot.folders,
        snapshot.notes.find((entry) => entry.id === id)?.folderId ?? null,
      ),
    );
  useCommand('tags.clearFilter', () => tagFilter.set(null));

  return (
    <section className="tagged" aria-labelledby="tagged-heading" data-testid="tagged-notes">
      <div className="tagged-head">
        <h2 id="tagged-heading" className="tagged-title">
          <span className="chip">#{tag}</span>
          <span className="muted">
            {notes.length} {notes.length === 1 ? 'note' : 'notes'}
          </span>
        </h2>
        <button
          type="button"
          className="icon-btn"
          data-ui="dismiss"
          data-command="tags.clearFilter"
          aria-label="All Notes"
          data-tip="Clear the Tag Filter"
          onClick={() => commands.run('tags.clearFilter')}
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      {notes.length === 0 ? (
        <p className="list-empty">No notes use this tag.</p>
      ) : (
        <ul className="tagged-list" role="list">
          {notes.map((note) => (
            <li key={note.id}>
              <a
                className="tagged-link"
                href={notePath(note.id)}
                data-ui="item"
                aria-current={note.id === activeId ? 'page' : undefined}
                data-tip={tipOf(note.id)}
                data-tip-on="hover"
                onClick={linkHandler(notePath(note.id))}
              >
                <span className="tagged-name">{displayTitle(note.title)}</span>
                <span className="tagged-tags">
                  {note.tags.map((each) => (
                    <span key={each} className="tag-mini">
                      #{each}
                    </span>
                  ))}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
