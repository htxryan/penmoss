/**
 * Copy to Notebook's tags (A1353): whether a note copied to another notebook takes its
 * tags with it. The picker asks each time, in a Copy Tags checkbox at its foot; this setting is
 * that checkbox's starting value, in Settings → Git Notebooks. One synced per-user setting, like
 * Display's (A576), so the choice follows the user to every device:
 *
 * - `copyToNotebook.tags`: true or false. Unset, or anything else, is the default, true: a copy
 *   took its tags before the setting existed (T68, #230), and still does unless told otherwise.
 *
 * Only the frontmatter tags are left behind when it is off: an inline `#tag` is part of the
 * note's text, which is copied as it is. Move to Notebook always keeps every tag, since the note
 * leaves the notebook it was in. Android has no Copy to Notebook and ignores it.
 */

export const COPY_TAGS_SETTING = 'copyToNotebook.tags';

/** Whether Copy to Notebook starts with Copy Tags ticked: only `false` unticks it. */
export function copiesTags(settings: Readonly<Record<string, unknown>>): boolean {
  return settings[COPY_TAGS_SETTING] !== false;
}
