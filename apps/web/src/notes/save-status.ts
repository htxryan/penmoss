/**
 * The open note's save status for the status bar (T41, A505). It is read from the state the app
 * already keeps: the note's keeper (its local write) and its git notebook's engine (T50 G4,
 * A860). It adds no new states of its own. The server's states (signed out, a conflict copy, a
 * note deleted for good elsewhere) went with the server (T59, D49).
 */
import type { LocalSyncState } from './service-types';

type SaveState =
  /** A change is not in this device's storage yet. */
  | 'saving'
  /** On this device, not pushed to git yet: a yellow dot and Sync Now beside it (A1629). */
  | 'local'
  /** On this device and in git, while a sync runs. */
  | 'syncing'
  /** On this device and pushed to git. */
  | 'synced'
  /** On this device; git gets it when the host answers. */
  | 'offline'
  /** On this device, but the notebook's sync stopped: a red pill that opens its Settings page. */
  | 'stopped'
  /** Not stored on this device. */
  | 'error';

/** What the note's keeper says about its own write. */
export interface NoteSaveFacts {
  readonly savedLocally: boolean;
  readonly persistError: unknown;
}

export interface SaveStatus {
  readonly state: SaveState;
  readonly label: string;
  readonly hint: string;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A git notebook's note (T50 G4, A860): stored on this device, then committed and pushed by the
 * notebook's engine. Its own words, so the bar never says the server has it.
 */
export function gitSaveStatus(
  note: NoteSaveFacts,
  sync: LocalSyncState,
  noteId: string,
): SaveStatus {
  const status = (state: SaveState, label: string, hint: string): SaveStatus => ({
    state,
    label,
    hint,
  });
  if (note.persistError) {
    return status(
      'error',
      'Not saved',
      `Could not save on this device (${message(note.persistError)}). Penmoss keeps trying; keep this window open.`,
    );
  }
  if (!note.savedLocally) return status('saving', 'Saving…', 'Saving on this device');
  const pending = sync.pending.has(noteId);
  if (sync.phase === 'stopped') {
    return status(
      'stopped',
      'Sync Stopped',
      `Saved on this device. ${sync.detail ?? 'The notebook’s git sync stopped.'} Its page in Settings says why.`,
    );
  }
  if (sync.phase === 'offline') {
    return pending
      ? status(
          'offline',
          'Saved Locally · Offline',
          `Saved on this device; it is pushed to git when the host answers.${sync.detail ? ` ${sync.detail}` : ''}`,
        )
      : status(
          'offline',
          'Saved Remotely · Offline',
          'Saved, and in git before the host stopped answering.',
        );
  }
  if (pending) {
    return status(
      'local',
      'Saved Locally',
      'Saved on this device; the notebook pushes it to git shortly, or Sync Now pushes every notebook’s changes now.',
    );
  }
  if (sync.phase === 'syncing')
    return status('syncing', 'Saved Remotely', 'In git; syncing with git now');
  return status('synced', 'Saved Remotely', 'Saved on this device and pushed to git');
}
