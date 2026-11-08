import type { ReactNode } from 'react';
import { SourceScope } from './context';
import { useSourcesState } from './hooks';

/**
 * The Primary Notebook's services (T50 G4, A827; "Journal notebook" until T62 item 9): Journal,
 * Calendar, Inbox, Today, This week and capture use the source this device chose, whichever note
 * is open. Chosen on a notebook's page in Settings → Git Notebooks.
 */
export function JournalScope({ children }: { children: ReactNode }) {
  const state = useSourcesState();
  if (!state) return children;
  return <SourceScope source={state.journal}>{children}</SourceScope>;
}
