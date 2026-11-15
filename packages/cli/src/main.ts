/**
 * `penmoss <command> [options]`: dispatch, help and errors. `run` returns
 * the exit code and never throws; it touches the world only through `io`.
 *
 * Every note command runs on a git notebook (T59, A1050): the one `--notebook` names, else the
 * only one on this machine.
 */
import { notebookTag, parseNoteRef } from '@penmoss/core/note-ref';
import { parseArgs, UsageError, type FlagSpec, type FlagValue } from './args';
import { Context, type Command } from './command';
import { cat, history, ls, open, search } from './commands/read';
import { mkdir, rename, rmdir, sort } from './commands/folders';
import { attach, restore, retag, settings } from './commands/workspace';
import { append, create, daily, edit, mv, setTitle, tag, trash } from './commands/write';
import { mcp, notebook } from './commands/notebook';
import { models } from './commands/models';
import { CliError, EXIT } from './errors';
import type { Io, NotebookIo } from './io';
import { VERSION } from './version';

export const COMMANDS: readonly Command[] = [
  search,
  cat,
  create,
  append,
  edit,
  daily,
  ls,
  mv,
  trash,
  restore,
  tag,
  setTitle,
  retag,
  attach,
  mkdir,
  rename,
  rmdir,
  sort,
  open,
  history,
  settings,
  notebook,
  mcp,
  models,
];

/**
 * The commands that run on a git notebook (T50 G2, #150; T59, A1050): locally, then one sync
 * (reads sync first, so they show the latest; changes sync after, so they are pushed).
 */
export const NOTEBOOK_COMMANDS: ReadonlySet<string> = new Set([
  'search',
  'cat',
  'new',
  'append',
  'edit',
  'daily',
  'ls',
  'mv',
  'trash',
  'restore',
  'tag',
  'set-title',
  'retag',
  'attach',
  'mkdir',
  'rename',
  'rmdir',
  'sort',
  'settings',
  // G6 (A858): versions are the commits that touched the note.
  'history',
  'open',
]);
/** Reads sync first only; every other command syncs before its change too, and after it. */
const SYNC_FIRST: ReadonlySet<string> = new Set(['search', 'cat', 'ls', 'open']);

const NOTEBOOK_FLAGS: readonly FlagSpec[] = [
  {
    name: 'notebook',
    type: 'string',
    value: 'name',
    description: 'The git notebook to run on (see penmoss notebook); default: the only one',
  },
  {
    name: 'no-sync',
    type: 'boolean',
    description: 'Do not sync with the notebook’s repository this time',
  },
];

const flagsOf = (command: Command): readonly FlagSpec[] =>
  NOTEBOOK_COMMANDS.has(command.name) ? [...command.flags, ...NOTEBOOK_FLAGS] : command.flags;

const GLOBAL_FLAGS: readonly FlagSpec[] = [
  {
    name: 'json',
    type: 'boolean',
    description: 'Print one JSON document (errors as JSON on stderr)',
  },
  { name: 'help', short: 'h', type: 'boolean', description: 'Show help' },
];

const EXIT_HELP = [
  '  0  done',
  '  1  unexpected failure: git failed, or the repository’s host could not be reached',
  '  2  the command line does not fit the command, or no notebook was named where one must be',
  '  3  not allowed (403), the host refused the credentials, or they are unsafe to read',
  '  4  no such note, folder, heading, text, version or notebook',
  '  5  conflict: the note changed since the version the edit is based on (409)',
  '  6  ambiguous: a title, heading or text matches more than once',
  '  7  refused for another reason (400, 413, 422, 428), or by the repository’s host',
];

export async function run(argv: readonly string[], io: Io): Promise<number> {
  const [name, ...rest] = argv;
  // JSON errors only for a real --json flag (A173): not a value, nothing after `--`. Until the
  // command line is parsed, only a known command's own parse can say; for anything else, a
  // --json before any `--`.
  const end = rest.indexOf('--');
  let json = (end < 0 ? rest : rest.slice(0, end)).includes('--json');
  try {
    if (name === undefined || name === '--help' || name === '-h' || name === 'help') {
      const topic = name === 'help' ? rest[0] : undefined;
      const command =
        topic === undefined ? undefined : COMMANDS.find((each) => each.name === topic);
      if (topic !== undefined && !command) throw new UsageError(`unknown command “${topic}”`);
      io.stdout.write(command ? commandHelp(command) : mainHelp());
      return EXIT.OK;
    }
    if (name === '--version' || name === '-V') {
      io.stdout.write(`penmoss ${VERSION}\n`);
      return EXIT.OK;
    }
    const command = COMMANDS.find((each) => each.name === name);
    if (!command) {
      throw new UsageError(
        name.startsWith('-')
          ? `put options after the command (got ${name})`
          : `unknown command “${name}”`,
      );
    }
    let parsed;
    try {
      parsed = parseArgs(rest, [...flagsOf(command), ...GLOBAL_FLAGS]);
    } catch (error) {
      json = error instanceof UsageError && error.flags?.['json'] === true;
      throw error;
    }
    json = parsed.flags['json'] === true;
    if (parsed.flags['help'] === true) {
      io.stdout.write(commandHelp(command));
      return EXIT.OK;
    }
    // A note command runs on a git notebook; `notebook` and `mcp` name theirs themselves.
    if (NOTEBOOK_COMMANDS.has(command.name)) {
      const notebooks = notebooksOf(io);
      const name =
        (parsed.flags['notebook'] as string | undefined) ??
        (await notebookOfRefs(notebooks, parsed.positionals)) ??
        (await onlyNotebook(notebooks));
      await onNotebook(io, notebooks, command, name, parsed.positionals, parsed.flags);
      return EXIT.OK;
    }
    await command.run(new Context(io, parsed.positionals, parsed.flags));
    return EXIT.OK;
  } catch (error) {
    return report(io, error, json, name);
  }
}

