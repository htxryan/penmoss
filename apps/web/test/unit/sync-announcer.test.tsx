import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NotesProvider } from '../../src/notes/context';
import type { AppSyncState, Notes } from '../../src/notes/service';
import { SyncAnnouncer } from '../../src/notes/SyncAnnouncer';
import { syncHint, syncLabel } from '../../src/notes/sync-label';

function render(state: AppSyncState): string {
  const notes = {
    subscribeSync: () => () => undefined,
    syncState: () => state,
  } as unknown as Notes;
  return renderToString(
    <NotesProvider notes={notes}>
      <SyncAnnouncer />
    </NotesProvider>,
  );
}

const alertOf = (html: string) => /data-testid="sync-alert"[^>]*>([^<]*)</.exec(html)?.[1] ?? null;

describe('SyncAnnouncer (T51, A933; git only since T59)', () => {
  it('announces only the states that need attention', () => {
    for (const phase of ['syncing', 'synced'] as const) {
      expect(alertOf(render({ phase, pending: 1, detail: null }))).toBe('');
    }
    const offline = render({ phase: 'offline', pending: 2, detail: null });
    expect(offline).toContain('role="status"');
    expect(alertOf(offline)).toContain('Offline: 2 notes with changes saved on this device');
    expect(
      alertOf(render({ phase: 'stopped', pending: 0, detail: 'no remote', reason: 'git' })),
    ).toContain('Sync stopped: no remote. Settings → Git Notebooks says why');
  });

  it('names a storage problem as this device’s, not git’s', () => {
    expect(syncHint({ phase: 'stopped', pending: 0, detail: null, reason: 'storage' })).toBe(
      'Sync stopped: this device’s storage needs a reload',
    );
  });

  it('labels each phase in words, with what waits', () => {
    expect(syncLabel({ phase: 'offline', pending: 3, detail: null })).toBe('Offline · 3 pending');
    expect(syncLabel({ phase: 'syncing', pending: 3, detail: null })).toBe('Syncing');
    expect(syncLabel({ phase: 'synced', pending: 0, detail: null })).toBe('Synced');
    expect(syncLabel({ phase: 'stopped', pending: 1, detail: null })).toBe(
      'Sync stopped · 1 pending',
    );
  });
});
