/** new, append, edit, daily, mv and tag: changing notes, attributed to the clone’s writer. */
import { stripInvisible } from '@penmoss/core/invisible';
import { UsageError, type FlagSpec } from '../args';
import type { Command, Context } from '../command';
import { ApiError, CliError } from '../errors';
import { editJson, editTail, named, type EditReply } from '../format';
import { resolveFolder, resolveNote } from '../refs';
import { noteJson, readContent, type NoteContent } from './read';

/** `text` as one shell word (#174 review): single-quoted, so nothing in it is expanded. */
const shellWord = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

const NOTE_HELP =
  'A note is its id or its exact title, ignoring the case of A–Z only; a title several notes share is an error listing their ids.';
const TEXT: FlagSpec = {
  name: 'text',
  type: 'string',
  value: 'markdown',
  description: 'The markdown, inline (instead of - for stdin)',
};

const notePath = (id: string, action = '') => `/api/notes/${encodeURIComponent(id)}${action}`;
const tagName = (tag: string) => tag.trim().replace(/^#/, '');

/** Positionals as `[note] [-]`: the note, and whether `-` (stdin) was given. */
function noteAndDash(context: Context, what: string): { ref: string; dash: boolean } {
  const [ref, dash, extra] = context.positionals;
  if (ref === undefined) throw new UsageError(`missing note`);
  if (dash !== undefined && dash !== '-') {
    throw new UsageError(`unexpected argument “${dash}”: pass ${what} as - (stdin) or --text`);
  }
  if (extra !== undefined) throw new UsageError(`unexpected argument “${extra}”`);
  return { ref, dash: dash === '-' };
}

// --- new ---

export const create: Command = {
  name: 'new',
  summary: 'Create a note',
  usage: ['new [<title>] [-] [--text <markdown>] [--tag <tag>]… [--folder <folder>]'],
  description: [
    'Creates a note with a title, a markdown body (- reads it from stdin, or --text), tags and a folder (its path from the top, such as Projects/Garden, or its id). Prints the new note’s id.',
  ],
  flags: [
    TEXT,
    { name: 'tag', short: 't', type: 'list', value: 'tag', description: 'A tag (repeat for more)' },
    {
      name: 'folder',
      type: 'string',
      value: 'folder',
      description: 'The folder: path or id (default: the top level)',
    },
  ],
  examples: [
    'echo "Buy seeds." | penmoss new "Garden plan" - --tag garden',
    'penmoss new "Ideas" --text "- one" --folder Projects',
  ],
  async run(context) {
    const positionals = [...context.positionals];
    const dash = positionals.at(-1) === '-';
    if (dash) positionals.pop();
    if (positionals.length > 1)
      throw new UsageError(`unexpected argument “${positionals[1]}” (quote a title with spaces)`);
    const title = positionals[0];
    const markdown =
      dash || context.string('text') !== undefined
        ? await context.content({ dash, what: 'body' })
        : '';
    const api = await context.api();
    const folderRef = context.string('folder');
    const folderId = folderRef === undefined ? null : await resolveFolder(api, folderRef);
    const reply = await api.request<EditReply>('POST', '/api/notes', {
      body: {
        ...(title !== undefined ? { title } : {}),
        markdown,
        tags: context.list('tag').map(tagName).filter(Boolean),
        folderId,
      },
    });
    context.emit(
      { id: reply.id, title: title ?? null, created: true, ...editJson(reply) },
      () => `Created ${named(title, reply.id)}${editTail(reply)}`,
    );
  },
};

// --- append ---

export const append: Command = {
  name: 'append',
  summary: 'Add markdown at the end of a note or of a section',
  usage: ['append <note> (- | --text <markdown>) [--heading <heading>]'],
  description: [
    'Adds markdown at the end of the note, or at the end of the section under --heading (e.g. "Log" or "## Log"). Nothing already there changes, so no base version is needed.',
    NOTE_HELP,
  ],
  flags: [
    TEXT,
    {
      name: 'heading',
      type: 'string',
      value: 'heading',
      description: 'Append at the end of this section',
    },
  ],
  examples: ['echo "- Fixed the backup job" | penmoss append "Homelab log" - --heading Log'],
  async run(context) {
    const { ref, dash } = noteAndDash(context, 'the markdown');
    const markdown = await context.content({ dash, what: 'markdown to append' });
    if (!markdown.trim()) throw new UsageError('nothing to append: the markdown is empty');
    const api = await context.api();
    const note = await resolveNote(api, ref);
    const heading = context.string('heading');
    const reply = await sectionErrors(
      api.request<EditReply>('POST', notePath(note.id, '/append'), {
        body: { markdown, ...(heading !== undefined ? { heading } : {}) },
      }),
      note.id,
    );
    context.emit(
      editJson(reply),
      () => `Appended to ${named(note.title, note.id)}${editTail(reply)}`,
    );
  },
};

// --- edit ---

export const edit: Command = {
  name: 'edit',
  summary: 'Replace a section, or find and replace text',
  usage: [
    'edit <note> --section <heading> (- | --text <markdown>) [--mode replace|prepend|append] [--allow-empty] [--base <version>]',
    'edit <note> --replace <old> --with <new> [--all] [--scope text|markdown] [--base <version>]',
  ],
  description: [
    '--section replaces the content under a heading (the heading stays; subsections are part of it) with markdown from stdin (-) or --text; --mode prepend or append inserts at its start or end instead. Stdin is read only with -. Empty markdown, which would clear the section, is refused unless --allow-empty.',
    '--replace finds text and puts --with in its place: it must occur once unless --all. By default it matches prose only, never where links point; --scope markdown matches the raw markdown.',
    'Both read the note first and send its baseVersion, so the edit only goes ahead if what it changes is still as read. Pass --base with the baseVersion an earlier `penmoss cat --json` gave to be safe across the time between reading and editing. If someone changed that part since, nothing is changed: the conflict is printed with the current text and the exit code is 5. Read the note again and redo the edit.',
    NOTE_HELP,
  ],
  flags: [
    {
      name: 'section',
      type: 'string',
      value: 'heading',
      description: 'The heading whose section to replace (e.g. "Plans" or "## Plans")',
    },
    {
      name: 'mode',
      type: 'string',
      value: 'mode',
      description: 'replace (default), prepend or append',
    },
    TEXT,
    {
      name: 'allow-empty',
      type: 'boolean',
      description: 'With --section: let empty markdown clear the section',
    },
    { name: 'replace', type: 'string', value: 'old', description: 'The exact text to find' },
    { name: 'with', type: 'string', value: 'new', description: 'What to put in its place' },
    { name: 'all', type: 'boolean', description: 'Replace every occurrence' },
    {
      name: 'scope',
      type: 'string',
      value: 'scope',
      description: 'text (prose only; default) or markdown',
    },
    {
      name: 'base',
      type: 'integer',
      value: 'version',
      description: 'The baseVersion your edit is based on (default: read now)',
    },
  ],
  examples: [
    'penmoss edit "Trip" --section Plans - < plans.md',
    'penmoss edit "Trip" --replace "Friday" --with "Saturday" --all',
  ],
  async run(context) {
    const section = context.string('section');
    const find = context.string('replace');
    const replacement = context.string('with');
    if ((section === undefined) === (find === undefined)) {
      throw new UsageError('use either --section <heading> or --replace <old> --with <new>');
    }
    if (find !== undefined && replacement === undefined)
      throw new UsageError('--replace needs --with <new>');
    if (find === undefined && replacement !== undefined)
      throw new UsageError('--with goes with --replace');
    if (section !== undefined) {
      for (const flag of ['all', 'scope']) {
        if (context.flags[flag] !== undefined)
          throw new UsageError(`--${flag} goes with --replace`);
      }
    } else {
      for (const flag of ['mode', 'text', 'allow-empty']) {
        if (context.flags[flag] !== undefined)
          throw new UsageError(`--${flag} goes with --section`);
      }
    }
    const { ref, dash } = noteAndDash(context, 'the section’s markdown');
    if (section === undefined && dash) throw new UsageError('- (stdin) goes with --section');
    const mode = context.string('mode') ?? 'replace';
    if (!['replace', 'prepend', 'append'].includes(mode))
      throw new UsageError('--mode must be replace, prepend or append');
    const scope = context.string('scope') ?? 'text';
    if (scope !== 'text' && scope !== 'markdown')
      throw new UsageError('--scope must be text or markdown');
    const markdown =
      section === undefined
        ? null
        : await context.content({ dash, what: 'markdown for the section' });
    if (markdown !== null && !markdown.trim() && !context.bool('allow-empty')) {
      throw new UsageError(
        'the markdown for the section is empty, which would clear it: pass --allow-empty to do that',
      );
    }

    const api = await context.api();
    const note = await readContent(context, ref);
    const baseVersion = context.number('base') ?? note.baseVersion;
    const request =
      section !== undefined
        ? api.request<EditReply>('POST', notePath(note.id, '/section'), {
            body: { heading: section, markdown, mode, baseVersion },
          })
        : api.request<EditReply>('POST', notePath(note.id, '/replace'), {
            body: { find, replace: replacement, all: context.bool('all'), scope, baseVersion },
          });
    const reply = await conflictErrors(
      sectionErrors(
        request,
        note.id,
        find !== undefined && replacement !== undefined
          ? { title: note.title, find, replacement }
          : null,
      ),
      note,
      baseVersion,
    );
    context.emit(editJson(reply), () => `Edited ${named(note.title, note.id)}${editTail(reply)}`);
  },
};

/** Adds what to do next to a heading or text refusal. */
async function sectionErrors<T>(
  request: Promise<T>,
  id: string,
  replacing: {
    readonly title: string | null;
    readonly find: string;
    readonly replacement: string;
  } | null = null,
): Promise<T> {
  try {
    return await request;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const headings = Array.isArray(error.details?.['headings'])
      ? (error.details['headings'] as string[])
      : null;
    if (error.code === 'heading_not_found' || error.code === 'heading_ambiguous') {
      throw withHints(error, [
        headings && headings.length > 0
          ? `The note’s headings: ${headings.join(' | ')}. Name one exactly; "## Plans" picks a level.`
          : 'The note has no headings: append without --heading.',
      ]);
    }
    if (error.code === 'text_ambiguous') {
      throw withHints(error, [
        'Make --replace longer so it occurs once, or add --all to replace every occurrence.',
      ]);
    }
    if (error.code === 'text_not_found') {
      // The title is the note's own property, not its text (#170 F10): say how to change it.
      const title = replacing?.title ?? null;
      if (replacing && title !== null && title.includes(replacing.find)) {
        throw withHints(error, [
          `“${replacing.find}” is in the note’s title, which edit does not change. To change the title: penmoss set-title ${id} ${shellWord(title.split(replacing.find).join(replacing.replacement))}`,
        ]);
      }
      throw withHints(error, [`See the exact text with: penmoss cat ${id} --body`]);
    }
    throw error;
  }
}

/** A 409 printed so a person or an agent can redo the edit on the current text. */
async function conflictErrors<T>(request: Promise<T>, note: NoteContent, base: number): Promise<T> {
  try {
    return await request;
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) throw error;
    const details = error.details ?? {};
    const hints: string[] = ['Nothing was changed.'];
    if (error.code === 'conflict') {
      if (typeof details['base'] === 'string') {
        hints.push(
          `--- in version ${base}, which your edit is based on:`,
          trimEnd(details['base']),
        );
      }
      if (typeof details['current'] === 'string') {
        hints.push('--- now:', trimEnd(details['current']));
      }
      if (details['truncated'] === true) hints.push('(cut at 4,000 characters)');
    }
    if (error.code === 'conflict' || error.code === 'base_unknown') {
      hints.push(
        `Read the note again (penmoss cat ${note.id}) and redo the edit on the current text.`,
      );
    }
    const message = `Conflict: ${error.message} (${error.code}).`;
    throw new ApiError(error.status, error.code, message, error.details, [
      ...error.hints,
      ...hints,
    ]);
  }
}