function notebooksOf(io: Io): NotebookIo {
  if (!io.notebooks) {
    throw new CliError(EXIT.ERROR, 'This penmoss cannot open git notebooks here.', 'unsupported');
  }
  return io.notebooks;
}

/**
 * The notebook a note command runs on without `--notebook` (A1050): the only git notebook on
 * this machine. With none, or several, it is a usage error that names them.
 */
export async function onlyNotebook(notebooks: NotebookIo): Promise<string> {
  const names = (await notebooks.list()).map((entry) => entry.name);
  if (names.length === 1) return names[0]!;
  if (names.length === 0) {
    throw new UsageError(
      'no git notebook on this machine: add one with `penmoss notebook add <remote>` (see `penmoss notebook --help`)',
    );
  }
  throw new UsageError(
    `${names.length} git notebooks are on this machine (${names.join(', ')}): pass --notebook <name>`,
  );
}

/**
 * The notebook a note command runs on without `--notebook` when it names a note by its short
 * reference (PEN-69): the notebook the reference's first 4 characters name, among this machine's
 * (a device's clone before an agent's). Null when no argument is a short reference.
 */
export async function notebookOfRefs(
  notebooks: NotebookIo,
  positionals: readonly string[],
): Promise<string | null> {
  const wanted = positionals
    .map(parseNoteRef)
    .flatMap((ref) => (ref.kind === 'short' ? [ref.notebook] : []))[0];
  if (wanted === undefined) return null;
  const clones = (await notebooks.list()).filter(
    (entry) => entry.notebookId !== undefined && notebookTag(entry.notebookId) === wanted,
  );
  const best = clones.find((entry) => entry.writer.kind === 'device') ?? clones[0];
  if (best) return best.name;
  throw new CliError(
    EXIT.NOT_FOUND,
    `No git notebook on this machine holds ${wanted}-… notes.`,
    'notebook_not_found',
    { notebook: wanted },
    ['List them with penmoss notebook ls, or add one with penmoss notebook add <remote>.'],
  );
}

