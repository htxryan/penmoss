/**
 * Auto-Update's IPC (A1112, A1196): anyone may read the state and check; the switch, the channel
 * and Install and Restart are the person's, after a click or key press (main window only).
 */
import type { IpcHandlers } from '../ipc';
import { releaseNotes, updates } from '../services';

export function registerUpdatesIpc(ipc: IpcHandlers): void {
  ipc.handle('updatesState', () => updates.current());
  ipc.handle('updatesCheck', () => updates.check());
  ipc.handle('updatesSetAuto', (_call, on) =>
    typeof on === 'boolean' ? updates.setAuto(on) : null,
  );
  ipc.handle('updatesSetChannel', (_call, channel) =>
    channel === 'stable' || channel === 'alpha' ? updates.setChannel(channel) : null,
  );
  ipc.handle('updatesInstall', () => updates.install());
  // The notice after an update (PEN-110): answered after a click, in the main window.
  ipc.handle('updatesAcknowledge', () => updates.acknowledge());
  // Release notes (PEN-108): the cached file at once; a newer one follows as a change.
  ipc.handle('updatesNotes', () => {
    void updates.current().then((state) => releaseNotes.refresh(state.channel));
    return releaseNotes.current();
  });
}
