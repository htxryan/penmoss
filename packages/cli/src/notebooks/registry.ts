/**
 * The git notebooks this machine knows (T50 G2): `~/.penmoss/notebooks.json`, written whole
 * (0600, a temporary file renamed over it) under its own lock, so two commands never lose each
 * other's change. The Mac app keeps its own registry (A993, A994).
 */
import { lockNotebook, redactRemote } from '@penmoss/git-notebook/node';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError, EXIT } from '../errors';
import type { NotebookEntry } from '../io';
import { cliError } from './errors';

/** What `notebooks.json` keeps of each notebook. */
export interface StoredNotebook extends NotebookEntry {
  /** git's identity when the notebook was added: kept for older files, no longer used (#170 F3). */
  readonly author: { readonly name: string; readonly email: string };
  /** This notebook's own commit identity, over git's (#170 F6: `notebook set --author-email`). */
  readonly identity?: { readonly name: string; readonly email: string };
  readonly added: string;
  /** The host ignored the partial-clone filter at the last sync. */
  readonly filterIgnored?: boolean;
  /** The user name sent with the token (default `x-access-token`, which github.com takes). */
  readonly tokenUser?: string;
  /** False: never sign this notebook's commits (`--no-sign`). Default: as git's config says. */
  readonly sign?: boolean;
}

export interface Registry {
  readonly version: 1;
  readonly notebooks: StoredNotebook[];
}

/** How many former names a clone keeps (Ryan's review of PR #192). */
const MAX_FORMER_NAMES = 5;

export class NotebookRegistry {
  private readonly path: string;

  constructor(
    private readonly home: string,
    private readonly lockWaitMs = 10_000,
  ) {
    this.path = join(home, 'notebooks.json');
  }

  async read(): Promise<Registry> {
    const text = await readFile(this.path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (text === null) return { version: 1, notebooks: [] };
    const parsed = JSON.parse(text) as Partial<Registry>;
    const notebooks = Array.isArray(parsed.notebooks) ? parsed.notebooks : [];
    // An older registry's confirmations (`confirmedPrivate`, gone with D51) and visibility
    // answers (gone with D61) are read and dropped, so the next write leaves them out (A1081).
    return {
      version: 1,
      notebooks: notebooks.map((each) => {
        if (!('confirmedPrivate' in each) && !('visibility' in each)) return each;
        const rest: StoredNotebook & { confirmedPrivate?: unknown; visibility?: unknown } = {
          ...each,
        };
        delete rest.confirmedPrivate;
        delete rest.visibility;
        return rest;
      }),
    };
  }

  private async write(registry: Registry): Promise<void> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    await chmod(this.home, 0o700).catch(() => undefined);
    const temporary = `${this.path}.${process.pid}.tmp`;
    await rm(temporary, { force: true });
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(registry, null, 2)}\n`);
    } finally {
      await handle.close();
    }
    await rename(temporary, this.path);
  }

  /** Changes `notebooks.json` under its own lock, so two commands never lose each other's. */
  async change(change: (registry: Registry) => Registry): Promise<void> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    let lock;
    try {
      lock = await lockNotebook(this.home, 'penmoss (notebooks.json)', {
        file: 'notebooks.lock',
        waitMs: this.lockWaitMs,
        pollMs: 20,
      });
    } catch (error) {
      throw cliError(error, 'notebooks.json');
    }
    try {
      await this.write(change(await this.read()));
    } finally {
      await lock.release();
    }
  }

  /** The clone named `name`, or `notebook_not_found`. */
  async find(name: string): Promise<StoredNotebook> {
    const found = (await this.read()).notebooks.find((each) => each.name === name);
    if (!found) {
      throw new CliError(
        EXIT.NOT_FOUND,
        `No git notebook named “${name}” on this machine.`,
        'notebook_not_found',
        undefined,
        ['List them with penmoss notebook ls, or add one with penmoss notebook add <remote>.'],
      );
    }
    return found;
  }

  /**
   * The clone `--notebook <name>` names (D52): its own name, else its notebook's (`notebook.json`'s,
   * which the Mac app shows and its Copy Agent Reference gives: “Quanta”), exactly, then ignoring
   * case. Of several clones of that notebook, `prefer`'s writer kind comes first (an agent's for
   * `penmoss mcp`, a device's for a person's commands), then the Mac app's own agent clone, then
   * the earliest added. Two notebooks of that name are refused: the clone's own name says which.
   */
  async resolve(name: string, prefer: 'agent' | 'device'): Promise<StoredNotebook> {
    const all = (await this.read()).notebooks;
    const own = all.find((each) => each.name === name);
    if (own) return own;
    const folded = name.toLowerCase();
    // A name the notebook had before a Rename (Ryan's review of PR #192) still finds it, so an
    // agent's MCP config keeps working; a notebook named that now comes first.
    const formerly = (each: StoredNotebook, match: (former: string) => boolean) =>
      (each.formerNames ?? []).some(match);
    const matches =
      [
        all.filter((each) => each.notebookName === name),
        all.filter((each) => each.notebookName?.toLowerCase() === folded),
        all.filter((each) => formerly(each, (former) => former === name)),
        all.filter((each) => formerly(each, (former) => former.toLowerCase() === folded)),
      ].find((list) => list.length > 0) ?? [];
    if (new Set(matches.map((each) => each.notebookId)).size > 1) {
      throw new CliError(
        EXIT.USAGE,
        `Several git notebooks on this machine are named “${name}”.`,
        'notebook_ambiguous',
        { names: matches.map((each) => each.name) },
        [`Pass the clone's own name: ${matches.map((each) => each.name).join(', ')}.`],
      );
    }
    const rank = (each: StoredNotebook) =>
      (each.writer.kind === prefer ? 0 : 2) + (each.automatic ? 0 : 1);
    const best = [...matches].sort(
      (a, b) => rank(a) - rank(b) || a.added.localeCompare(b.added),
    )[0];
    return best ?? this.find(name);
  }

  /** Changes the clone named `name`. */
  async update(name: string, change: (entry: StoredNotebook) => StoredNotebook): Promise<void> {
    await this.change((registry) => ({
      version: 1,
      notebooks: registry.notebooks.map((each) => (each.name === name ? change(each) : each)),
    }));
  }
}

/**
 * A clone whose notebook is now called `name`: the name it had joins its former names (the
 * latest last, at most MAX_FORMER_NAMES), so `--notebook <old name>` still finds it.
 */
export function renamedTo<T extends NotebookEntry>(entry: T, name: string): T {
  if (entry.notebookName === name) return entry;
  const former = [...(entry.formerNames ?? []), ...(entry.notebookName ? [entry.notebookName] : [])]
    .filter((each, at, all) => each !== name && all.lastIndexOf(each) === at)
    .slice(-MAX_FORMER_NAMES);
  const next: T = { ...entry, notebookName: name, formerNames: former };
  if (former.length === 0) delete (next as { formerNames?: readonly string[] }).formerNames;
  return next;
}

/** A clone as commands and `--json` show it: its remote without credentials. */
export function publicEntry(entry: StoredNotebook): NotebookEntry {
  return {
    name: entry.name,
    localId: entry.localId,
    remote: redactRemote(entry.remote),
    branch: entry.branch,
    dir: entry.dir,
    writer: entry.writer,
    ...(entry.notebookId ? { notebookId: entry.notebookId } : {}),
    ...(entry.notebookName ? { notebookName: entry.notebookName } : {}),
    ...(entry.formerNames?.length ? { formerNames: entry.formerNames } : {}),
    ...(entry.automatic ? { automatic: true as const } : {}),
  };
}
