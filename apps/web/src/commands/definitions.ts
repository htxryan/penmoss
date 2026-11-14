/**
 * Every user-visible action in the app as a command (T20, FR-NAV-1): an id,
 * a title, a palette group and default key combinations (`Mod+Shift+E`,
 * see @penmoss/editor/keys). The editor's own commands come from
 * @penmoss/editor. Handlers are registered at run time by whatever owns the
 * action (the shell, the open note, the folder tree); definitions are static
 * so the palette, the cheat sheet, the shortcut editor and the coverage test
 * all read one list.
 */
import { EDITOR_COMMANDS } from '@penmoss/editor/commands';
import { applePlatformOr } from '@penmoss/editor/keys';

export type CommandArea =
  | 'General'
  | 'Navigation'
  | 'Daily notes'
  | 'Note'
  | 'Editor'
  | 'Insert'
  | 'Symbols'
  | 'Folders'
  | 'Tags'
  | 'Appearance'
  | 'Sync';

/**
 * Where a command's keys act. `editor`: only while the note body has focus.
 * `tree`: only while a row of the folder tree has focus. `global`: anywhere.
 */
export type CommandScope = 'global' | 'editor' | 'tree';

export interface CommandDefinition {
  readonly id: string;
  readonly title: string;
  readonly area: CommandArea;
  /** Default key combinations; the user's bindings (synced settings) replace them. */
  readonly keys: readonly string[];
  readonly scope: CommandScope;
  /**
   * Acts only in a narrow situation and otherwise passes its keys on to the
   * next command bound to them, so sharing them is not a conflict (A42: Mod+K
   * links selected text, and opens the palette otherwise).
   */
  readonly yields?: boolean;
  /** Not in the palette (it acts on the focused row, or is the palette itself). */
  readonly hidden?: boolean;
  /**
   * Arrives with another task (named here): listed in the shortcut editor so
   * its keys stay reserved, but never run and not in the palette.
   */
  readonly pending?: string;
}

const global = (
  id: string,
  title: string,
  area: CommandArea,
  keys: readonly string[] = [],
  extra: Partial<CommandDefinition> = {},
): CommandDefinition => ({ id, title, area, keys, scope: 'global', ...extra });

const tree = (id: string, title: string, keys: readonly string[]): CommandDefinition => ({
  id,
  title,
  area: 'Folders',
  keys,
  scope: 'tree',
  hidden: true,
});

