import { isoWeek, longDate } from '@penmoss/core/periodic';
import { formatCombo } from '@penmoss/editor/keys';
import { Icon } from '@penmoss/ui/icons';
import { useCommands, useKeys } from '../commands/hooks';
import { today } from '../journal/journal';
import { useNoteList } from '../notes/hooks';
import { useOpenNoteList } from '../workspace/notebooks';
import { displayTitle } from '../notes/list';
import { browserStorage, readOpened, recentNotes } from '../notes/recent';
import { linkHandler, notePath } from '../router';
import { useWorkspace, useWorkspaceState } from '../workspace/hooks';

const RECENT_ON_PHONE = 6;

const when = (time: number) =>
  new Date(time).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/**
 * With no note open. On a phone, the prototype's home screen (T36): search,
 * today's and this week's notes, the graph and recent notes, one tap each.
 * Everywhere, a short note on where to start.
 */
export function Home({ phone }: { readonly phone: boolean }) {
  const commands = useCommands();
  const workspace = useWorkspace();
  useWorkspaceState(); // the time zone setting
  const list = useNoteList();
  // Closed notebooks' notes are not Recent on this device (T43, A752).
  const openList = useOpenNoteList();
  const newNoteKeys = useKeys('note.new');
  const paletteKeys = useKeys('app.palette');
  const day = today(workspace.settings());
  const recent = phone
    ? recentNotes(openList, readOpened(browserStorage()), null, RECENT_ON_PHONE)
    : [];
  return (
    <div className="home">
      {phone ? (
        <div className="phone-home" data-testid="phone-home">
          <button
            type="button"
            className="ph-search"
            data-command="app.search"
            onClick={() => commands.run('app.search')}
          >
            <Icon name="search" size={20} />
            <span>Search Notes</span>
          </button>
          <button
            type="button"
            className="ph-card"
            data-command="journal.today"
            onClick={() => commands.run('journal.today')}
          >
            <span className="ph-kicker">
              <Icon name="today" size={14} />
              Today
            </span>
            <span className="ph-head">{longDate(day)}</span>
          </button>
          <div className="ph-row">
            <button
              type="button"
              className="ph-card"
              data-command="journal.thisWeek"
              onClick={() => commands.run('journal.thisWeek')}
            >
              <span className="ph-kicker">
                <Icon name="week" size={14} />
                This Week
              </span>
              <span className="ph-head">{isoWeek(day).toString()}</span>
            </button>
            <button
              type="button"
              className="ph-card"
              data-command="app.graph"
              onClick={() => commands.run('app.graph')}
            >
              <span className="ph-kicker">
                <Icon name="graph" size={14} />
                Graph
              </span>
              <span className="ph-head">
                {list.length} {list.length === 1 ? 'note' : 'notes'}
              </span>
            </button>
          </div>
          {recent.length > 0 ? (
            <section className="ph-section" aria-labelledby="ph-recent">
              <h2 id="ph-recent">Recent</h2>
              <ul className="ph-list" role="list">
                {recent.map((note) => (
                  <li key={note.id}>
                    <a
                      className="ph-li"
                      href={notePath(note.id)}
                      data-ui="item"
                      onClick={linkHandler(notePath(note.id))}
                    >
                      <Icon name="file" size={20} />
                      <span className="ph-two">
                        <span data-untitled={note.title ? undefined : ''}>
                          {displayTitle(note.title)}
                        </span>
                        <span className="muted">Edited {when(note.updatedAt)}</span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
      <div className="empty-state" data-testid="empty-state">
        <svg className="empty-art" viewBox="0 0 72 72" aria-hidden="true" focusable="false">
          <rect x="16" y="12" width="40" height="50" rx="4" className="art-page" />
          <path d="M24 26h24M24 34h18M24 42h21" className="art-lines" />
          <path d="M14 60c6-8 12-10 22-10s14 4 22 10" className="art-moss" />
        </svg>
        <h2>No note open</h2>
        <p>
          Pick a note from the list, or create one with <strong>New Note</strong>
          {newNoteKeys[0] ? ` (${formatCombo(newNoteKeys[0])})` : ''}. Every command is in the
          command palette{paletteKeys[0] ? ` (${formatCombo(paletteKeys[0])})` : ''}.
        </p>
      </div>
    </div>
  );
}
