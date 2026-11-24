/**
 * What main keeps of this Mac's git notebooks (T50, A824, A853–A857): `git-notebooks.json`, the
 * registry of each notebook's remote, branch, directory and cadence, and `git-secrets.json`, each
 * notebook's token and writer secret sealed with the Keychain's key and never written in the
 * clear. Both are written whole through a temporary file, one change at a time.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** What `git-notebooks.json` keeps of each notebook on this Mac. */
export interface GitNotebookEntry {
  /** This Mac's own id for the clone (its folder); not the notebook's. */
  readonly localId: string;
  /** The notebook's id (`.penmoss/notebook.json`): its IndexedDB is `penmoss-git-<id>`. */
  readonly notebookId: string;
  /** `notebook.json`'s salt for derived ids, when it has one (`''`: the imported workspace, A1021). */
  readonly salt?: string;
  /** Its name as `notebook.json` has it (or as given for a new one, or as renamed here). */
  readonly name: string;
  /**
   * Renamed on this Mac (Ryan's review of PR #192): the name the engine's window writes to
   * `notebook.json` at its next sync. Goes once a sync reports that name at the branch; until
   * then, a name another device pushed does not replace it.
   */
  readonly pendingName?: string;
  /** True when this Mac makes the notebook (the target held none when it was added). */
  readonly create: boolean;
  readonly remote: string;
  readonly branch: string;
  /** '' or a directory such as `docs/notes` (no slashes at the ends). */
  readonly dir: string;
  /** Push this long after edits settle (A825; default 12 since A1013, 60 before). */
  readonly pushDelayS: number;
  /** Pull this often while the app is in front (A825; default 1 since A1013, 2 before). */
  readonly pullEveryMin: number;
  /** 2: the cadence has been moved to A1013's defaults if it still had A825's (once). */
  readonly cadence?: 2;
  /** The user name sent with a token (github.com needs none). */
  readonly tokenUser?: string;
  /** False: never sign this notebook's commits. Default: as git's config says (A825). */
  readonly sign?: boolean;
  /** This notebook's own commit identity, over git's (#170 F6): a GitHub no-reply address. */
  readonly author?: { readonly name: string; readonly email: string };
  readonly added: string;
  /** The host ignored the partial-clone filter (Status warns that the clone is full). */
  readonly filterIgnored?: boolean;
  /**
   * Notes the Mac's owner confirmed deleting for good (Touch ID) whose purge has not landed yet,
   * with when: only these may a commit delete for good (A855), for `PURGE_TTL_MS`. Each goes
   * once its push lands.
   */
  readonly purges?: readonly PurgeConfirmation[];
}

/** One note the owner confirmed deleting for good, and when (epoch ms). */
export interface PurgeConfirmation {
  readonly id: string;
  readonly at: number;
}

export const LOCAL_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const NOTEBOOK_ID = /^[0-9A-Z]{26}$/;
/** A note's id, as the layout takes it. */
export const NOTE_ID = /^[0-9A-Z]{26}$/;
/** The sync cadence a new notebook gets (A1013; A825's 60 s and 2 min before T57). */
export const CADENCE = { pushDelayS: 12, pullEveryMin: 1 } as const;
const OLD_CADENCE = { pushDelayS: 60, pullEveryMin: 2 } as const;

/**
 * An entry from before A1013 moves to the new cadence once, if it still had the old defaults;
 * one set to anything else keeps it. Marked, so a person who sets 60 s and 2 min later keeps them.
 */
export function withCadence(entry: GitNotebookEntry): GitNotebookEntry {
  if (entry.cadence === 2) return entry;
  const old =
    entry.pushDelayS === OLD_CADENCE.pushDelayS && entry.pullEveryMin === OLD_CADENCE.pullEveryMin;
  return { ...entry, ...(old ? CADENCE : {}), cadence: 2 };
}

export interface Registry {
  readonly version: 1;
  readonly notebooks: GitNotebookEntry[];
}

/**
 * An entry as kept from now on: a confirmation an older Mac stored (`confirmed`, sealed; D51
 * ended them) is left out, so the next write of the registry drops it.
 */
