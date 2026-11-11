// Release notes from pull requests (PEN-106, A1301, D67): each build to main collects the
// Release note of every pull request merged since the build before it, into
//   - `release-notes.json` on the `alpha` release: every note so far, the one record (build
//     releases are pruned to the last 10, so they can't be the record), read by the apps;
//   - the build's own release: a "What's new" section above its install text;
//   - the alpha release: "What's new since vX.Y.Z".
// A stable release (PEN-107) attaches a copy of the file and lists itself in its `releases`.
//
// The file is changed by pull request: a re-run of a build, or `fix-note`, replaces that pull
// request's notes and adds nothing twice. Run through releases.mjs (`publish-notes`, `fix-note`).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { formatNote, parseReleaseNote } from './release-note.mjs';

export const NOTES_FILE = 'release-notes.json';
export const SCHEMA = 1;
const ALPHA = 'alpha';
const START = '<!-- penmoss-notes -->';
const END = '<!-- /penmoss-notes -->';
const STABLE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
/** The alpha release lists at most this many unreleased notes; the file holds them all. */
export const ALPHA_LIST = 40;

/**
 * @typedef {import('./release-note.mjs').Kind} Kind
 * @typedef {import('./release-note.mjs').Platform} Platform
 * @typedef {{ build: number, pr: number, kind: Kind, platform: Platform | null, text: string }} NoteEntry
 * @typedef {{ version: string, tag: string, build: number, date: string }} StableEntry
 * @typedef {{ schema: 1, generated: string, head: string | null, prs: { pr: number, build: number }[], notes: NoteEntry[], releases: StableEntry[] }} NotesFile
 * @typedef {{ number: number, body: string | null, mergedTo: string | null }} PullRequest
 * @typedef {{ tag: string, target: string, body: string, prerelease: boolean, assets: { name: string }[] }} Release
 * @typedef {{
 *   list(): Promise<Release[]>,
 *   download(tag: string, name: string, dir: string): Promise<string>,
 *   upload(tag: string, file: string): Promise<void>,
 *   editNotes(tag: string, notes: string): Promise<void>,
 *   compare(base: string, head: string): Promise<string[]>,
 *   pullsOf(sha: string): Promise<PullRequest[]>,
 *   pull(number: number): Promise<PullRequest>,
 *   log(message: string): void,
 * }} NotesGh
 * `compare` lists the commits after `base` up to and including `head`, oldest first.
 * `pullsOf` lists the pull requests a commit belongs to, with the branch each merged into
 * (`mergedTo`, null when not merged).
 */

/** @returns {NotesFile} */
export function emptyNotes() {
  return { schema: SCHEMA, generated: '', head: null, prs: [], notes: [], releases: [] };
}

/**
 * Reads a notes file, refusing one this code doesn't understand rather than overwriting it.
 * @param {string} text @returns {NotesFile}
 */
export function readNotesFile(text) {
  /** @type {Partial<NotesFile>} */
  const raw = JSON.parse(text);
  if (raw.schema !== SCHEMA) {
    throw new Error(
      `${NOTES_FILE} has schema ${String(raw.schema)}, not ${SCHEMA}: not changing it.`,
    );
  }
  return {
    ...emptyNotes(),
    ...raw,
    prs: raw.prs ?? [],
    notes: raw.notes ?? [],
    releases: raw.releases ?? [],
  };
}

/**
 * The notes of pull requests merged into main, for build `build`, and a warning for each one
 * whose Release note doesn't parse (it counts as none: the check should have caught it).
 * @param {PullRequest[]} prs @param {number} build
 */
export function notesOf(prs, build) {
  /** @type {NoteEntry[]} */
  const notes = [];
  /** @type {string[]} */
  const warnings = [];
  for (const pr of prs) {
    const parsed = parseReleaseNote(pr.body);
    if (!parsed.ok) {
      warnings.push(`#${pr.number} has no usable Release note, so none: ${parsed.errors[0]}`);
      continue;
    }
    for (const note of parsed.notes) notes.push({ build, pr: pr.number, ...note });
  }
  return { notes, warnings };
}

/**
 * The file with `prs`' notes replaced by `notes` (all at build `build`).
 * @param {NotesFile} file @param {number[]} prs @param {NoteEntry[]} notes @param {number} build
 * @returns {NotesFile}
 */
export function withNotes(file, prs, notes, build) {
  const replaced = new Set(prs);
  return {
    ...file,
    prs: [
      ...file.prs.filter(({ pr }) => !replaced.has(pr)),
      ...prs.map((pr) => ({ pr, build })),
    ].sort((a, b) => a.build - b.build || a.pr - b.pr),
    notes: [...file.notes.filter(({ pr }) => !replaced.has(pr)), ...notes].sort(
      (a, b) => a.build - b.build || a.pr - b.pr,
    ),
  };
}

const KINDS = /** @type {const} */ ([
  ['new', 'New'],
  ['improved', 'Improved'],
  ['fixed', 'Fixed'],
]);

