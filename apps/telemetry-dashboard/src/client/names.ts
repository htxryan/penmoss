/**
 * What the dashboard calls an event (PEN-137, review round 2): its display name in Title Case,
 * never the raw id alone. A command is named by its title in the shortcut contract every client
 * shares ("note.new" → "New Note"), a screen, dialog or first-run step by the name the app shows
 * for it, and anything else by its id in Title Case. The id stays beside it, muted, in a table's
 * cell, a chart's tooltip and a path's node.
 */
import shortcutsContract from '../../../android/contract/shortcuts-v1.json';

/** Words kept lower case inside a Title Case label (A938). */
const SHORT_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'nor',
  'as',
  'at',
  'by',
  'for',
  'from',
  'in',
  'into',
  'of',
  'on',
  'per',
  'to',
  'with',
]);

/** Words that keep their own case. */
const OWN_CASE: Record<string, string> = {
  id: 'ID',
  ok: 'OK',
  cli: 'CLI',
  mcp: 'MCP',
  url: 'URL',
  github: 'GitHub',
  json: 'JSON',
  pdf: 'PDF',
  ai: 'AI',
};

/** An id ("git-missing", "notFound", "read_note") as a Title Case label ("Git Missing"…). */
export function titled(id: string): string {
  const words = id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_.-]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  return words
    .map((word, i) => {
      if (OWN_CASE[word]) return OWN_CASE[word];
      return i > 0 && i < words.length - 1 && SHORT_WORDS.has(word)
        ? word
        : word[0]!.toUpperCase() + word.slice(1);
    })
    .join(' ');
}

/** Each command's title in the shortcut contract, without the ellipsis a menu gives it. */
const COMMAND_TITLES: ReadonlyMap<string, string> = new Map(
  shortcutsContract.commands.map((command) => [
    command.id,
    command.title.replace(/(…|\.\.\.)$/, '').trim(),
  ]),
);

/** The first run's screens (FIRSTRUN_STEPS), as the funnel names them. */
export const FIRSTRUN_LABELS: Record<string, string> = {
  welcome: 'Welcome',
  goal: 'Choose a Goal',
  way: 'Choose a Way',
  github: 'Sign In with GitHub',
  accounts: 'Choose an Account',
  create: 'Create a Repository',
  list: 'Choose a Repository',
  branch: 'Choose a Branch',
  repo: 'Open a Repository',
  folder: 'Choose a Folder',
  url: 'Enter a Git URL',
  'git-missing': 'Git Missing',
  name: 'Name the Notebook',
  setup: 'Set Up',
  consent: 'Consent Answered',
};

/** Settings' pages (SETTINGS_SCREENS), as the Settings nav names them. */
const SETTINGS_PAGES: Record<string, string> = {
  appearance: 'Appearance',
  sidebar: 'Sidebar',
  note: 'Note',
  symbols: 'Symbols',
  journal: 'Daily Notes',
  'quick-capture': 'Quick Capture',
  shortcuts: 'Keyboard Shortcuts',
  'git-notebooks': 'All Notebooks',
  'git-notebook': 'A Notebook',
  agents: 'Agents',
  'agent-activity': 'Agent Activity',
  meaning: 'Semantic Search',
  github: 'GitHub',
  updates: 'Updates',
  storage: 'Storage',
  'whats-new': "What's New",
  privacy: 'Privacy',
  'privacy-data': 'Analytics Data',
  search: 'Search Settings',
  home: 'Settings',
};

/** Screens (SCREEN_NAMES) the app names otherwise than their id. */
const SCREENS: Record<string, string> = {
  journal: 'Daily Notes',
  'time-machine': 'Time Machine',
  history: 'Version History',
  capture: 'Quick Capture',
  feedback: 'Send Feedback',
  notebook: 'Notebook Home',
};

/** Dialogs (DIALOG_NAMES) the app names otherwise than their id. */
const DIALOGS: Record<string, string> = {
  palette: 'Command Palette',
  quickOpen: 'Quick Open',
  recent: 'Recent Notes',
  cheatsheet: 'Keyboard Shortcuts',
  feedback: 'Send Feedback',
  consent: 'Share How You Use Penmoss?',
  move: 'Move to Folder',
  link: 'Add a Link',
  tag: 'Tags',
  newTab: 'New Tab',
  confirm: 'Confirmation',
  releaseNotes: "What's New",
  history: 'Version History',
  capture: 'Quick Capture',
  shareSheet: 'Share Sheet',
};