function withoutConfirmation(entry: GitNotebookEntry): GitNotebookEntry {
  if (!('confirmed' in entry)) return entry;
  const rest: Partial<Record<string, unknown>> = { ...entry };
  delete rest['confirmed'];
  return rest as unknown as GitNotebookEntry;
}

interface GitNotebookStoreOptions {
  /** The app's data directory. */
  readonly dir: string;
  /** Encrypts with the Keychain's key; null when it cannot (then nothing is kept on disk). */
  readonly seal: (plain: string) => Promise<string | null>;
  readonly unseal: (sealed: string) => Promise<string | null>;
  /** Told when the registry changes, so every window reads it again. */
  readonly onChange?: () => void;
}

export class GitNotebookStore {
  private readonly registryPath: string;
  private readonly secretsPath: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: GitNotebookStoreOptions) {
    this.registryPath = join(options.dir, 'git-notebooks.json');
    this.secretsPath = join(options.dir, 'git-secrets.json');
  }

  /** One change to the files at a time (main is one process, but calls interleave). */
  serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async registry(): Promise<Registry> {
    try {
      const parsed = JSON.parse(await readFile(this.registryPath, 'utf8')) as Partial<Registry>;
      const notebooks = Array.isArray(parsed.notebooks)
        ? parsed.notebooks.filter((each: unknown): each is GitNotebookEntry => {
            if (typeof each !== 'object' || each === null) return false;
            const entry = each as Partial<Record<keyof GitNotebookEntry, unknown>>;
            return (
              LOCAL_ID.test(String(entry.localId)) &&
              NOTEBOOK_ID.test(String(entry.notebookId)) &&
              typeof entry.remote === 'string' &&
              typeof entry.branch === 'string' &&
              (entry.purges === undefined ||
                (Array.isArray(entry.purges) &&
                  entry.purges.every(
                    (each: unknown) =>
                      typeof each === 'object' &&
                      each !== null &&
                      typeof (each as PurgeConfirmation).id === 'string' &&
                      NOTE_ID.test((each as PurgeConfirmation).id) &&
                      Number.isFinite((each as PurgeConfirmation).at),
                  )))
            );
          })
        : [];
      return {
        version: 1,
        notebooks: notebooks.map((each) => withCadence(withoutConfirmation(each))),
      };
    } catch {
      return { version: 1, notebooks: [] };
    }
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(this.options.dir, { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }

  change(edit: (registry: Registry) => Registry): Promise<void> {
    return this.serial(async () => {
      await this.writeJson(this.registryPath, edit(await this.registry()));
      this.options.onChange?.();
    });
  }

  async entry(localId: unknown): Promise<GitNotebookEntry | null> {
    if (typeof localId !== 'string' || !LOCAL_ID.test(localId)) return null;
    return (await this.registry()).notebooks.find((each) => each.localId === localId) ?? null;
  }

  // --- secrets: sealed with the Keychain key, never written in the clear ---

  async secrets(): Promise<Record<string, string>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.secretsPath, 'utf8'));
      return typeof parsed === 'object' && parsed !== null
        ? Object.fromEntries(
            Object.entries(parsed).filter(
              (pair): pair is [string, string] => typeof pair[1] === 'string',
            ),
          )
        : {};
    } catch {
      return {};
    }
  }

  async secret(key: string): Promise<string | null> {
    const sealed = (await this.secrets())[key];
    return sealed ? this.options.unseal(sealed).catch(() => null) : null;
  }

  setSecret(key: string, plain: string | null): Promise<boolean> {
    return this.serial(async () => {
      const secrets = await this.secrets();
      if (plain === null) {
        delete secrets[key];
      } else {
        const sealed = await this.options.seal(plain);
        if (sealed === null) return false;
        secrets[key] = sealed;
      }
      await this.writeJson(this.secretsPath, secrets);
      return true;
    });
  }

  token(entry: GitNotebookEntry): Promise<string | null> {
    return this.secret(`token:${entry.localId}`);
  }

  /** The registry, written whole (inside `serial`, after reading it there). */
  write(registry: Registry): Promise<void> {
    return this.writeJson(this.registryPath, registry);
  }
}
