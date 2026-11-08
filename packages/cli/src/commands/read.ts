/** search, cat, ls, open and history: reading notes. */
import { UsageError } from '../args';
import type { Command, Context } from '../command';
import { ApiError, CliError, EXIT } from '../errors';
import { dim, highlight, iso, markdownMarks, named, when } from '../format';
import { listFolder, resolveFolder, resolveNote } from '../refs';

const NOTE = 'note';
/** The most `ls --recent` lists (A175); the API allows 5,000, more than a terminal can use. */
const MAX_RECENT = 500;
const NOTE_HELP =
  'A note is its id or its exact title, ignoring the case of A–Z only; a title several notes share is an error listing their ids.';

// --- search ---

interface SearchHit {
  readonly id: string;
  readonly title: string;
  readonly titleHighlighted: string;
  readonly snippet: string;
  readonly heading: string | null;
  readonly tags: string[];
  readonly updatedAt: number;
  readonly sources: string[];
}

const MODES = ['hybrid', 'full-text', 'semantic'];

/** A date (2026-10-01) or time as epoch ms, for the search filters. */
function epoch(context: Context, flag: string): number | undefined {
  const value = context.string(flag);
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new UsageError(`--${flag} must be a date such as 2026-10-01`);
  return ms;
}

export const search: Command = {
  name: 'search',
  summary: 'Search notes by their words and their meaning',
  usage: [
    'search <query…> [--mode hybrid|full-text|semantic] [--tag <tag>] [--folder <folder>] [--after <date>] [--before <date>] [--limit <n>]',
  ],
  description: [
    'Searches the notes on this machine. hybrid (the default) finds notes by their words and by their meaning: notes about what you mean, in other words. full-text matches words only ("a phrase", prefix*, -excluded and title:word), and semantic by meaning alone.',
    'Search by meaning needs its model on this Mac (penmoss models fetch, or the app’s Settings → Search by Meaning). Without it hybrid is words only and says so, and semantic is refused (exit 7). While notes are still being indexed, results say how many notes meaning covers so far.',
    'Each result shows the note id, title, when it was last updated, its tags and a snippet with the matches.',
  ],
  flags: [
    {
      name: 'mode',
      type: 'string',
      value: 'mode',
      description: 'hybrid (default: words and meaning), full-text (words) or semantic (meaning)',
    },
    {
      name: 'tag',
      type: 'string',
      value: 'tag',
      description: 'Only notes with this tag (nested tags included)',
    },
    {
      name: 'folder',
      type: 'string',
      value: 'folder',
      description: 'Only notes in this folder (path or id) and its subfolders',
    },
    {
      name: 'after',
      type: 'string',
      value: 'date',
      description: 'Only notes edited after this date or time',
    },
    {
      name: 'before',
      type: 'string',
      value: 'date',
      description: 'Only notes edited before this date or time',
    },
    {
      name: 'limit',
      type: 'integer',
      value: 'n',
      description: 'At most this many results (default 10, up to 50)',
    },
  ],
  examples: [
    'penmoss search proxmox upgrade',
    'penmoss search "garden plan" --mode full-text --json',
    'penmoss search how do I keep the servers running in a blackout --mode semantic',
  ],
  async run(context) {
    const query = context.positionals.join(' ').trim();
    if (!query) throw new UsageError('missing query');
    const mode = context.string('mode') ?? 'hybrid';
    if (!MODES.includes(mode)) throw new UsageError('--mode must be hybrid, full-text or semantic');
    const limit = context.number('limit') ?? 10;
    if (limit > 50) throw new UsageError('--limit must be at most 50');
    const after = epoch(context, 'after');
    const before = epoch(context, 'before');
    if (mode !== 'full-text') await context.notebook?.useMeaning?.();
    const api = await context.api();
    const folderRef = context.string('folder');
    const folder = folderRef === undefined ? undefined : await resolveFolder(api, folderRef);
    const found = await api.get<{ mode: string; results: SearchHit[]; notice?: string }>(
      '/api/search',
      {
        q: query,
        mode,
        limit,
        tag: context.string('tag')?.replace(/^#/, ''),
        folder: folder ?? undefined,
        after,
        before,
      },
    );
    if (found.notice && !context.json) context.note(found.notice);
    context.emit(
      {
        mode: found.mode,
        results: found.results.map((hit) => ({
          id: hit.id,
          title: hit.title,
          snippet: markdownMarks(hit.snippet),
          ...(hit.heading ? { heading: hit.heading } : {}),
          tags: hit.tags,
          updatedAt: iso(hit.updatedAt),
          foundBy: hit.sources,
        })),
        ...(found.notice ? { notice: found.notice } : {}),
      },
      () => {
        if (found.results.length === 0) return `No notes found for “${query}”.`;
        const { color } = context;
        return found.results.flatMap((hit) => {
          const tags = hit.tags.length > 0 ? `  ${hit.tags.map((tag) => `#${tag}`).join(' ')}` : '';
          const lines = [
            `${hit.id}  ${highlight(hit.titleHighlighted || hit.title, color)}  ${dim(when(hit.updatedAt), color)}${tags}`,
          ];
          const snippet = highlight(hit.snippet, color).replace(/\s+/g, ' ').trim();
          if (hit.heading) lines.push(`    ${dim(`§ ${hit.heading}`, color)}`);
          if (snippet) lines.push(`    ${snippet}`);
          return lines;
        });
      },
    );
  },
};

// --- cat ---

/** `GET /api/notes/:id/content` (A121). */
export interface NoteContent {
  readonly id: string;
  readonly title: string;
  readonly tags: string[];
  readonly markdown: string;
  readonly body: string;
  readonly headings: string[];
  readonly baseVersion: number;
  readonly deleted: boolean;
}

/** A note as `cat --json` and `daily --json` give it. */
export const noteJson = (note: NoteContent, extra: Record<string, unknown> = {}) => ({
  id: note.id,
  title: note.title,
  tags: note.tags,
  headings: note.headings,
  baseVersion: note.baseVersion,
  ...(note.deleted ? { deleted: true } : {}),
  ...extra,
  markdown: note.markdown,
  body: note.body,
});

export async function readContent(context: Context, ref: string): Promise<NoteContent> {
  const api = await context.api();
  const note = await resolveNote(api, ref);
  try {
    return await api.get<NoteContent>(`/api/notes/${encodeURIComponent(note.id)}/content`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new CliError(EXIT.NOT_FOUND, `No note with id ${note.id}.`, 'not_found', undefined, [
        'Find notes with penmoss search or penmoss ls --recent.',
      ]);
    }
    throw error;
  }
}

export const cat: Command = {
  name: 'cat',
  summary: 'Print a note’s markdown',
  usage: ['cat <note> [--body]'],
  description: [
    'Prints the note’s markdown, with its frontmatter, as the apps export it and the notebook renders it in its repository. --body leaves the frontmatter out.',
    `${NOTE_HELP} With --json: the id, title, tags, headings, baseVersion (pass it to edit --base), markdown and body.`,
  ],
  flags: [{ name: 'body', type: 'boolean', description: 'Only the body, without frontmatter' }],
  examples: ['penmoss cat "Garden plan"', 'penmoss cat 01JB8Y0V5TQ0QW8KZ9C7N3F2XA --json'],
  async run(context) {
    const [ref] = context.args([NOTE]);
    const note = await readContent(context, ref!);
    if (note.deleted && !context.json) context.note(`(“${note.title}” is in Trash.)`);
    context.emit(noteJson(note), () => (context.bool('body') ? note.body : note.markdown));
  },
};

// --- ls ---

interface Listed {
  readonly id: string;
  readonly title: string;
  readonly kind?: string;
  readonly tags?: string[];
  readonly excerpt?: string;
  readonly updatedAt: number;
}

const NOTE_ROW = (id: string, title: string | null, updatedAt: number | null, color: boolean) =>
  `${id.padEnd(26)}  ${title ?? '(untitled)'}  ${dim(when(updatedAt), color)}`;

export const ls: Command = {
  name: 'ls',
  summary: 'List a folder, recent notes or tags',
  usage: ['ls [<folder>]', 'ls --recent [--limit <n>]', 'ls --tags', 'ls --tag <tag>'],
  description: [
    'Lists a folder’s subfolders and notes in app order: the top level, or a folder by its path from the top (Projects/Garden, ignoring case) or its id.',
    '--recent lists the most recently edited notes; --tags every tag with its note count; --tag the notes with a tag (nested tags included).',
  ],
  flags: [
    { name: 'recent', type: 'boolean', description: 'The most recently edited notes' },
    {
      name: 'limit',
      type: 'integer',
      value: 'n',
      description: `With --recent: at most this many (default 20, up to ${MAX_RECENT})`,
    },
    { name: 'tags', type: 'boolean', description: 'Every tag with its note count' },
    { name: 'tag', type: 'string', value: 'tag', description: 'The notes with this tag' },
  ],
  examples: [
    'penmoss ls',
    'penmoss ls Journal/2026',
    'penmoss ls --recent --limit 5',
    'penmoss ls --tag homelab',
  ],
  async run(context) {
    const modes = ['recent', 'tags', 'tag'].filter((flag) => context.flags[flag] !== undefined);
    if (modes.length > 1) throw new UsageError('use one of --recent, --tags and --tag');
    if (context.number('limit') !== undefined && !context.bool('recent')) {
      throw new UsageError('--limit goes with --recent');
    }
    if ((context.number('limit') ?? 0) > MAX_RECENT) {
      throw new UsageError(`--limit must be at most ${MAX_RECENT}`);
    }
    const { color } = context;
    const api = await context.api();
    if (context.bool('recent')) {
      context.args([]);
      const limit = context.number('limit') ?? 20;
      const { notes } = await api.get<{ notes: Listed[] }>('/api/notes', { limit });
      context.emit(
        {
          notes: notes.map((note) => ({
            id: note.id,
            title: note.title,
            kind: note.kind,
            tags: note.tags,
            excerpt: note.excerpt,
            updatedAt: iso(note.updatedAt),
          })),
        },
        () => notes.map((note) => NOTE_ROW(note.id, note.title, note.updatedAt, color)),
      );
      return;
    }
    if (context.bool('tags')) {
      context.args([]);
      const { tags } = await api.get<{ tags: Array<{ name: string; notes: number }> }>('/api/tags');
      context.emit({ tags }, () =>
        tags.length > 0
          ? tags.map((tag) => `#${tag.name}  ${dim(String(tag.notes), color)}`)
          : 'No tags yet.',
      );
      return;
    }
    const tag = context.string('tag');
    if (tag !== undefined) {
      context.args([]);
      const listed = await api.get<{ tag: string; notes: Listed[] }>('/api/tags', {
        tag: tag.replace(/^#/, ''),
      });
      context.emit(
        {
          tag: listed.tag,
          notes: listed.notes.map((note) => ({
            id: note.id,
            title: note.title,
            updatedAt: iso(note.updatedAt),
          })),
        },
        () =>
          listed.notes.length > 0
            ? listed.notes.map((note) => NOTE_ROW(note.id, note.title, note.updatedAt, color))
            : `No notes tagged #${listed.tag}.`,
      );
      return;
    }
    const [ref] = context.args(['folder'], 1);
    const listing = await listFolder(api, ref);
    context.emit(
      {
        folder: listing.folder,
        folders: listing.folders,
        notes: listing.notes.map((note) => ({ ...note, updatedAt: iso(note.updatedAt) })),
        ...(listing.truncated ? { truncated: true } : {}),
      },
      () => {
        const lines = [
          // A notebook says so (T43): its notes are mirrored to a repository of its own.
          ...listing.folders.map(
            (folder) =>
              `${folder.id.padEnd(26)}  ${folder.name}/${folder.isNotebook ? dim('  notebook', color) : ''}`,
          ),
          ...listing.notes.map((note) => NOTE_ROW(note.id, note.title, note.updatedAt, color)),
        ];
        if (listing.truncated) lines.push('… (more notes not shown)');
        return lines.length > 0
          ? lines
          : `${listing.folder ? listing.folder.path : 'The top level'} is empty.`;
      },
    );
  },
};

// --- open ---

export const open: Command = {
  name: 'open',
  summary: 'Print, or open, the note’s penmoss:// link in Penmoss for Mac',
  usage: ['open <note> [--print]'],
  description: [
    'Prints the note’s penmoss://note/<id> link and opens it, which shows the note in Penmoss for Mac. With --print or --json it only prints it (agents: use one of them).',
    NOTE_HELP,
  ],
  flags: [{ name: 'print', type: 'boolean', description: 'Only print the link' }],
  async run(context) {
    const [ref] = context.args([NOTE]);
    const note = await resolveNote(await context.api(), ref!);
    // The Mac app's deep link (apps/desktop/src/deep-link.ts): it opens /notes/<id>.
    const url = `penmoss://note/${encodeURIComponent(note.id)}`;
    const shouldOpen = !context.bool('print') && !context.json;
    const opened = shouldOpen ? await context.io.openUrl(url) : false;
    context.emit({ id: note.id, url, opened }, () => url);
  },
};

// --- history ---

interface Author {
  readonly label: string;
  readonly kind: string;
}

interface History {
  readonly versions: Array<{
    id: number;
    createdAt: number;
    reason: string;
    summary: string;
    authors: Author[];
  }>;
  readonly unversioned: { authors: Author[]; since: number } | null;
}

interface VersionDetail {
  readonly id: number;
  readonly previousId: number | null;
  readonly markdown: string;
  readonly diff: Array<{ op: 'same' | 'add' | 'remove'; line: string }>;
}

export const history: Command = {
  name: 'history',
  summary: 'List a note’s versions, or show one',
  usage: [
    'history <note> [--limit <n>]',
    'history <note> --version <id>',
    'history <note> --save',
    'history <note> --restore <id>',
    'history <note> --revert <id>',
  ],
  description: [
    'Lists the note’s versions, newest first: id, time, authors (devices and agents by name), and what changed. Agents’ versions are marked ✦. A version is a commit that touched the note (A858).',
    `--version shows that version’s lines added (+) and removed (-) since the version before it; with --json also its markdown. ${NOTE_HELP}`,
    '--save makes a version of the note as it is now (each sync that sends a change makes one too). --restore brings back a version’s content as a new change; --revert undoes what one version changed and keeps later edits, listing any part it could not undo. Both can be undone the same way.',
  ],
  flags: [
    { name: 'version', type: 'integer', value: 'id', description: 'Show this version' },
    { name: 'save', type: 'boolean', description: 'Save a version of the note now' },
    { name: 'restore', type: 'integer', value: 'id', description: 'Restore this version' },
    { name: 'revert', type: 'integer', value: 'id', description: 'Undo what this version changed' },
    {
      name: 'limit',
      type: 'integer',
      value: 'n',
      description: 'At most this many versions (default 20)',
    },
  ],
  async run(context) {
    const [ref] = context.args([NOTE]);
    const api = await context.api();
    const note = await resolveNote(api, ref!);
    const base = `/api/notes/${encodeURIComponent(note.id)}/versions`;
    const restoreId = context.number('restore');
    const revertId = context.number('revert');
    const actions = [context.bool('save'), restoreId !== undefined, revertId !== undefined];
    if (actions.filter(Boolean).length + (context.number('version') === undefined ? 0 : 1) > 1) {
      throw new UsageError('give one of --version, --save, --restore and --revert');
    }
    if (context.bool('save')) {
      const version = await api.request<{ id: number; summary: string }>('POST', base, {
        body: {},
      });
      context.emit(
        { id: note.id, version },
        () => `Saved version ${version.id} of ${named(note.title, note.id)}.`,
      );
      return;
    }
    const changeId = restoreId ?? revertId;
    if (changeId !== undefined) {
      const what = restoreId !== undefined ? 'restore' : 'revert';
      let reply: { changed: boolean; conflicts?: Array<{ part: string }> };
      try {
        reply = await api.request('POST', `${base}/${changeId}/${what}`, { body: {} });
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          throw new CliError(
            EXIT.NOT_FOUND,
            `No version ${changeId} of ${named(note.title, note.id)}.`,
            'not_found',
            undefined,
            [`List its versions with: penmoss history ${note.id}`],
          );
        }
        throw error;
      }
      const conflicts = reply.conflicts ?? [];
      context.emit({ id: note.id, versionId: changeId, ...reply }, () => [
        !reply.changed
          ? `${named(note.title, note.id)} already ${what === 'restore' ? 'matches' : 'lacks the changes of'} version ${changeId}.`
          : what === 'restore'
            ? `Restored version ${changeId} of ${named(note.title, note.id)} as a new change.`
            : `Reverted version ${changeId} of ${named(note.title, note.id)}.`,
        ...(conflicts.length > 0
          ? [
              `${conflicts.length} part${conflicts.length === 1 ? '' : 's'} changed since could not be undone.`,
            ]
          : []),
      ]);
      return;
    }
    const versionId = context.number('version');
    if (versionId !== undefined) {
      let detail: VersionDetail;
      try {
        detail = await api.get<VersionDetail>(`${base}/${versionId}`);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          throw new CliError(
            EXIT.NOT_FOUND,
            `No version ${versionId} of ${named(note.title, note.id)}.`,
            'not_found',
            undefined,
            [`List its versions with: penmoss history ${note.id}`],
          );
        }
        throw error;
      }
      const changes = detail.diff
        .filter((op) => op.op !== 'same')
        .map((op) => `${op.op === 'add' ? '+' : '-'} ${op.line}`);
      context.emit(
        {
          id: note.id,
          versionId: detail.id,
          previousId: detail.previousId,
          markdown: detail.markdown,
          changes,
        },
        () => [
          `Version ${detail.id} of ${named(note.title, note.id)}${detail.previousId ? `, against version ${detail.previousId}` : ''}:`,
          ...(changes.length > 0 ? changes : ['(no changed lines)']),
        ],
      );
      return;
    }
    const limit = context.number('limit') ?? 20;
    const listed = await api.get<History>(base);
    if (listed.versions.length === 0 && !listed.unversioned) {
      throw new CliError(EXIT.NOT_FOUND, `No note with id ${note.id}.`, 'not_found');
    }
    const labels = (authors: readonly Author[]) => authors.map((author) => author.label);
    const versions = listed.versions.slice(0, limit);
    const { color } = context;
    context.emit(
      {
        id: note.id,
        versions: versions.map((version) => ({
          id: version.id,
          createdAt: iso(version.createdAt),
          reason: version.reason,
          summary: version.summary,
          authors: labels(version.authors),
        })),
        unversioned: listed.unversioned
          ? { since: iso(listed.unversioned.since), authors: labels(listed.unversioned.authors) }
          : null,
        ...(listed.versions.length > limit ? { more: true } : {}),
      },
      () => {
        const authorText = (authors: readonly Author[]) =>
          authors
            .map((author) => (author.kind === 'agent' ? `✦ ${author.label}` : author.label))
            .join(', ');
        const lines = [`Versions of ${named(note.title, note.id)}, newest first:`];
        if (listed.unversioned) {
          lines.push(
            `  ${'now'.padStart(6)}  ${dim(`unsaved changes since ${when(listed.unversioned.since)}`, color)}  ${authorText(listed.unversioned.authors)}`,
          );
        }
        for (const version of versions) {
          lines.push(
            `  ${String(version.id).padStart(6)}  ${when(version.createdAt)}  ${authorText(version.authors)}  ${dim(version.summary || version.reason, color)}`,
          );
        }
        if (listed.versions.length > limit)
          lines.push(`  … ${listed.versions.length - limit} older (--limit)`);
        return lines;
      },
    );
  },
};
