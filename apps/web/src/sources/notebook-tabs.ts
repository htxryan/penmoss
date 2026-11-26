/**
 * A notebook's page in Settings has three tabs (PEN-146): Overview, Sync and Git, kept in the
 * URL as `?tab=sync` or `?tab=git` (Overview has none).
 */
import { gitNotebookPath } from '../router';
import type { GitControl } from './git-commands';

export type NotebookTab = 'overview' | 'sync' | 'git';
export const NOTEBOOK_TABS: ReadonlyArray<{ readonly id: NotebookTab; readonly label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'sync', label: 'Sync' },
  { id: 'git', label: 'Git' },
];

/** The tab a command's control is on (#170 F5): the page opens it, then focuses the control. */
export const CONTROL_TAB: Record<GitControl, NotebookTab | null> = {
  'git-push-delay': 'sync',
  'git-pull-interval': 'sync',
  'git-token': 'git',
  'git-author-email': 'git',
  // Over the tabs, on every one.
  'git-reconfirm-purges': null,
  'git-remove': 'overview',
};

/** The tab in the URL (`?tab=sync`); Overview without one. */
export function notebookTab(search: string): NotebookTab {
  const tab = new URLSearchParams(search).get('tab');
  return tab === 'sync' || tab === 'git' ? tab : 'overview';
}

/** A notebook's page at one of its tabs. */
export const notebookTabPath = (sourceId: string, tab: NotebookTab) =>
  tab === 'overview' ? gitNotebookPath(sourceId) : `${gitNotebookPath(sourceId)}?tab=${tab}`;
