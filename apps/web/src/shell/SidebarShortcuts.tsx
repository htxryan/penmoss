import type { SidebarItem } from '@penmoss/core/display';
import { ariaKeyShortcuts } from '@penmoss/editor/keys';
import { Icon, type IconName } from '@penmoss/ui/icons';
import { useCommands, useKeys } from '../commands/hooks';
import { graphPath } from '../graph/path';
import { thisWeek, today } from '../journal/journal';
import { useNotes } from '../notes/hooks';
import { linkHandler } from '../router';
import { useSourcesState } from '../sources/hooks';
import { useWorkspace } from '../workspace/hooks';
import { useSidebarDisplay } from './display';
import { withKeys } from './drawer';

interface Shortcut {
  /** The Display setting that hides it; Search has none (A576). */
  readonly item: SidebarItem | null;
  readonly command: string;
  readonly label: string;
  readonly icon: IconName;
  readonly testId?: string;
}

const SHORTCUTS: readonly Shortcut[] = [
  { item: null, command: 'app.search', label: 'Search', icon: 'search', testId: 'open-search' },
  { item: 'today', command: 'journal.today', label: 'Today', icon: 'today' },
  { item: 'thisWeek', command: 'journal.thisWeek', label: 'This Week', icon: 'week' },
  { item: 'graph', command: 'app.graph', label: 'Graph', icon: 'graph', testId: 'open-graph' },
  {
    item: 'commands',
    command: 'app.palette',
    label: 'Commands',
    icon: 'command',
    testId: 'open-palette',
  },
];

/**
 * The sidebar's top row (T36; the icon rail's items, T41, A508): New Note, filled with the
 * accent so it stands out (T52), then Search, Today, This Week, Graph and Commands, as one
 * row of
 * icon buttons (T51, A932), each named by its `aria-label` and its tooltip with its keys; the
 * rail has them as a column. Settings → Display hides any but New Note and Search, on the
 * sidebar and the rail alike (A576); a hidden one's command, keys and palette entry still work.
 * Today and This Week show as the page while today's or this week's note is open (T53 item 1),
 * as Graph does on the graph.
 */
export function SidebarShortcuts({
  openNote,
  graphOpen,
  shownNote,
}: {
  /** The note the graph opens around (T17). */
  readonly openNote: string | null;
  /** The graph is the page showing. */
  readonly graphOpen: boolean;
  /** The note the page shows, if it shows one. */
  readonly shownNote: string | null;
}) {
  const { shows } = useSidebarDisplay();
  const current = useCurrentJournal();
  return (
    <div className="sb-shortcuts" data-testid="sidebar-shortcuts">
      <NewNoteButton />
      {SHORTCUTS.filter(({ item }) => item === null || shows(item)).map((shortcut) =>
        shortcut.command === 'app.graph' ? (
          <GraphLink key={shortcut.command} openNote={openNote} open={graphOpen} />
        ) : (
          <ShortcutButton
            key={shortcut.command}
            shortcut={shortcut}
            current={shownNote !== null && current[shortcut.command] === shownNote}
          />
        ),
      )}
    </div>
  );
}

function NewNoteButton() {
  const commands = useCommands();
  const keys = useKeys('note.new');
  return (
    <button
      type="button"
      className="icon-btn sb-shortcut new-note"
      data-command="note.new"
      onClick={() => commands.run('note.new')}
      aria-label="New Note"
      aria-keyshortcuts={ariaKeyShortcuts(keys) || undefined}
      data-tip={withKeys('New Note', keys)}
    >
      <Icon name="plus" size={18} />
    </button>
  );
}

/**
 * The ids of today's and this week's notes in the Journal notebook (A827), by the command that
 * opens each; the ids are the same on every device, made or not.
 */
function useCurrentJournal(): Readonly<Record<string, string>> {
  const source = useSourcesState()?.journal ?? null;
  const notes = useNotes();
  const workspace = useWorkspace();
  const journal = source?.notes ?? notes;
  const settings = (source?.workspace ?? workspace).settings();
  return {
    'journal.today': journal.periodicId('daily', today(settings).toString()),
    'journal.thisWeek': journal.periodicId('weekly', thisWeek(settings)),
  };
}

function ShortcutButton({ shortcut, current }: { shortcut: Shortcut; current: boolean }) {
  const commands = useCommands();
  const keys = useKeys(shortcut.command);
  return (
    <button
      type="button"
      className="icon-btn sb-shortcut"
      data-command={shortcut.command}
      data-testid={shortcut.testId}
      onClick={() => commands.run(shortcut.command)}
      aria-label={shortcut.label}
      aria-current={current ? 'page' : undefined}
      aria-keyshortcuts={ariaKeyShortcuts(keys) || undefined}
      data-tip={withKeys(shortcut.label, keys)}
    >
      <Icon name={shortcut.icon} size={18} />
    </button>
  );
}

/** Graph is a link (to the graph around the open note), so it can open in a new tab. */
function GraphLink({ openNote, open }: { openNote: string | null; open: boolean }) {
  const keys = useKeys('app.graph');
  const href = graphPath(openNote);
  return (
    <a
      className="icon-btn sb-shortcut sb-graph"
      href={href}
      data-command="app.graph"
      onClick={linkHandler(href)}
      aria-label="Graph"
      aria-current={open ? 'page' : undefined}
      aria-keyshortcuts={ariaKeyShortcuts(keys) || undefined}
      data-tip={withKeys('Graph', keys)}
      data-testid="open-graph"
    >
      <Icon name="graph" size={18} />
    </a>
  );
}
