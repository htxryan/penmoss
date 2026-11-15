import type { AppSyncState } from './service';

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** A source's sync state in words: `Offline · 3 pending` → `Syncing` → `Synced`. */
export function syncLabel(state: AppSyncState): string {
  const pending = state.pending > 0 ? ` · ${state.pending} pending` : '';
  switch (state.phase) {
    case 'offline':
      return `Offline${pending}`;
    case 'syncing':
      return 'Syncing';
    case 'synced':
      return 'Synced';
    case 'stopped':
      return `Sync Stopped${pending}`;
  }
}

/** What the state means, read out when sync needs attention (A522). */
export function syncHint(state: AppSyncState): string {
  const waiting = plural(state.pending, 'note');
  switch (state.phase) {
    case 'offline':
      return state.pending > 0
        ? `Offline: ${waiting} with changes saved on this device; they are pushed when the host answers`
        : 'Offline: changes are saved on this device and pushed when the host answers';
    case 'syncing':
      return state.pending > 0 ? `Syncing ${waiting} with changes` : 'Syncing';
    case 'synced':
      return 'Every note on this device is pushed';
    case 'stopped':
      return state.reason === 'storage'
        ? `Sync stopped: ${state.detail ?? 'this device’s storage needs a reload'}`
        : `Sync stopped: ${state.detail ?? 'the notebook’s git sync stopped'}. Settings → Notebooks says why`;
  }
}
