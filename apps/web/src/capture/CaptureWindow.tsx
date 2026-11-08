import { useCallback, useEffect, useState } from 'react';
import { desktop } from '../desktop/bridge';
import { useNotes } from '../notes/hooks';
import { useWorkspace } from '../workspace/hooks';
import { CaptureForm } from './CaptureForm';

/**
 * The Mac app's capture window (T30, `/capture`): a small window the global
 * hotkey shows over any app. It keeps its own replicas open (the same
 * IndexedDB as the main window, A20), so a save is a local write even
 * offline. Showing it again focuses the field and keeps the draft; it reads
 * what the main window stored meanwhile (a time zone, an Inbox folder, A228)
 * then, again when the main process says the main window has stored its
 * latest, and before each save, since offline no socket brings it.
 */
export function CaptureWindow() {
  const notes = useNotes();
  const workspace = useWorkspace();
  const [shown, setShown] = useState(0);
  const [pulled, setPulled] = useState(0);

  const pull = useCallback(async () => {
    // Best effort: a capture still saves on what this window has.
    await Promise.all([workspace.pullStored(), notes.pullStored()]).catch((error: unknown) =>
      console.warn('[capture] could not read what other windows stored', error),
    );
  }, [notes, workspace]);
  const refresh = useCallback(() => {
    void pull().finally(() => setPulled((count) => count + 1));
  }, [pull]);

  useEffect(() => {
    notes.start().catch((error: unknown) => console.error('[capture] local storage', error));
    workspace.start().catch((error: unknown) => console.error('[capture] workspace', error));
    return () => {
      notes.stop();
      workspace.stop();
    };
  }, [notes, workspace]);

  useEffect(
    () =>
      desktop()?.capture.onShow(() => {
        setShown((count) => count + 1);
        refresh();
      }),
    [refresh],
  );
  useEffect(() => desktop()?.onStoreChanged(refresh), [refresh]);

  return (
    <main className="capture-window" data-testid="capture-window">
      <CaptureForm
        focusKey={shown}
        settingsKey={pulled}
        prepare={pull}
        onSaved={() => desktop()?.capture.done(true)}
        onCancel={() => desktop()?.capture.done(false)}
      />
    </main>
  );
}
