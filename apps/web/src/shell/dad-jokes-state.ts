import { DAD_JOKES_SETTING, dadJokesOf } from '@penmoss/core/settings';
import { useSyncExternalStore } from 'react';
import { useAppWorkspace } from '../sources/hooks';

/**
 * Dad Jokes (Settings → Appearance): whether the empty window's heading is a dad joke (A1576) or
 * Welcome to Penmoss, from the app's own settings (the Journal notebook's, A827, as the rest of
 * Appearance), and a way to change it. Synced, so turning it off here turns it off on every Mac
 * and in the web app.
 */
export function useDadJokes(): {
  readonly on: boolean;
  readonly set: (on: boolean) => void;
  /** Settings can change now: this device's copy is read (until then they are only defaults). */
  readonly canChange: boolean;
} {
  const workspace = useAppWorkspace();
  // Re-renders when the settings change, here or by sync.
  const { loaded } = useSyncExternalStore(
    workspace.subscribe,
    workspace.getState,
    workspace.getState,
  );
  return {
    on: dadJokesOf(workspace.settings()),
    set: (on) => workspace.setSetting(DAD_JOKES_SETTING, on),
    canChange: loaded,
  };
}
