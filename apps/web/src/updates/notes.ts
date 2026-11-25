/**
 * Release notes in Settings → Updates (PEN-108, A-NEW): which notes each view shows, from
 * `release-notes.json` (.github/scripts/release-notes.mjs writes it; main fetches and caches it,
 * apps/desktop/src/release-notes.ts). Pure, so the views are tested without a window.
 *
 * - The offered update: the notes after this build, up to the offered one.
 * - This version: a stable release's own range (after the stable release before it, up to it);
 *   an Alpha build's notes since the version Penmoss ran before it (`since`), or only its own
 *   build's when that isn't known, each with its build. Never further back than the last stable
 *   release: every Alpha build is a release of its own, so "this version" is not everything
 *   since the last stable one (which, before the first stable release, is every note ever).
 * - Earlier versions: an Alpha build's earlier builds since the last stable release, in one
 *   block, then each stable release older than this version, newest first.
 *
 * Builds place themselves by build number (D65): an Alpha version says it (`X.Y.Z-alpha.N`), a
 * stable one is found in the file's `releases`.
 */
import type {
  DesktopReleaseNote,
  DesktopReleaseNotes,
  DesktopReleaseNotesRelease,
} from '../desktop/bridge';
import { counted } from '@penmoss/core/words';

/** The `release-notes.json` schema this app reads; a newer file shows a link instead. */
const NOTES_SCHEMA = 1;

const KIND_ORDER = ['new', 'improved', 'fixed'] as const;
type NoteKind = (typeof KIND_ORDER)[number];

const KIND_LABELS: Readonly<Record<NoteKind, string>> = {
  new: 'New',
  improved: 'Improved',
  fixed: 'Fixed',
};

