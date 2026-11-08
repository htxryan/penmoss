/**
 * Settings → Display (T42, #104 item 7, A576): which shortcuts the sidebar and its collapsed
 * rail show. Today, This week, Graph and Commands may each be hidden; Search never can. One
 * synced per-user setting each (`sidebar.<item>`, true or false; unset shows it), so a choice
 * follows the user to every device like the theme, and two devices hiding different items
 * never overwrite each other. The web app writes them in the WorkspaceDoc; the Android app
 * will through `PUT /api/settings`, whose server checks them with these same rules.
 */

/** The sidebar shortcuts that may be hidden, in the sidebar's order. Search is not one. */
export const SIDEBAR_ITEMS = ['today', 'thisWeek', 'graph', 'commands'] as const;
export type SidebarItem = (typeof SIDEBAR_ITEMS)[number];

/** The setting that holds whether `item` shows. */
export const sidebarSetting = (item: SidebarItem): string => `sidebar.${item}`;

/** Every Display setting's key, in the sidebar's order. */
export const DISPLAY_SETTING_KEYS = SIDEBAR_ITEMS.map(sidebarSetting) as readonly string[];

/** Whether `key` is a Display setting. */
export const isDisplaySetting = (key: string): boolean => DISPLAY_SETTING_KEYS.includes(key);

/** Why `value` cannot be stored as a Display setting, or null when it can (null removes it). */
export function displaySettingProblem(key: string, value: unknown): string | null {
  if (value === null || typeof value === 'boolean') return null;
  return `${key} must be true or false`;
}

/** Whether `item` shows, from the user's settings: only `false` hides it. */
export function sidebarShows(
  settings: Readonly<Record<string, unknown>>,
  item: SidebarItem,
): boolean {
  return settings[sidebarSetting(item)] !== false;
}
