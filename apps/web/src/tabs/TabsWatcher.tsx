import { Icon } from '@penmoss/ui/icons';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { trashedTitle } from '../trash/trashed';
import { useSourcesState } from '../sources/hooks';
import type { Source } from '../sources/registry';
import { ActionToast } from '../toasts/ActionToast';
import { ToastSlot } from '../toasts/ToastSlot';
import { useTabs, useTabsState } from './hooks';
import { currentEntry, noteIdOfPath, type TabsState } from './state';
import { closedNotice, rememberClosedFor, reopenTabsOfRestored } from './trash';

/** How long the toast for a tab closed by a trash from elsewhere shows, unless held. */
const CLOSED_MS = 8000;

/** Every note id the tabs' pages and histories name. */
function tabNotes(state: TabsState): string[] {
  const ids = new Set<string>();
  for (const tab of state.tabs) {
    for (const entry of tab.entries) {
      const note = noteIdOfPath(entry.path);
      if (note !== null) ids.add(note);
    }
  }
  return [...ids];
}

/**
 * Keeps the tabs in step with the notebooks (PEN-140, A1501):
 *
 * - A note moved to Trash anywhere (another window, sync, an agent) closes every tab whose page
 *   it is, with a toast that offers Restore; Back and Forward pass over it deeper in a history.
 * - A notebook closed or removed closes its notes' tabs onto the closed list (⇧⌘T reopens them
 *   once it is open again).
 * - Once every notebook has been read, the pages of notes none of them knows are dropped.
 */
export function TabsWatcher() {
  const tabs = useTabs();
  const state = useTabsState();
  const sources = useSourcesState();
  const all = sources.all;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    const offs = all.map((source) => source.notes.subscribe(bump));
    return () => {
      for (const off of offs) off();
    };
  }, [all]);

  /** Each source's notes in Trash on this device, by id. */
  const trashed = useMemo(() => {
    void tick;
    const map = new Map<string, { title: string; source: Source }>();
    for (const source of all) {
      for (const entry of source.notes.localTrash()) {
        map.set(entry.id, { title: entry.title, source });
      }
    }
    return map;
  }, [all, tick]);

  useEffect(() => {
    tabs?.setGone((note) => trashed.has(note));
  }, [tabs, trashed]);

  // A note moved to Trash closes its tabs. Only as it goes there: a link followed to a note
  // already in Trash still shows it.
  // What was in Trash, and which notebooks had read their notes, last time: only a move to Trash
  // seen while open closes tabs, not what a notebook finds there as it loads.
  const before = useRef<{
    readonly trashed: ReadonlyMap<string, unknown>;
    readonly loaded: ReadonlySet<string>;
  }>({ trashed: new Map(), loaded: new Set() });
  useEffect(() => {
    const was = before.current;
    const loaded = new Set(
      all.filter((source) => source.notes.isLoaded).map((source) => source.id),
    );
    before.current = { trashed, loaded };
    if (!tabs) return;
    const closed = tabs.closeShowing((note) => {
      const info = trashed.get(note);
      return info !== undefined && !was.trashed.has(note) && was.loaded.has(info.source.id);
    });
    if (closed.length === 0) return;
    const byNote = new Map<string, typeof closed>();
    for (const item of closed) {
      const note = noteIdOfPath(currentEntry(item.tab).path)!;
      byNote.set(note, [...(byNote.get(note) ?? []), item]);
    }
    for (const [note, items] of byNote) rememberClosedFor(note, items);
    const [first] = byNote.keys();
    const info = first === undefined ? undefined : trashed.get(first);
    if (first !== undefined && info) {
      closedNotice.set({
        id: first,
        title: info.title,
        restore: async () => {
          await info.source.notes.restoreFromTrash(first);
          reopenTabsOfRestored(first);
        },
      });
    }
  }, [tabs, trashed, all]);

  // Which notebook each tab's note is in, while it is known: a notebook that closes takes them.
  const sourceOf = useRef(new Map<string, string>());
  const known = useRef(new Set<string>());
  useEffect(() => {
    if (!state) return;
    for (const note of tabNotes(state)) {
      const source = all.find((each) => each.notes.knows(note) === true);
      if (source) sourceOf.current.set(note, source.id);
    }
  }, [state, all, tick]);
  useEffect(() => {
    if (!tabs) return;
    const open = new Set(all.map((source) => source.id));
    const gone = [...known.current].filter((id) => !open.has(id));
    known.current = open;
    if (gone.length === 0) return;
    tabs.closeShowing((note) => {
      const source = sourceOf.current.get(note);
      return source !== undefined && gone.includes(source);
    });
  }, [tabs, all]);

  // Once the notebooks have read their notes, a page of a note none knows goes (AC7).
  const dropped = useRef(false);
  useEffect(() => {
    if (dropped.current || !tabs || !state || !sources.loaded) return;
    // Only tabs saved at the last launch: a page opened now waits for its notebook.
    if (!tabs.restored) {
      dropped.current = true;
      return;
    }
    const notes = tabNotes(state).filter((note) => note !== tabs.launchNote);
    const knows = (note: string) => all.map((source) => source.notes.knows(note));
    if (notes.some((note) => knows(note).includes(null))) return;
    dropped.current = true;
    tabs.dropUnknown((note) => note === tabs.launchNote || knows(note).includes(true));
  }, [tabs, state, sources, all, tick]);

  return <TabClosedToast />;
}

/** "“Title” was moved to Trash, so its tab closed." with Restore (AC9). */
function TabClosedToast() {
  const notice = useSyncExternalStore(closedNotice.subscribe, closedNotice.get, closedNotice.get);
  const onDone = useCallback(() => closedNotice.set(null), []);
  const [held, setHeld] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!notice || held) return;
    const timer = setTimeout(onDone, CLOSED_MS);
    return () => clearTimeout(timer);
  }, [notice, held, onDone]);
  const restore = async () => {
    if (!notice) return;
    try {
      await notice.restore();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not restore the note.');
      return;
    }
    setError(null);
    onDone();
  };
  return (
    <ToastSlot>
      {notice ? (
        <ActionToast
          tone="info"
          testId="tab-trashed-toast"
          icon={<Icon name="trash" />}
          actions={
            <button
              type="button"
              className="toast-action"
              data-ui="submit"
              data-testid="tab-trashed-restore"
              onClick={() => void restore()}
            >
              Restore
            </button>
          }
          onDismiss={onDone}
          onHold={setHeld}
        >
          <span role="status">
            {error ?? (
              <>
                “<bdi>{trashedTitle(notice.title)}</bdi>” was moved to Trash, so its tab closed.
              </>
            )}
          </span>
        </ActionToast>
      ) : null}
    </ToastSlot>
  );
}
