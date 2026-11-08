import {
  HIDDEN_SECTIONS_SETTING,
  hiddenSectionsOf,
  movedSection,
  QUICK_ACCESS_NOTEBOOK_SETTING,
  quickAccessShowsNotebook,
  RECENT_COUNT_SETTING,
  recentCountOf,
  SECTION_ORDER_SETTING,
  sectionOrderOf,
  withSectionHidden,
  type SidebarSection,
} from '@penmoss/core/sidebar-layout';
import { useSyncExternalStore } from 'react';
import { useSourcesState } from '../sources/hooks';
import { useWorkspace } from '../workspace/hooks';
import type { Workspace } from '../workspace/service';

export interface SidebarLayout {
  /** Every section in the order shown, hidden ones included. */
  readonly order: readonly SidebarSection[];
  readonly hidden: ReadonlySet<SidebarSection>;
  /** The sections shown, in order. */
  readonly shown: readonly SidebarSection[];
  readonly recentCount: number;
  readonly quickAccessNotebook: boolean;
  /** Moves `id` to `index` among every section. */
  readonly move: (id: SidebarSection, index: number) => void;
  readonly setHidden: (id: SidebarSection, hide: boolean) => void;
  readonly setRecentCount: (count: number) => void;
  readonly setQuickAccessNotebook: (shown: boolean) => void;
  /** Settings can change now: this device's copy is read (until then they are only defaults). */
  readonly canChange: boolean;
}

/**
 * The sidebar's sections (T53 item 8, A983): their order, which are hidden, Recent Notes' length
 * and Quick Access's notebook names, from the app's own settings (the Journal notebook's, A827, as
 * Quick Access's are).
 */
export function useSidebarLayout(): SidebarLayout {
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
  const order = sectionOrderOf(settings);
  const hidden = hiddenSectionsOf(settings);
  // The settings now, not this render's: two quick changes must not undo each other.
  const move = (id: SidebarSection, index: number) =>
    workspace.setSetting(
      SECTION_ORDER_SETTING,
      movedSection(sectionOrderOf(workspace.settings()), id, index),
    );
  const setHidden = (id: SidebarSection, hide: boolean) =>
    workspace.setSetting(
      HIDDEN_SECTIONS_SETTING,
      withSectionHidden(hiddenSectionsOf(workspace.settings()), id, hide),
    );
  const setRecentCount = (count: number) => workspace.setSetting(RECENT_COUNT_SETTING, count);
  const setQuickAccessNotebook = (shown: boolean) =>
    workspace.setSetting(QUICK_ACCESS_NOTEBOOK_SETTING, shown);
  return {
    order,
    hidden,
    shown: order.filter((id) => !hidden.has(id)),
    recentCount: recentCountOf(settings),
    quickAccessNotebook: quickAccessShowsNotebook(settings),
    move,
    setHidden,
    setRecentCount,
    setQuickAccessNotebook,
    canChange: loaded,
  };
}
