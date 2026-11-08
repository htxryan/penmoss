import { Icon } from '@penmoss/ui/icons';
import { useState } from 'react';
import { useWorkspaceState } from './hooks';
import { recoveredText } from './recovered';

/**
 * Says how many folder changes a closed window could not keep (#116, A676). It reports lost
 * changes, so it stays until dismissed.
 */
export function RecoveredNotice() {
  const { recovered } = useWorkspaceState();
  const [dismissed, setDismissed] = useState<number | null>(null);
  const shown = recovered && recovered.at !== dismissed ? recovered : null;

  return (
    <div role="status" className="toast-live">
      {shown ? (
        <div className="toast toast-with-action" data-testid="folders-recovered">
          <Icon name="folder" />
          <span>{recoveredText(shown)}</span>
          <button
            type="button"
            className="toast-close"
            data-ui="dismiss"
            aria-label="Dismiss"
            onClick={() => setDismissed(shown.at)}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
