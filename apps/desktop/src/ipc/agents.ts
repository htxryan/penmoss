/** Agents on this Mac's IPC (T54, A992, A993): the main window's Settings only. */
import type { IpcHandlers } from '../ipc';
import { localAgents } from '../services';

export function registerAgentsIpc(ipc: IpcHandlers): void {
  ipc.handle('agentsList', (_call, localId) => localAgents.list(localId));
  ipc.handle('agentsConnect', (_call, localId, label) => localAgents.connect(localId, label));
  ipc.handle('agentsDisconnect', (_call, name, force) => localAgents.disconnect(name, force));
  ipc.handle('cliStatus', () => localAgents.cliStatus());
  ipc.handle('cliInstall', () => localAgents.installCli());
  ipc.handle('cliRemove', () => localAgents.removeCli());
}
