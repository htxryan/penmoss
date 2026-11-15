/**
 * Search Settings (PEN-146): every setting a person can look for, the page it is on and the group
 * there, and how a query finds it. A row on a page carries `data-setting="<id>"`, its label in
 * kebab case (`note-font-size`); opening a result goes to `/settings/<section>` and scrolls to
 * that row. The index is written by hand from the pages, so a new setting adds its line here.
 * The pages and their groups in the nav are here too, so a result can say where it is.
 */
import type { SettingsSection } from '../router';

/** The nav's groups (PEN-146), each naming its scope once. */
export type SettingsGroup = 'look' | 'writing' | 'notebooks' | 'agents' | 'mac';

export const SETTINGS_GROUPS: ReadonlyArray<{
  readonly id: SettingsGroup;
  readonly label: string;
  /** Said once, at the group's heading: nothing under This Mac syncs. */
  readonly scope?: string;
}> = [
  { id: 'look', label: 'Look and Feel' },
  { id: 'writing', label: 'Writing' },
  { id: 'notebooks', label: 'Notebooks' },
  { id: 'agents', label: 'Agents' },
  { id: 'mac', label: 'This Mac', scope: 'Not Synced' },
];

/** Each section's name in the nav and its group, in the nav's order. */
export const SETTINGS_PAGES: ReadonlyArray<{
  readonly id: SettingsSection;
  readonly label: string;
  readonly group: SettingsGroup;
}> = [
  { id: 'appearance', label: 'Appearance', group: 'look' },
  { id: 'sidebar', label: 'Sidebar', group: 'look' },
  { id: 'note', label: 'Note', group: 'look' },
  { id: 'symbols', label: 'Symbols', group: 'look' },
  { id: 'journal', label: 'Daily Notes', group: 'writing' },
  { id: 'quick-capture', label: 'Quick Capture', group: 'writing' },
  { id: 'shortcuts', label: 'Keyboard Shortcuts', group: 'writing' },
  { id: 'git-notebooks', label: 'All Notebooks', group: 'notebooks' },
  { id: 'agents', label: 'Agents', group: 'agents' },
  { id: 'agent-activity', label: 'Agent Activity', group: 'agents' },
  { id: 'meaning', label: 'Semantic Search', group: 'mac' },
  { id: 'github', label: 'GitHub', group: 'mac' },
  { id: 'updates', label: 'Updates', group: 'mac' },
];

export const pageLabel = (section: SettingsSection): string =>
  SETTINGS_PAGES.find((page) => page.id === section)?.label ?? section;

export interface SettingEntry {
  /** The row's `data-setting`: its label in kebab case. */
  readonly id: string;
  readonly label: string;
  readonly section: SettingsSection;
  /** The group on its page ("Text" on Appearance), when the page has groups. */
  readonly group?: string;
  /** The row's help, which a query reads too. */
  readonly help?: string;
  /** Other names people use for it ("typeface", "text size"). */
  readonly aliases?: readonly string[];
}

/**
 * A setting with a page and group, and its id, made from its label; `id` names a row whose
 * `data-setting` differs (two rows of one label on a page).
 */
const at =
  (section: SettingsSection, group?: string) =>
  (
    label: string,
    extra: Omit<SettingEntry, 'id' | 'label' | 'section' | 'group'> & { readonly id?: string } = {},
  ) =>
    ({
      id: settingId(label),
      label,
      section,
      ...(group ? { group } : {}),
      ...extra,
    }) satisfies SettingEntry;

