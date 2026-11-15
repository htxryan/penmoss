import type { ReactNode } from 'react';
import { SourceScope } from './context';
import { useSourcesState } from './hooks';

/**
 * The Primary Notebook's services (T50 G4, A827; "Journal notebook" until T62 item 9): Journal,
 * Calendar, Inbox, Today, This week and capture use the source this device chose, whichever note
 * is open. Chosen on a notebook's page in Settings → Notebooks. The app's own services (settings,
 * the palette, the theme) are this notebook's too: `main.tsx` puts the whole app in its scope.
 */
export function JournalScope({ children }: { children: ReactNode }) {
  const state = useSourcesState();
  return <SourceScope source={state.journal}>{children}</SourceScope>;
}
