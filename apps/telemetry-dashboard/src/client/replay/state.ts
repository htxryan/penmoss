/**
 * A session's replay (PEN-178): what the app showed at any moment, from the session's events
 * alone. Pure, with no DOM: `createReplay(events).frameAt(t)` is the Frame at session time `t`
 * (ms since its first event). Seeking to `t` and playing up to `t` call the same function, so
 * they can't disagree. A note's shape changes by core's rules (tokenLength, withLength, the
 * splice `replayShape` makes), kept per note ref, so switching back to a note brings back its
 * shape. A typing burst is recorded at the end of the second it covers (TypingGate), so a frame
 * looks one second ahead and spreads the burst over it.
 */
import { TYPING_GAP_MS, tokenLength, withLength } from '@penmoss/core/analytics';

/** A prop's value, as recorded. */
type PropValue = string | number | boolean | readonly string[];

/** What the replay reads of an event (/api/session's rows). */
export interface ReplayEvent {
  readonly seq: number;
  readonly at: number;
  readonly client: string;
  readonly size_class: string | null;
  readonly kind: string;
  readonly name: string;
  readonly props: Readonly<Record<string, PropValue>>;
}

export type SizeClass = 'compact' | 'medium' | 'expanded';
export type SidebarState = 'shown' | 'rail' | 'hidden';
export type PanelState = 'open' | 'closed' | 'none';
export type ThemeMode = 'light' | 'dark' | 'system';

/** A window when none was recorded: the size class's (as sizeClassOf divides them at 600, 840). */
export const SIZE_CLASS_WINDOWS: Readonly<Record<SizeClass, { width: number; height: number }>> = {
  compact: { width: 412, height: 915 },
  medium: { width: 768, height: 1024 },
  expanded: { width: 1280, height: 800 },
};

/** The app's sidebar width before any is recorded: 17 rem. */
export const DEFAULT_SIDEBAR_PX = 17 * 16;

/** Gaps longer than this play as SKIP_TO before the next event (O4). */
export const SKIP_OVER_MS = 10_000;
export const SKIP_TO_MS = 1_000;

/** How often a snapshot of the state is kept, so a seek replays at most this many events. */
const SNAPSHOT_EVERY = 200;

export interface FrameBlock {
  /** Its token, as recorded (`p:182`, `li.t.2:31`, `hr`). */
  readonly token: string;
  /** Its length in characters, or null for a kind without text. */
  readonly length: number | null;
  /** Its lorem's seed: the note's ref and the block's place when it first appeared. */
  readonly seed: string;
}

export interface FrameNote {
  /** Its ref, or null for a note never named. */
  readonly ref: string | null;
  /** The title's length and seed; null when the shape wasn't recorded (placeholders). */
  readonly title: { readonly length: number; readonly seed: string } | null;
  /** Its blocks, or null when the shape wasn't recorded (placeholders). */
  readonly blocks: readonly FrameBlock[] | null;
  /** The shape was cut by the cap: it ends with the blocks it has. */
  readonly more: boolean;
  /** Where the caret is: a block's index, the title, or nowhere recorded. */
  readonly caret: number | 'title' | null;
  readonly selection: {
    readonly block: number;
    readonly chars: number;
    readonly span: number;
  } | null;
}

export interface FrameDialog {
  /** Its name in the catalogue (DIALOG_NAMES). */
  readonly name: string;
  /** Its field and the length typed there, once an input event says. */
  readonly field: string | null;
  readonly chars: number | null;
}

export interface Frame {
  /** The moment, ms since the session's first event. */
  readonly t: number;
  /** The event the moment is at: the last at or before `t`. */
  readonly current: number;
  readonly client: string;
  readonly sizeClass: SizeClass;
  readonly window: { readonly width: number; readonly height: number; readonly recorded: boolean };
  readonly layout: {
    readonly sidebar: SidebarState;
    /** In CSS px (dp on Android); null when the sidebar isn't shown. */
    readonly sidebarWidth: number | null;
    readonly panel: PanelState;
    readonly fullWidth: boolean;
    readonly themeMode: ThemeMode;
    /** The tab count's bucket ("2–4"), or null where there are no tabs (Android). */
    readonly tabs: string | null;
    readonly recorded: boolean;
  };
  /** The last `setting theme.id`: a built-in theme's id or `custom`; null when none was. */
  readonly theme: string | null;
  /** The screen showing, or null before any. */
  readonly screen: string | null;
  /** The dialogs open, the topmost last. */
  readonly dialogs: readonly FrameDialog[];
  /** The length typed in Search Settings (A1666), while there is one. */
  readonly settingsSearch: number | null;
  /** Each area scrolled on this screen, 0–1. */
  readonly scroll: Readonly<Record<string, number>>;
  /** The note shown on a note screen; null when no note is (or not yet). */
  readonly note: FrameNote | null;
  /** The whole session was recorded before note shape and typing were (PEN-177). */
  readonly placeholders: boolean;
}