/**
 * Notes as Markdown, grouped New, Improved, Fixed, each with its pull request.
 * @param {NoteEntry[]} notes @param {{ builds?: boolean }} [options]
 */
export function renderNotes(notes, { builds = false } = {}) {
  /** @type {string[]} */
  const out = [];
  for (const [kind, label] of KINDS) {
    const items = notes.filter((note) => note.kind === kind);
    if (!items.length) continue;
    if (out.length) out.push('');
    out.push(`**${label}**`, '');
    for (const note of items) {
      const platform = note.platform ? `${note.platform === 'mac' ? 'Mac' : 'Android'}: ` : '';
      out.push(`- ${platform}${note.text} (#${note.pr}${builds ? `, build ${note.build}` : ''})`);
    }
  }
  return out.join('\n');
}

/** The body's notes section, markers included, or ''. @param {string} body */
export function notesSectionOf(body) {
  const start = body.indexOf(START);
  const end = body.indexOf(END, start);
  return start === -1 || end === -1 ? '' : body.slice(start, end + END.length);
}

/**
 * `body` with its notes section replaced by `section` (or put first), or removed for ''.
 * @param {string} body @param {string} section
 */
export function withNotesSection(body, section) {
  const old = notesSectionOf(body);
  if (old) return body.replace(old, section).replace(/^\n+/, '');
  return section ? `${section}\n\n${body}` : body;
}

/** @param {string} markdown */
const section = (markdown) => `${START}\n${markdown}\n${END}`;

/** Build `build`'s section: its notes, or that it changes nothing people see. */
/** @param {NotesFile} file @param {number} build */
export function buildSection(file, build) {
  const notes = file.notes.filter((note) => note.build === build);
  return section(
    `### What's new\n\n${notes.length ? renderNotes(notes) : 'Nothing that people using Penmoss would notice.'}`,
  );
}

/** The alpha release's section: the notes since the newest stable release. @param {NotesFile} file */
export function alphaSection(file) {
  const stable = [...file.releases].sort((a, b) => b.build - a.build)[0];
  const since = file.notes.filter((note) => !stable || note.build > stable.build);
  const shown = since.slice(-ALPHA_LIST);
  const more = since.length - shown.length;
  return section(
    [
      `### What's new since ${stable ? stable.tag : 'notes began'}`,
      '',
      shown.length ? renderNotes(shown, { builds: true }) : 'Nothing yet.',
      ...(more > 0 ? ['', `And ${more} earlier: see \`${NOTES_FILE}\` on this release.`] : []),
    ].join('\n'),
  );
}

/**
 * The notes file the alpha release holds, else the newest stable release's, else a new one.
 * @param {NotesGh} gh @param {Release[]} releases @param {string} dir
 */
export async function loadNotes(gh, releases, dir) {
  const holder =
    releases.find((r) => r.tag === ALPHA && r.assets.some((a) => a.name === NOTES_FILE)) ??
    releases
      .filter((r) => STABLE.test(r.tag) && r.assets.some((a) => a.name === NOTES_FILE))
      .sort((a, b) => b.tag.localeCompare(a.tag, 'en', { numeric: true }))[0];
  if (!holder) return emptyNotes();
  return readNotesFile(readFileSync(await gh.download(holder.tag, NOTES_FILE, dir), 'utf8'));
}

/**
 * The file with the `releases` of the newest published stable release's own file added: a
 * stable release lists itself when it is drafted (PEN-107), so alpha learns of it once it is
 * published, never from a draft that might be deleted.
 * @param {NotesGh} gh @param {Release[]} releases @param {NotesFile} file @param {string} dir
 */
async function withPublished(gh, releases, file, dir) {
  const stable = releases
    .filter((r) => STABLE.test(r.tag) && r.assets.some((a) => a.name === NOTES_FILE))
    .sort((a, b) => b.tag.localeCompare(a.tag, 'en', { numeric: true }))[0];
  if (!stable || file.releases.some((r) => r.tag === stable.tag)) return file;
  const theirs = readNotesFile(
    readFileSync(await gh.download(stable.tag, NOTES_FILE, path.join(dir)), 'utf8'),
  );
  const tags = new Set(file.releases.map((r) => r.tag));
  return {
    ...file,
    releases: [...file.releases, ...theirs.releases.filter((r) => !tags.has(r.tag))].sort(
      (a, b) => a.build - b.build,
    ),
  };
}

/** Writes and uploads the file to `tag`. @param {NotesGh} gh @param {string} tag @param {NotesFile} file @param {string} dir */
export async function uploadNotes(gh, tag, file, dir) {
  const out = path.join(dir, NOTES_FILE);
  writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
  await gh.upload(tag, out);
}

/**
 * Collects build `run`'s notes: the pull requests merged into main since the build the file
 * last saw (or the newest build release before `run`), up to `sha`. Then writes the file to
 * the alpha release, and the sections to the build's and the alpha release's notes.
 * @param {NotesGh} gh @param {{ run: number, sha: string, dir: string, now?: Date }} build
 */
