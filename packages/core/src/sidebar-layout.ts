/**
 * The sidebar's sections (T53 item 8, A983): Quick Access, Recent Notes, Notebooks, Calendar and
 * Tags, each of which a person may hide (its title's ✕, or Settings → Display, T62 item 11)
 * and drag to a new place; Recent Notes shows the notes opened or changed last, as many as
 * Settings → Display says. Quick Access may name each note's notebook under its title (T53 item
 * 10). Synced per-user settings, so the layout follows the person to every device:
 *
 * - `sidebar.sectionOrder`: section ids in the order shown. Ids this build does not know are
 *   skipped; sections missing from it follow in the default order, so a section added later
 *   finds a place.
 * - `sidebar.hiddenSections`: the ids of the sections hidden.
 * - `sidebar.recentCount`: how many notes Recent Notes shows, 1 to 50 (10 unset).
 * - `quickAccess.showNotebook`: whether Quick Access names each note's notebook (false unset).
 *
 * The web writes them in its WorkspaceDoc; the Android app through `PUT /api/settings`, which
 * checks them with these same rules (`apps/android/contract/settings-v1.json`).
 */

/** The sections, in the default order. */
export const SIDEBAR_SECTIONS = ['quickAccess', 'recent', 'notebooks', 'calendar', 'tags'] as const;
export type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];

/** Each section's name, as its title and Settings → Display say it. */
export const SIDEBAR_SECTION_NAMES: Readonly<Record<SidebarSection, string>> = {
  quickAccess: 'Quick Access',
  recent: 'Recent Notes',
  notebooks: 'Notebooks',
  calendar: 'Calendar',
  tags: 'Tags',
};

export const SECTION_ORDER_SETTING = 'sidebar.sectionOrder';
export const HIDDEN_SECTIONS_SETTING = 'sidebar.hiddenSections';
export const RECENT_COUNT_SETTING = 'sidebar.recentCount';
export const QUICK_ACCESS_NOTEBOOK_SETTING = 'quickAccess.showNotebook';

/** Every setting of the sidebar's layout. */
export const SIDEBAR_LAYOUT_KEYS = [
  SECTION_ORDER_SETTING,
  HIDDEN_SECTIONS_SETTING,
  RECENT_COUNT_SETTING,
  QUICK_ACCESS_NOTEBOOK_SETTING,
] as const;

/** Recent Notes' length: unset, and the least and most it may be. */
export const RECENT_COUNT_DEFAULT = 10;
export const RECENT_COUNT_MIN = 1;
export const RECENT_COUNT_MAX = 50;

const isSection = (value: unknown): value is SidebarSection =>
  typeof value === 'string' && (SIDEBAR_SECTIONS as readonly string[]).includes(value);

/** A list of section ids, each once (ids this build does not know are allowed, and skipped). */
function sectionListProblem(key: string, value: unknown): string | null {
  if (!Array.isArray(value) || value.length > 20) return `${key} must be a list of sections`;
  const seen = new Set<string>();
  for (const id of value as unknown[]) {
    if (typeof id !== 'string' || !/^[A-Za-z]{1,40}$/.test(id))
      return `${key} must hold section ids`;
    if (seen.has(id)) return `${key} repeats ${id}`;
    seen.add(id);
  }
  return null;
}

/** Why `value` cannot be stored as the layout setting `key`, or null when it can. */
export function sidebarLayoutProblem(key: string, value: unknown): string | null {
  if (value === null) return null;
  switch (key) {
    case SECTION_ORDER_SETTING:
    case HIDDEN_SECTIONS_SETTING:
      return sectionListProblem(key, value);
    case RECENT_COUNT_SETTING:
      return Number.isInteger(value) &&
        (value as number) >= RECENT_COUNT_MIN &&
        (value as number) <= RECENT_COUNT_MAX
        ? null
        : `${key} must be a whole number from ${RECENT_COUNT_MIN} to ${RECENT_COUNT_MAX}`;
    case QUICK_ACCESS_NOTEBOOK_SETTING:
      return typeof value === 'boolean' ? null : `${key} must be true or false`;
  }
  return `${key} is not a sidebar setting`;
}

const listOf = (settings: Readonly<Record<string, unknown>>, key: string): readonly unknown[] => {
  const value = settings[key];
  return Array.isArray(value) && sidebarLayoutProblem(key, value) === null ? value : [];
};

/** Every section in the order shown, hidden ones included (they keep their place). */
export function sectionOrderOf(
  settings: Readonly<Record<string, unknown>>,
): readonly SidebarSection[] {
  const stored = listOf(settings, SECTION_ORDER_SETTING).filter(isSection);
  return [...stored, ...SIDEBAR_SECTIONS.filter((id) => !stored.includes(id))];
}

/** The sections hidden. */
export function hiddenSectionsOf(
  settings: Readonly<Record<string, unknown>>,
): ReadonlySet<SidebarSection> {
  return new Set(listOf(settings, HIDDEN_SECTIONS_SETTING).filter(isSection));
}

/** The sections shown, in order. */
export function shownSectionsOf(
  settings: Readonly<Record<string, unknown>>,
): readonly SidebarSection[] {
  const hidden = hiddenSectionsOf(settings);
  return sectionOrderOf(settings).filter((id) => !hidden.has(id));
}

/** How many notes Recent Notes shows. */
export function recentCountOf(settings: Readonly<Record<string, unknown>>): number {
  const value = settings[RECENT_COUNT_SETTING];
  return sidebarLayoutProblem(RECENT_COUNT_SETTING, value) === null && typeof value === 'number'
    ? value
    : RECENT_COUNT_DEFAULT;
}

/** Whether Quick Access names each note's notebook. */
export function quickAccessShowsNotebook(settings: Readonly<Record<string, unknown>>): boolean {
  return settings[QUICK_ACCESS_NOTEBOOK_SETTING] === true;
}

/**
 * The order with `id` moved to `index` among all the sections (hidden ones included), as
 * `sidebar.sectionOrder` stores it: every section, so later defaults never reshuffle it.
 */
export function movedSection(
  order: readonly SidebarSection[],
  id: SidebarSection,
  index: number,
): readonly SidebarSection[] {
  const rest = order.filter((each) => each !== id);
  const at = Math.max(0, Math.min(index, rest.length));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** The hidden sections with `id` hidden or shown, in the default order (a stable value). */
export function withSectionHidden(
  hidden: ReadonlySet<SidebarSection>,
  id: SidebarSection,
  hide: boolean,
): readonly SidebarSection[] {
  return SIDEBAR_SECTIONS.filter((each) => (each === id ? hide : hidden.has(each)));
}