/** A command on a git notebook (T50): its local API, under the clone's lock, and one sync. */
async function onNotebook(
  io: Io,
  notebooks: NotebookIo,
  command: Command,
  name: string,
  positionals: readonly string[],
  flags: Readonly<Record<string, FlagValue>>,
): Promise<void> {
  const session = await notebooks.session(name, `penmoss ${command.name}`);
  const sync = flags['no-sync'] !== true;
  const reads = SYNC_FIRST.has(command.name);
  const timeoutMs = notebookSyncTimeout(io.env);
  /** The host did not answer in time: the rest goes to a sync in the background (A852). */
  let stalled = false;
  const syncNow = async (when: 'before' | 'after') => {
    try {
      const done = await session.sync({ timeoutMs });
      for (const warning of done.warnings) io.stderr.write(`penmoss: ${warning}\n`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (error instanceof CliError && error.code === 'sync_timeout') stalled = true;
      io.stderr.write(
        when === 'before'
          ? `penmoss: could not sync ${name} (${reason}); ${reads ? 'showing' : 'working on'} what this machine has.\n`
          : `penmoss: saved here, not synced yet (${reason}). It syncs with the next command, or run: penmoss notebook sync ${name}\n`,
      );
      if (error instanceof CliError) for (const hint of error.hints) io.stderr.write(`${hint}\n`);
    }
  };
  try {
    // A change is made on what the branch has, when it can be reached (A821): a profile behind
    // what it pushed (a restored snapshot) catches up before it writes. Bounded (A852): a host
    // that does not answer leaves the change to be made here and synced afterwards.
    if (sync) await syncNow('before');
    await command.run(new Context(io, positionals, flags, session));
    if (sync && !reads && !stalled) await syncNow('after');
  } finally {
    await session.close();
  }
  // Stalled with a change made: a detached sync pushes it once the host answers, so the command
  // (an agent's Bash call) returns now. The change is on disk either way.
  if (sync && !reads && stalled) {
    const detached = io.stdio?.detach?.(
      ['notebook', 'sync', name, '--wait', '120'],
      session.detachedLog,
    );
    io.stderr.write(
      detached
        ? `penmoss: saved here; the sync is pending and runs in the background (log: ${session.detachedLog ?? 'detached-sync.log'}).\n`
        : `penmoss: saved here; the sync is pending. Run: penmoss notebook sync ${name}\n`,
    );
  }
}

/** How long a note command's own sync may wait for the host (A852): 15 s unless set. */
export function notebookSyncTimeout(env: Readonly<Record<string, string | undefined>>): number {
  const seconds = Number(env['PENMOSS_NOTEBOOK_SYNC_TIMEOUT'] ?? '');
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 15_000;
}

function report(io: Io, error: unknown, json: boolean, name: string | undefined): number {
  const known = COMMANDS.some((each) => each.name === name);
  if (error instanceof UsageError) {
    const message = `${error.message}`;
    if (json) {
      io.stderr.write(
        `${JSON.stringify({ error: { code: 'usage', message }, exitCode: EXIT.USAGE })}\n`,
      );
    } else {
      io.stderr.write(
        `penmoss: ${message}\nRun \`penmoss ${known ? `${name} ` : ''}--help\` for usage.\n`,
      );
    }
    return EXIT.USAGE;
  }
  if (error instanceof CliError) {
    if (json) {
      const body = {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
        exitCode: error.exitCode,
      };
      io.stderr.write(`${JSON.stringify(body)}\n`);
    } else {
      io.stderr.write(`penmoss: ${error.message}\n`);
      for (const hint of error.hints) io.stderr.write(`${hint}\n`);
    }
    return error.exitCode;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    io.stderr.write(
      `${JSON.stringify({ error: { code: 'internal', message }, exitCode: EXIT.ERROR })}\n`,
    );
  } else {
    io.stderr.write(`penmoss: ${message}\n`);
  }
  return EXIT.ERROR;
}

// --- help ---

function flagLines(flags: readonly FlagSpec[]): string[] {
  const left = flags.map(
    (flag) =>
      `  ${flag.short ? `-${flag.short}, ` : ''}--${flag.name}${flag.value ? ` <${flag.value}>` : ''}`,
  );
  const width = Math.max(...left.map((each) => each.length)) + 2;
  return flags.map((flag, i) => `${left[i]!.padEnd(width)}${flag.description}`);
}

function mainHelp(): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length)) + 2;
  return [
    'penmoss: search, read and edit the notes in your git notebooks from a terminal or an agent.',
    '',
    'Usage: penmoss <command> [options]',
    '',
    'Commands:',
    ...COMMANDS.map((command) => `  ${command.name.padEnd(width)} ${command.summary}`),
    '',
    'Global options:',
    ...flagLines([
      ...GLOBAL_FLAGS,
      { name: 'version', type: 'boolean', description: 'Print the version (penmoss --version)' },
    ]),
    '',
    'Note commands run on a git notebook: the one --notebook names, or, without it, the',
    'one a short id names, else the only one on this machine (`penmoss notebook ls`). Add',
    'one with `penmoss notebook add`.',
    '',
    'Notes are named by id, by short id (K7QD-9HTF2CXA, from Copy Agent Reference) or by',
    'exact title, ignoring the case of A–Z only. Content',
    'is read from stdin only where a command is given -, e.g.',
    '`echo "- done" | penmoss daily --append -`.',
    '',
    'Environment:',
    '  PENMOSS_HOME       Where git notebooks are kept (default ~/.penmoss)',
    '  PENMOSS_GIT_TOKEN  A token for git notebooks’ repositories, instead of a saved one',
    '  NO_COLOR           Never style output',
    '',
    'Exit codes:',
    ...EXIT_HELP,
    '',
    'Run `penmoss <command> --help` for a command’s options.',
    '',
  ].join('\n');
}

function commandHelp(command: Command): string {
  const [first, ...more] = command.usage;
  const lines = [
    `Usage: penmoss ${first}`,
    ...more.map((usage) => `       penmoss ${usage}`),
    '',
    ...command.description.flatMap((paragraph) => [...wrap(paragraph, 80), '']),
  ];
  const flags = flagsOf(command);
  if (flags.length > 0) lines.push('Options:', ...flagLines(flags), '');
  lines.push('Global options:', ...flagLines(GLOBAL_FLAGS), '');
  if (command.examples?.length) {
    lines.push('Examples:', ...command.examples.map((example) => `  ${example}`), '');
  }
  lines.push('Exit codes: see `penmoss --help`.', '');
  return lines.join('\n');
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
