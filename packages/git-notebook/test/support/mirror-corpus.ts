/**
 * The mirror golden corpus (T50 G1, A752 → A832): every markdown fixture of the codec as a note,
 * filed in a folder tree that exercises A201/A212's naming rules (colliding, cut, reserved and
 * Windows names), and rendered as the server's git mirror renders it (`NoteDoc.mirrorRender`:
 * links written by file name, attachment paths relative to the note's folder).
 *
 * It takes the mirror's code as an argument, so the same corpus ran against the server's own
 * modules before they moved (recording `fixtures/mirror-golden.json`) and runs against the shared
 * packages now: the bytes must not change. No clock and no randomness: every id, time and Yjs
 * client id is fixed.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMarkdown, type LinkResolver } from '@penmoss/core';
import { initNote } from '@penmoss/sync-client/note';
import { NOTE_ROOT } from '@penmoss/sync-client/replica';
import { setFrontmatterTag } from '@penmoss/sync-client/tags';
import { docToDelta } from '@y/prosemirror';
import * as Y from '@y/y';

/** The mirror's code the corpus runs (before the move: the server's modules; after: shared). */
export interface MirrorCode {
  readonly readNoteState: (doc: Y.Doc) => unknown;
  readonly renderNote: (
    state: never,
    noteId: string,
    changedAt: number,
    options: {
      readonly links?: LinkResolver;
      readonly assetUrl?: (url: string) => string;
    },
  ) => { readonly markdown: string; readonly text: string; readonly tags: string[] };
  readonly localAttachment: (url: string) => { sha256: string; ext: string } | null;
  readonly attachmentFiles: (body: never) => Array<{ sha256: string; ext: string }>;
  readonly noteBody: (doc: Y.Doc) => unknown;
  readonly noteStamp: (at: number, like: string | null | undefined) => string;
  readonly assignFolders: (
    folders: ReadonlyArray<{ id: string; name: string; parentId: string | null }>,
    previous: ReadonlyMap<string, unknown>,
    reserved?: (dir: string, key: string) => boolean,
  ) => Map<string, { name: string; base: string; parentId: string | null; top: boolean }>;
  readonly folderDirs: (
    folders: ReadonlyArray<{ id: string; name: string; parentId: string | null }>,
    assigned: never,
  ) => Map<string, string>;
  readonly noteName: (title: string) => string;
  readonly nameKey: (name: string) => string;
  readonly uniqueName: (base: string, id: string, taken: (key: string) => boolean) => string;
  readonly notePath: (dir: string, name: string) => string;
  readonly assetPrefix: (path: string) => string;
  readonly sanitizeName: (raw: string) => string;
  readonly gitTextSha: (text: string) => Promise<string>;
  readonly textHash: (text: string) => string;
  readonly periodicNoteId: (kind: 'daily' | 'weekly', period: string) => string;
  readonly journalFolderId: (path: string) => string;
  readonly periodicNote: (
    codec: { parseMarkdown: typeof parseMarkdown },
    kind: 'daily' | 'weekly',
    period: string,
    template: string,
  ) => { readonly id: string; readonly update: Uint8Array };
}

export interface MirrorGolden {
  /** Every folder's directory, by id. */
  readonly folders: Record<string, string>;
  /** Every note's file: path, git blob SHA and the markdown itself. */
  readonly notes: Array<{ id: string; path: string; sha: string; markdown: string }>;
  /** Names `sanitizeName`, `noteName` and `uniqueName` give awkward titles. */
  readonly names: Record<string, { sanitized: string; note: string; unique: string }>;
  /** Unsalted periodic ids (A76): a server workspace's ids must never change (A820). */
  readonly periodic: Record<string, string>;
  /** SHA-256 of the unsalted periodic notes' Yjs updates (A4): the same bytes on every device. */
  readonly periodicUpdates: Record<string, string>;
  /** Frontmatter stamps (A209). */
  readonly stamps: Record<string, string>;
  /** The attachment files each note uses, by note id. */
  readonly files: Record<string, string[]>;
  readonly treeHash: string;
}

const FIXTURES = join(import.meta.dirname, '..', '..', '..', 'core', 'test', 'fixtures');

/** A fixed ULID-shaped id: a time part, then the index in base 32. */
function fixedId(prefix: string, index: number): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let tail = '';
  for (let rest = index, i = 0; i < 6; i++) {
    tail = alphabet[rest % 32] + tail;
    rest = Math.floor(rest / 32);
  }
  return `01JB${prefix.padEnd(16, '0')}${tail}`.slice(0, 26);
}

