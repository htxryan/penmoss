/**
 * The Mac app's menus from the command registry (T29): every Penmoss menu
 * item is a command, titled as in the palette and showing the shortcut the
 * user has now (their synced bindings, A70). The main process adds only the
 * system's own items (About, Services, Hide, Quit, Cut, Copy, Paste, Select
 * All, the Window menu), which are not app commands (A222).
 */
import type { CommandArea, CommandDefinition } from '../commands/definitions';
import type { DesktopMenu, DesktopMenuItem } from './bridge';

/** The menus in order. `Penmoss` is the application menu on a Mac. */
export const MENU_ORDER = [
  'Penmoss',
  'File',
  'Edit',
  'Format',
  'Insert',
  'View',
  'Go',
  'Help',
] as const;
export type MenuLabel = (typeof MENU_ORDER)[number];

const AREA_MENU: Readonly<Record<CommandArea, MenuLabel>> = {
  Note: 'File',
  Folders: 'File',
  Sync: 'File',
  Editor: 'Format',
  Insert: 'Insert',
  // T44 (A744): the symbol toggles and the picker, a group of their own in Format.
  Symbols: 'Format',
  General: 'View',
  Appearance: 'View',
  Tags: 'View',
  Navigation: 'Go',
  'Daily notes': 'Go',
};

/** Commands whose menu is not their area's. */
const PLACED: Readonly<Record<string, MenuLabel>> = {
  'app.settings': 'Penmoss',
  // T64 item 2 (A1112): where Mac apps put it.
  'app.checkForUpdates': 'Penmoss',
  'editor.undo': 'Edit',
  'editor.redo': 'Edit',
  'copy-markdown': 'Edit',
  'copy-rich-text': 'Edit',
  'note.copyMarkdown': 'Edit',
  'note.copyRich': 'Edit',
  'note.copyAgentReference': 'Edit',
  'app.search': 'Edit',
  'app.cheatsheet': 'Help',
  'app.shortcuts': 'Help',
  // T49 (A798): Help → Send feedback, as Mac apps put it.
  'app.sendFeedback': 'Help',
  // How the window looks (T41): with the theme commands in View.
  'note.togglePanel': 'View',
  'note.backlinks': 'View',
  // T48: the Comments panel, beside Info.
  'note.comments': 'View',
  'note.addNoteComment': 'View',
  'note.fullWidth': 'View',
  'app.toggleSidebar': 'View',
  // T46 (A720): a checkbox for the window in front.
  'window.keepOnTop': 'View',
};

/** Edit: undo and redo, then the copy commands, then find (the system's Cut, Copy and Paste sit between). */
const EDIT_GROUPS = ['history', 'copy', 'find'] as const;

/**
 * The Mac's window behaviours (T46, A726): left out of the menus of a window that does not have
 * them (a Mac app from before T46, the suite off a Mac), not greyed out.
 */
const MAC_WINDOW_COMMANDS = new Set(['window.keepOnTop']);

/**
 * Items that take something away, after the rest of their group with a separator of their own
 * (T39 pass 3, A890): Move to Trash ends the note's commands, as it ends the note's ⋯ menu here
 * and on Android, instead of sitting between Markdown source and Move to folder….
 */
const SET_APART = new Set(['note.delete']);

/** Hidden from the palette, but a menu item all the same. */
const SHOWN_HIDDEN = new Set(['app.palette']);

/** Where a command goes, or null when it has no menu item. */
export function menuOf(definition: CommandDefinition): MenuLabel | null {
  if (definition.pending || definition.scope === 'tree') return null;
  if (definition.hidden && !SHOWN_HIDDEN.has(definition.id)) return null;
  return PLACED[definition.id] ?? AREA_MENU[definition.area];
}

/**
 * The menus for the registry's commands, in registry order, grouped by area
 * (a separator between groups), each with its current combinations.
 */
export function menuModel(
  definitions: Iterable<CommandDefinition>,
  keysOf: (id: string) => readonly string[],
  options: {
    /** Whether a command can run now; an item that cannot is greyed out (A526). */
    readonly available?: (id: string) => boolean;
    /** A checkbox item's tick (T46: Keep on top for this window); undefined for the rest. */
    readonly checked?: (id: string) => boolean | undefined;
    /** The window has the Mac's window behaviours (keep on top, A726). */
    readonly macWindow?: boolean;
  },
): DesktopMenu[] {
  const menus = new Map<MenuLabel, Map<string, DesktopMenuItem[]>>();
  for (const definition of definitions) {
    const label = menuOf(definition);
    if (!label) continue;
    if (MAC_WINDOW_COMMANDS.has(definition.id) && !options.macWindow) continue;
    const groups = menus.get(label) ?? new Map<string, DesktopMenuItem[]>();
    menus.set(label, groups);
    // Edit keeps undo apart from the copy commands; other menus group by area.
    const group =
      label === 'Edit'
        ? definition.id.startsWith('editor.')
          ? 'history'
          : definition.id === 'app.search'
            ? 'find'
            : 'copy'
        : definition.area;
    // Its own group, made (empty) right after its area's, so it keeps that place.
    if (SET_APART.has(definition.id) && !groups.has(group)) groups.set(group, []);
    const key = SET_APART.has(definition.id) ? `${group}:apart` : group;
    const items = groups.get(key) ?? [];
    const enabled = options.available?.(definition.id) ?? true;
    const checked = options.checked?.(definition.id);
    items.push({
      id: definition.id,
      title: definition.title,
      keys: [...keysOf(definition.id)],
      ...(enabled ? {} : { enabled: false }),
      ...(checked === undefined ? {} : { checked }),
    });
    groups.set(key, items);
  }
  return MENU_ORDER.filter((label) => menus.has(label)).map((label) => {
    const groups = menus.get(label)!;
    const ordered =
      label === 'Edit'
        ? EDIT_GROUPS.map((name) => groups.get(name)).filter((items) => items !== undefined)
        : [...groups].flatMap(([key, items]) =>
            key.endsWith(':apart')
              ? []
              : [items, ...(groups.has(`${key}:apart`) ? [groups.get(`${key}:apart`)!] : [])],
          );
    return { label, groups: ordered.filter((items) => items.length > 0) };
  });
}