/** The areas a scroll event names (SCROLL_NAMES, PEN-175), as the app calls them. */
const SCROLL_AREAS: Record<string, string> = {
  note: 'Note',
  sidebar: 'Sidebar',
  'sidebar.folders': 'Sidebar › Folders',
  'sidebar.recent': 'Sidebar › Recent Notes',
  'sidebar.tags': 'Sidebar › Tags',
  settings: 'Settings',
  'settings.nav': 'Settings › List of Pages',
};

/** The display name of event `name` of `kind`, without its kind. */
export function displayName(kind: string, name: string): string {
  switch (kind) {
    case 'command':
      return COMMAND_TITLES.get(name) ?? titled(name);
    case 'screen': {
      if (name.startsWith('settings.')) {
        const page = name.slice('settings.'.length);
        return `Settings › ${SETTINGS_PAGES[page] ?? titled(page)}`;
      }
      if (name.startsWith('firstrun.')) {
        const step = name.slice('firstrun.'.length);
        return `First Run › ${FIRSTRUN_LABELS[step] ?? titled(step)}`;
      }
      return SCREENS[name] ?? titled(name);
    }
    case 'dialog':
      return DIALOGS[name] ?? titled(name);
    case 'firstrun':
      return FIRSTRUN_LABELS[name] ?? titled(name);
    case 'click':
    case 'setting':
      // A control's or setting's id names where it is, part by part.
      return name.split('.').map(titled).join(' › ');
    case 'cli':
      return `penmoss ${name}`;
    case 'scroll':
      return SCROLL_AREAS[name] ?? name.split('.').map(titled).join(' › ');
    default:
      return titled(name);
  }
}

export interface EventName {
  /** "New Note", "Note", "Session Ended". */
  readonly title: string;
  /** The id as recorded: "note.new", "screen:note"; empty for the end of a session. */
  readonly id: string;
}

/**
 * A path's or chip's event ("command:note.new", "screen:note", "end") by name: "New Note",
 * "Note". Its id keeps the kind for anything but a command ("screen:note"), so a screen and a
 * dialog of one name are told apart by the muted line under it.
 */
export function eventName(event: string): EventName {
  if (event === 'end') return { title: 'Session Ended', id: '' };
  const at = event.indexOf(':');
  if (at < 0) return { title: titled(event), id: event };
  const kind = event.slice(0, at);
  const name = event.slice(at + 1);
  return { title: displayName(kind, name), id: kind === 'command' ? name : event };
}

/** What kind of event `event` ("dialog:palette") is, as a word: "Dialog". */
export function kindName(event: string): string {
  const kind = event.slice(0, Math.max(0, event.indexOf(':')));
  return KINDS[kind] ?? titled(kind);
}

const KINDS: Record<string, string> = {
  command: 'Command',
  scroll: 'Scroll',
  firstrun: 'First Run',
  cli: 'CLI Command',
  tool: 'MCP Tool',
};

/** A command's display name and id. */
export function commandName(name: string): EventName {
  return { title: displayName('command', name), id: name };
}

// ---------------------------------------------------------------------------------------------
// The words for recorded values, which every view and Sessions' props share (PEN-173).

export const CLIENT_LABELS: Record<string, string> = {
  mac: 'Mac',
  android: 'Android',
  cli: 'CLI',
  mcp: 'MCP',
};
export const ACTOR_LABELS: Record<string, string> = {
  person: 'Person',
  agent: 'Agent',
  script: 'Script',
};
/** The MCP clients' fixed list (core's AGENT_CLIENTS), as people name them. */
export const AGENT_CLIENT_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  cursor: 'Cursor',
  vscode: 'VS Code',
  windsurf: 'Windsurf',
  zed: 'Zed',
  gemini: 'Gemini',
  goose: 'Goose',
  cline: 'Cline',
  continue: 'Continue',
  penmoss: 'Penmoss',
  other: 'Other Agent',
};
/** Who ran a CLI command or MCP tool: an agent client by name, else the actor. */
export const agentLabel = (key: string) =>
  AGENT_CLIENT_LABELS[key] ?? ACTOR_LABELS[key] ?? titled(key);
export const STEP_RESULT_LABELS: Record<string, string> = {
  done: 'Done',
  back: 'Back',
  failed: 'Failed',
};
/**
 * A CLI command's or MCP tool's results, as the Agents query's columns name them, in order: blue,
 * then orange, aqua, and the rest.
 */