/** Titles the naming rules have opinions about (A201): clashes, cuts, devices, dots, slashes. */
const AWKWARD = [
  'Meeting',
  'meeting',
  'MEETING',
  'Q3: plans? <draft> "final" | v2',
  'con',
  'CON.txt',
  'aux',
  '.hidden',
  'trailing dot.',
  '   spaced   out   ',
  'A very long title that goes on and on, well past the eighty characters a note name keeps, and then some more',
  'Résumé',
  'Résumé',
  'Ελληνικά ΣΣ ς',
  '#tag ^block [link]',
  'a/b\\c',
  '',
  '…',
  'Penmoss — product brief',
  'Penmoss — sync design',
  'Penmoss — MCP tools',
  'Sync design',
  'attachments',
  'Notes.md',
];

const FOLDERS: ReadonlyArray<{ key: string; name: string; parent: string | null }> = [
  { key: 'projects', name: 'Projects', parent: null },
  { key: 'q3', name: 'Q3: launch', parent: 'projects' },
  { key: 'workA', name: 'Work', parent: null },
  { key: 'workB', name: 'work', parent: null },
  { key: 'attachments', name: 'attachments', parent: null },
  { key: 'md', name: 'Ideas.md', parent: null },
  { key: 'archive', name: 'Archive', parent: null },
  {
    key: 'long',
    name: 'A folder name that is much too long to fit in a Windows clone path at all, really',
    parent: 'archive',
  },
  {
    key: 'longer',
    name: 'Another folder name that is also far too long for a Windows clone path to hold',
    parent: 'long',
  },
  { key: 'deep', name: 'Deep', parent: 'longer' },
  { key: 'dots', name: '...dots...', parent: 'projects' },
  { key: 'device', name: 'nul', parent: null },
];