interface NoteGroup {
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

/** Which app the notes are for: the Mac's page, or Android's (the shared cases, PEN-109). */
export type NotesPlatform = 'mac' | 'android';

/** Notes for `platform` (no platform, or that one) with `from < build <= to`. */
function range(
  file: DesktopReleaseNotes,
  from: number | null,
  to: number,
  platform: NotesPlatform,
): DesktopReleaseNote[] {
  return file.notes.filter(
    (note) =>
      (note.platform === null || note.platform === platform) &&
      note.build <= to &&
      (from === null || note.build > from),
  );
}

function groupNotes(notes: readonly DesktopReleaseNote[]): NoteGroup[] {
  return KIND_ORDER.map((kind) => ({
    kind,
    label: KIND_LABELS[kind],
    notes: notes.filter((note) => note.kind === kind),
  })).filter((group) => group.notes.length > 0);
}

/** A stable release's own notes: after the stable release before it, up to it. */
function releaseBlock(
  file: DesktopReleaseNotes,
  release: DesktopReleaseNotesRelease,
  platform: NotesPlatform,
): NotesBlock {
  return {
    title: release.version,
    groups: groupNotes(
      range(file, before(file, release.build)?.build ?? null, release.build, platform),
    ),
    builds: false,
  };
}

/** How the views read a version: "0.2.1", or "build 1180" for an Alpha build. */
export function versionLabel(version: string): string {
  const build = alphaBuildOf(version);
  return build === null ? version : `build ${build}`;
}

/** A version as a heading names it (Title Case): "Build 1183", "0.2.1". */
const headingVersion = (version: string) => version.charAt(0).toUpperCase() + version.slice(1);

/**
 * The notes Settings → Updates shows: `current` is this app's version, `offered` the newer one
 * an update check found (or null), and `since` the version Penmoss ran before this one (or null
 * when it isn't known), where an Alpha build's "In This Version" starts.
 */
export function notesView(
  file: DesktopReleaseNotes | null,
  current: string,
  offered: string | null,
  platform: NotesPlatform = 'mac',
  since: string | null = null,
): NotesView {
  if (!file) return { status: 'none' };
  if (file.schema > NOTES_SCHEMA) return { status: 'newer' };
  const here = buildFor(file, current);
  const alpha = alphaBuildOf(current) !== null;
  const base = here === null ? null : before(file, alpha ? here + 1 : here);

  let currentBlock: NotesBlock | null = null;
  // An Alpha build's notes start after `from`; earlier builds since `base` are Earlier Versions.
  let from: number | null = null;
  if (here !== null && alpha) {
    const start = alphaStart(file, here, base, since);
    from = start.from;
    currentBlock = {
      title: start.label
        ? `In This Version (Since ${headingVersion(start.label)})`
        : 'In This Version',
      groups: groupNotes(range(file, from, here, platform)),
      builds: true,
    };
  } else if (here !== null) {
    currentBlock = {
      ...releaseBlock(
        file,
        { version: current, tag: `v${current}`, build: here, date: '' },
        platform,
      ),
      title: 'In This Version',
    };
  }

  let offeredBlock: NotesBlock | null = null;
  const there = offered === null ? null : buildFor(file, offered);
  if (offered !== null && there !== null && (here === null || there > here)) {
    const offeredAlpha = alphaBuildOf(offered) !== null;
    const start = here ?? before(file, there)?.build ?? null;
    offeredBlock = {
      title: `What's New in ${headingVersion(versionLabel(offered))}`,
      groups: groupNotes(range(file, start, there, platform)),
      builds: offeredAlpha,
    };
  }

  // Earlier versions: the stable releases before this version's own notes begin, and on Alpha
  // the builds between the last stable release and this version's notes.
  const floor =
    here === null ? null : alpha ? (base?.build ?? null) : (before(file, here)?.build ?? null);
  const releases =
    here === null
      ? stable(file)
          .reverse()
          .map((release) => releaseBlock(file, release, platform))
      : floor === null
        ? []
        : stable(file)
            .filter((release) => release.build <= floor)
            .reverse()
            .map((release) => releaseBlock(file, release, platform));
  const builds = from === null ? [] : groupNotes(range(file, base?.build ?? null, from, platform));
  const earlier =
    builds.length === 0
      ? releases
      : [
          {
            title: base ? `Earlier Builds (Since ${base.version})` : 'Earlier Builds',
            groups: builds,
            builds: true,
          },
          ...releases,
        ];

  return { status: 'ok', offered: offeredBlock, current: currentBlock, earlier };
}

/**
 * Where an Alpha build's "In This Version" starts: after the version Penmoss ran before it when
 * that is an older build since the last stable release; after the last stable release when it
 * ran one from before that; and otherwise (not known, or not older) after the build before this
 * one, so only this build's own notes. `label` is what the heading says it is since, if anything.
 */
function alphaStart(
  file: DesktopReleaseNotes,
  here: number,
  base: DesktopReleaseNotesRelease | null,
  since: string | null,
): { from: number; label: string | null } {
  const previous = since ? buildFor(file, since) : null;
  if (since && previous !== null && previous < here) {
    if (base === null || previous > base.build) {
      return { from: previous, label: versionLabel(since) };
    }
    return { from: base.build, label: base.version };
  }
  return { from: here - 1, label: null };
}

/**
 * The notice after an update (PEN-110): the version Penmoss now runs, as people read it, when it
 * updated from an older one, the notice is unanswered, and this version has notes to show.
 */
export function updatedNotice(
  file: DesktopReleaseNotes | null,
  current: string,
  updatedFrom: string | null | undefined,
  platform: NotesPlatform = 'mac',
): string | null {
  if (!updatedFrom) return null;
  const view = notesView(file, current, null, platform, updatedFrom);
  if (view.status !== 'ok' || !view.current || view.current.groups.length === 0) return null;
  return versionLabel(current);
}

/** Settings → Updates opened from the notice scrolls to "In This Version". */
export const WHATS_NEW_PATH = '/settings/updates?whats-new';

/** A note as a line: "Fixed: …" is its group, so only its text, and its build on Alpha. */
export function noteText(note: DesktopReleaseNote, builds: boolean): string {
  return builds ? `${note.text} (build ${note.build})` : note.text;
}

/** A block's notes, counted. */
const changes = (block: NotesBlock) =>
  block.groups.reduce((count, group) => count + group.notes.length, 0);

/** What's New's summary: the version it shows first and its changes, "Build 1413 · 12 changes". */
export function whatsNewSummary(view: NotesView, current: string, offered: string | null): string {
  const label = (version: string) => {
    const words = versionLabel(version);
    return words.charAt(0).toUpperCase() + words.slice(1);
  };
  if (view.status !== 'ok') return 'On GitHub';
  const block = view.offered ?? view.current;
  const version = view.offered && offered ? offered : current;
  if (!block) return label(version);
  const count = changes(block);
  const summary = count === 0 ? 'nothing to notice' : counted(count, 'change');
  return `${view.offered ? `${label(version)} to install` : label(version)} · ${summary}`;
}
