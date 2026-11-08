/**
 * `penmoss notebook …` and `penmoss mcp --notebook` (T50 G2, #150): git notebooks on this
 * machine. A git notebook syncs only through a git repository (any host, HTTPS or SSH).
 */
import { validCommitEmail, validCommitName } from '@penmoss/git-notebook/identity';
import { UsageError } from '../args';
import type { Command, Context } from '../command';
import { CliError, EXIT } from '../errors';
import type { NotebookIo, NotebookSyncSummary } from '../io';

function notebooks(context: Context): NotebookIo {
  if (!context.io.notebooks) {
    throw new CliError(EXIT.ERROR, 'This penmoss cannot open git notebooks here.', 'unsupported');
  }
  return context.io.notebooks;
}

function syncLines(done: NotebookSyncSummary): string[] {
  const lines = [
    done.commit
      ? `Synced ${done.name}: pushed ${done.commit.slice(0, 7)}${done.pulled > 0 ? `, ${done.pulled} ${done.pulled === 1 ? 'note' : 'notes'} changed elsewhere` : ''}.`
      : done.pulled > 0
        ? `Synced ${done.name}: ${done.pulled} ${done.pulled === 1 ? 'note' : 'notes'} changed elsewhere.`
        : `${done.name} is up to date.`,
  ];
  if (done.attempts > 1) lines.push(`  (built ${done.attempts} times: others pushed meanwhile)`);
  if (done.handEdits.length > 0) {
    lines.push(
      `  Overwrote ${done.handEdits.length} rendered ${done.handEdits.length === 1 ? 'file' : 'files'} edited by hand (the notes are the source; edit them in Penmoss): ${done.handEdits.join(', ')}`,
    );
  }
  if (done.copies.length > 0) {
    lines.push(
      `  Left alone ${done.copies.length} ${done.copies.length === 1 ? 'copy' : 'copies'} of notes' files made by hand (same note id; Penmoss writes only its own file): ${done.copies.join(', ')}`,
    );
  }
  const skipped = Object.entries(done.skipped);
  if (skipped.length > 0) {
    lines.push(
      `  Could not read ${skipped.length} ${skipped.length === 1 ? 'file' : 'files'}, skipped (the rest synced):`,
      ...skipped.map(([path, why]) => `    ${path}: ${why}`),
    );
  }
  if (done.renderSkipped) {
    lines.push(
      '  A newer Penmoss renders this notebook: this one wrote its changes but no files. Update penmoss.',
    );
  }
  if (done.filterIgnored) {
    lines.push(
      '  The host ignored the partial-clone filter, so this machine holds a full copy of the repository.',
    );
  }
  return lines;
}

/** A token from stdin (`-`), never from the command line, where other users could see it. */
export async function tokenFrom(
  context: Context,
  value: string | undefined,
): Promise<string | undefined> {
  if (value === undefined) return undefined;
  if (value !== '-') {
    throw new UsageError(
      'pass the token on stdin (--token -), or in PENMOSS_GIT_TOKEN: never on the command line',
    );
  }
  const token = (await context.io.stdin.read()).trim();
  if (!token) throw new UsageError('no token on stdin');
  return token;
}

const SUBCOMMANDS = ['add', 'ls', 'sync', 'status', 'set', 'remove', 'token'];

