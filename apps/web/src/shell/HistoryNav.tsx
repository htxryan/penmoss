import { ariaKeyShortcuts } from '@penmoss/editor/keys';
import { Icon } from '@penmoss/ui/icons';
import { useCommands, useKeys } from '../commands/hooks';
import { useHistoryPlace } from '../router';
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
          data-tip={withKeys('Back', backKeys)}
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
          data-tip={withKeys('Forward', forwardKeys)}
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
