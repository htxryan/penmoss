import type { AppSyncState } from './service-types';
import { counted } from '@penmoss/core/words';

/** What the state means, read out when sync needs attention (A522). */
export function syncHint(state: AppSyncState): string {
  const waiting = counted(state.pending, 'note');
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
        : `Sync stopped: ${state.detail ?? 'the notebook’s git sync stopped'}. Its page in Settings says why`;
  }
}
