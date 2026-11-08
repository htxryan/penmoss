import type { ReactNode } from 'react';
import { SourceScope } from './context';
import { useSourcesState } from './hooks';

/**
 * The app's own services (T50, A828): the personal workspace's, or, with no account and a git
 * notebook, the Journal notebook's. Settings, the palette and the theme read them.
 */
export function RootScope({ children }: { children: ReactNode }) {
  const state = useSourcesState();
  if (!state) return children;
  return <SourceScope source={state.root}>{children}</SourceScope>;
}
