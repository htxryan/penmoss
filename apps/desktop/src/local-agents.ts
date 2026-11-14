/**
 * Agents on this Mac, with no account (T54, D47): the `penmoss` command, which is this app's own
 * binary running the CLI (A992), and agents connected to a git notebook through the local MCP
 * server, each with a clone of its own in `~/.penmoss` (A993, A994).
 *
 * Everything here stays on this Mac and on the notebook's git host: nothing reaches the Penmoss
 * server. The page sees names, commands and refusals, never a token.
 */
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CliError, type NotebookEntry, type NotebookIo } from '@penmoss/cli/node';
import type { GitAnswer, GitNotebookEntry, GitRefusal } from './git-notebooks';
import { fitWords, repositoryWords } from './git-notebooks';

/** The switch that makes this binary the CLI (A992). */
export const CLI_FLAG = '--penmoss-cli';
/**
 * The CLI's own bundle in the packaged Mac app (PEN-121, amending A992): its executable, from the
 * app's `Contents` (scripts/cli-bundle.mjs makes it). Run from there, the CLI checks in with
 * LaunchServices as `app.penmoss.mac.cli`, a background-only app, never as Penmoss itself.
 */
export const CLI_EXECUTABLE = ['Helpers', 'Penmoss CLI.app', 'Contents', 'MacOS', 'Penmoss'];

/**
 * The command that runs this app as the CLI. A packaged Mac app hands out its CLI bundle's
 * executable (PEN-121), unless that bundle is missing, when the app's own binary still works;
 * development (the app's folder after Electron) and Linux are as before (A992).
 */
export function cliCommand(options: {
  /** `app.getPath('exe')`. */
  readonly exe: string;
  /** `app.getAppPath()`, used only unpackaged. */
  readonly appPath: string;
  readonly packaged: boolean;
  readonly platform: NodeJS.Platform;
  /** For the tests: whether a file is there. */
  readonly exists?: (path: string) => boolean;
}): { readonly cli: readonly string[]; readonly old: readonly string[] | null } {
  const { exe, packaged, platform } = options;
  if (!packaged) return { cli: [exe, options.appPath, CLI_FLAG], old: null };
  const own = [exe, CLI_FLAG];
  if (platform !== 'darwin') return { cli: own, old: null };
  const bundled = join(dirname(dirname(exe)), ...CLI_EXECUTABLE);
  return (options.exists ?? existsSync)(bundled)
    ? { cli: [bundled, CLI_FLAG], old: own }
    : { cli: own, old: null };
}

/** Marks the script the app writes, so it never overwrites someone else's `penmoss`. */
const MARKER = '# Written by Penmoss for Mac: runs the penmoss CLI in the app (A992).';
/** The text of the app's `penmoss` script running `cli`, the person's arguments after it. */
export function cliScript(cli: readonly string[]): string {
  return `#!/bin/sh\n${MARKER}\nexec ${cli.map(shellWord).join(' ')} "$@"\n`;
}
/** The CLI's rule for a notebook's name. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LABEL_MAX = 40;
/** The agent the app connects to every one of its notebooks by itself (D52). */
export const AUTOMATIC_AGENT = 'Agent';
/** How long an automatic clone that could not be made waits before the next try (D52). */
const RETRY_MS = 5 * 60_000;
/** The same while the target holds no notebook yet: the app's first push is on its way. */
const NOT_THERE_RETRY_MS = 15_000;

/** One agent connected to a git notebook: its clone's name and how to give it the MCP server. */
export interface LocalAgentView {
  /** The clone's name in `~/.penmoss` (`penmoss … --notebook <name>`). */
  readonly name: string;
  /** The agent's name, as History and Agent activity show it. */
  readonly label: string;
  /** The app made it by itself, for every agent on this Mac (D52): it goes with the notebook. */
  readonly automatic: boolean;
  /** The MCP server's name in the agent's configuration. */
  readonly server: string;
  /** `claude mcp add …`, to paste into a terminal. */
  readonly claude: string;
  /**
   * The same with `--channel` (T60, A1063, A1073): the server is also the channel that brings
   * Claude Code the comments Ryan sends to this session.
   */
  readonly claudeChannel: string;
  /** How Claude Code is started so it loads that channel: `claude --dangerously-load-… server:<server>`. */
  readonly claudeLaunch: string;
  /** The lines for Codex's `~/.codex/config.toml`. */
  readonly codex: string;
}