export const RESULTS = [
  { key: 'ok', label: 'OK', color: 'var(--s1)' },
  { key: 'invalid', label: 'Invalid', color: 'var(--s2)' },
  { key: 'not_found', label: 'Not Found', color: 'var(--s3)' },
  { key: 'conflict', label: 'Conflict', color: 'var(--s4)' },
  { key: 'failed', label: 'Failed', color: 'var(--s5)' },
] as const;
export const SOURCE_LABELS: Record<string, string> = {
  key: 'Key',
  palette: 'Palette',
  button: 'Button',
  menu: 'Menu',
  tray: 'Tray',
  hotkey: 'Hotkey',
  editor: 'Editor',
  other: 'Other',
  '': 'Other',
};
export const SYNC_LABELS: Record<string, string> = {
  ok: 'OK',
  conflict: 'Conflict',
  offline: 'Offline',
  failed: 'Failed',
};
/** An OS as people write it. */
export const osName = (os: string) =>
  ({ macos: 'macOS', android: 'Android', linux: 'Linux', windows: 'Windows' })[os] ?? 'Other';

/** A prop's value as recorded (core's PropValue). */
export type PropValue = string | number | boolean | readonly string[];

interface PropWords {
  /** The prop's label, in Title Case. */
  readonly label: string;
  /** Its recorded values' words, keyed as recorded. */
  readonly values?: Readonly<Record<string, string>>;
  /** Or a function from the value to its word. */
  readonly word?: (value: PropValue) => string;
}

const YES_NO = { true: 'Yes', false: 'No' };
const each = (value: PropValue) => (Array.isArray(value) ? value : [value]).map(String);

/** Which window an `app window` or `app layout` event is about. */
const WINDOW_LABELS: Readonly<Record<string, string>> = {
  main: 'Main',
  note: 'Note',
  capture: 'Quick Capture',
};

/**
 * Each kind's props (core's PROP_SPECS, in its order), labelled, with a word for each value. A
 * test walks PROP_SPECS, so a prop added there fails until it has its words here.
 */
export const PROP_WORDS: Readonly<Record<string, Readonly<Record<string, PropWords>>>> = {
  app: {
    notebooks: { label: 'Notebooks' },
    notes: { label: 'Notes' },
    agents: { label: 'Agents', values: YES_NO },
    theme: { label: 'Theme', word: (value) => titled(String(value)) },
    active: { label: 'Active For' },
  },
  command: {
    source: { label: 'Source', values: SOURCE_LABELS },
    keys: { label: 'Keys' },
    custom: { label: 'Own Shortcut', values: YES_NO },
    ran: { label: 'Ran', values: YES_NO },
  },
  screen: { from: { label: 'From', word: (value) => displayName('screen', String(value)) } },
  dialog: {
    action: { label: 'Action', values: { open: 'Open', done: 'Done', cancel: 'Cancel' } },
    open: { label: 'Open For' },
  },
  click: { state: { label: 'State', values: { on: 'On', off: 'Off' } } },
  menu: {
    source: {
      label: 'Source',
      values: { menubar: 'Menu Bar', tray: 'Tray', context: 'Context Menu' },
    },
  },
  setting: {
    value: {
      label: 'Value',
      word: (value) =>
        typeof value === 'boolean'
          ? YES_NO[String(value) as 'true' | 'false']
          : typeof value === 'number'
            ? String(value)
            : titled(String(value)),
    },
    changed: { label: 'Changed', values: { true: 'Yes' } },
  },
  firstrun: {
    result: { label: 'Result', values: STEP_RESULT_LABELS },
    error: { label: 'Error', word: (value) => titled(String(value)) },
  },
  feedback: {
    type: { label: 'Type', values: { bug: 'Bug', feature: 'Feature' } },
    priority: { label: 'Priority', values: { 1: '1', 2: '2', 3: '3', 4: '4' } },
    screenshots: { label: 'Screenshots' },
    logs: { label: 'Logs', values: YES_NO },
    groupsLeftOut: { label: 'Groups Left Out' },
  },
  sync: {
    result: { label: 'Result', values: SYNC_LABELS },
    took: { label: 'Took' },
    changed: { label: 'Changed' },
  },
  cli: {
    // CLI_FLAGS are stored without their dashes.
    flags: {
      label: 'Flags',
      word: (value) =>
        each(value)
          .map((flag) => `--${flag}`)
          .join(' '),
    },
    exit: {
      label: 'Exit',
      values: {
        OK: 'OK',
        ERROR: 'Error',
        USAGE: 'Usage',
        AUTH: 'Auth',
        NOT_FOUND: 'Not Found',
        CONFLICT: 'Conflict',
        AMBIGUOUS: 'Ambiguous',
        REFUSED: 'Refused',
      },
    },
    took: { label: 'Took' },
    tty: { label: 'Terminal', values: YES_NO },
  },
  tool: {
    agentClient: { label: 'Agent', values: AGENT_CLIENT_LABELS },
    // Keyed as the tool records it (notFound), not as the Agents query's column (not_found).
    result: {
      label: 'Result',
      values: {
        ok: 'OK',
        invalid: 'Invalid',
        notFound: 'Not Found',
        conflict: 'Conflict',
        failed: 'Failed',
      },
    },
    took: { label: 'Took' },
  },
};