/** A note's shape as the replay holds it: tokens, each with its lorem's id. */
interface NoteState {
  titleChars: number;
  tokens: string[];
  ids: number[];
  nextId: number;
  more: boolean;
}

interface State {
  window: { width: number; height: number } | null;
  layout: {
    sidebar: SidebarState;
    sidebarWidth: number | null;
    panel: PanelState;
    fullWidth: boolean;
    themeMode: ThemeMode;
    tabs: string | null;
  } | null;
  theme: string | null;
  screen: string | null;
  dialogs: FrameDialog[];
  settingsSearch: number | null;
  scroll: Record<string, number>;
  notes: Map<string, NoteState>;
  /** The ref of the note shown, '' for one shown but not yet opened (placeholders), or null. */
  shown: string | null;
  caret: number | 'title' | null;
  selection: { block: number; chars: number; span: number } | null;
}

const NOTE_SCREENS = new Set(['note', 'journal']);
export const isNoteScreen = (screen: string | null) => screen !== null && NOTE_SCREENS.has(screen);

const str = (props: Readonly<Record<string, PropValue>>, key: string): string | null => {
  const value = props[key];
  return typeof value === 'string' ? value : null;
};
const num = (props: Readonly<Record<string, PropValue>>, key: string): number | null => {
  const value = props[key];
  return typeof value === 'number' ? value : null;
};
const list = (props: Readonly<Record<string, PropValue>>, key: string): readonly string[] => {
  const value = props[key];
  return Array.isArray(value) ? (value as readonly string[]) : [];
};

/** The lower bound of a count bucket ("2–4" → 2, "5000+" → 5000), or null. */
export function bucketFloor(bucket: string | null): number | null {
  if (bucket === null) return null;
  const match = /^\d+/.exec(bucket);
  return match ? Number(match[0]) : null;
}

function emptyState(): State {
  return {
    window: null,
    layout: null,
    theme: null,
    screen: null,
    dialogs: [],
    settingsSearch: null,
    scroll: {},
    notes: new Map(),
    shown: null,
    caret: null,
    selection: null,
  };
}

function cloneNote(note: NoteState): NoteState {
  return { ...note, tokens: [...note.tokens], ids: [...note.ids] };
}

function cloneState(state: State): State {
  return {
    ...state,
    window: state.window ? { ...state.window } : null,
    layout: state.layout ? { ...state.layout } : null,
    dialogs: state.dialogs.map((dialog) => ({ ...dialog })),
    scroll: { ...state.scroll },
    notes: new Map([...state.notes].map(([ref, note]) => [ref, cloneNote(note)])),
    selection: state.selection ? { ...state.selection } : null,
  };
}

/** A note's state from an open's props. */
function noteFrom(props: Readonly<Record<string, PropValue>>): NoteState {
  const tokens = [...list(props, 'shape')];
  return {
    titleChars: num(props, 'titleChars') ?? 0,
    tokens,
    ids: tokens.map((_, i) => i),
    nextId: tokens.length,
    more: props['more'] === true,
  };
}

/** The ref of a note event: its own, or the note shown. */
const refOf = (state: State, props: Readonly<Record<string, PropValue>>) =>
  str(props, 'note') ?? (state.shown || null);

export interface FrameOptions {
  readonly reduceMotion?: boolean;
  readonly index?: number;
}

export interface Replay {
  readonly events: readonly ReplayEvent[];
  /** Each event's time in the session, ms since its first, never going back. */
  readonly times: readonly number[];
  /** The session's length: its last event's time. */
  readonly duration: number;
  /** The session shows a note screen but has no note events: before PEN-177. */
  readonly beforeDetail: boolean;
  /** The session has no app window or app layout event: before PEN-174. */
  readonly beforeLayout: boolean;
  readonly sizeClass: SizeClass;
  /** The index of the last event at or before `t`, at least 0. */
  indexAt(t: number): number;
  /**
   * The frame at `t`; Reduce Motion gives a typing burst its length in one step. `index` names the
   * event the moment is at, when several share its time (a row chosen in the timeline).
   */
  frameAt(t: number, options?: FrameOptions): Frame;
}

