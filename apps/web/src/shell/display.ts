import { sidebarSetting, sidebarShows, type SidebarItem } from '@penmoss/core/display';
import { useCallback } from 'react';
import { useWorkspace, useWorkspaceState } from '../workspace/hooks';

/**
 * The Display settings (T42, #104 item 7, A576): which sidebar shortcuts show, on the sidebar
 * and its rail, and a way to change one. The Journal notebook's settings, like the theme (A827).
 */
export function useSidebarDisplay(): {
  readonly shows: (item: SidebarItem) => boolean;
  readonly set: (item: SidebarItem, shown: boolean) => void;
  /** Settings can change now: this device's copy is read. */
  readonly canChange: boolean;
} {
  const workspace = useWorkspace();
  // Re-renders when settings change (here or by sync). Until this device's copy is read the
  // values are only defaults, so they cannot change yet: a toggle would flip back.
  const { loaded } = useWorkspaceState();
  const settings = workspace.settings();
  // Shown is stored as true, not removed: another device's older "hidden" must not win.
  const set = useCallback(
    (item: SidebarItem, shown: boolean) => workspace.setSetting(sidebarSetting(item), shown),
    [workspace],
  );
  return {
    shows: (item) => sidebarShows(settings, item),
    set,
    canChange: loaded,
  };
}
