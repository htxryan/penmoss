import { createContext, useContext, useSyncExternalStore } from 'react';
import type { Workspace, WorkspaceState } from './service';

export const WorkspaceContext = createContext<Workspace | null>(null);

export function useWorkspace(): Workspace {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error('useWorkspace outside WorkspaceProvider');
  return workspace;
}

export function useWorkspaceState(): WorkspaceState {
  const workspace = useWorkspace();
  return useSyncExternalStore(workspace.subscribe, workspace.getState, workspace.getState);
}
