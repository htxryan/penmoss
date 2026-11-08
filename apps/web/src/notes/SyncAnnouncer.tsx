import { useSyncState } from './hooks';
import type { AppSyncState } from './service';
import { syncHint } from './sync-label';

/**
 * The phases worth interrupting a screen reader for (A522): every edit sends the state through
 * Syncing and back to Synced, which, read out each time, drowned the writing.
 */
const ANNOUNCED: ReadonlySet<AppSyncState['phase']> = new Set(['offline', 'stopped']);

/**
 * What stays in the sidebar whichever sections show (T51, A933): the live region that reads out
 * offline and stopped for the notebook in context. Always in the page, so the change into one of
 * those phases is what gets read out. Each notebook's own state is the dot on its section.
 */
export function SyncAnnouncer() {
  const state = useSyncState();
  return (
    <span className="sr-only" role="status" data-testid="sync-alert">
      {ANNOUNCED.has(state.phase) ? syncHint(state) : ''}
    </span>
  );
}