export const notebook: Command = {
  name: 'notebook',
  summary: 'Add, list, sync and remove git notebooks',
  usage: [
    'notebook add <remote> [--branch <branch>] [--dir <dir>] [--name <name>] [--agent <label>] [--token -] [--token-user <user>] [--no-sign] [--author-name <name>] [--author-email <email>]',
    'notebook ls',
    'notebook sync [<name>] [--full] [--wait <seconds>]',
    'notebook status <name>',
    'notebook set <name> [--sign | --no-sign] [--author-name <name>] [--author-email <email> | --git-author]',
    'notebook remove <name> [--force]',
    'notebook token <name> (- | --forget)',
  ],
  description: [
    'A git notebook keeps its notes in a git repository you choose (any host, HTTPS or SSH): a branch, and optionally a directory of a code repository. Its notes are per-writer logs plus rendered markdown, so several devices and agents edit offline and every sync converges with no git conflicts.',
    'add clones the repository into ~/.penmoss/git/ (only the files Penmoss reads are downloaded), and makes a notebook there if there is none yet, committing only inside --dir. The clone writes as its own writer: a device, or an agent named by --agent (use one for an agent such as Claude Code, so History names it). Commits keep your git identity, with a Penmoss-Writer trailer, and are signed if your git config signs commits (--no-sign: never).',
    'Penmoss does not check whether the repository is private: choosing who can read it is yours. git follows its own configuration, url.<base>.insteadOf and pushInsteadOf rewrites included.',
    'git’s own credentials are used (credential helpers, SSH keys). For HTTPS with a personal access token, pass it on stdin with --token - (it is kept in the keychain, or ~/.penmoss/credentials.json), or set PENMOSS_GIT_TOKEN, which is only sent to PENMOSS_GIT_TOKEN_HOST (default github.com). Never put a token in the remote URL: such a remote is refused. Hosts other than GitHub may need --token-user (Bitbucket: x-token-auth).',
    'Then use any note command: penmoss search, cat, new, append, edit, daily, ls, mv, trash, restore, tag, set-title, retag, attach, mkdir, rename, rmdir, sort, open, history and settings. They run on the notebook --notebook <name> names (a clone’s name, or the notebook’s own, as the Mac app shows it), or on the only one on this machine without it, and sync once (--no-sync to skip). penmoss mcp --notebook <name> serves the notebook to an agent.',
  ],
  flags: [
    { name: 'branch', type: 'string', value: 'branch', description: 'The branch (default main)' },
    {
      name: 'dir',
      type: 'string',
      value: 'dir',
      description: 'A directory of the repository to keep the notebook in (default: its top)',
    },
    {
      name: 'name',
      type: 'string',
      value: 'name',
      description: 'The name this machine knows it by (default: the notebook’s)',
    },
    {
      name: 'agent',
      type: 'string',
      value: 'label',
      description: 'Write as an agent with this name, not as this device',
    },
    {
      name: 'token',
      type: 'string',
      value: '-',
      description: 'Read a personal access token from stdin',
    },
    {
      name: 'token-user',
      type: 'string',
      value: 'user',
      description: 'The user name sent with the token (default x-access-token)',
    },
    { name: 'no-sign', type: 'boolean', description: 'Never sign this notebook’s commits' },
    {
      name: 'sign',
      type: 'boolean',
      description: 'With set: sign commits as git’s config says (the default)',
    },
    {
      name: 'author-name',
      type: 'string',
      value: 'name',
      description: 'With add or set: the name this notebook commits as (with --author-email)',
    },
    {
      name: 'author-email',
      type: 'string',
      value: 'email',
      description:
        'With add or set: the email this notebook commits as, over git’s user.email (a GitHub no-reply address keeps yours private)',
    },
    {
      name: 'git-author',
      type: 'boolean',
      description: 'With set: commit as git’s own user.name and user.email again',
    },
    {
      name: 'forget',
      type: 'boolean',
      description: 'With token: forget the saved token',
    },
    {
      name: 'full',
      type: 'boolean',
      description: 'With sync: recompute every note, not only changed ones',
    },
    {
      name: 'wait',
      type: 'integer',
      value: 'seconds',
      description:
        'With sync: wait up to this long for another penmoss using the notebook (default 10)',
    },
    {
      name: 'force',
      type: 'boolean',
      description: 'With remove: remove even with changes that have not synced',
    },
  ],
  examples: [
    'penmoss notebook add https://github.com/acme/notes.git --name work',
    'echo "$TOKEN" | penmoss notebook add https://git.example.com/me/notes.git --token -',
    'penmoss notebook add git@github.com:acme/app.git --dir docs/notes --name app-notes',
    'penmoss notebook add https://github.com/acme/notes.git --name work-agent --agent "Claude Code"',
    'penmoss search standup --notebook work',
  ],
  async run(context) {
    const [sub, ...rest] = context.positionals;
    if (sub === undefined || !SUBCOMMANDS.includes(sub)) {
      throw new UsageError(
        sub === undefined
          ? `missing subcommand: ${SUBCOMMANDS.join(', ')}`
          : `unknown subcommand “${sub}” (${SUBCOMMANDS.join(', ')})`,
      );
    }
    const allowed: Record<string, readonly string[]> = {
      add: [
        'branch',
        'dir',
        'name',
        'agent',
        'token',
        'token-user',
        'no-sign',
        'author-name',
        'author-email',
      ],
      sync: ['full', 'wait'],
      remove: ['force'],
      token: ['forget'],
      set: ['sign', 'no-sign', 'author-name', 'author-email', 'git-author'],
    };
    for (const flag of [
      'branch',
      'dir',
      'name',
      'agent',
      'token',
      'token-user',
      'no-sign',
      'sign',
      'author-name',
      'author-email',
      'git-author',
      'forget',
      'full',
      'force',
    ]) {
      if (context.flags[flag] !== undefined && !(allowed[sub] ?? []).includes(flag)) {
        throw new UsageError(`--${flag} does not go with notebook ${sub}`);
      }
    }
    const io = notebooks(context);
    const one = (what: string) => {
      if (rest.length !== 1)
        throw new UsageError(
          rest.length === 0 ? `missing ${what}` : `unexpected argument “${rest[1]}”`,
        );
      return rest[0]!;
    };
    switch (sub) {
      case 'add': {
        const remote = one('remote');
        const dir = (context.string('dir') ?? '').replace(/^\/+|\/+$/g, '');
        if (dir.split('/').some((part) => part === '..' || part === '.')) {
          throw new UsageError('--dir must be a directory inside the repository');
        }
        const authorName = context.string('author-name');
        const authorEmail = context.string('author-email');
        if (authorName !== undefined && authorEmail === undefined) {
          throw new UsageError('--author-name goes with --author-email');
        }
        // Checked as set checks them; the name is git's user.name when not given.
        const author =
          authorEmail === undefined
            ? undefined
            : authorName === undefined
              ? { email: commitIdentity('Penmoss', authorEmail).email }
              : commitIdentity(authorName, authorEmail);
        const token = await tokenFrom(context, context.string('token'));
        const name = context.string('name');
        const agent = context.string('agent');
        const tokenUser = context.string('token-user');
        const added = await io.add({
          remote,
          branch: context.string('branch') ?? 'main',
          dir,
          ...(name !== undefined ? { name } : {}),
          ...(agent !== undefined ? { agent } : {}),
          ...(token !== undefined ? { token } : {}),
          ...(tokenUser !== undefined ? { tokenUser } : {}),
          ...(context.bool('no-sign') ? { sign: false } : {}),
          ...(author ? { author } : {}),
        });
        for (const warning of added.sync.warnings) context.note(`penmoss: ${warning}`);
        const shown = added.entry.remote;
        context.emit({ ...added.entry, created: added.created, sync: added.sync }, () => [
          added.created
            ? `Made the git notebook “${added.entry.notebookName ?? added.entry.name}” in ${shown}${dir ? ` (${dir}/)` : ''}, on ${added.entry.branch}.`
            : `Added the git notebook “${added.entry.notebookName ?? added.entry.name}” from ${shown}${dir ? ` (${dir}/)` : ''}.`,
          `Use it with --notebook ${added.entry.name}, e.g. penmoss ls --notebook ${added.entry.name}`,
        ]);
        return;
      }
      case 'ls': {
        if (rest.length > 0) throw new UsageError(`unexpected argument “${rest[0]}”`);
        const all = await io.list();
        context.emit({ notebooks: all }, () =>
          all.length === 0
            ? 'No git notebooks yet: add one with penmoss notebook add <remote>.'
            : all.map(
                (each) =>
                  `${each.name}  ${each.remote}${each.dir ? ` ${each.dir}/` : ''} (${each.branch})  ${each.writer.kind === 'agent' ? `agent “${each.writer.label}”` : 'device'}`,
              ),
        );
        return;
      }
      case 'sync': {
        if (rest.length > 1) throw new UsageError(`unexpected argument “${rest[1]}”`);
        const wait = context.number('wait');
        if (wait !== undefined && !(wait >= 0 && wait <= 3600)) {
          throw new UsageError('--wait takes 0 to 3600 seconds');
        }
        const names = rest.length === 1 ? [rest[0]!] : (await io.list()).map((each) => each.name);
        const done: NotebookSyncSummary[] = [];
        for (const name of names) {
          const synced = await io.sync(name, {
            full: context.bool('full'),
            ...(wait === undefined ? {} : { waitMs: wait * 1000 }),
          });
          for (const warning of synced.warnings) context.note(`penmoss: ${warning}`);
          done.push(synced);
        }
        context.emit({ synced: done }, () =>
          done.length === 0 ? 'No git notebooks to sync.' : done.flatMap(syncLines),
        );
        return;
      }
      case 'status': {
        const status = await io.status(one('name'));
        context.emit(status, () => [
          `${status.name}: ${status.notebookName ?? '(not synced yet)'}`,
          `  repository  ${status.remote}${status.dir ? ` ${status.dir}/` : ''} (${status.branch})`,
          `  writer      ${status.writerId ?? '(none yet)'} (${status.writer.kind} “${status.writer.label}”)`,
          `  notes       ${status.notes}${status.unsynced > 0 ? `, ${status.unsynced} changed here and not pushed yet` : ''}`,
          `  last sync   ${status.lastHead ? status.lastHead.slice(0, 7) : 'never'}`,
          `  on disk     ${Math.ceil(status.cloneBytes / 1024)} KB clone, ${Math.ceil(status.stateBytes / 1024)} KB notes`,
          `  token       ${status.token === 'saved' ? 'saved' : status.token === 'environment' ? 'from PENMOSS_GIT_TOKEN' : 'none (git’s own credentials)'}`,
          `  signing     ${status.signing}`,
          `  commits as  ${status.author.name} <${status.author.email}>${status.author.own ? ' (this notebook’s own)' : ' (git’s user.name and user.email)'}`,
          ...Object.entries(status.skipped).map(([path, why]) => `  skipped     ${path}: ${why}`),
          ...(status.filterIgnored
            ? ['  the host ignored the partial-clone filter: a full copy is kept']
            : []),
        ]);
        return;
      }
      case 'remove': {
        const removed = await io.remove(one('name'), context.bool('force'));
        context.emit(
          { removed: removed.name },
          () =>
            `Removed ${removed.name} from this machine (its clone and saved token). The repository is unchanged.`,
        );
        return;
      }
      case 'token': {
        const [name, dash, extra] = rest;
        if (name === undefined) throw new UsageError('missing name');
        if (extra !== undefined) throw new UsageError(`unexpected argument “${extra}”`);
        if (context.bool('forget')) {
          if (dash !== undefined) throw new UsageError('give - or --forget, not both');
          await io.setToken(name, null);
          context.emit({ name, token: false }, () => `Forgot the token for ${name}.`);
          return;
        }
        if (dash !== '-')
          throw new UsageError('pass the token on stdin: penmoss notebook token <name> -');
        const token = await tokenFrom(context, '-');
        await io.setToken(name, token!);
        context.emit({ name, token: true }, () => `Saved the token for ${name}.`);
        return;
      }
      case 'set': {
        const name = one('name');
        const sign = context.bool('sign');
        const noSign = context.bool('no-sign');
        if (sign && noSign) throw new UsageError('give --sign or --no-sign, not both');
        const authorName = context.string('author-name');
        const authorEmail = context.string('author-email');
        const gitAuthor = context.bool('git-author');
        if (gitAuthor && (authorName !== undefined || authorEmail !== undefined)) {
          throw new UsageError('give --git-author or --author-name and --author-email, not both');
        }
        if (authorName !== undefined && authorEmail === undefined) {
          throw new UsageError('--author-name goes with --author-email');
        }
        const author = gitAuthor
          ? null
          : authorEmail !== undefined
            ? commitIdentity(authorName ?? (await io.status(name)).author.name, authorEmail)
            : undefined;
        if (!sign && !noSign && author === undefined) {
          throw new UsageError('give --sign, --no-sign, --author-email or --git-author');
        }
        await io.set(name, {
          ...(sign || noSign ? { sign } : {}),
          ...(author !== undefined ? { author } : {}),
        });
        const said: string[] = [];
        if (sign) said.push(`${name}'s commits are signed as your git config says.`);
        if (noSign) said.push(`${name}'s commits are no longer signed.`);
        if (author) said.push(`${name} commits as ${author.name} <${author.email}> from now on.`);
        if (author === null) said.push(`${name} commits as git’s user.name and user.email again.`);
        context.emit(
          {
            name,
            ...(sign || noSign ? { sign } : {}),
            ...(author !== undefined ? { author } : {}),
          },
          () => said,
        );
        return;
      }
    }
  },
};

