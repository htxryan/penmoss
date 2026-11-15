import { ariaKeyShortcuts } from '@penmoss/editor/keys';
import { Icon } from '@penmoss/ui/icons';
import { useCommands, useKeys } from '../commands/hooks';
import { useHistoryPlace } from '../router';
import { useEveryOpenNoteList } from '../sources/lists';
import { pageTitle } from '../tabs/describe';
import { useTabs, useTabsState } from '../tabs/hooks';
import { withKeys } from './drawer';
import { useHistoryCommands } from './history';

/** The commands, for a window whose Back and Forward buttons show elsewhere (or nowhere). */
export function HistoryCommands() {
  useHistoryCommands();
  return null;
}

/**
 * The Back and Forward buttons (T45; T51, A943): `window` in a note window (`window-back`),
 * `app` in the main window's sidebar head, the rail and Settings' bar (`app-back`). One compact
 * pair (T52): two half-width buttons joined as a segmented control, each with its own tooltip,
 * keys, focus ring and disabled state.
 */
export function HistoryNav({ testIdPrefix }: { readonly testIdPrefix: 'app' | 'window' }) {
  // The main window's Back and Forward step the active tab, and their tooltips say where to (AC6).
  return useTabs() ? (
    <TabsHistoryNav testIdPrefix={testIdPrefix} />
  ) : (
    <Nav testIdPrefix={testIdPrefix} backTip="Back" forwardTip="Forward" />
  );
}

/** "Back to 2026-11-13 (this tab)": the active tab's page that Back or Forward shows. */
function TabsHistoryNav({ testIdPrefix }: { readonly testIdPrefix: 'app' | 'window' }) {
  const tabs = useTabs();
  useTabsState();
  const list = useEveryOpenNoteList();
  const titleOf = (id: string) => list.find((entry) => entry.id === id)?.title;
  const tip = (label: string, path: string | null | undefined) =>
    path ? `${label} to ${pageTitle(path, titleOf)} (this tab)` : label;
  return (
    <Nav
      testIdPrefix={testIdPrefix}
      backTip={tip('Back', tabs?.target(-1))}
      forwardTip={tip('Forward', tabs?.target(1))}
    />
  );
}

function Nav({
  testIdPrefix,
  backTip,
  forwardTip,
}: {
  readonly testIdPrefix: 'app' | 'window';
  readonly backTip: string;
  readonly forwardTip: string;
}) {
  const commands = useCommands();
  const place = useHistoryPlace();
  const backKeys = useKeys('window.back');
  const forwardKeys = useKeys('window.forward');
  return (
    <nav className={testIdPrefix === 'window' ? 'window-nav' : 'history-nav'} aria-label="History">
      <span className="history-pair">
        <button
          type="button"
          className="icon-btn history-half"
          data-command="window.back"
          aria-label="Back"
          aria-keyshortcuts={ariaKeyShortcuts(backKeys) || undefined}
          data-tip={withKeys(backTip, backKeys)}
          disabled={!place.back}
          data-testid={`${testIdPrefix}-back`}
          onClick={() => commands.run('window.back')}
        >
          <Icon name="navBack" size={16} />
        </button>
        <button
          type="button"
          className="icon-btn history-half"
          data-command="window.forward"
          aria-label="Forward"
          aria-keyshortcuts={ariaKeyShortcuts(forwardKeys) || undefined}
          data-tip={withKeys(forwardTip, forwardKeys)}
          disabled={!place.forward}
          data-testid={`${testIdPrefix}-forward`}
          onClick={() => commands.run('window.forward')}
        >
          <Icon name="navForward" size={16} />
        </button>
      </span>
    </nav>
  );
}