const trimEnd = (text: string) => text.replace(/\s+$/, '');

function withHints(error: ApiError, hints: readonly string[]): ApiError {
  return new ApiError(error.status, error.code, error.message, error.details, [
    ...error.hints,
    ...hints,
  ]);
}

// --- set-title ---

export const setTitle: Command = {
  name: 'set-title',
  summary: 'Change a note’s title',
  usage: ['set-title <note> <title> [--base <version>]'],
  description: [
    'Gives the note a new title, as Rename does in the apps; its id, links to it by id and its text stay. Its file in the repository is renamed at the next sync. An empty title is refused.',
    'With --base, the change is refused (exit 5) if the note changed since that version (penmoss cat <note> --json shows it).',
    NOTE_HELP,
  ],
  flags: [
    {
      name: 'base',
      type: 'integer',
      value: 'version',
      description: 'Refuse if the note changed since this version',
    },
  ],
  examples: [
    'penmoss set-title "Garden plan" "Garden plan 2027"',
    'penmoss set-title 01J… "Ideas"',
  ],
  async run(context) {
    const [ref, title, extra] = context.positionals;
    if (ref === undefined) throw new UsageError('missing note');
    if (title === undefined) throw new UsageError('missing title (quote a title with spaces)');
    if (extra !== undefined) {
      throw new UsageError(`unexpected argument “${extra}” (quote a title with spaces)`);
    }
    // Only bidi or format characters is empty too (#174 review).
    if (stripInvisible(title).trim() === '') throw new UsageError('the title must not be empty');
    const api = await context.api();
    const note = await resolveNote(api, ref);
    const base = context.number('base');
    const reply = await api.request<EditReply>('PATCH', notePath(note.id, '/properties'), {
      body: { title, ...(base !== undefined ? { baseVersion: base } : {}) },
    });
    context.emit(
      { ...editJson(reply), title },
      () => `Retitled ${named(note.title, note.id)} to “${title}”${editTail(reply)}`,
    );
  },
};

