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
  firstrun: 'First Run',
  cli: 'CLI Command',
  tool: 'MCP Tool',
};

/** A command's display name and id. */
export function commandName(name: string): EventName {
  return { title: displayName('command', name), id: name };
}
