import {
  TOOLTIP_DELAY_SETTING,
  tooltipDelay,
  tooltipDelayChoice,
  type TooltipDelayChoice,
} from '@penmoss/core/tooltips';
import { useSyncExternalStore } from 'react';
import { useSourcesState } from '../sources/hooks';
import { useWorkspace } from '../workspace/hooks';
import type { Workspace } from '../workspace/service';

/**
 * Show Tooltips After (PEN-70, A1247): how long the mouse rests on a control before its
 * tooltip shows, from the app's own settings (the Journal notebook's, A827, as the rest of
 * Display), and a way to change it. Synced, so a change here or on another device applies to
 * the next hover.
 */
export function useTooltipDelay(): {
  /** The wait in milliseconds, or null for Never (no tooltip on hover). */
  readonly delay: number | null;
  /** The choice Settings → Display shows. */
  readonly choice: TooltipDelayChoice;
  readonly set: (choice: TooltipDelayChoice) => void;
  /** Settings can change now: this device's copy is read (until then they are only defaults). */
  readonly canChange: boolean;
} {
  const inScope = useWorkspace();
  const sources = useSourcesState();
  const workspace: Workspace = sources?.root.workspace ?? inScope;
  // Re-renders when the settings change, here or by sync.
  const { loaded } = useSyncExternalStore(
    workspace.subscribe,
    workspace.getState,
    workspace.getState,
  );
  const settings = workspace.settings();
  return {
    delay: tooltipDelay(settings),
    choice: tooltipDelayChoice(settings),
    set: (choice) => workspace.setSetting(TOOLTIP_DELAY_SETTING, choice),
    canChange: loaded,
  };
}