/** The longest `--name` (the old channel's). */
const MAX_SESSION_NAME = 200;

export const mcp: Command = {
  name: 'mcp',
  summary: 'Serve a git notebook to an agent over MCP (stdio)',
  usage: ['mcp --notebook <name> [--channel [--name <name>]]'],
  description: [
    'A local MCP server for a git notebook, over stdin and stdout, for agents such as Claude Code (claude mcp add penmoss-work -- penmoss mcp --notebook work). It has the tools of the relay at mcp.penmoss.app (docs/relay.md), with the same names and arguments, on this machine’s clone and as its writer: search_notes (by words, and by meaning once the model is on this Mac: penmoss models fetch), read_note, list_folder, list_tags, get_backlinks, list_recent, get_daily_note, create_note, append_to_note, update_section, replace_text, set_properties, tag_note, rename_tag, move_note, trash_note, restore_note, the folder tools, attach_file, get_settings and set_settings; and the comment tools, which the relay does not have: list_comment_threads, read_comment_thread, create_comment_thread, reply_to_comment_thread and resolve_comment_thread.',
    'With the model, the server opens it in a worker thread; the one process on this Mac that holds the indexing lease (normally the app) embeds notes in the background, and searches say how many notes meaning covers so far. History comes from the git log: a version is a commit that touched the note. It syncs when it starts; edits are committed and pushed a minute after they settle, and when the server stops (in the background, logged in the clone’s detached-sync.log); it pulls every two minutes. --notebook is required: give each agent a clone of its own (penmoss notebook add --agent), so History names it.',
    '--channel makes it a Claude Code channel too (a research preview): comments Ryan sends to this session from Penmoss’s Send to… arrive in Claude Code as channel messages. The session is listed in the notebook (hourly), the remote’s head is checked every 10 seconds, and the clone’s own writes are pushed at once. Start Claude Code with `claude --dangerously-load-development-channels server:<the .mcp.json key>`. --name names the session (default: this machine and directory), so a restart in the same place is the same session.',
  ],
  flags: [
    { name: 'notebook', type: 'string', value: 'name', description: 'The git notebook to serve' },
    {
      name: 'channel',
      type: 'boolean',
      description: 'Also a Claude Code channel: comments sent to this session arrive in it',
    },
    {
      name: 'name',
      type: 'string',
      value: 'name',
      description: 'With --channel: the session’s name in Send to… (default <host>:<directory>)',
    },
  ],
  examples: [
    'claude mcp add penmoss-work -- penmoss mcp --notebook work-agent',
    'claude mcp add penmoss -- penmoss mcp --notebook work-agent --channel',
    'claude --dangerously-load-development-channels server:penmoss',
  ],
  async run(context) {
    context.args([]);
    const name = context.string('notebook');
    if (name === undefined) {
      throw new UsageError(
        'missing --notebook: name the git notebook to serve (see `penmoss notebook ls`)',
      );
    }
    const channel = context.bool('channel');
    const sessionName = context.string('name')?.trim();
    if (sessionName !== undefined && !channel) {
      throw new UsageError('--name names a channel session: add --channel');
    }
    if (sessionName !== undefined && (!sessionName || sessionName.length > MAX_SESSION_NAME)) {
      throw new UsageError(`--name must be 1 to ${MAX_SESSION_NAME} characters`);
    }
    const stdio = context.io.stdio;
    if (!stdio) throw new CliError(EXIT.ERROR, 'This penmoss cannot serve stdio here.');
    await notebooks(context).serveMcp(
      name,
      {
        lines: stdio.lines(),
        write: (line) => context.io.stdout.write(`${line}\n`),
        log: (text) => context.io.stderr.write(`${text}\n`),
        ...(stdio.stopped ? { stopped: stdio.stopped() } : {}),
        ...(stdio.detach
          ? { detach: (args: readonly string[], log?: string) => stdio.detach!(args, log) }
          : {}),
      },
      channel ? { channel: sessionName !== undefined ? { name: sessionName } : {} } : {},
    );
  },
};

/** A commit identity given on the command line (#170 F6): one line each, an email address. */
function commitIdentity(name: string, email: string): { name: string; email: string } {
  const cleanName = name.trim();
  const cleanEmail = email.trim();
  // Plain text only: no NUL, control, bidi or format character (#174 review).
  if (!validCommitName(cleanName)) {
    throw new UsageError('--author-name is a name on one line of plain text, without < or >');
  }
  if (!validCommitEmail(cleanEmail)) {
    throw new UsageError(
      '--author-email is an email address, such as 1234+you@users.noreply.github.com',
    );
  }
  return { name: cleanName, email: cleanEmail };
}