// --- daily ---

interface Daily extends NoteContent {
  readonly kind: 'daily' | 'weekly';
  readonly date?: string;
  readonly week?: string;
  readonly timeZone: string;
  readonly created: boolean;
  readonly restoredFromTrash?: boolean;
}

export const daily: Command = {
  name: 'daily',
  summary: 'Print today’s daily note, or append to it',
  usage: [
    'daily [--date <YYYY-MM-DD>] [--weekly] [--body]',
    'daily --append (- | <markdown>) [--heading <heading>] [--date <YYYY-MM-DD>] [--weekly]',
  ],
  description: [
    'Gets today’s daily note (“today” in your time zone setting), creating it from your template and filing it under Journal as the apps do if no device has yet, and prints its markdown (--body: without frontmatter).',
    '--append adds markdown at its end, or at the end of the section under --heading; --append - reads it from stdin. --date picks another day; --weekly the weekly note of the week holding it.',
  ],
  flags: [
    {
      name: 'append',
      type: 'string',
      value: 'markdown',
      description: 'Append this markdown; - reads it from stdin',
    },
    {
      name: 'heading',
      type: 'string',
      value: 'heading',
      description: 'With --append: at the end of this section',
    },
    {
      name: 'date',
      type: 'string',
      value: 'YYYY-MM-DD',
      description: 'Another day (default: today)',
    },
    { name: 'weekly', type: 'boolean', description: 'The weekly note instead' },
    { name: 'body', type: 'boolean', description: 'Print only the body, without frontmatter' },
  ],
  examples: [
    'echo "- Shipped the CLI" | penmoss daily --append -',
    'penmoss daily --append "Call the vet" --heading Tasks',
    'penmoss daily --date 2026-10-01 --body',
  ],
  async run(context) {
    context.args([]);
    const date = context.string('date');
    if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw new UsageError('--date must be YYYY-MM-DD');
    const appendArg = context.string('append');
    const heading = context.string('heading');
    if (appendArg === undefined && heading !== undefined)
      throw new UsageError('--heading goes with --append');
    if (appendArg !== undefined && context.bool('body'))
      throw new UsageError('--body goes without --append');
    const markdown = appendArg === '-' ? await context.io.stdin.read() : appendArg;
    if (markdown !== undefined && !markdown.trim())
      throw new UsageError('nothing to append: the markdown is empty');

    const api = await context.api();
    const kind = context.bool('weekly') ? 'weekly' : 'daily';
    const note = await api.request<Daily>('POST', '/api/daily', {
      body: { period: kind, ...(date !== undefined ? { date } : {}) },
    });
    const period = note.kind === 'daily' ? { date: note.date } : { week: note.week };
    const label = note.kind === 'daily' ? `daily note ${note.date}` : `weekly note ${note.week}`;
    if (markdown === undefined) {
      if (note.created && !context.json) context.note(`(Created the ${label} from your template.)`);
      context.emit(
        noteJson(note, {
          kind: note.kind,
          ...period,
          timeZone: note.timeZone,
          created: note.created,
          ...(note.restoredFromTrash ? { restoredFromTrash: true } : {}),
        }),
        () => (context.bool('body') ? note.body : note.markdown),
      );
      return;
    }
    const reply = await sectionErrors(
      api.request<EditReply>('POST', notePath(note.id, '/append'), {
        // No base, as `append` sends none (A170): adding at the end changes nothing already
        // there, and a base would refuse it whenever the section changed since the read above.
        body: { markdown, ...(heading !== undefined ? { heading } : {}) },
      }),
      note.id,
    );
    context.emit(
      { ...editJson(reply), kind: note.kind, ...period, created: note.created },
      () =>
        `Appended to ${label} (${note.id})${editTail(reply)}${note.created ? ' · created from your template' : ''}`,
    );
  },
};

