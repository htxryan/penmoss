import { ariaKeyShortcuts } from '@penmoss/editor/keys';
import { Icon } from '@penmoss/ui/icons';
import { useCommands, useKeys } from '../commands/hooks';
import { graphPath } from '../graph/path';
import { thisWeek, today } from '../journal/journal';
import { hasTabs, linkHandler, openIntent } from '../router';
import { QuickAccessFlyout } from '../notes/QuickAccessFlyout';
import { useSourcesState } from '../sources/hooks';
import { useSidebarDisplay } from './display';
import { withKeys } from './drawer';
import { useSidebarLayout } from './sidebar-layout-state';
import { SHORTCUTS, type Shortcut } from './sidebar-shortcuts';

/**
 * The sidebar's top row (T36; the icon rail's items, T41, A508): New Note, filled with the
 * accent so it stands out (T52), then Search, Tags (R2-9), Today, This Week, Graph and Commands,
 * as one row of icon buttons (T51, A932), each named by its `aria-label` and its tooltip with its
 * keys; the rail has them as a column. Settings → Display hides any but New Note and Search, on
 * the sidebar and the rail alike (A576); a hidden one's command, keys and palette entry still
 * work. Today and This Week show as the page while today's or this week's note is open (T53
 * item 1), as Graph does on the graph and Tags on the Tags page. On the rail, Quick Access ends
 * the column: a pin whose menu lists the pinned notes (Quanta feedback, PEN-182).
 */
export function SidebarShortcuts({
  openNote,
  graphOpen,
  tagsOpen = false,
  shownNote,
  rail = false,
}: {
  /** The note the graph opens around (T17). */
  readonly openNote: string | null;
  /** The graph is the page showing. */
  readonly graphOpen: boolean;
  /** The Tags page is the page showing. */
  readonly tagsOpen?: boolean;
  /** The note the page shows, if it shows one. */
  readonly shownNote: string | null;
  /** The sidebar is the icon rail (T41): Quick Access is a menu at the column's end. */
  readonly rail?: boolean;
}) {
  const { shows } = useSidebarDisplay();
  // Quick Access hidden in Settings → Sidebar: no pin on the rail either (A1675).
  const { hidden } = useSidebarLayout();
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
            current={
              shortcut.command === 'app.tags'
                ? tagsOpen
                : shownNote !== null && current[shortcut.command] === shownNote
            }
          />
        ),
      )}
      {rail && !hidden.has('quickAccess') ? <QuickAccessFlyout /> : null}
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
  const { notes: journal, workspace } = useSourcesState().journal;
  const settings = workspace.settings();
  return {
    'journal.today': journal.periodicId('daily', today(settings).toString()),
    'journal.thisWeek': journal.periodicId('weekly', thisWeek(settings)),
  };
}

/** Today and This Week open a note, so a ⌘-click opens it in a new tab (A1570). */
const opensNote = (shortcut: Shortcut): boolean =>
  shortcut.command === 'journal.today' || shortcut.command === 'journal.thisWeek';

function ShortcutButton({ shortcut, current }: { shortcut: Shortcut; current: boolean }) {
  const commands = useCommands();
  const keys = useKeys(shortcut.command);
  return (
    <button
      type="button"
      className="icon-btn sb-shortcut"
      data-command={shortcut.command}
      data-testid={shortcut.testId}
      onClick={(event) => {
        // Today and This Week ⌘-clicked: their note in a new tab behind this one (A1570).
        const intent = opensNote(shortcut) && hasTabs() ? openIntent(event) : null;
        const newTab = intent === 'background' || intent === 'foreground' ? intent : undefined;
        commands.run(shortcut.command, { source: 'button', newTab });
      }}
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
