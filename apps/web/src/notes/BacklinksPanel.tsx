import { Backlinks } from '@penmoss/ui/panels/Backlinks';
import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { isPlainLeftClick, isWindowClick, navigate } from '../router';
import { openNoteWindow } from '../window/open';
import { loadBacklinks, othersKey, type Backlinks as BacklinksData } from './backlinks';
import { noteHref } from './directory';
import { useNoteList, useNotes } from './hooks';
import { useDirectory } from './directory-hooks';
import { displayTitle } from './list';

/** How long the list must be quiet before the panel asks again. */
const RELOAD_DELAY_MS = 800;

/**
 * The open note's backlinks (T16), from this device's index, reloaded when other notes change
 * (not while typing in this one) and when the window shows again (A861: no polling). Other
 * Macs' edits reach the list when their notebook's sync pulls them in.
 */
export function BacklinksPanel({ noteId }: { noteId: string }) {
  const notes = useNotes();
  const directory = useDirectory();
  const list = useNoteList();
  const [data, setData] = useState<BacklinksData | null>(null);
  const [tick, setTick] = useState(0);

  const own = list.find((entry) => entry.id === noteId);
  const title = own ? displayTitle(own.title) : '';
  // Other notes' titles and edit times (this note's typing changes neither).
  const others = useMemo(() => othersKey(list, noteId), [list, noteId]);

  useEffect(() => {
    const again = () => {
      if (!document.hidden) setTick((value) => value + 1);
    };
    document.addEventListener('visibilitychange', again);
    return () => document.removeEventListener('visibilitychange', again);
  }, []);

  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      loadBacklinks(notes, noteId, title).then(
        (loaded) => {
          if (current) setData(loaded);
        },
        (error: unknown) => console.warn('[backlinks] could not load', error),
      );
    }, RELOAD_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [notes, noteId, title, others, tick]);

  const onOpen = (id: string, event: MouseEvent<HTMLAnchorElement>) => {
    if (isWindowClick(event)) {
      // ⌥-click: in a new window (T45, A710), not the browser's download.
      event.preventDefault();
      openNoteWindow(id);
      return;
    }
    if (!isPlainLeftClick(event)) return;
    event.preventDefault();
    navigate(noteHref(id));
  };

  return (
    <Backlinks
      noteId={noteId}
      linked={data?.linked ?? []}
      unlinked={data?.unlinked ?? []}
      loading={data === null}
      titleOf={(id) => directory.title(id)}
      hrefOf={(id) => noteHref(id)}
      onOpen={onOpen}
    />
  );
}