/** A label in kebab case: `Today’s Note` → `todays-note`, `Copy Settings…` → `copy-settings`. */
export function settingId(label: string): string {
  return label
    .toLowerCase()
    .replace(/[’'‘]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const theme = at('appearance', 'Theme');
const text = at('appearance', 'Text');
const macWindow = at('appearance', 'Window');
const shortcuts = at('sidebar', 'Shortcuts');
const sections = at('sidebar', 'Sections');
const layout = at('note', 'Layout');
const noteBar = at('note');
const saves = at('quick-capture', 'Saves To');
const captureMac = at('quick-capture', 'This Mac');
const between = at('git-notebooks', 'Between Notebooks');

/** Every setting a query can find, page by page in the nav's order. */
export const SETTINGS_INDEX: readonly SettingEntry[] = [
  // Appearance.
  theme('Mode', {
    help: 'Light, dark, or the same as this Mac',
    aliases: ['dark mode', 'light mode', 'night'],
  }),
  theme('Theme', { aliases: ['colours', 'colors'] }),
  theme('Customize Theme', {
    help: 'Edits a copy of the theme',
    aliases: ['customise', 'duplicate', 'theme editor', 'colours', 'colors'],
  }),
  text('Interface Font', { aliases: ['typeface', 'ui font', 'menu font'] }),
  text('Note Font', { aliases: ['typeface', 'editor font'] }),
  text('Note Font Size', { aliases: ['text size', 'font size', 'zoom', 'bigger', 'smaller'] }),
  text('Show Tooltips After', { aliases: ['tooltip', 'hover', 'delay'] }),
  macWindow('Compact Title Bar', {
    help: 'Reopens the windows; your notes are saved first',
    aliases: ['toolbar', 'window'],
  }),
  // Sidebar.
  shortcuts('Search', { help: 'Always shown' }),
  shortcuts('Tags'),
  shortcuts('Today', { aliases: ['daily note', 'journal'] }),
  shortcuts('This Week', { aliases: ['weekly note'] }),
  shortcuts('Graph'),
  shortcuts('Commands', { aliases: ['command palette'] }),
  sections('Quick Access', { aliases: ['pinned', 'favourites', 'favorites'] }),
  sections('Show Notebook Names'),
  sections('Recent Notes', { help: 'How many notes it shows', aliases: ['recent', 'history'] }),
  sections('Notebooks'),
  sections('Calendar'),
  // The Tags section, apart from the Tags shortcut above.
  sections('Tags', { id: 'tags-section' }),
  // Note.
  layout('Note Width', { aliases: ['full width', 'wide', 'column'] }),
  layout('Note Panel', {
    help: 'Backlinks, outline and metadata beside the note',
    aliases: ['backlinks', 'outline', 'info panel'],
  }),
  noteBar('Title Bar Buttons', {
    aliases: ['markdown source', 'copy', 'pin', 'new window', 'move to trash'],
  }),
  noteBar('Under the Title', {
    aliases: ['notebook', 'folder', 'created', 'edited', 'tags', 'metadata'],
  }),
  noteBar('In the Status Bar', {
    aliases: ['word count', 'words', 'characters', 'reading time', 'token count'],
  }),
  // Symbols.
  at('symbols')('Symbols', {
    help: 'Type a symbol at the start of a line to mark it',
    aliases: ['line symbols', 'markers', 'star', 'emoji', 'colour', 'color'],
  }),
  at('symbols')('Add a Symbol', { help: 'Up to nine' }),
  at('symbols')('Change Their Shortcuts', { aliases: ['symbol keys', 'keys'] }),
  at('symbols')('Restore Defaults', { aliases: ['reset symbols'] }),
  // Daily Notes.
  at('journal')('Time Zone', { aliases: ['timezone', 'today', 'date'] }),
  at('journal')('Daily Template', { aliases: ['template', 'placeholder', 'journal'] }),
  at('journal')('Weekly Template', { aliases: ['template', 'week'] }),
  // Quick Capture.
  saves('Today’s Note', { help: 'At the end of ## Captures, with the time' }),
  saves('New Note in Inbox', { help: 'Titled by its first line', aliases: ['inbox'] }),
  saves('Notebook', { help: 'Your primary notebook' }),
  captureMac('Shortcut From Any App', { aliases: ['hotkey', 'global shortcut', 'keys'] }),
  captureMac('Show in the Menu Bar', {
    help: 'Quick Capture, Today’s Journal and Quick Access',
    aliases: ['menu bar icon', 'tray', 'status bar'],
  }),
  // Keyboard Shortcuts.
  at('shortcuts')('Keyboard Shortcuts', {
    aliases: ['keys', 'hotkeys', 'key bindings', 'keybindings'],
  }),
  // All Notebooks.
  at('git-notebooks')('Add Notebook', { aliases: ['git', 'repository', 'clone', 'github'] }),
  between('Primary Notebook', {
    help: 'Holds your journal, Inbox and these settings',
    aliases: ['default notebook', 'journal'],
  }),
  between('Keep Settings in Step', {
    help: 'A change in one notebook’s settings goes to the others',
    aliases: ['sync settings'],
  }),
  between('Copy Tags When Copying Notes'),
  between('Copy Settings', { help: 'From one notebook to another, once' }),
  at('git-notebooks')('Commit Identity', {
    help: 'The name and email commits are made with',
    aliases: [
      'commits from this mac',
      'author',
      'commit name',
      'commit email',
      'signing',
      'git config',
    ],
  }),
  // Agents.
  at('agents')('Penmoss Command', {
    help: 'Agents read and edit your notes through it',
    aliases: ['cli', 'terminal', 'install'],
  }),
  at('agents')('Connected Agents', {
    aliases: [
      'connected on this mac',
      'connect an agent',
      'claude code',
      'codex',
      'mcp',
      'disconnect',
    ],
  }),
  at('agent-activity')('Agent Activity', {
    id: 'agent-activity-filters',
    help: 'What agents changed, in every notebook',
    aliases: ['undo', 'history', 'changes'],
  }),
  // Semantic Search (A1566; once Search by Meaning).
  at('meaning')('Semantic Search', {
    help: 'Runs on this Mac. Your notes never leave it.',
    aliases: [
      'search by meaning',
      'find notes by meaning',
      'embeddings',
      'ai search',
      'similar notes',
    ],
  }),
  at('meaning')('Indexing', { aliases: ['progress', 'download'] }),
  at('meaning')('Model', {
    help: 'Delete Model… frees its space on this Mac',
    aliases: [
      'embeddinggemma',
      'licence',
      'license',
      'size',
      'delete model',
      'remove model',
      'disk space',
    ],
  }),
  // Recreate Index… on, Delete Index… off (A1595).
  at('meaning')('Semantic Index', {
    help: 'Recreate it while on, or delete it while off',
    aliases: [
      'semantic index',
      'recreate index',
      'rebuild index',
      'reindex',
      'delete index',
      'vectors',
      'disk space',
    ],
  }),
  // GitHub.
  at('github')('GitHub Account', {
    help: 'Sign in with GitHub, kept in this Mac’s Keychain',
    aliases: ['sign in', 'sign out', 'log in', 'login', 'keychain'],
  }),
  at('github')('GitHub Token', {
    help: 'A token pasted instead of signing in',
    aliases: ['use a token instead', 'personal access token', 'pat'],
  }),
  at('github', 'Used For')('Adding Notebooks', {
    help: 'Lists your repositories when git has no sign-in',
  }),
  at('github', 'Used For')('Send Feedback', {
    help: 'Opens issues in htxryan/penmoss',
    aliases: ['bug report', 'outbox', 'waiting'],
  }),
  // Updates.
  at('updates')('Version', {
    help: 'Whether this Mac has the newest Penmoss',
    aliases: ['check now', 'check for updates', 'up to date', 'install', 'about'],
  }),
  at('updates')('Open Source Notices', {
    help: 'The licences of the open source software Penmoss includes',
    aliases: ['licences', 'licenses', 'third-party notices', 'credits', 'about', 'lucide'],
  }),
  at('updates')('Update Automatically', {
    help: 'Checks at launch and every hour, and asks before restarting',
    aliases: ['auto-update', 'auto update'],
  }),
  at('updates')('Update Channel', {
    help: 'Alpha gets every build from main: newest features, may break',
    aliases: ['alpha', 'stable', 'beta'],
  }),
  at('updates')('What’s New', { aliases: ['release notes', 'changelog', 'earlier versions'] }),
];

/** A result: the setting, where its label matched the query (to mark), and its place. */
export interface SettingMatch {
  readonly entry: SettingEntry;
  /** `[start, end)` ranges of the label that the query's words matched. */
  readonly marks: ReadonlyArray<readonly [number, number]>;
  /** "Appearance › Text": the page, and the group on it. */
  readonly place: string;
}

const fold = (value: string) => value.toLowerCase().replace(/[’‘]/g, "'");

/**
 * The settings a query finds, best first. Every word of the query must be in the setting's
 * label, help, other names, page or group; a label that starts with the query ranks first,
 * then one with a word that starts with it, then a label that has it anywhere, then the rest.
 * Only sections in `available` (the ones this build shows) are searched.
 */
export function searchSettings(
  query: string,
  available: ReadonlySet<SettingsSection> | readonly SettingsSection[] = SETTINGS_PAGES.map(
    (page) => page.id,
  ),
  index: readonly SettingEntry[] = SETTINGS_INDEX,
): SettingMatch[] {
  const q = fold(query.trim().replace(/\s+/g, ' '));
  if (!q) return [];
  const words = q.split(' ');
  const shown = available instanceof Set ? available : new Set(available);
  const found: Array<{ match: SettingMatch; rank: number; order: number }> = [];
  index.forEach((entry, order) => {
    if (!shown.has(entry.section)) return;
    const page = pageLabel(entry.section);
    const label = fold(entry.label);
    const haystack = [label, entry.help, ...(entry.aliases ?? []), page, entry.group]
      .filter(Boolean)
      .map((part) => fold(part!))
      .join('\n');
    if (!words.every((word) => haystack.includes(word))) return;
    const rank = label.startsWith(q)
      ? 0
      : label.split(/[^a-z0-9']+/).some((part) => part.startsWith(q))
        ? 1
        : label.includes(q) || words.every((word) => label.includes(word))
          ? 2
          : (entry.aliases ?? []).some((alias) => fold(alias).includes(q))
            ? 3
            : 4;
    found.push({
      match: {
        entry,
        marks: marksOf(label, words),
        place: entry.group ? `${page} › ${entry.group}` : page,
      },
      rank,
      order,
    });
  });
  found.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return found.map((each) => each.match);
}

/** Where each word is in the label, merged and in order. */
function marksOf(label: string, words: readonly string[]): Array<readonly [number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const word of words) {
    const at = label.indexOf(word);
    if (at !== -1) ranges.push([at, at + word.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}
