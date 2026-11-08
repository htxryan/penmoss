/**
 * Whether a note's panel is open (T53 item 9, A985, superseding T52 item 6's Hidden, Compact and
 * Expanded): the four tabs' icons always run down the note's right edge as vertical tabs, and the
 * panel is either open beside them on one tab or closed. Each note remembers its own on this
 * device, in a bounded list (the most recent few hundred); a note without one takes this device's
 * default, chosen in Settings → Appearance. In a pane too narrow for a readable column beside the
 * panel (60rem), the open panel lies over the note's text instead of pushing it.
 */
import {
  useCallback,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import type { KeyValueStore } from '../shell/key-value';
import { usePhone } from '../shell/media';

export type NotePanelMode = 'closed' | 'open';

/** Settings' order. */
export const NOTE_PANEL_MODES: ReadonlyArray<{
  readonly mode: NotePanelMode;
  readonly label: string;
}> = [
  { mode: 'closed', label: 'Closed' },
  { mode: 'open', label: 'Open' },
];

/** This device's default for notes without a state of their own. */
export const PANEL_DEFAULT_KEY = 'penmoss.notePanelMode';
/** Each note's own state, most recent first: `[[noteId, state], …]`. */
export const PANEL_NOTES_KEY = 'penmoss.notePanelModes';
/** How many notes keep their own state; the least recently changed goes first. */
export const MAX_NOTE_MODES = 300;

/** The note pane's width (in rem) from which the open panel, at its first width, shows beside the text. */
export const WIDE_PANE_REM = 60;

/**
 * Whether a pane this wide (px) has room for the side panel, at this root font size (px): the
 * panel's width (26rem until it is dragged, A1122) and the note's 34rem beside it.
 */
export function paneIsWide(width: number, remPx: number, panelRem = 26): boolean {
  return width >= (WIDE_PANE_REM - 26 + panelRem) * remPx;
}

/**
 * A stored state, read: T52's modes count too (Expanded was open; Hidden and Compact were
 * closed), so a note keeps what it showed. Null for anything else.
 */
export function readPanelMode(value: unknown): NotePanelMode | null {
  if (value === 'open' || value === 'expanded') return 'open';
  if (value === 'closed' || value === 'hidden' || value === 'compact') return 'closed';
  return null;
}

type Remembered = ReadonlyArray<readonly [string, NotePanelMode]>;

/** The list with this note's mode first, at most `max` long. */
export function rememberPanelMode(
  list: Remembered,
  noteId: string,
  mode: NotePanelMode,
  max = MAX_NOTE_MODES,
): Remembered {
  return [[noteId, mode] as const, ...list.filter(([id]) => id !== noteId)].slice(0, max);
}

/** The stored list, without anything unreadable in it. */
export function parsePanelModes(raw: string | null): Remembered {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry: unknown) => {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') return [];
      const mode = readPanelMode(entry[1]);
      return mode ? [[entry[0], mode] as const] : [];
    });
  } catch {
    return [];
  }
}

function storage(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * The default where this device has none chosen: closed in the phone layout (700 px and below),
 * where the panel covers the note and every tab is in the ⋯ sheet, so the note keeps the
 * screen's width (T52); open elsewhere.
 */
export function unchosenPanelMode(phone: boolean): NotePanelMode {
  return phone ? 'closed' : 'open';
}

/** This device's default: the one chosen in Settings, else closed on a phone, else open. */
export function readDefaultPanelMode(
  store: KeyValueStore | null = storage(),
  phone = false,
): NotePanelMode {
  try {
    return readPanelMode(store?.getItem(PANEL_DEFAULT_KEY)) ?? unchosenPanelMode(phone);
  } catch {
    return unchosenPanelMode(phone);
  }
}

/** The note's own mode, or null when it has none (it takes the default). */
export function readNotePanelMode(
  noteId: string,
  store: KeyValueStore | null = storage(),
): NotePanelMode | null {
  try {
    const list = parsePanelModes(store?.getItem(PANEL_NOTES_KEY) ?? null);
    return list.find(([id]) => id === noteId)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function writeNotePanelMode(
  noteId: string,
  mode: NotePanelMode,
  store: KeyValueStore | null = storage(),
): void {
  try {
    const list = parsePanelModes(store?.getItem(PANEL_NOTES_KEY) ?? null);
    store?.setItem(PANEL_NOTES_KEY, JSON.stringify(rememberPanelMode(list, noteId, mode)));
  } catch {
    // Private mode: the choice lasts while the note is open.
  }
}

const listeners = new Set<() => void>();

function subscribeDefault(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Settings → Appearance → Note Panel: this device's default, and a way to change it. */
export function useDefaultPanelMode(): readonly [NotePanelMode, (mode: NotePanelMode) => void] {
  const phone = usePhone();
  const mode = useSyncExternalStore<NotePanelMode>(
    subscribeDefault,
    () => readDefaultPanelMode(storage(), phone),
    () => unchosenPanelMode(phone),
  );
  const set = useCallback((next: NotePanelMode) => {
    try {
      storage()?.setItem(PANEL_DEFAULT_KEY, next);
    } catch {
      // Private mode: as above.
    }
    for (const listener of listeners) listener();
  }, []);
  return [mode, set] as const;
}

/**
 * Whether the note's pane (`.note-main`, around `ref`) has room for the side panel, following
 * the window and the sidebar as they change, and whether it has been measured yet. The pane's
 * border box, scrollbar included, so the panel's coming and going never moves the answer. Wide
 * until measured, as on the server; measured before the first paint.
 */
export function usePaneWidth(
  ref: RefObject<HTMLElement | null>,
  panelRem = 26,
): {
  readonly wide: boolean;
  readonly measured: boolean;
} {
  const [state, setState] = useState({ wide: true, measured: false });
  useLayoutEffect(() => {
    const element = ref.current;
    const pane = element?.closest<HTMLElement>('.note-main') ?? element;
    if (!pane) return;
    const measure = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const wide = paneIsWide(pane.offsetWidth, rem, panelRem);
      setState((last) => (last.measured && last.wide === wide ? last : { wide, measured: true }));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(pane);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [ref, panelRem]);
  return state;
}

/** Whether the note's pane has room for the side panel (`usePaneWidth`'s answer). */
export function usePaneWide(ref: RefObject<HTMLElement | null>): boolean {
  return usePaneWidth(ref).wide;
}

/**
 * The note's state (its own, else the default) and a way to change it, which remembers it for
 * this note. Read once per note: the view is mounted afresh for each note. A note with no state
 * of its own starts closed when its pane was too narrow for the panel beside it as it opened
 * (`startedWide` false: a note window, a narrow window), so it never opens over the text it was
 * opened to read (T53); the pane changing width later moves the panel, never closes it.
 */
export function useNotePanelMode(
  noteId: string,
  startedWide = true,
): readonly [NotePanelMode, (mode: NotePanelMode) => void, NotePanelMode] {
  const [fallback] = useDefaultPanelMode();
  const [own, setOwn] = useState(() => ({ noteId, mode: readNotePanelMode(noteId) }));
  // Another note in the same view (a test, a future caller): its own mode, read afresh.
  const mode = own.noteId === noteId ? own.mode : readNotePanelMode(noteId);
  const set = useCallback(
    (next: NotePanelMode) => {
      setOwn({ noteId, mode: next });
      writeNotePanelMode(noteId, next);
    },
    [noteId],
  );
  return [mode ?? (startedWide ? fallback : 'closed'), set, fallback] as const;
}