// --- mv ---

export const mv: Command = {
  name: 'mv',
  summary: 'Move a note, or a folder, to a folder',
  usage: ['mv <note> <folder>', 'mv --folder <folder> <folder>'],
  description: [
    'Moves the note into a folder: its path from the top (Projects/Garden, ignoring case), its id, or / for the top level. The folder must exist: mv does not create folders (penmoss mkdir does). The note keeps its id and links.',
    'With --folder the first argument is a folder, moved with everything in it; a folder cannot move into itself or one of its subfolders.',
    NOTE_HELP,
  ],
  flags: [{ name: 'folder', type: 'boolean', description: 'Move a folder rather than a note' }],
  examples: [
    'penmoss mv "Garden plan" Projects/Garden',
    'penmoss mv "Garden plan" /',
    'penmoss mv --folder Projects/Garden Archive',
  ],
  async run(context) {
    const [ref, folderRef] = context.args(['note', 'folder']);
    const api = await context.api();
    if (context.bool('folder')) {
      const id = await resolveFolder(api, ref!);
      if (id === null) throw new UsageError('the top level is not a folder to move');
      const parentId = await resolveFolder(api, folderRef!);
      const reply = await api.request<{ id: string; parentId: string | null }>(
        'PATCH',
        `/api/folders/${encodeURIComponent(id)}`,
        { body: { parentId } },
      );
      context.emit(
        { id: reply.id, parentId: reply.parentId },
        () => `Moved ${ref} to ${parentId === null ? 'the top level' : folderRef!}.`,
      );
      return;
    }
    const note = await resolveNote(api, ref!);
    let folderId: string | null;
    try {
      folderId = await resolveFolder(api, folderRef!);
    } catch (error) {
      if (!(error instanceof CliError && error.code === 'folder_not_found')) throw error;
      throw new CliError(error.exitCode, error.message, error.code, error.details, [
        ...error.hints,
        'mv does not create folders: make it with penmoss mkdir (or move the note to an existing one).',
      ]);
    }
    const reply = await api.request<{ id: string; folderId: string | null }>(
      'POST',
      notePath(note.id, '/move'),
      {
        body: { folderId },
      },
    );
    context.emit(
      reply,
      () =>
        `Moved ${named(note.title, note.id)} to ${folderId === null ? 'the top level' : folderRef!}.`,
    );
  },
};