export async function mirrorCorpus(code: MirrorCode, fixtures = FIXTURES): Promise<MirrorGolden> {
  const folderIds = new Map(FOLDERS.map((folder, i) => [folder.key, fixedId('F', i)]));
  const folders = FOLDERS.map((folder) => ({
    id: folderIds.get(folder.key)!,
    name: folder.name,
    parentId: folder.parent === null ? null : folderIds.get(folder.parent)!,
  }));
  const fixtureFiles = readdirSync(fixtures)
    .filter((file) => file.endsWith('.md'))
    .sort();
  const folderCycle = [null, ...folders.map((folder) => folder.id)];
  interface Entry {
    id: string;
    title: string;
    markdown: string;
    folderId: string | null;
    kind: 'note' | 'daily' | 'weekly';
    tags: string[];
  }
  const entries: Entry[] = fixtureFiles.map((file, i) => ({
    id: fixedId('N', i),
    title: AWKWARD[i % AWKWARD.length] ?? file,
    markdown: readFileSync(join(fixtures, file), 'utf8'),
    folderId: folderCycle[i % folderCycle.length] ?? null,
    kind: i % 17 === 5 ? 'daily' : i % 23 === 7 ? 'weekly' : 'note',
    tags: i % 4 === 0 ? ['projects/garden', `fixture-${i % 3}`] : [],
  }));
  // Titles by note, for links: the first note with a title wins, as a resolver picks one.
  const byTitle = new Map<string, string>();
  for (const entry of entries) if (!byTitle.has(entry.title)) byTitle.set(entry.title, entry.id);
  const resolve: LinkResolver = {
    resolve: (target) => byTitle.get(target.trim()) ?? null,
    linkText: () => null,
  };

  const docs = new Map<string, Y.Doc>();
  entries.forEach((entry, i) => {
    const doc = new Y.Doc();
    doc.clientID = 1000 + i;
    initNote(
      doc,
      {
        id: entry.id,
        created:
          i % 3 === 0
            ? `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T09:15:00-05:00`
            : '2026-10-02T23:59:59Z',
        kind: entry.kind,
        ...(entry.kind === 'daily' ? { period: '2026-10-22' } : {}),
        ...(entry.kind === 'weekly' ? { period: '2026-W43' } : {}),
      },
      entry.title,
    );
    const parsed = parseMarkdown(entry.markdown, { links: resolve });
    doc.get(NOTE_ROOT).applyDelta(docToDelta(parsed.doc));
    for (const tag of entry.tags) setFrontmatterTag(doc, tag, true);
    docs.set(entry.id, doc);
  });

  // Names: folders by A212, then notes in id order, unique across the repository (A201).
  const assigned = code.assignFolders(
    folders,
    new Map(),
    (dir, key) => dir === '' && key === 'readme.md',
  );
  const dirs = code.folderDirs(folders, assigned as never);
  const taken = new Set<string>([code.nameKey('README')]);
  const names = new Map<string, string>();
  for (const entry of entries) {
    const name = code.uniqueName(code.noteName(entry.title), entry.id, (key) => taken.has(key));
    taken.add(code.nameKey(name));
    names.set(entry.id, name);
  }
  const paths = new Map<string, string>();
  for (const entry of entries) {
    const dir = entry.folderId === null ? '' : (dirs.get(entry.folderId) ?? '');
    paths.set(entry.id, code.notePath(dir, names.get(entry.id)!));
  }

  const notes: MirrorGolden['notes'] = [];
  const files: Record<string, string[]> = {};
  for (const [i, entry] of entries.entries()) {
    const doc = docs.get(entry.id)!;
    const path = paths.get(entry.id)!;
    const links: LinkResolver = {
      resolve: () => null,
      linkText: (id) => names.get(id) ?? null,
      title: (id) => (docs.has(id) ? entries.find((e) => e.id === id)!.title : null),
    };
    const prefix = code.assetPrefix(path);
    const assetUrl = (url: string) => {
      const file = code.localAttachment(url);
      return file ? `${prefix}attachments/${file.sha256}.${file.ext}` : url;
    };
    // Some notes were never edited after their creation (changedAt 0: `updated` is `created`).
    const changedAt = i % 5 === 0 ? 0 : Date.UTC(2026, 9, 20, 12, i, i);
    const state = code.readNoteState(doc);
    const rendered = code.renderNote(state as never, entry.id, changedAt, { links, assetUrl });
    notes.push({
      id: entry.id,
      path,
      sha: await code.gitTextSha(rendered.markdown),
      markdown: rendered.markdown,
    });
    const used = code.attachmentFiles(code.noteBody(doc) as never);
    if (used.length > 0) files[entry.id] = used.map((file) => `${file.sha256}.${file.ext}`);
  }

  const nameCases: MirrorGolden['names'] = {};
  for (const [i, title] of AWKWARD.entries()) {
    nameCases[title || '(empty)'] = {
      sanitized: code.sanitizeName(title),
      note: code.noteName(title),
      // Taken plain and with the short suffix: the longer suffix (never the random fallback).
      unique: code.uniqueName(code.noteName(title), fixedId('U', i), (key) =>
        [code.noteName(title), `${code.noteName(title)} (${fixedId('U', i).slice(-7)})`]
          .map(code.nameKey)
          .includes(key),
      ),
    };
  }
  const periodic: Record<string, string> = {};
  for (const day of ['2026-01-01', '2026-10-22', '2026-12-31', '2027-02-28']) {
    periodic[`daily:${day}`] = code.periodicNoteId('daily', day);
  }
  for (const week of ['2026-W01', '2026-W43', '2026-W53']) {
    periodic[`weekly:${week}`] = code.periodicNoteId('weekly', week);
  }
  for (const path of ['Journal', 'Journal/2026', 'Journal/2026/10', 'Journal/2026/Weekly']) {
    periodic[`folder:${path}`] = code.journalFolderId(path);
  }
  const periodicUpdates: Record<string, string> = {};
  const templates = [
    '## Plan\n\n## Notes\n',
    '## {{longDate}}\n\n- [ ] Plan the day\n\nNotes for {{weekday}}.',
  ];
  for (const [t, template] of templates.entries()) {
    for (const [kind, period] of [
      ['daily', '2026-10-22'],
      ['weekly', '2026-W43'],
    ] as const) {
      const note = code.periodicNote({ parseMarkdown }, kind, period, template);
      periodicUpdates[`${kind}:${period}:${t}`] =
        `${note.id} ${createHash('sha256').update(note.update).digest('hex')}`;
    }
  }
  const stamps: Record<string, string> = {};
  for (const like of [
    '2026-10-22T09:15:00-05:00',
    '2026-10-22T09:15:00+05:30',
    '2026-10-22T09:15:00Z',
    null,
    '2026-10-22',
  ]) {
    stamps[String(like)] = code.noteStamp(Date.UTC(2026, 9, 29, 14, 3, 7, 999), like);
  }
  for (const doc of docs.values()) doc.destroy();
  return {
    folders: Object.fromEntries([...dirs].sort(([a], [b]) => (a < b ? -1 : 1))),
    notes,
    names: nameCases,
    periodic,
    periodicUpdates,
    stamps,
    files,
    treeHash: code.textHash(JSON.stringify({ folders, notes: notes.map((note) => note.path) })),
  };
}