/** The `penmoss` command on this Mac. */
export interface CliView {
  /** Where the app writes it: `~/.local/bin/penmoss`. */
  readonly path: string;
  /**
   * `installed`: the app's script, running this app; `stale`: the app's, running another copy
   * (moved or renamed); `missing`: nothing there; `other`: a file the app did not write.
   */
  readonly state: 'installed' | 'stale' | 'missing' | 'other';
  /** Whether a login shell's PATH has its folder; null when the shell could not be asked. */
  readonly onPath: boolean | null;
  /** The line that puts the folder on PATH, and the file it goes in. */
  readonly pathLine: string;
  readonly profile: string;
  /** The command that runs the CLI without the script: the app's binary and the switch. */
  readonly direct: string;
}

/** Answers yes or no for the person, with words main makes (Touch ID or the password). */
export type OwnerCheck = (
  words: string,
) => Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;

export interface LocalAgentsOptions {
  /** The command that runs this app as the CLI: its binary, the app path in development, the switch. */
  readonly cli: readonly string[];
  /**
   * The command this same app handed out before it had the CLI bundle (PEN-121): its own binary
   * and the switch. A script of the app's running exactly that is rewritten (`refreshCli`).
   */
  readonly oldCli?: readonly string[] | null;
  /** The person's home folder. */
  readonly home: string;
  /** The person's login shell (`$SHELL`), asked for its PATH. */
  readonly shell: string;
  /** The CLI's notebooks in `~/.penmoss` (`nodeNotebooks`). */
  readonly notebooks: () => NotebookIo;
  /** The app's own git notebook, for main only (`GitNotebooks.forAgent`). */
  readonly notebook: (localId: unknown) => Promise<{
    readonly entry: GitNotebookEntry;
    readonly token: string | null;
  } | null>;
  readonly ownerCheck: OwnerCheck;
  /** Every one of the app's notebooks with its token (`GitNotebooks.forAgents`, D52). */
  readonly all?: () => Promise<
    readonly { readonly entry: GitNotebookEntry; readonly token: string | null }[]
  >;
  readonly log?: (text: string) => void;
  /** For the tests: the clock. */
  readonly now?: () => number;
  /** For the tests: a login shell's PATH. */
  readonly loginPath?: () => Promise<string | null>;
}

const refuse = (code: string, message: string): { ok: false; error: GitRefusal } => ({
  ok: false,
  error: { code, message },
});

