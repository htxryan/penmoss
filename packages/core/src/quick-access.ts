/**
 * Quick Access (T51 item 18, A946): notes a person pins to reach from anywhere, the Mac's menu
 * bar icon, the sidebar and Android's Home. One synced per-user setting, `quickAccess.notes`:
 * note ids in pin order, at most twenty. The web writes it in its WorkspaceDoc; the Android app
 * through `PUT /api/settings`, which checks it with these same rules.
 */

export const QUICK_ACCESS_SETTING = 'quickAccess.notes';

/** At most this many pinned notes. */
export const MAX_QUICK_ACCESS = 20;

/** A note id as the apps make them (ULIDs, 26 characters) or as older notes have them. */
const NOTE_ID = /^[0-9A-Za-z_-]{1,80}$/;

/** Why `value` cannot be stored as `quickAccess.notes`, or null when it can. */
export function quickAccessProblem(value: unknown): string | null {
  if (value === null) return null;
  if (!Array.isArray(value)) return `${QUICK_ACCESS_SETTING} must be a list of note ids`;
  if (value.length > MAX_QUICK_ACCESS)
    return `${QUICK_ACCESS_SETTING} must have at most ${MAX_QUICK_ACCESS} notes`;
  const seen = new Set<string>();
  for (const id of value as unknown[]) {
    if (typeof id !== 'string' || !NOTE_ID.test(id))
      return `${QUICK_ACCESS_SETTING} must hold note ids`;
    if (seen.has(id)) return `${QUICK_ACCESS_SETTING} repeats ${id}`;
    seen.add(id);
  }
  return null;
}

/** The pinned ids, or none while unset or unreadable. */
export function quickAccessOf(settings: Readonly<Record<string, unknown>>): readonly string[] {
  const value = settings[QUICK_ACCESS_SETTING];
  return value !== undefined && value !== null && quickAccessProblem(value) === null
    ? (value as string[])
    : [];
}

/** The list with `id` pinned (at the end) or unpinned; null when it is full. */
export function toggledQuickAccess(list: readonly string[], id: string): readonly string[] | null {
  if (list.includes(id)) return list.filter((entry) => entry !== id);
  if (list.length >= MAX_QUICK_ACCESS) return null;
  return [...list, id];
}

/**
 * The list with `id` moved to `index` (T53 item 10: Quick Access is dragged into order); the
 * list as it was when `id` is not pinned.
 */
export function movedQuickAccess(
  list: readonly string[],
  id: string,
  index: number,
): readonly string[] {
  if (!list.includes(id)) return list;
  const rest = list.filter((entry) => entry !== id);
  const at = Math.max(0, Math.min(index, rest.length));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}
