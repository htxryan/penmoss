import { Icon } from '@penmoss/ui/icons';
import { useState } from 'react';
import { useWorkspaceState } from './hooks';
import { recoveredText } from './recovered';
import { ActionToast } from '../toasts/ActionToast';
import { ToastSlot } from '../toasts/ToastSlot';

/**
 * Says how many folder changes a closed window could not keep (#116, A676). It reports lost
 * changes, so it stays until dismissed.
 */
export function RecoveredNotice() {
  const { recovered } = useWorkspaceState();
  const [dismissed, setDismissed] = useState<number | null>(null);
  const shown = recovered && recovered.at !== dismissed ? recovered : null;

  return (
    <ToastSlot>
      {shown ? (
        <ActionToast
          tone="info"
          testId="folders-recovered"
          icon={<Icon name="folder" />}
          onDismiss={() => setDismissed(shown.at)}
        >
          {recoveredText(shown)}
        </ActionToast>
      ) : null}
    </ToastSlot>
  );
}
