import { useCallback, useEffect } from 'react';
import { useQuickAccessNotes } from '../notes/quick-access';
import { desktop, type MenuBarPin } from './bridge';

function Sender({ send }: { readonly send: (pins: readonly MenuBarPin[]) => void }) {
  // In pin order, titles from whichever source holds each; a trashed or unknown pin is left out.
  const notes = useQuickAccessNotes();
  // Ids and titles only, sent when a pin or a pinned note's title changes, not on every edit.
  const pins = JSON.stringify(notes.map(({ id, title }): MenuBarPin => ({ id, title })));
  useEffect(() => {
    send(JSON.parse(pins) as MenuBarPin[]);
  }, [pins, send]);
  return null;
}

/**
 * The menu bar icon's Quick Access notes (T51 item 17, A945, A946): the Mac app's main window
 * tells the main process the pinned notes and their titles as they change, for the icon's menu.
 * Nothing in a browser, a note window, the capture window or a Mac app from before T51.
 */
export function QuickAccessMenuBar() {
  const bridge = desktop();
  const menuBar = bridge?.window === 'main' ? bridge.menuBar : undefined;
  const send = useCallback(
    (pins: readonly MenuBarPin[]) => {
      menuBar?.setQuickAccess?.(pins);
    },
    [menuBar],
  );
  if (!menuBar?.setQuickAccess) return null;
  return <Sender send={send} />;
}