// --- trash (T42, A566) ---

export const trash: Command = {
  name: 'trash',
  summary: 'Move a note to Trash',
  usage: ['trash <note>'],
  description: [
    'Moves the note to the notebook’s Trash, as deleting it in the apps does: it leaves its folder, keeps its content and history, and can be restored in the apps or with penmoss restore. History shows the change under this clone’s writer. A note already in Trash stays there. Nothing deletes a note for good from the CLI: only you can, in the apps.',
    NOTE_HELP,
  ],
  flags: [],
  examples: ['penmoss trash "Old idea"'],
  async run(context) {
    const [ref] = context.args(['note']);
    const api = await context.api();
    const note = await resolveNote(api, ref!);
    // Idempotent (a note already in Trash answers as it was), so asking twice is safe.
    // The reply is trash_note's: deletedAt in ISO 8601, as every time --json prints.
    const reply = await api.request<{
      id: string;
      inTrash: true;
      alreadyInTrash: boolean;
      deletedAt: string;
      folderId: string | null;
    }>('POST', notePath(note.id, '/trash'), { body: {} });
    context.emit(reply, () =>
      reply.alreadyInTrash
        ? `${named(note.title, note.id)} was in Trash already.`
        : `Moved ${named(note.title, note.id)} to Trash. Restore it with penmoss restore, or in the app’s Trash.`,
    );
  },
};

// --- tag ---

export const tag: Command = {
  name: 'tag',
  summary: 'Add or remove tags on a note',
  usage: ['tag <note> [<tag>…] [--remove <tag>]…'],
  description: [
    'Adds the tags given after the note (with or without #) and removes those given with --remove, in the note’s properties. Tags nest with /, e.g. projects/garden. #tags written in the text stay.',
    NOTE_HELP,
  ],
  flags: [
    {
      name: 'remove',
      type: 'list',
      value: 'tag',
      description: 'A tag to remove (repeat for more)',
    },
  ],
  examples: ['penmoss tag "Garden plan" garden projects/2027 --remove someday'],
  async run(context) {
    const [ref, ...added] = context.positionals;
    if (ref === undefined) throw new UsageError('missing note');
    const add = added.map(tagName).filter(Boolean);
    const remove = context.list('remove').map(tagName).filter(Boolean);
    if (add.length === 0 && remove.length === 0)
      throw new UsageError('give tags to add, or --remove <tag>');
    const api = await context.api();
    const note = await resolveNote(api, ref);
    const reply = await api.request<EditReply>('POST', notePath(note.id, '/tags'), {
      body: { add, remove },
    });
    const change = [...add.map((each) => `+#${each}`), ...remove.map((each) => `-#${each}`)].join(
      ' ',
    );
    context.emit(
      editJson(reply),
      () => `Tagged ${named(note.title, note.id)}: ${change}${editTail(reply)}`,
    );
  },
};