export const APP_COMMANDS: readonly CommandDefinition[] = [
  global('app.palette', 'Command Palette', 'General', ['Mod+K'], { hidden: true }),
  global('app.quickOpen', 'Quick Open Note…', 'Navigation', ['Mod+P']),
  // T22. Mod+Shift+F, as in Obsidian and VS Code (Mod+F stays the browser's find, A90).
  global('app.search', 'Search Notes…', 'Navigation', ['Mod+Shift+F']),
  global('app.recent', 'Switch to a Recent Note', 'Navigation', ['Mod+E']),
  global('app.cheatsheet', 'Keyboard Shortcuts', 'General', ['Mod+/']),
  global('app.settings', 'Settings', 'General', ['Mod+,']),
  global('app.shortcuts', 'Customise Keyboard Shortcuts', 'General'),
  // T50 (A856): Settings → Notebooks, in the Mac app. No default keys.
  global('app.gitNotebooks', 'Notebooks', 'General'),
  // Settings → Status: Send feedback's GitHub token and outbox (T57, T59 A1036).
  global('app.status', 'Feedback Status and GitHub Token', 'General'),
  // T64 item 2 (A1112): Settings → Updates, checking now. The Mac app only.
  global('app.checkForUpdates', 'Check for Updates…', 'General'),
  // T49 (D41, A797): a bug report or feature request to the Penmoss board. No default keys.
  global('app.sendFeedback', 'Send Feedback', 'General'),
  global('app.home', 'Close the Note', 'Navigation'),
  // T41 (A508): the sidebar down to an icon rail. Mod+\\, as Notion's sidebar key.
  global('app.toggleSidebar', 'Collapse or Expand the Sidebar', 'Navigation', ['Mod+\\']),
  // T17. Around the open note when there is one.
  global('app.graph', 'Graph', 'Navigation', ['Mod+Shift+G']),
  // ⌘⌥ on Apple platforms; elsewhere Ctrl+Alt is AltGr, which types on many layouts (Polish ń
  // is AltGr+N), so those defaults drop Ctrl: Alt+N, Alt+Shift+N, Alt+Shift+H, Alt+W (A90).
  global('note.new', 'New Note', 'Note', [applePlatformOr('Mod+Alt+N', 'Alt+N')]),
  // T30. To today's note under ## Captures, or a new note in Inbox. The Mac app also has a
  // system-wide hotkey for its capture window (A226).
  global('app.capture', 'Quick Capture…', 'Note', ['Mod+Shift+K']),
  global('note.toggleSource', 'Toggle Markdown Source', 'Note', ['Mod+Shift+M']),
  global('note.delete', 'Move to Trash', 'Note'),
  // T39. A note into another folder without dragging it (keyboard, phone); no default key.
  global('note.move', 'Move to Folder…', 'Note'),
  // T21. Google Docs' version-history keys; Mod+Alt+H hides other apps on a Mac.
  global('note.history', 'Version History', 'Note', [
    applePlatformOr('Mod+Alt+Shift+H', 'Alt+Shift+H'),
  ]),
  global('note.saveVersion', 'Save a Version of This Note Now', 'Note'),
  // T51 review (A936): the note bar's panel button. Closes the side panel when it is open, on
  // whichever tab, else opens it on the tab shown last. No default keys: each tab has its own.
  global('note.togglePanel', 'Show or Hide the Note Panel', 'Note'),
  // T16, T17. The Backlinks panel became the Info panel in T41 (A502), the side panel's Metadata
  // tab in T51 (A936); the id is kept, so bindings made for it still work. ⌘⌥⇧I (Alt+Shift+I
  // elsewhere, A90).
  global('note.backlinks', 'Show or Hide the Note’s Metadata', 'Note', [
    applePlatformOr('Mod+Alt+Shift+I', 'Alt+Shift+I'),
  ]),
  // T48 (A770): the note's comment threads, beside the note where the Info panel goes. ⌘⌥⇧A,
  // as Google Docs' discussion threads (A951: ⌘⌥⇧C is Copy as Rich Text's in the note's body);
  // Alt+Shift+C elsewhere (A90). A new thread on the selection is the editor's Comment.
  global('note.comments', 'Show or Hide Comments', 'Note', [
    applePlatformOr('Mod+Alt+Shift+A', 'Alt+Shift+C'),
  ]),
  // T52 item 5: a thread on the note as a whole, with no passage: the Comments tab's composer.
  global('note.addNoteComment', 'Add Note Comment', 'Note'),
  // T17; a tab of the note's side panel since T51 (A936), the full graph one click away.
  global('note.localGraph', 'Show or Hide the Note’s Local Graph', 'Navigation'),
  global('app.trash', 'Trash', 'Navigation'),
  // PEN-68: every tag, with what each means. No default keys.
  global('app.tags', 'Tags', 'Navigation'),
  // T45 (A710): the open note in a window of its own (a popup on the web). ⌘⌥O (Alt+O elsewhere,
  // A90): free in the app, the browsers and macOS.
  global('note.openInNewWindow', 'Open in New Window', 'Note', [
    applePlatformOr('Mod+Alt+O', 'Alt+O'),
  ]),
  // T51 (A946): the open note in Quick Access (the menu bar icon, the sidebar, Android's Home),
  // or out of it. No default keys.
  global('note.pinQuickAccess', 'Pin or Unpin from Quick Access', 'Note'),
  // T45. Back and Forward in a note window: ⌘[ and ⌘] in the Mac app; in a browser its own
  // keys (the same ones) go back and forward, and the commands leave the keys to it.
  global('window.back', 'Back', 'Navigation', [applePlatformOr('Mod+[', 'Alt+Left')]),
  global('window.forward', 'Forward', 'Navigation', [applePlatformOr('Mod+]', 'Alt+Right')]),
  // T46 (D38, A720). The Mac app only: this window above other apps' windows (View menu, its
  // pin button). No default keys; bind them in Settings → Keyboard Shortcuts.
  global('window.keepOnTop', 'Keep on Top', 'General'),
  global('note.focusTitle', 'Edit the Note Title', 'Note'),
  // The header's Copy menu (T15): always the whole note. The editor's copy-markdown and
  // copy-rich-text (selection, or the whole note) carry T15's keys.
  global('note.copyMarkdown', 'Copy Note as Markdown', 'Note'),
  global('note.copyRich', 'Copy Note as Rich Text', 'Note'),
  // T52 item 4: the note's title, id, notebook and folders and its read_note call, for an agent
  // conversation (core's agentReference, the same text on every client). No default keys.
  global('note.copyAgentReference', 'Copy Agent Reference', 'Note'),
  // T19. Mod+Shift+W is the plan's key and stays for the Mac app; Chrome keeps it (it closes
  // the window), so the web build also binds Mod+Alt+W (Alt+W off Apple platforms, A90).
  global('journal.today', "Today's Note", 'Daily notes', ['Mod+D']),
  global('journal.thisWeek', "This Week's Note", 'Daily notes', [
    'Mod+Shift+W',
    applePlatformOr('Mod+Alt+W', 'Alt+W'),
  ]),
  global('journal.previous', 'Previous Day or Week', 'Daily notes'),
  global('journal.next', 'Next Day or Week', 'Daily notes'),
  global('journal.week', 'The Week of This Daily Note', 'Daily notes'),
  global('journal.calendar', 'Show the Calendar', 'Daily notes'),
  global('journal.settings', 'Time Zone and Templates', 'Daily notes'),
  global('note.addTag', 'Add a Tag to This Note', 'Tags'),
  global('tags.clearFilter', 'Show All Notes (Clear the Tag Filter)', 'Tags'),
  global('folder.new', 'New Folder', 'Folders', [
    applePlatformOr('Mod+Alt+Shift+N', 'Alt+Shift+N'),
  ]),
  global('folder.topLevel', 'File New Notes at the Top Level', 'Folders'),
  global('folder.sortManual', 'Sort the Current Folder: Manual', 'Folders'),
  global('folder.sortAlpha', 'Sort the Current Folder: A–Z', 'Folders'),
  global('folder.sortModified', 'Sort the Current Folder: Last Modified', 'Folders'),
  tree('folder.moveUp', 'Move the Focused Row Up', ['Alt+Up']),
  tree('folder.moveDown', 'Move the Focused Row Down', ['Alt+Down']),
  tree('folder.rename', 'Rename the Focused Folder', ['F2']),
  tree('folder.delete', 'Delete the Focused Folder', ['Delete', 'Backspace']),
  // #170 F5: Settings → Notebooks' actions, for the open note's git notebook (or the only
  // one), in the Mac app only (sources/git-commands.ts). No default keys.
  global('git.syncNow', 'Sync This Git Notebook Now', 'Sync'),
  global('git.signCommits', 'Sign This Git Notebook’s Commits, or Stop', 'Sync'),
  global('git.pushAfter', 'Set When This Git Notebook Pushes…', 'Sync'),
  global('git.pullEvery', 'Set How Often This Git Notebook Pulls…', 'Sync'),
  global('git.useToken', 'Use a Token for This Git Notebook…', 'Sync'),
  global('git.forgetToken', 'Forget This Git Notebook’s Token', 'Sync'),
  global('git.identity', 'Set This Git Notebook’s Commit Name and Email…', 'Sync'),
  global('git.reconfirmPurges', 'Confirm Delete for Good Again…', 'Sync'),
  global('git.remove', 'Remove This Git Notebook from This Mac…', 'Sync'),
  // T28. No default keys: users bind them in Settings → Keyboard Shortcuts (A70, A90).
  global('app.appearance', 'Appearance and Themes', 'Appearance'),
  // T42 (A576): which shortcuts the sidebar shows.
  global('app.display', 'Sidebar Display Settings', 'Appearance'),
  // T44 (A743): the line symbols, their names, colours and order. The picker's "Edit symbols…".
  global('app.symbols', 'Edit Line Symbols', 'Symbols'),
  global('theme.switch', 'Switch Theme…', 'Appearance'),
  global('theme.toggleDark', 'Toggle Dark Mode', 'Appearance'),
  // T41 (A501): the note column fills the window; in the Mac's View menu. ⌘⌥⇧W (Alt+Shift+W
  // elsewhere, A90).
  global('note.fullWidth', 'Toggle Full-Width Notes', 'Note', [
    applePlatformOr('Mod+Alt+Shift+W', 'Alt+Shift+W'),
  ]),
];

/** The app's commands, then the editor's (formatting, then one "Insert: …" per block). */
export const COMMANDS: readonly CommandDefinition[] = [
  ...APP_COMMANDS,
  ...EDITOR_COMMANDS.map((command): CommandDefinition => ({
    id: command.id,
    title: command.title,
    area: command.area,
    keys: command.keys,
    scope: 'editor',
    ...(command.yields ? { yields: true } : {}),
  })),
];