/**
 * The words for props tied to one name (core's NAME_PROP_SPECS, PEN-174), keyed `kind.name`: an
 * event of that name takes these and no others. The same test walks NAME_PROP_SPECS.
 */
export const NAME_PROP_WORDS: Readonly<Record<string, Readonly<Record<string, PropWords>>>> = {
  'app.window': {
    window: { label: 'Window', values: WINDOW_LABELS },
    width: { label: 'Width' },
    height: { label: 'Height' },
    fullScreen: { label: 'Full Screen', values: YES_NO },
    maximised: { label: 'Maximised', values: YES_NO },
  },
  'app.layout': {
    window: { label: 'Window', values: WINDOW_LABELS },
    sidebar: { label: 'Sidebar', values: { shown: 'Shown', rail: 'Rail', hidden: 'Hidden' } },
    sidebarWidth: { label: 'Sidebar Width' },
    panel: { label: 'Note Panel', values: { open: 'Open', closed: 'Closed', none: 'None' } },
    fullWidth: { label: 'Full Width', values: YES_NO },
    themeMode: { label: 'Theme Mode', values: { light: 'Light', dark: 'Dark', system: 'System' } },
    tabs: { label: 'Tabs' },
  },
};

export interface PropInWords {
  readonly label: string;
  readonly value: string;
}

/** The word for one prop's value. */
function propWord(words: PropWords | undefined, value: PropValue): string {
  if (words?.word) return words.word(value);
  const key = String(value);
  if (words?.values && Object.hasOwn(words.values, key)) return words.values[key]!;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return each(value).join(' ');
  // A bucket, a key combination or a count shows as recorded; a word it doesn't know, from a
  // newer client, in Title Case.
  if (typeof value === 'number' || (words && !words.values)) return key;
  return titled(key);
}

/**
 * An event's props as label and value pairs, in PROP_SPECS' order: every recorded prop, No and 0
 * included, and a key this page doesn't know (a newer client's) in Title Case at the end.
 */
export function propsInWords(
  kind: string,
  props: Readonly<Record<string, PropValue>> | null | undefined,
  name?: string,
): PropInWords[] {
  const known =
    (name === undefined ? undefined : NAME_PROP_WORDS[`${kind}.${name}`]) ?? PROP_WORDS[kind] ?? {};
  const recorded = Object.entries(props ?? {});
  const order = Object.keys(known);
  return recorded
    .sort(([a], [b]) => {
      const i = order.indexOf(a);
      const j = order.indexOf(b);
      return (i < 0 ? order.length : i) - (j < 0 ? order.length : j);
    })
    .map(([key, value]) => ({
      label: known[key]?.label ?? titled(key),
      value: propWord(known[key], value),
    }));
}

// ---------------------------------------------------------------------------------------------
// Times and lengths in a session (PEN-173).

const pad = (n: number) => String(n).padStart(2, '0');
/** The minus sign a negative gap starts with. */
export const MINUS = '−';