export function createReplay(events: readonly ReplayEvent[]): Replay {
  const start = events[0]?.at ?? 0;
  const times: number[] = [];
  for (const [i, event] of events.entries()) {
    times.push(Math.max(i > 0 ? times[i - 1]! : 0, event.at - start));
  }
  const duration = times.at(-1) ?? 0;
  const client = events[0]?.client ?? 'mac';
  const recordedClass = events.find((e) => e.size_class)?.size_class;
  const sizeClass: SizeClass =
    recordedClass === 'compact' || recordedClass === 'medium' || recordedClass === 'expanded'
      ? recordedClass
      : client === 'android'
        ? 'compact'
        : 'expanded';
  const beforeDetail =
    events.some((e) => e.kind === 'screen' && isNoteScreen(e.name)) &&
    !events.some((e) => e.kind === 'note');
  const beforeLayout = !events.some(
    (e) => e.kind === 'app' && (e.name === 'window' || e.name === 'layout'),
  );
  // A note only switched to before the session's first event has no open of its own before its
  // typing: it takes its first recorded shape.
  const firstOpen = new Map<string, Readonly<Record<string, PropValue>>>();
  for (const event of events) {
    if (event.kind !== 'note' || event.name !== 'open') continue;
    const ref = str(event.props, 'note');
    if (ref && !firstOpen.has(ref) && Array.isArray(event.props['shape'])) {
      firstOpen.set(ref, event.props);
    }
  }

  /** The note `ref`'s state, made from its first recorded shape when it has none yet. */
  const noteOf = (state: State, ref: string | null): NoteState | null => {
    if (!ref) return null;
    let note = state.notes.get(ref);
    if (!note) {
      const open = firstOpen.get(ref);
      if (!open) return null;
      note = noteFrom(open);
      state.notes.set(ref, note);
    }
    return note;
  };

  /** Applies event `event` to `state`. */
  const apply = (state: State, event: ReplayEvent): void => {
    const { props } = event;
    switch (event.kind) {
      case 'app': {
        const window = str(props, 'window') ?? 'main';
        if (window !== 'main') return;
        if (event.name === 'window') {
          const width = num(props, 'width') ?? 0;
          const height = num(props, 'height') ?? 0;
          if (width > 0 && height > 0) state.window = { width, height };
        } else if (event.name === 'layout') {
          const before = state.layout;
          const sidebar =
            (str(props, 'sidebar') as SidebarState | null) ?? before?.sidebar ?? 'shown';
          state.layout = {
            sidebar,
            sidebarWidth:
              sidebar === 'shown'
                ? (num(props, 'sidebarWidth') ?? before?.sidebarWidth ?? DEFAULT_SIDEBAR_PX)
                : null,
            panel: (str(props, 'panel') as PanelState | null) ?? before?.panel ?? 'closed',
            fullWidth:
              typeof props['fullWidth'] === 'boolean'
                ? props['fullWidth']
                : (before?.fullWidth ?? false),
            themeMode:
              (str(props, 'themeMode') as ThemeMode | null) ?? before?.themeMode ?? 'system',
            tabs: str(props, 'tabs') ?? before?.tabs ?? null,
          };
        }
        return;
      }
      case 'setting':
        if (event.name === 'theme.id' && typeof props['value'] === 'string') {
          state.theme = props['value'];
        }
        return;
      case 'screen': {
        const changed = event.name !== state.screen;
        if (changed) {
          // A new screen starts at the top, as the app's does (A1663).
          state.scroll = {};
          state.settingsSearch = null;
          // A note screen shows its note once the note's open says which (A1669).
          if (isNoteScreen(event.name) && !isNoteScreen(state.screen)) {
            state.shown = '';
            state.caret = null;
            state.selection = null;
          }
        }
        state.screen = event.name;
        return;
      }
      case 'dialog': {
        const action = str(props, 'action');
        if (action === 'open') {
          state.dialogs.push({ name: event.name, field: null, chars: null });
        } else if (action === 'done' || action === 'cancel') {
          // The topmost dialog of that name closes, showing the one under it.
          for (let i = state.dialogs.length - 1; i >= 0; i--) {
            if (state.dialogs[i]!.name === event.name) {
              state.dialogs.splice(i, 1);
              break;
            }
          }
        }
        return;
      }
      case 'input': {
        const chars = num(props, 'chars');
        if (event.name === 'settingsSearch') {
          state.settingsSearch = chars && chars > 0 ? chars : null;
          return;
        }
        for (let i = state.dialogs.length - 1; i >= 0; i--) {
          const dialog = state.dialogs[i]!;
          if (dialog.name === event.name) {
            state.dialogs[i] = { ...dialog, field: str(props, 'field'), chars };
            break;
          }
        }
        return;
      }
      case 'scroll': {
        const position = num(props, 'position');
        if (position !== null) state.scroll[event.name] = position;
        return;
      }
      case 'note':
        applyNote(state, event);
        return;
      default:
        return;
    }
  };

  const applyNote = (state: State, event: ReplayEvent): void => {
    const { props } = event;
    const shownRef = state.shown || null;
    if (event.name === 'open') {
      const ref = str(props, 'note');
      const how = str(props, 'how') ?? 'open';
      const key = ref ?? '';
      const kept = state.notes.get(key);
      // A switch back brings back the note as it was; an open or a resync starts from its shape.
      if (!(how === 'switch' && kept)) state.notes.set(key, noteFrom(props));
      if (how !== 'resync' || shownRef !== ref) {
        state.caret = null;
        state.selection = null;
      }
      state.shown = key;
      return;
    }
    const ref = refOf(state, props);
    const note = noteOf(state, ref);
    if (!note) return;
    const local = props['remote'] !== true;
    const isShown = ref === shownRef;
    if (event.name === 'typing') {
      const typed = num(props, 'typed') ?? 0;
      const deleted = num(props, 'deleted') ?? 0;
      if (props['title'] === true) {
        note.titleChars = Math.max(0, note.titleChars + typed - deleted);
        if (local && isShown) {
          state.caret = 'title';
          state.selection = null;
        }
        return;
      }
      const block = num(props, 'block');
      if (block === null || block >= note.tokens.length) return;
      const token = note.tokens[block]!;
      const length = tokenLength(token);
      if (length === null) return;
      note.tokens[block] = withLength(token, length + typed - deleted);
      if (local && isShown) {
        state.caret = block;
        state.selection = null;
      }
    } else if (event.name === 'blocks') {
      const block = num(props, 'block') ?? 0;
      const removed = num(props, 'removed') ?? 0;
      const inserted = list(props, 'inserted');
      const ids = inserted.map(() => note.nextId++);
      note.tokens.splice(block, removed, ...inserted);
      note.ids.splice(block, removed, ...ids);
      if (isShown && typeof state.caret === 'number') {
        const caret = state.caret;
        if (caret >= block + removed) state.caret = caret - removed + inserted.length;
        else if (caret >= block) state.caret = Math.min(block, note.tokens.length - 1);
        if (typeof state.caret === 'number' && state.caret < 0) state.caret = null;
      }
      if (isShown) state.selection = null;
    } else if (event.name === 'cursor') {
      if (!isShown) return;
      state.caret = props['title'] === true ? 'title' : (num(props, 'block') ?? 0);
      state.selection = null;
    } else if (event.name === 'select') {
      if (!isShown) return;
      const block = num(props, 'block') ?? 0;
      state.selection = {
        block,
        chars: num(props, 'chars') ?? 0,
        span: Math.max(1, num(props, 'span') ?? 1),
      };
      state.caret = null;
    }
  };

  // Snapshots: snapshots[k] is the state after events 0 … k·SNAPSHOT_EVERY − 1.
  const snapshots: State[] = [emptyState()];
  {
    const state = emptyState();
    events.forEach((event, i) => {
      apply(state, event);
      if ((i + 1) % SNAPSHOT_EVERY === 0) snapshots.push(cloneState(state));
    });
  }
  /** The last state worked out, so playing forward continues from it. */
  let last: { index: number; state: State } | null = null;

  /** The state after event `index`. */
  const stateAfter = (index: number): State => {
    if (last && last.index === index) return last.state;
    let state: State;
    let from: number;
    if (last && last.index < index && index - last.index < SNAPSHOT_EVERY) {
      state = last.state;
      from = last.index + 1;
    } else {
      const k = Math.floor((index + 1) / SNAPSHOT_EVERY);
      state = cloneState(snapshots[k]!);
      from = k * SNAPSHOT_EVERY;
    }
    for (let i = from; i <= index; i++) apply(state, events[i]!);
    last = { index, state };
    return state;
  };

  const indexAt = (t: number): number => {
    let lo = 0;
    let hi = times.length - 1;
    if (hi < 0) return -1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (times[mid]! <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const frameAt = (t: number, options: FrameOptions = {}): Frame => {
    const time = Math.max(0, Math.min(t, duration));
    const asked = options.index;
    const index =
      asked !== undefined && asked >= 0 && asked < events.length && times[asked]! <= time
        ? asked
        : indexAt(time);
    const state = index < 0 ? emptyState() : stateAfter(index);
    const shownRef = state.shown || null;
    let note: FrameNote | null = null;
    // The burst the next event records, spread over the second before it (TypingGate).
    const next = events[index + 1];
    let partial: { block: number | 'title'; length: number; caret: boolean } | null = null;
    if (next && next.kind === 'note' && next.name === 'typing' && !options.reduceMotion) {
      const ends = times[index + 1]!;
      const begins = Math.max(ends - TYPING_GAP_MS, times[index]!);
      const ref = refOf(state, next.props);
      if (ends > begins && time >= begins && time < ends && ref === shownRef) {
        const target = state.notes.get(ref ?? '') ?? null;
        const typed = num(next.props, 'typed') ?? 0;
        const deleted = num(next.props, 'deleted') ?? 0;
        const steps = Math.floor(((time - begins) / (ends - begins)) * (typed + deleted));
        const change = steps <= deleted ? -steps : -deleted + (steps - deleted);
        const local = next.props['remote'] !== true;
        if (target && next.props['title'] === true) {
          partial = {
            block: 'title',
            length: Math.max(0, target.titleChars + change),
            caret: local,
          };
        } else if (target) {
          const block = num(next.props, 'block');
          const length = block === null ? null : tokenLength(target.tokens[block] ?? '');
          if (block !== null && length !== null) {
            partial = { block, length: Math.max(0, length + change), caret: local };
          }
        }
      }
    }
    if (isNoteScreen(state.screen) && state.shown !== null) {
      const held = shownRef === null ? null : (state.notes.get(shownRef) ?? null);
      const seed = shownRef ?? 'note';
      if (held && !beforeDetail) {
        const blocks = held.tokens.map((token, i): FrameBlock => {
          const length = partial && partial.block === i ? partial.length : tokenLength(token);
          return {
            token: length === null ? token : withLength(token, length),
            length,
            seed: `${seed}:${held.ids[i]}`,
          };
        });
        note = {
          ref: shownRef,
          title: {
            length: partial && partial.block === 'title' ? partial.length : held.titleChars,
            seed: `${seed}:title`,
          },
          blocks,
          more: held.more,
          caret: partial && partial.caret ? partial.block : state.caret,
          selection: partial && partial.caret ? null : state.selection,
        };
      } else {
        note = {
          ref: shownRef,
          title: null,
          blocks: null,
          more: false,
          caret: null,
          selection: null,
        };
      }
    }
    const recordedLayout = state.layout;
    return {
      t: time,
      current: index,
      client,
      sizeClass,
      window: state.window
        ? { ...state.window, recorded: true }
        : { ...SIZE_CLASS_WINDOWS[sizeClass], recorded: false },
      layout: recordedLayout
        ? {
            ...recordedLayout,
            tabs: client === 'android' ? null : recordedLayout.tabs,
            recorded: true,
          }
        : {
            sidebar: 'shown',
            sidebarWidth: DEFAULT_SIDEBAR_PX,
            panel: 'closed',
            fullWidth: false,
            themeMode: 'system',
            tabs: client === 'android' ? null : '1',
            recorded: false,
          },
      theme: state.theme,
      screen: state.screen,
      dialogs: state.dialogs.map((dialog) => ({ ...dialog })),
      settingsSearch: state.settingsSearch,
      scroll: { ...state.scroll },
      note,
      placeholders: beforeDetail,
    };
  };

  return { events, times, duration, beforeDetail, beforeLayout, sizeClass, indexAt, frameAt };
}

/**
 * Where playing moves next from `t`: a gap of more than SKIP_OVER_MS before the next event jumps to
 * SKIP_TO_MS before it (O4). The skipped length, or null for none.
 */
export function skipFrom(
  replay: Pick<Replay, 'times' | 'indexAt'>,
  t: number,
): { readonly to: number; readonly skipped: number } | null {
  const index = replay.indexAt(t);
  const next = replay.times[index + 1];
  if (next === undefined) return null;
  const at = Math.max(t, replay.times[index] ?? 0);
  if (next - at <= SKIP_OVER_MS) return null;
  return { to: next - SKIP_TO_MS, skipped: next - SKIP_TO_MS - at };
}
