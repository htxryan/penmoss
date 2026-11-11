/**
 * The addresses the brochure links to (T80.10, P1, P2). The download links are GitHub's own
 * `/releases/latest/download/<name>` URLs, which GitHub redirects to that file on the release
 * marked Latest: the newest published stable release (P3). The file names are fixed on every
 * stable release (P2).
 */
export const REPOSITORY = 'https://github.com/htxryan/penmoss';

export const DOWNLOADS = {
  mac: `${REPOSITORY}/releases/latest/download/Penmoss.dmg`,
  android: `${REPOSITORY}/releases/latest/download/Penmoss.apk`,
  /** The rolling Alpha prerelease: every build from main (P4). */
  alpha: `${REPOSITORY}/releases/tag/alpha`,
  all: `${REPOSITORY}/releases`,
} as const;

/** What site/build.mjs found on the latest stable release (R3, T80.12). */
export interface ReleaseInfo {
  version: string;
  tag: string;
  date: string | null;
  /** The file's size in MB, or null when the release lacks it. */
  mac: number | null;
  android: number | null;
}

/**
 * The latest stable release as `site/build.mjs` wrote it into src/data/release.json, or null when
 * the build couldn't reach GitHub, there is no stable release yet, or the file is missing
 * (`astro dev` without a build).
 */
export function latestRelease(): ReleaseInfo | null {
  const files = import.meta.glob<{ release: ReleaseInfo | null }>('./data/release.json', {
    eager: true,
    import: 'default',
  });
  return Object.values(files)[0]?.release ?? null;
}

/**
 * The latest stable release's `release-notes.json` as `site/build.mjs` saved it (PEN-111), or null
 * when the build couldn't reach it or the file is missing (`astro dev` without a build).
 */
export function releaseNotes(): import('./releases.mjs').NotesFile | null {
  const files = import.meta.glob<import('./releases.mjs').NotesFile | null>(
    './data/release-notes.json',
    { eager: true, import: 'default' },
  );
  return Object.values(files)[0] ?? null;
}