/** Time since a session started: "0:12", "1:02", "1:02:03" past an hour. */
export function sinceStart(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}`
    : `${minutes}:${pad(seconds % 60)}`;
}

/** A length: "42s", "18m 04s", "2h 05m"; a negative one starts with a minus. */
export function duration(ms: number): string {
  if (ms < 0) return `${MINUS}${duration(-ms)}`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${pad(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
}

/** The gap since the event before: "+11s", "+1m 21s", "+2h 05m", "−3s" when a clock moved back. */
export function gap(ms: number): string {
  return ms < 0 ? duration(ms) : `+${duration(ms)}`;
}

/**
 * A session's length: its last event's time less its first's. A session of one event has
 * nothing to measure to, so its length is that event's took bucket ("<1s"), or 0s without one.
 */
export function sessionLength(session: {
  readonly started: number;
  readonly ended: number;
  readonly events: number;
  readonly took?: string | null;
}): string {
  if (session.events <= 1) return session.took || '0s';
  return duration(session.ended - session.started);
}

const count = (n: number) => n.toLocaleString('en-GB');

/**
 * What This Install's Sessions holds when it is cut: "Showing 500 of 1,250: this session, the 250
 * before it and the 249 after it." Empty when it holds them all.
 */
export function cutLine(total: number, before: number, after: number): string {
  const shown = before + after + 1;
  if (shown >= total) return '';
  const sides =
    before === 0 && after === 0
      ? ''
      : before === 0
        ? ` and the ${count(after)} after it`
        : after === 0
          ? ` and the ${count(before)} before it`
          : before === after
            ? ` and the ${count(before)} either side of it`
            : `, the ${count(before)} before it and the ${count(after)} after it`;
  return `Showing ${count(shown)} of ${count(total)}: this session${sides}.`;
}

/** An install as the page shows it: its first 8 hex characters (PEN-173). */
export const shortInstall = (install: string) => `${install.slice(0, 8)}…`;

/** A window's size class in words, or '' for none (the CLI and MCP). */
export function windowName(sizeClass: string | null | undefined): string {
  const words: Record<string, string> = {
    compact: 'Compact Window',
    medium: 'Medium Window',
    expanded: 'Expanded Window',
  };
  return words[sizeClass ?? ''] ?? '';
}

/** What a stretch needs of an event. */
export interface StretchEvent {
  readonly at: number;
  readonly client: string;
  readonly kind: string;
  readonly name: string;
  readonly props?: Readonly<Record<string, PropValue>> | null;
}

/** A run of a session's events on one screen. */
export interface Stretch {
  /** The screen's display name, or what the run is ("Before Any Screen", "CLI Run"…). */
  readonly title: string;
  /** The screen's id ("screen:note"), or '' for a run with no screen. */
  readonly id: string;
  /** Its events: from `first` up to, not including, `end` (indexes in the session's list). */
  readonly first: number;
  readonly end: number;
  /** "from 0:12 · 1m 21s here · came from Home". */
  readonly summary: string;
}

/**
 * A session's events (in seq order) split where the screen changes. A screen event naming the
 * screen already showing stays in its stretch. Events before the first screen are "Before Any
 * Screen"; a session with no screen events is one stretch named for what it is.
 */
export function stretches(events: readonly StretchEvent[]): Stretch[] {
  if (events.length === 0) return [];
  const start = Math.min(...events.map((e) => e.at));
  const starts: { first: number; screen: string | null; from: string | null }[] = [];
  events.forEach((e, i) => {
    const current = starts.at(-1);
    if (e.kind === 'screen' && (current === undefined || current.screen !== e.name)) {
      const from = e.props?.['from'];
      starts.push({ first: i, screen: e.name, from: typeof from === 'string' ? from : null });
    } else if (current === undefined) {
      starts.push({ first: i, screen: null, from: null });
    }
  });
  const hasScreens = starts.some((s) => s.screen !== null);
  const opening = events[0]!;
  const unscreened = hasScreens
    ? 'Before Any Screen'
    : opening.client === 'cli'
      ? 'CLI Run'
      : opening.client === 'mcp'
        ? 'MCP Connection'
        : events.every((e) => e.kind === 'firstrun')
          ? 'First Run'
          : 'No Screens';
  const last = events.at(-1)!;
  return starts.map((s, k) => {
    const next = starts[k + 1];
    const end = next?.first ?? events.length;
    const at = events[s.first]!.at;
    const took = events[0]!.props?.['took'];
    const stay =
      events.length === 1
        ? sessionLength({
            started: at,
            ended: at,
            events: 1,
            took: typeof took === 'string' ? took : null,
          })
        : duration((next ? events[next.first]!.at : last.at) - at);
    const name = s.screen === null ? null : eventName(`screen:${s.screen}`);
    return {
      title: name?.title ?? unscreened,
      id: name?.id ?? '',
      first: s.first,
      end,
      summary: [
        `from ${sinceStart(at - start)}`,
        `${stay} here`,
        ...(s.from ? [`came from ${displayName('screen', s.from)}`] : []),
      ].join(' · '),
    };
  });
}
