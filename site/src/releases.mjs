// The docs' Release notes page (PEN-111, RN13): the stable releases in `release-notes.json`, as
// the apps read it (.github/scripts/release-notes.mjs writes it). Plain JavaScript so build.mjs's
// tests (node --test) and the Astro page share it.

/** The kinds, in the order the page lists them. */
export const KINDS = /** @type {const} */ ([
  ['new', 'New'],
  ['improved', 'Improved'],
  ['fixed', 'Fixed'],
]);

/** A note's platform as people read it, or null for both. */
export const PLATFORM_LABELS = /** @type {Record<string, string>} */ ({
  mac: 'Mac',
  android: 'Android',
});

/**
 * @typedef {{ build: number, pr: number, kind: string, platform: string | null, text: string }} Note
 * @typedef {{ version: string, tag: string, build: number, date: string }} Release
 * @typedef {{ schema: number, notes: Note[], releases: Release[] }} NotesFile
 * @typedef {{ kind: string, label: string, notes: Note[] }} Group
 * @typedef {{ version: string, tag: string, date: string, groups: Group[] }} ReleaseBlock
 */

/**
 * Each stable release, newest first, with its own notes (after the release before it, up to its
 * build) grouped by kind. Null for no file or a schema this page does not know.
 * @param {NotesFile | null | undefined} file
 * @returns {ReleaseBlock[] | null}
 */
export function stableReleases(file) {
  if (!file || file.schema !== 1 || !Array.isArray(file.releases) || !Array.isArray(file.notes)) {
    return null;
  }
  const releases = [...file.releases].sort((a, b) => a.build - b.build);
  return releases
    .map((release, i) => {
      const from = i === 0 ? null : (releases[i - 1]?.build ?? null);
      const notes = file.notes.filter(
        (note) => note.build <= release.build && (from === null || note.build > from),
      );
      return {
        version: release.version,
        tag: release.tag,
        date: release.date,
        groups: KINDS.map(([kind, label]) => ({
          kind,
          label,
          notes: notes.filter((note) => note.kind === kind),
        })).filter((group) => group.notes.length > 0),
      };
    })
    .reverse();
}

/** "8 November 2026" for `2026-11-08`. @param {string} date */
export function longDate(date) {
  const day = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(day.getTime())) return date;
  return day.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