/** A word for a shell: as is when it is plain, in single quotes otherwise. */
export function shellWord(word: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** A TOML basic string. */
const tomlString = (text: string) =>
  `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`;

/** A clone's name from the notebook's and the agent's: `notes-claude-code`. */
export function agentCloneName(
  notebook: string,
  label: string,
  taken: ReadonlySet<string>,
): string {
  const slug = (text: string) =>
    text
      .normalize('NFKD')
      .replace(/[^\w.-]+/g, '-')
      .replace(/[_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .toLowerCase();
  const base = `${slug(notebook) || 'notebook'}-${slug(label) || 'agent'}`.slice(0, 56);
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (NAME.test(name) && !taken.has(name)) return name;
  }
}

/** What an automatic clone is made from: a change to any of it is worth another try at once. */
const settingsOf = (entry: GitNotebookEntry, token: string | null) =>
  JSON.stringify([
    entry.remote,
    entry.branch,
    entry.dir,
    entry.tokenUser ?? null,
    entry.sign ?? null,
    entry.author ?? null,
    token,
  ]);

/** The same remote, branch and directory. */
const sameTarget = (
  a: { remote: string; branch: string; dir: string },
  b: { remote: string; branch: string; dir: string },
) => a.remote === b.remote && a.branch === b.branch && a.dir === b.dir;

export class LocalAgents {
  constructor(private readonly options: LocalAgentsOptions) {}

  /** The pass running now, and whether another is wanted after it. */
  private ensuring: Promise<void> | null = null;
  private again = false;
  /** An app notebook's localId → when its automatic clone may be tried again. */
  private readonly waits = new Map<string, { readonly until: number; readonly settings: string }>();
  /** The next try of a clone that waits. */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The token each automatic clone was last given, by the app notebook's localId. */
  private readonly tokens = new Map<string, string | null>();

  private get scriptPath(): string {
    return join(this.options.home, '.local', 'bin', 'penmoss');
  }

  /** The script's text: the app's binary with the switch, the person's arguments after it. */
  private script(cli: readonly string[] = this.options.cli): string {
    return cliScript(cli);
  }

  /** The MCP server's command for `name`, as words (the app's binary first). */
  private mcpCommand(name: string): readonly string[] {
    return [...this.options.cli, 'mcp', '--notebook', name];
  }

  private view(entry: NotebookEntry): LocalAgentView {
    const server = `penmoss-${entry.name}`;
    const [command = '', ...args] = this.mcpCommand(entry.name);
    return {
      name: entry.name,
      label: entry.writer.label,
      automatic: entry.automatic === true,
      server,
      claude: ['claude', 'mcp', 'add', server, '--', ...this.mcpCommand(entry.name)]
        .map(shellWord)
        .join(' '),
      claudeChannel: [
        'claude',
        'mcp',
        'add',
        server,
        '--',
        ...this.mcpCommand(entry.name),
        '--channel',
      ]
        .map(shellWord)
        .join(' '),
      claudeLaunch: ['claude', '--dangerously-load-development-channels', `server:${server}`]
        .map(shellWord)
        .join(' '),
      codex: [
        `[mcp_servers.${tomlString(server)}]`,
        `command = ${tomlString(command)}`,
        `args = [${args.map(tomlString).join(', ')}]`,
      ].join('\n'),
    };
  }

  // --- the command ---

  async cliStatus(): Promise<CliView> {
    const text = await readFile(this.scriptPath, 'utf8').catch(() => null);
    const state: CliView['state'] =
      text === null
        ? 'missing'
        : !text.includes(MARKER)
          ? 'other'
          : text === this.script()
            ? 'installed'
            : 'stale';
    const folder = join(this.options.home, '.local', 'bin');
    const path = await (this.options.loginPath ?? (() => loginShellPath(this.options.shell)))();
    const zsh = this.options.shell.endsWith('/zsh');
    return {
      path: this.scriptPath,
      state,
      onPath: path === null ? null : path.split(':').includes(folder),
      pathLine: 'export PATH="$HOME/.local/bin:$PATH"',
      profile: zsh
        ? '~/.zshrc'
        : this.options.shell.endsWith('/bash')
          ? '~/.bash_profile'
          : '~/.profile',
      direct: [...this.options.cli].map(shellWord).join(' '),
    };
  }

  /** Writes `~/.local/bin/penmoss`; never over a file the app did not write. */
  async installCli(): Promise<GitAnswer<CliView>> {
    const text = await readFile(this.scriptPath, 'utf8').catch(() => null);
    if (text !== null && !text.includes(MARKER)) {
      return refuse(
        'cli_other',
        `${this.scriptPath} is another program's, so Penmoss left it as it is. Move it away to install Penmoss's.`,
      );
    }
    await mkdir(join(this.options.home, '.local', 'bin'), { recursive: true });
    await writeFile(this.scriptPath, this.script(), { mode: 0o755 });
    await chmod(this.scriptPath, 0o755);
    return { ok: true, value: await this.cliStatus() };
  }

  /**
   * As the app starts (PEN-121): when `~/.local/bin/penmoss` is the app's own script running this
   * same app's binary (`oldCli`, before the CLI bundle), it is rewritten to run the CLI bundle. A
   * script for another copy of Penmoss stays stale, and a file the app did not write is never
   * touched. Never throws; true when it rewrote the script.
   */
  async refreshCli(): Promise<boolean> {
    const old = this.options.oldCli;
    if (!old) return false;
    try {
      const text = await readFile(this.scriptPath, 'utf8').catch(() => null);
      if (text === null || text !== this.script(old)) return false;
      await writeFile(this.scriptPath, this.script(), { mode: 0o755 });
      await chmod(this.scriptPath, 0o755);
      this.options.log?.(`agents: ${this.scriptPath} now runs the CLI bundle`);
      return true;
    } catch (error) {
      this.options.log?.(`agents: could not rewrite ${this.scriptPath}: ${cliMessage(error)}`);
      return false;
    }
  }

  /** Removes the app's script; leaves anyone else's. */
  async removeCli(): Promise<GitAnswer<CliView>> {
    const text = await readFile(this.scriptPath, 'utf8').catch(() => null);
    if (text !== null && !text.includes(MARKER)) {
      return refuse('cli_other', `${this.scriptPath} is another program's, so Penmoss left it.`);
    }
    await rm(this.scriptPath, { force: true });
    return { ok: true, value: await this.cliStatus() };
  }

  // --- agents ---

  /**
   * Every agent on this Mac reaches every notebook in the app (D52): each of the app's notebooks
   * gets an agent clone of its own in `~/.penmoss` (“Agent”, `<notebook>-agent`), as Connect an
   * Agent makes one but with no owner check, once the target holds the notebook (the app's first
   * push). `penmoss mcp --notebook <the notebook's name>` serves it. A notebook removed from the
   * app takes its automatic clone with it, unless that clone has changes not pushed yet. Runs at
   * launch and whenever the app's notebooks change, one pass at a time; never throws.
   */
  ensureAll(): Promise<void> {
    if (this.ensuring) {
      this.again = true;
      return this.ensuring;
    }
    const run = async () => {
      try {
        do {
          this.again = false;
          await this.ensureOnce().catch((error: unknown) =>
            this.options.log?.(`agents: ${cliMessage(error)}`),
          );
        } while (this.again);
      } finally {
        this.ensuring = null;
        this.schedule();
      }
    };
    this.ensuring = run();
    return this.ensuring;
  }

  /** Tries again when the first waiting clone's time comes (the app's first push lands). */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.waits.size === 0) return;
    const now = (this.options.now ?? Date.now)();
    const next = Math.min(...[...this.waits.values()].map((wait) => wait.until));
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.ensureAll();
      },
      Math.max(1_000, next - now),
    );
    this.timer.unref?.();
  }

  private async ensureOnce(): Promise<void> {
    if (!this.options.all) return;
    const now = this.options.now ?? Date.now;
    const app = await this.options.all();
    const notebooks = this.options.notebooks();
    let clones = await notebooks.list();
    for (const clone of clones) {
      if (!clone.automatic || app.some(({ entry }) => sameTarget(entry, clone))) continue;
      await notebooks.remove(clone.name, false).then(
        () => this.options.log?.(`agents: removed ${clone.name}, its notebook gone from the app`),
        (error: unknown) => this.options.log?.(`agents: kept ${clone.name}: ${cliMessage(error)}`),
      );
    }
    clones = await notebooks.list();
    for (const { entry, token } of app) {
      const automatic = clones.find((each) => each.automatic && sameTarget(each, entry));
      // A token added, changed or forgotten in the app reaches its automatic clone.
      if (automatic && this.tokens.get(entry.localId) !== token) {
        await notebooks.setToken(automatic.name, token).then(
          () => this.tokens.set(entry.localId, token),
          (error: unknown) =>
            this.options.log?.(`agents: token for ${automatic.name}: ${cliMessage(error)}`),
        );
      }
      // Renamed in the app (Ryan's review of PR #192): its clones in ~/.penmoss take the name
      // now, before they next sync it from notebook.json, and keep the old one, so
      // `--notebook <either>` finds them. Their folders and names stay as they are.
      for (const clone of clones) {
        // Names are matched ignoring case, so a clone told only a change of case is left be.
        const known = clone.notebookName?.toLowerCase();
        if (!sameTarget(clone, entry) || !known || known === entry.name.toLowerCase()) continue;
        await notebooks.set(clone.name, { notebookName: entry.name }).then(
          () => this.options.log?.(`agents: ${clone.name} is now “${entry.name}”`),
          (error: unknown) =>
            this.options.log?.(`agents: could not rename ${clone.name}: ${cliMessage(error)}`),
        );
      }
      if (clones.some((each) => each.writer.kind === 'agent' && sameTarget(each, entry))) {
        this.waits.delete(entry.localId);
        continue;
      }
      // A wait ends early once the notebook's settings change (a commit email for GH007, a
      // token): the next try may be the one that works.
      const settings = settingsOf(entry, token);
      const wait = this.waits.get(entry.localId);
      if (wait && wait.settings === settings && wait.until > now()) continue;
      const name = agentCloneName(
        entry.name,
        AUTOMATIC_AGENT,
        new Set(clones.map((each) => each.name)),
      );
      try {
        const added = await notebooks.add({
          remote: entry.remote,
          branch: entry.branch,
          dir: entry.dir,
          name,
          agent: AUTOMATIC_AGENT,
          existing: true,
          automatic: true,
          ...(token ? { token } : {}),
          ...(entry.tokenUser ? { tokenUser: entry.tokenUser } : {}),
          ...(entry.sign === false ? { sign: false } : {}),
          ...(entry.author ? { author: entry.author } : {}),
        });
        clones = [...clones, added.entry];
        this.tokens.set(entry.localId, token);
        this.waits.delete(entry.localId);
        this.options.log?.(`agents: connected ${name}`);
      } catch (error) {
        const notThere = error instanceof CliError && error.code === 'notebook_not_there';
        this.waits.set(entry.localId, {
          until: now() + (notThere ? NOT_THERE_RETRY_MS : RETRY_MS),
          settings,
        });
        if (!notThere)
          this.options.log?.(`agents: could not connect ${name}: ${cliMessage(error)}`);
      }
    }
  }

  /** The agents' clones of exactly this notebook's remote, branch and directory. */
  private async agentsOf(entry: GitNotebookEntry): Promise<NotebookEntry[]> {
    return (await this.options.notebooks().list()).filter(
      (each) =>
        each.writer.kind === 'agent' &&
        each.remote === entry.remote &&
        each.branch === entry.branch &&
        each.dir === entry.dir,
    );
  }

  async list(localId: unknown): Promise<GitAnswer<readonly LocalAgentView[]>> {
    const found = await this.options.notebook(localId);
    if (!found) return refuse('not_found', 'No such git notebook.');
    try {
      return { ok: true, value: (await this.agentsOf(found.entry)).map((each) => this.view(each)) };
    } catch (error) {
      return refuse('agents_unreadable', cliMessage(error));
    }
  }

  /**
   * Connect an Agent (A993): after the owner check, the agent's own clone, as `penmoss notebook
   * add --agent` makes it, with this notebook's target, token, signing and commit identity
   * (A994).
   */
  async connect(localId: unknown, label: unknown): Promise<GitAnswer<LocalAgentView>> {
    const found = await this.options.notebook(localId);
    if (!found) return refuse('not_found', 'No such git notebook.');
    const name = typeof label === 'string' ? label.trim().replace(/\s+/g, ' ') : '';
    if (!name || name.length > LABEL_MAX || /[\p{Cc}"]/u.test(name)) {
      return refuse('invalid_label', `Give the agent a name of up to ${LABEL_MAX} characters.`);
    }
    const { entry, token } = found;
    const notebooks = this.options.notebooks();
    let all: NotebookEntry[];
    try {
      all = await notebooks.list();
    } catch (error) {
      return refuse('agents_unreadable', cliMessage(error));
    }
    const twin = all.find(
      (each) =>
        each.writer.kind === 'agent' &&
        each.writer.label === name &&
        each.remote === entry.remote &&
        each.branch === entry.branch &&
        each.dir === entry.dir,
    );
    if (twin) {
      return refuse(
        'agent_exists',
        `“${name}” is connected to this notebook already, as ${twin.name}.`,
      );
    }
    const asked = await this.options.ownerCheck(
      fitWords(`let the agent “${name}” edit `, repositoryWords(entry.remote), ' on this Mac'),
    );
    if (!asked.ok) return refuse('not_confirmed', asked.message);
    const clone = agentCloneName(entry.name, name, new Set(all.map((each) => each.name)));
    try {
      const added = await notebooks.add({
        remote: entry.remote,
        branch: entry.branch,
        dir: entry.dir,
        name: clone,
        agent: name,
        ...(token ? { token } : {}),
        ...(entry.tokenUser ? { tokenUser: entry.tokenUser } : {}),
        ...(entry.sign === false ? { sign: false } : {}),
      });
      if (entry.author) await notebooks.set(clone, { author: entry.author });
      return { ok: true, value: this.view(added.entry) };
    } catch (error) {
      return refuse(error instanceof CliError ? error.code : 'connect_failed', cliMessage(error));
    }
  }

  /**
   * Disconnect (A993): removes an agent's clone, never a person's. With changes the clone has
   * not pushed, it refuses with `unsynced_changes`; `force` loses them, after the owner check.
   */
  async disconnect(name: unknown, force: unknown): Promise<GitAnswer<null>> {
    if (typeof name !== 'string' || !NAME.test(name)) return refuse('not_found', 'No such agent.');
    const notebooks = this.options.notebooks();
    const entry = (await notebooks.list().catch(() => [])).find((each) => each.name === name);
    if (!entry || entry.writer.kind !== 'agent') return refuse('not_found', 'No such agent.');
    if (entry.automatic) {
      return refuse(
        'agent_automatic',
        'Every agent on this Mac uses this one: it goes when the notebook is removed from this Mac.',
      );
    }
    if (force === true) {
      const asked = await this.options.ownerCheck(
        `disconnect the agent “${entry.writer.label}” and lose the changes it has not pushed`,
      );
      if (!asked.ok) return refuse('not_confirmed', asked.message);
    }
    try {
      await notebooks.remove(name, force === true);
      return { ok: true, value: null };
    } catch (error) {
      return refuse(
        error instanceof CliError ? error.code : 'disconnect_failed',
        cliMessage(error),
      );
    }
  }
}

