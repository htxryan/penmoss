/**
 * The menu bar icon (T51 item 17, A945): a template image in the Mac's menu bar, on by default
 * since T53 (item 6, A976) and turned off in Settings → Display (a preference of this Mac, preferences.json, like the
 * compact title bar). Its menu: Quick Capture, Open Today's Journal, the Quick Access notes
 * (A946), each opening in the main window, then Open Penmoss. The main window's page tells main
 * the pinned notes and their titles as they change (`quickAccessSet`).
 *
 * The main process owns the Tray (main.ts); this module holds what can be decided and checked
 * without one: the menu's template, and the pins a page sent, checked.
 */
import type { MenuItemConstructorOptions } from 'electron';
import { MAX_QUICK_ACCESS } from '@penmoss/core/quick-access';

/** A Quick Access note as the menu shows it: its id and title ('' for none). */
export interface QuickAccessPin {
  readonly id: string;
  readonly title: string;
}

/** What the menu's items do (main.ts wires them to its windows). */
export interface TrayActions {
  readonly capture: () => void;
  readonly today: () => void;
  readonly openNote: (id: string) => void;
  readonly showMain: () => void;
}

/** The icon's tooltip. */
export const TRAY_TOOLTIP = 'Penmoss';

/** The template image's file name, beside boot.cjs (`dist/tray/`); macOS picks `@2x` itself. */
export const TRAY_ICON = 'trayTemplate.png';

/** A note id as the apps make them, the same rule as @penmoss/core's quick-access check. */
const NOTE_ID = /^[0-9A-Za-z_-]{1,80}$/;

/** The longest title the menu shows in full; longer ones end in an ellipsis. */
export const MAX_TITLE = 60;

/** A pin's label: its title on one line, shortened, or "Untitled". */
export function pinLabel(title: string): string {
  const line = title.replace(/\s+/g, ' ').trim();
  if (line === '') return 'Untitled';
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1).trimEnd()}…` : line;
}

/**
 * The pins a page sent (they come over IPC), checked: a list of at most twenty `{ id, title }`
 * with note ids, each once. Null when it is not one.
 */
export function parseQuickAccess(value: unknown): QuickAccessPin[] | null {
  if (!Array.isArray(value) || value.length > MAX_QUICK_ACCESS) return null;
  const seen = new Set<string>();
  const pins: QuickAccessPin[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { id, title } = entry as { id?: unknown; title?: unknown };
    if (typeof id !== 'string' || !NOTE_ID.test(id) || seen.has(id)) return null;
    if (typeof title !== 'string') return null;
    seen.add(id);
    // A title is only shown, shortened: no more of it than the menu needs is kept.
    pins.push({ id, title: title.slice(0, 1000) });
  }
  return pins;
}

/** The in-app path of a pinned note (the web app's `notePath`). */
export const pinPath = (id: string): string => `/notes/${encodeURIComponent(id)}`;

/**
 * The menu bar icon's menu (A945). `hotkey` is the capture hotkey while it is registered, shown
 * on Quick Capture as a hint only (`registerAccelerator: false`: the system-wide hotkey already
 * opens it). The Quick Access notes come after a separator, with one after them only when there
 * are any.
 */
export function trayMenuTemplate(
  pins: readonly QuickAccessPin[],
  hotkey: string | null,
  actions: TrayActions,
): MenuItemConstructorOptions[] {
  const capture: MenuItemConstructorOptions = {
    id: 'tray.capture',
    label: 'Quick Capture',
    click: () => actions.capture(),
    ...(hotkey ? { accelerator: hotkey, registerAccelerator: false } : {}),
  };
  const notes = pins.map((pin): MenuItemConstructorOptions => ({
    id: `tray.note.${pin.id}`,
    label: pinLabel(pin.title),
    click: () => actions.openNote(pin.id),
  }));
  return [
    capture,
    { id: 'tray.today', label: "Open Today's Journal", click: () => actions.today() },
    { type: 'separator' },
    ...(notes.length > 0 ? [...notes, { type: 'separator' as const }] : []),
    { id: 'tray.open', label: 'Open Penmoss', click: () => actions.showMain() },
  ];
}

/** A template as the Playwright suite reads it: each item's label and hint, or a separator. */
export function describeMenu(
  template: readonly MenuItemConstructorOptions[],
): Array<{ readonly id?: string; readonly label?: string; readonly accelerator?: string } | '-'> {
  return template.map((item) =>
    item.type === 'separator'
      ? '-'
      : {
          ...(item.id ? { id: item.id } : {}),
          ...(item.label ? { label: item.label } : {}),
          ...(typeof item.accelerator === 'string' ? { accelerator: item.accelerator } : {}),
        },
  );
}
