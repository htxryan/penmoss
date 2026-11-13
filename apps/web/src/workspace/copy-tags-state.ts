import { COPY_TAGS_SETTING, copiesTags } from '@penmoss/core/copy-to-notebook';
import { useSyncExternalStore } from 'react';
import { useSourcesState } from '../sources/hooks';
import { useWorkspace } from './hooks';
import type { Workspace } from './service';

/**
 * Copy Tags by Default (A1353): whether Copy to Notebook's Copy Tags checkbox starts ticked,
 * from the app's own settings (the primary notebook's, A827, A1136), and a way to change it.
 * Synced, so a change here or on another device applies to the next copy.
 */
export function useCopyTagsDefault(): {
  readonly copies: boolean;
  readonly set: (copies: boolean) => void;
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
  return {
    copies: copiesTags(workspace.settings()),
    // Ticked is stored as true, not removed: another device's older "off" must not win.
    set: (copies) => workspace.setSetting(COPY_TAGS_SETTING, copies),
    canChange: loaded,
  };
}