export async function publishNotes(gh, { run, sha, dir, now = new Date() }) {
  const releases = await gh.list();
  const alpha = releases.find((r) => r.tag === ALPHA);
  if (!alpha) {
    gh.log(`::warning::No ${ALPHA} release yet: build ${run}'s notes wait for the next build.`);
    return;
  }
  const file = await withPublished(gh, releases, await loadNotes(gh, releases, dir), dir);
  const before = releases
    .map((r) => ({ r, n: /^build-(\d+)$/.exec(r.tag)?.[1] }))
    .filter(({ n }) => n !== undefined && Number(n) < run)
    .sort((a, b) => Number(b.n) - Number(a.n))[0]?.r.target;
  const base = file.head ?? before ?? null;
  const commits = base && base !== sha ? await gh.compare(base, sha) : [sha];
  /** @type {Map<number, PullRequest>} */
  const prs = new Map();
  for (const commit of commits) {
    for (const pr of await gh.pullsOf(commit)) {
      if (pr.mergedTo === 'main') prs.set(pr.number, pr);
    }
  }
  const { notes, warnings } = notesOf([...prs.values()], run);
  for (const warning of warnings) gh.log(`::warning::${warning}`);
  const next = {
    ...withNotes(file, [...prs.keys()], notes, run),
    head: sha,
    generated: now.toISOString(),
  };
  await uploadNotes(gh, ALPHA, next, dir);
  const own = releases.find((r) => r.tag === `build-${run}`);
  if (own) await gh.editNotes(own.tag, withNotesSection(own.body, buildSection(next, run)));
  await gh.editNotes(ALPHA, withNotesSection(alpha.body, alphaSection(next)));
  gh.log(
    `Notes for build ${run}: ${notes.length} from ${prs.size} pull request(s) (${commits.length} commit(s) since ${base ? base.slice(0, 7) : 'the start'})`,
  );
}

/**
 * A stable release's notes (PEN-107): the notes after the stable release before it (`previous`,
 * found in the file's `releases`; all of them when it isn't there) up to its own `build`, as the
 * draft's text, and the file it carries, which lists it among `releases` (a -rc.N rehearsal is
 * never listed: the apps place themselves by stable releases only). `install`, when given, goes
 * between the notes and the changelog link.
 * @param {NotesFile} file
 * @param {{ tag: string, version: string, build: number, previous: string | null, date: string, repo: string, install?: string }} release
 * @returns {{ body: string, file: NotesFile }}
 */
export function stableNotes(file, { tag, version, build, previous, date, repo, install }) {
  const from = previous ? file.releases.find((r) => r.tag === previous)?.build : undefined;
  const notes = file.notes.filter(
    (n) => n.build <= build && (from === undefined || n.build > from),
  );
  const body = [
    `## What's new in ${version}`,
    '',
    notes.length
      ? renderNotes(notes)
      : 'A maintenance release: nothing that people using Penmoss would notice.',
    '',
    ...(install ? [install, ''] : []),
    previous
      ? `**Full changelog**: https://github.com/${repo}/compare/${previous}...${tag}`
      : `**Full changelog**: https://github.com/${repo}/commits/${tag}`,
  ].join('\n');
  const listed = STABLE.test(tag)
    ? [...file.releases.filter((r) => r.tag !== tag), { version, tag, build, date }].sort(
        (a, b) => a.build - b.build,
      )
    : file.releases;
  return { body, file: { ...file, releases: listed } };
}

/**
 * Re-reads pull request `number`'s Release note and puts it in place of the one captured at
 * merge: in the file, its build's release (if still there) and the alpha release.
 * @param {NotesGh} gh @param {{ pr: number, dir: string, now?: Date }} fix
 */
export async function fixNote(gh, { pr, dir, now = new Date() }) {
  const releases = await gh.list();
  const alpha = releases.find((r) => r.tag === ALPHA);
  if (!alpha) throw new Error(`No ${ALPHA} release: there are no notes to fix.`);
  const file = await loadNotes(gh, releases, dir);
  const seen = file.prs.find((entry) => entry.pr === pr);
  if (!seen) throw new Error(`#${pr} is in no build's notes: was it merged before notes began?`);
  const parsed = parseReleaseNote((await gh.pull(pr)).body);
  if (!parsed.ok) {
    throw new Error(`#${pr}'s Release note still doesn't parse:\n${parsed.errors.join('\n')}`);
  }
  const notes = parsed.notes.map((note) => ({ build: seen.build, pr, ...note }));
  const next = { ...withNotes(file, [pr], notes, seen.build), generated: now.toISOString() };
  await uploadNotes(gh, ALPHA, next, dir);
  const own = releases.find((r) => r.tag === `build-${seen.build}`);
  if (own) await gh.editNotes(own.tag, withNotesSection(own.body, buildSection(next, seen.build)));
  await gh.editNotes(ALPHA, withNotesSection(alpha.body, alphaSection(next)));
  gh.log(
    `#${pr} (build ${seen.build}): ${notes.length ? notes.map(formatNote).join(' / ') : 'none'}`,
  );
}