/** A CLI error's message with its hints, or any other error's. */
function cliMessage(error: unknown): string {
  if (error instanceof CliError) {
    return [error.message, ...error.hints].join(' ');
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The login shell's PATH, asked once and kept (Quanta feedback 2, item 5; A1124): a login shell
 * with a heavy profile took 3–4 seconds to answer, and Settings → Agents waited for it each time
 * it opened. The app asks as it starts; after that the PATH kept answers at once, and an answer
 * older than `fresh` ms is asked again for the next time (a terminal may have changed it).
 */
export function keptLoginPath(
  ask: () => Promise<string | null>,
  { fresh = 15_000, now = Date.now }: { fresh?: number; now?: () => number } = {},
): { readonly warm: () => void; readonly get: () => Promise<string | null> } {
  /** Undefined until the shell first answers. */
  let kept: string | null | undefined;
  let at = 0;
  let asking: Promise<string | null> | null = null;
  const refresh = (): Promise<string | null> => {
    asking ??= ask()
      .catch(() => null)
      .then((path) => {
        kept = path;
        at = now();
        asking = null;
        return path;
      });
    return asking;
  };
  return {
    warm: () => void refresh(),
    get: () => {
      if (kept === undefined) return refresh();
      if (now() - at > fresh) void refresh();
      return Promise.resolve(kept);
    },
  };
}

/**
 * The PATH a terminal would have: the app, opened from the Finder, has launchd's. Asks the
 * person's login shell, for at most 4 seconds; null when it cannot say.
 */
export function loginShellPath(shell: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawn(shell || '/bin/zsh', ['-ilc', 'printf "\\n__PENMOSS_PATH__%s" "$PATH"'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, 4000);
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.on('error', () => finish(null));
    child.on('close', () => {
      const at = out.lastIndexOf('__PENMOSS_PATH__');
      finish(at === -1 ? null : out.slice(at + '__PENMOSS_PATH__'.length).trim());
    });
  });
}
