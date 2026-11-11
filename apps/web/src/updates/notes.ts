/**
 * Release notes in Settings → Updates (PEN-108, A-NEW): which notes each view shows, from
 * `release-notes.json` (.github/scripts/release-notes.mjs writes it; main fetches and caches it,
 * apps/desktop/src/release-notes.ts). Pure, so the views are tested without a window.
 *
 * - The offered update: the notes after this build, up to the offered one.
 * - This version: a stable release's own range (after the stable release before it, up to it);
 *   an Alpha build's notes since the last stable release, up to it, each with its build.
 * - Earlier versions: each stable release older than this version, newest first.
 *
 * Builds place themselves by build number (D65): an Alpha version says it (`X.Y.Z-alpha.N`), a
 * stable one is found in the file's `releases`.
 */
import type {
  DesktopReleaseNote,
  DesktopReleaseNotes,
  DesktopReleaseNotesRelease,
} from '../desktop/bridge';

/** The `release-notes.json` schema this app reads; a newer file shows a link instead. */
export const NOTES_SCHEMA = 1;

export const KIND_ORDER = ['new', 'improved', 'fixed'] as const;
export type NoteKind = (typeof KIND_ORDER)[number];

export const KIND_LABELS: Readonly<Record<NoteKind, string>> = {
  new: 'New',
  improved: 'Improved',
  fixed: 'Fixed',
};

export interface NoteGroup {
  readonly kind: NoteKind;
  readonly label: string;
  readonly notes: readonly DesktopReleaseNote[];
}

/** One block of notes: a heading and its notes grouped by kind (empty when there are none). */
export interface NotesBlock {
  readonly title: string;
  readonly groups: readonly NoteGroup[];
  /** An Alpha block: each note says its build. */
  readonly builds: boolean;
}

export type NotesView =
  | { readonly status: 'none' }
  | { readonly status: 'newer' }
  | {
      readonly status: 'ok';
      readonly offered: NotesBlock | null;
      readonly current: NotesBlock | null;
      readonly earlier: readonly NotesBlock[];
    };

/** `X.Y.Z-alpha.N`'s build N, or null for any other version. */
export function alphaBuildOf(version: string): number | null {
  const match = /^\d+\.\d+\.\d+-alpha\.(\d+)$/.exec(version);
  return match ? Number(match[1]) : null;
}

/** A version's build: an Alpha build's own number, or a stable release's from the file. */
export function buildFor(file: DesktopReleaseNotes, version: string): number | null {
  return (
    alphaBuildOf(version) ??
    file.releases.find((release) => release.version === version)?.build ??
    null
  );
}

/** Stable releases, oldest first. */
function stable(file: DesktopReleaseNotes): DesktopReleaseNotesRelease[] {
  return [...file.releases].sort((a, b) => a.build - b.build);
}

/** The newest stable release before `build`. */
function before(file: DesktopReleaseNotes, build: number): DesktopReleaseNotesRelease | null {
  return (
    stable(file)
      .filter((release) => release.build < build)
      .at(-1) ?? null
  );
}

/** Notes for the Mac (no platform, or Mac) with `from < build <= to`. */
function range(file: DesktopReleaseNotes, from: number | null, to: number): DesktopReleaseNote[] {
  return file.notes.filter(
    (note) =>
      (note.platform === null || note.platform === 'mac') &&
      note.build <= to &&
      (from === null || note.build > from),
  );
}

export function groupNotes(notes: readonly DesktopReleaseNote[]): NoteGroup[] {
  return KIND_ORDER.map((kind) => ({
    kind,
    label: KIND_LABELS[kind],
    notes: notes.filter((note) => note.kind === kind),
  })).filter((group) => group.notes.length > 0);
}

/** A stable release's own notes: after the stable release before it, up to it. */
function releaseBlock(file: DesktopReleaseNotes, release: DesktopReleaseNotesRelease): NotesBlock {
  return {
    title: release.version,
    groups: groupNotes(range(file, before(file, release.build)?.build ?? null, release.build)),
    builds: false,
  };
}

/** How the views read a version: "0.2.1", or "build 1180" for an Alpha build. */
export function versionLabel(version: string): string {
  const build = alphaBuildOf(version);
  return build === null ? version : `build ${build}`;
}

/**
 * The notes Settings → Updates shows: `current` is this app's version, `offered` the newer one
 * an update check found (or null).
 */
export function notesView(
  file: DesktopReleaseNotes | null,
  current: string,
  offered: string | null,
): NotesView {
  if (!file) return { status: 'none' };
  if (file.schema > NOTES_SCHEMA) return { status: 'newer' };
  const here = buildFor(file, current);
  const alpha = alphaBuildOf(current) !== null;
  const base = here === null ? null : before(file, alpha ? here + 1 : here);

  let currentBlock: NotesBlock | null = null;
  if (here !== null) {
    currentBlock = alpha
      ? {
          title: base ? `In this version (since ${base.version})` : 'In this version',
          groups: groupNotes(range(file, base?.build ?? null, here)),
          builds: true,
        }
      : {
          ...releaseBlock(file, { version: current, tag: `v${current}`, build: here, date: '' }),
          title: 'In this version',
        };
  }

  let offeredBlock: NotesBlock | null = null;
  const there = offered === null ? null : buildFor(file, offered);
  if (offered !== null && there !== null && (here === null || there > here)) {
    const offeredAlpha = alphaBuildOf(offered) !== null;
    const from = here ?? before(file, there)?.build ?? null;
    offeredBlock = {
      title: `What's new in ${versionLabel(offered)}`,
      groups: groupNotes(range(file, from, there)),
      builds: offeredAlpha,
    };
  }

  // Earlier versions: the stable releases before this version's own notes begin.
  const floor =
    here === null ? null : alpha ? (base?.build ?? null) : (before(file, here)?.build ?? null);
  const earlier =
    here === null
      ? stable(file)
          .reverse()
          .map((release) => releaseBlock(file, release))
      : floor === null
        ? []
        : stable(file)
            .filter((release) => release.build <= floor)
            .reverse()
            .map((release) => releaseBlock(file, release));

  return { status: 'ok', offered: offeredBlock, current: currentBlock, earlier };
}

/** A note as a line: "Fixed: …" is its group, so only its text, and its build on Alpha. */
export function noteText(note: DesktopReleaseNote, builds: boolean): string {
  return builds ? `${note.text} (build ${note.build})` : note.text;
}
