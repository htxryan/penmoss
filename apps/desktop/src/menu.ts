/**
 * Native menus from the command registry (T29, A222). The page sends its
 * menus (apps/web/src/desktop/menu.ts): every item is a command with its
 * title and current keys. This adds the system's own items around them and
 * turns each command's first combination into an accelerator, so the menu
 * shows the shortcut the user has now.
 *
 * Keys stay the page's: it sees a key first and runs the command (its
 * scopes decide, e.g. Bold only in the note body). When a menu takes a
 * shortcut itself, the click says so and the page dispatches the key where
 * focus is, unless it has just seen that key (CommandCenter.dispatchMenuShortcut).
 */
import type { MenuItemConstructorOptions } from 'electron';

export interface MenuItemModel {
  readonly id: string;
  readonly title: string;
  readonly keys: readonly string[];
  /** False greys the item out: the command cannot run now (A526). */
  readonly enabled?: boolean;
  /**
   * A checkbox item, ticked or not (T46: View → Keep on top, for the window in front, A720).
   * Absent: a plain item.
   */
  readonly checked?: boolean;
}

export interface MenuModel {
  readonly label: string;
  readonly groups: ReadonlyArray<readonly MenuItemModel[]>;
}

const KEY_NAMES: Readonly<Record<string, string>> = {
  '+': 'Plus',
  Enter: 'Return',
  Escape: 'Esc',
  Space: 'Space',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Up: 'Up',
  Down: 'Down',
  Left: 'Left',
  Right: 'Right',
};
const PUNCTUATION = new Set(['/', ',', '.', '[', ']', '\\', ';', "'", '`', '-', '=']);

/**
 * A registry combination (`Mod+Alt+N`, see @penmoss/editor/keys) as an
 * Electron accelerator (`CommandOrControl+Alt+N`), or null when the menu
 * cannot show it.
 */
export function toAccelerator(combo: string): string | null {
  const parts = combo.split(/\+(?!$)/);
  const key = parts.pop() ?? '';
  const modifiers: string[] = [];
  for (const part of parts) {
    if (part === 'Mod') modifiers.push('CommandOrControl');
    else if (part === 'Ctrl') modifiers.push('Control');
    else if (part === 'Alt') modifiers.push('Alt');
    else if (part === 'Shift') modifiers.push('Shift');
    else return null;
  }
  let name: string | undefined;
  if (/^[A-Z0-9]$/.test(key)) name = key;
  else if (/^F([1-9]|1\d|2[0-4])$/.test(key)) name = key;
  else if (PUNCTUATION.has(key)) name = key;
  else name = KEY_NAMES[key];
  if (!name) return null;
  return [...modifiers, name].join('+');
}

export interface TemplateOptions {
  readonly platform: NodeJS.Platform;
  readonly appName: string;
  readonly devTools: boolean;
  /** A menu item was chosen; `accelerator` is set when its shortcut chose it. */
  readonly onCommand: (id: string, accelerator: string | null) => void;
  /** Window → Penmoss: the main window, made again if it was closed (T45, A712). */
  readonly onShowMain?: () => void;
}

/** Window → Penmoss's id (T45). */
export const SHOW_MAIN_ID = 'window.main';

/** What a page may put in the menus (A222): enough for the registry, and no more. */
export const MENU_LIMITS = { menus: 20, groups: 30, items: 120, total: 600, keys: 8 } as const;

/**
 * The page's menus, checked (they come over IPC): labels, ids and titles are
 * short strings, keys shorter ones, and every count is capped, so a page
 * script cannot make the main process build an enormous menu. Null when
 * anything is off.
 */
export function parseMenus(value: unknown): MenuModel[] | null {
  if (!Array.isArray(value) || value.length > MENU_LIMITS.menus) return null;
  const text = (item: unknown, max = 200) => typeof item === 'string' && item.length <= max;
  const menus: MenuModel[] = [];
  let total = 0;
  for (const menu of value as unknown[]) {
    const { label, groups } = (menu ?? {}) as Record<string, unknown>;
    if (!text(label) || !Array.isArray(groups) || groups.length > MENU_LIMITS.groups) return null;
    const parsed: MenuItemModel[][] = [];
    for (const group of groups as unknown[]) {
      if (!Array.isArray(group) || group.length > MENU_LIMITS.items) return null;
      total += group.length;
      if (total > MENU_LIMITS.total) return null;
      const items: MenuItemModel[] = [];
      for (const item of group as unknown[]) {
        const { id, title, keys, enabled, checked } = (item ?? {}) as Record<string, unknown>;
        if (
          !text(id) ||
          !text(title) ||
          !Array.isArray(keys) ||
          keys.length > MENU_LIMITS.keys ||
          !keys.every((k) => text(k, 40)) ||
          (enabled !== undefined && typeof enabled !== 'boolean') ||
          (checked !== undefined && typeof checked !== 'boolean')
        ) {
          return null;
        }
        items.push({
          id: id as string,
          title: title as string,
          keys: keys as string[],
          ...(enabled === false ? { enabled: false } : {}),
          ...(typeof checked === 'boolean' ? { checked } : {}),
        });
      }
      parsed.push(items);
    }
    menus.push({ label: label as string, groups: parsed });
  }
  return menus;
}

