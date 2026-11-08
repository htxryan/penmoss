import type { ReactNode } from 'react';
import { WorkspaceContext } from './hooks';
import type { Workspace } from './service';

export function WorkspaceProvider({
  workspace,
  children,
}: {
  workspace: Workspace;
  children: ReactNode;
}) {
  return <WorkspaceContext.Provider value={workspace}>{children}</WorkspaceContext.Provider>;
}
