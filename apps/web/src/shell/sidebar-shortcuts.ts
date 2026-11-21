/**
 * The sidebar's shortcuts (T36, R2-9; A576): Search, Tags, Today, This Week, Graph and Commands,
 * on the sidebar's top row and the Mac's icon rail. Plain data, free of React, so the usage
 * dashboard's session player (PEN-178) draws the same buttons from the same list.
 */
import type { SidebarItem } from '@penmoss/core/display';
import type { IconName } from '@penmoss/ui/icons';

export interface Shortcut {
  /** The Display setting that hides it; Search has none (A576). */
  readonly item: SidebarItem | null;
  readonly command: string;
  readonly label: string;
  readonly icon: IconName;
  readonly testId?: string;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { item: null, command: 'app.search', label: 'Search', icon: 'search', testId: 'open-search' },
  // The Tags page (Ryan's review of #193, R2-9), its icon the page's own.
  { item: 'tags', command: 'app.tags', label: 'Tags', icon: 'hash', testId: 'open-tags' },
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