const separator: MenuItemConstructorOptions = { type: 'separator' };

function commandItems(
  items: readonly MenuItemModel[],
  options: TemplateOptions,
): MenuItemConstructorOptions[] {
  return items.map((item) => {
    const accelerator = item.keys[0] ? toAccelerator(item.keys[0]) : null;
    return {
      id: item.id,
      label: item.title,
      ...(accelerator ? { accelerator } : {}),
      // Greyed out when it cannot run now; its keys then reach the page, which does nothing.
      enabled: item.enabled !== false,
      // A checkbox shows the page's state; a click ticks it at once, and the page sends the
      // real state back with its next menus.
      ...(item.checked !== undefined ? { type: 'checkbox' as const, checked: item.checked } : {}),
      // `event` is missing when something calls `click()` itself (VoiceOver, tests).
      click: (_menuItem, _window, event?: Partial<Electron.KeyboardEvent>) =>
        options.onCommand(item.id, event?.triggeredByAccelerator ? accelerator : null),
    };
  });
}

/** Groups joined by separators. */
function grouped(
  groups: ReadonlyArray<readonly MenuItemModel[]>,
  options: TemplateOptions,
): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = [];
  for (const group of groups) {
    if (group.length === 0) continue;
    if (out.length > 0) out.push(separator);
    out.push(...commandItems(group, options));
  }
  return out;
}

/** The whole menu bar: the page's command menus with the system's items around them. */
export function menuTemplate(
  menus: readonly MenuModel[],
  options: TemplateOptions,
): MenuItemConstructorOptions[] {
  const mac = options.platform === 'darwin';
  const byLabel = new Map(menus.map((menu) => [menu.label, menu]));
  const groupsOf = (label: string) => byLabel.get(label)?.groups ?? [];
  const items = (label: string) => grouped(groupsOf(label), options);
  const join = (...parts: MenuItemConstructorOptions[][]) =>
    parts
      .filter((part) => part.length > 0)
      .flatMap((part, index) => (index === 0 ? part : [separator, ...part]));

  const template: MenuItemConstructorOptions[] = [];
  if (mac) {
    template.push({
      label: options.appName,
      submenu: join(
        [{ role: 'about' }],
        items('Penmoss'),
        [{ role: 'services' }],
        [{ role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }],
        [{ role: 'quit' }],
      ),
    });
  }
  template.push({
    label: 'File',
    submenu: join(
      items('File'),
      mac ? [{ role: 'close' }] : [...items('Penmoss'), { role: 'quit' }],
    ),
  });
  const edit = groupsOf('Edit');
  template.push({
    label: 'Edit',
    submenu: join(
      grouped(edit.slice(0, 1), options),
      [
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(mac ? [{ role: 'pasteAndMatchStyle' } as const] : []),
        { role: 'selectAll' },
      ],
      grouped(edit.slice(1), options),
    ),
  });
  for (const label of ['Format', 'Insert']) {
    if (byLabel.has(label)) template.push({ label, submenu: items(label) });
  }
  template.push({
    label: 'View',
    submenu: join(
      items('View'),
      [{ role: 'togglefullscreen' }],
      options.devTools ? [{ role: 'reload' }, { role: 'toggleDevTools' }] : [],
    ),
  });
  if (byLabel.has('Go')) template.push({ label: 'Go', submenu: items('Go') });
  // The system's Window menu, with Penmoss in it: the main window, also when only note
  // windows are open (T45, A712). macOS lists the open windows after it.
  const showMain: MenuItemConstructorOptions[] = options.onShowMain
    ? [{ id: SHOW_MAIN_ID, label: options.appName, click: () => options.onShowMain?.() }]
    : [];
  template.push({
    label: 'Window',
    role: 'window',
    submenu: join(
      mac ? [{ role: 'minimize' }, { role: 'zoom' }] : [{ role: 'minimize' }, { role: 'close' }],
      showMain,
      mac ? [{ role: 'front' }] : [],
    ),
  });
  template.push({ label: 'Help', role: 'help', submenu: items('Help') });
  return template;
}
