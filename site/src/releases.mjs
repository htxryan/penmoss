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

/**
 * Stable releases published before release notes began (PEN-106), so no `release-notes.json`
 * carries them: 0.2.0, the first public release, whose notes are its GitHub release's, written
 * for people using Penmoss. In the file's own shape, and the file wins for a release it lists.
 * @type {{ version: string, tag: string, date: string, notes: Omit<Note, 'build' | 'pr'>[] }[]}
 */
export const BEFORE_NOTES = [
  {
    version: '0.2.0',
    tag: 'v0.2.0',
    date: '2026-11-08',
    notes: [
      {
        kind: 'new',
        platform: null,
        text: 'The first public release of Penmoss: notes in your own git repositories, on the Mac and Android, that your AI agents can read and edit through the local MCP server and the penmoss CLI.',
      },
      {
        kind: 'new',
        platform: 'android',
        text: 'The APK is signed with the certificate every later release keeps, so updates install over it.',
      },
    ],
  },
];

/**
 * `blocks` (from `stableReleases`, or null) with the releases before notes began that they lack,
 * newest first. Never null: there is always 0.2.0.
 * @param {ReleaseBlock[] | null} blocks
 * @param {typeof BEFORE_NOTES} [before]
 * @returns {ReleaseBlock[]}
 */
export function withEarlierReleases(blocks, before = BEFORE_NOTES) {
  const listed = new Set((blocks ?? []).map((block) => block.tag));
  const earlier = before
    .filter((release) => !listed.has(release.tag))
    .map((release) => ({
      version: release.version,
      tag: release.tag,
      date: release.date,
      groups: KINDS.map(([kind, label]) => ({
        kind,
        label,
        notes: release.notes
          .filter((note) => note.kind === kind)
          .map((note) => ({ build: 0, pr: 0, ...note })),
      })).filter((group) => group.notes.length > 0),
    }));
  return [...(blocks ?? []), ...earlier].sort((a, b) => byVersion(b.version, a.version));
}

/** Compares two x.y.z versions. @param {string} a @param {string} b */
function byVersion(a, b) {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) {
    const d = (x?.[i] ?? 0) - (y?.[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
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
