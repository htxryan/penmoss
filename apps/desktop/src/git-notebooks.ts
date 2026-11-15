/**
 * Git notebooks in the Mac app's main process (T50 G3 and G5: #151, #153; A824, A853–A857).
 *
 * The page runs each notebook's engine (`@penmoss/git-notebook`) and keeps its docs in IndexedDB;
 * main runs git for it (the `penmoss:git:*` channels), so the page never reaches a git host and
 * never holds a credential. Per notebook main keeps:
 *
 * - its entry in `git-notebooks.json` (remote, branch, directory, cadence, signing);
 * - a bare partial clone in `git-notebooks/<localId>/repo.git` (A837), which is disposable;
 * - a personal access token and the writer's secret (A821) in `git-secrets.json`, each encrypted
 *   with `safeStorage` (the Keychain's "Penmoss Safe Storage" key). The token goes to git through
 *   `GIT_ASKPASS` (NodeGitTransport) and never back to the page.
 *
 * A notebook syncs with whatever repository it names, and git follows its own configuration:
 * Penmoss asks GitHub nothing about privacy (D61) and refuses no rewrite (D62).
 *
 * Removing a notebook and Delete for good ask the Mac's owner first too (D34), as admin changes do.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ulid } from '@penmoss/core/ids';
import {
  GitTransportError,
  gitRunner,
  NodeGitTransport,
  redactRemote,
  remoteParts,
} from '@penmoss/git-notebook/system-git';
import { validCommitEmail, validCommitName } from '@penmoss/git-notebook/identity';
import { cleanNotebookName, NOTEBOOK_NAME_MAX } from '@penmoss/git-notebook/layout';
import { commitPurges, commitWriter, purgedAt, titlesAt } from '@penmoss/git-notebook/purge-check';

import { isolatedTitle } from '@penmoss/core/titles';

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

/** What the page is told about a notebook: never its token. */
export interface GitNotebookView {
  readonly localId: string;
  readonly notebookId: string;
  readonly salt?: string;
  readonly name: string;
  /** Renamed here and not yet in `notebook.json` (Ryan's review of PR #192); null: none. */
  readonly pendingName: string | null;
  readonly create: boolean;
  /** Credentials in a remote are refused at add, so this is the remote as given. */
  readonly remote: string;
  /** `github.com/owner/repo`, or the host and path: how Status names the repository. */
  readonly repository: string;
  readonly host: string;
  readonly branch: string;
  readonly dir: string;
  readonly pushDelayS: number;
  readonly pullEveryMin: number;
  readonly sign: boolean;
  /** This notebook's own commit identity (#170 F6), or null for git's. */
  readonly author: { readonly name: string; readonly email: string } | null;
  readonly hasToken: boolean;
  readonly filterIgnored: boolean;
}

/** A refusal the page shows as it is. */
export interface GitRefusal {
  readonly code: string;
  readonly message: string;
  readonly hostMessage?: string;
}

export type GitAnswer<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: GitRefusal };

/** The transport calls the page's engine makes (GitTransport, A836). */
export const TRANSPORT_OPS = [
  'fetch',
  'list',
  'sizes',
  'changed',
  'read',
  'commit',
  'push',
  'log',
  'readAt',
  'readDir',
  'maintain',
] as const;
export type TransportOp = (typeof TRANSPORT_OPS)[number];

export interface OwnerCheck {
  /** Asks the Mac's owner (Touch ID, or the password) with these words (main's own). */
  (
    words: string,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
}

export interface GitNotebooksOptions {
  /** The app's data directory. */
  readonly dir: string;
  /** Encrypts with the Keychain's key; null when it cannot (then nothing is kept on disk). */
  readonly seal: (plain: string) => Promise<string | null>;
  readonly unseal: (sealed: string) => Promise<string | null>;
  readonly ownerCheck: OwnerCheck;
  readonly platform: NodeJS.Platform;
  /** Extra environment for git (the suite isolates git's config with it). */
  readonly gitEnv?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
  /** Told when the list changes, so every window reads it again. */
  readonly onChange?: () => void;
}

const SECRET = /^[A-Za-z0-9_.~+/=-]{8,1000}$/;
const TOKEN_USER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const LOCAL_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const NOTEBOOK_ID = /^[0-9A-Z]{26}$/;
/** A note's id, as the layout takes it. */
const NOTE_ID = /^[0-9A-Z]{26}$/;
/** A note a sync would delete for good, as Settings lists it before confirming again (A855). */
export interface PendingPurge {
  readonly id: string;
  /** Its title at head ('' for none). */
  readonly title: string;
  /** Confirmed on this Mac once already (its confirmation ran out); false: never confirmed here. */
  readonly confirmedBefore: boolean;
}

/** At most this many confirmed purges wait for their push. */
const MAX_PURGES = 1000;
/**
 * A Delete for good confirmed with Touch ID counts this long for a first commit to carry it; a
 * commit main let through keeps it until that push lands (in this run of the app).
 */
export const PURGE_TTL_MS = 10 * 60_000;
/** How long a notebook may be named (the sidebar shows it). */
export const MAX_NAME = NOTEBOOK_NAME_MAX;

/** A refusal from main's own checks inside a transport call (not git's). */
class Refused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const refuse = (code: string, message: string, hostMessage?: string): GitRefusal => ({
  code,
  message,
  ...(hostMessage ? { hostMessage } : {}),
});

/** How the person sees a repository: `github.com/owner/repo`, or the host and path. */
export function repositoryName(remote: string): string {
  const parts = remoteParts(remote);
  if (!parts) return redactRemote(remote);
  if (parts.protocol === 'file') return `this Mac: ${parts.path}`;
  return `${parts.host}/${parts.path}`;
}

/** A repository in the owner check's words: `github.com/owner/repo`, or a path on this Mac. */
export function repositoryWords(remote: string): string {
  const parts = remoteParts(remote);
  if (parts?.protocol === 'file') return `${parts.path} on this Mac`;
  return repositoryName(remote);
}

/** A notebook directory as stored: no slashes at the ends, no `.` or `..`, or null if invalid. */
export function cleanDir(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
  if (trimmed === '') return '';
  const parts = trimmed.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part === '.git')) {
    return null;
  }
  if (trimmed.length > 200 || /[\p{Cc}\\]/u.test(trimmed)) return null;
  return trimmed;
}

/**
 * A note as an owner check names it (A855), last in the words: its title from the branch in
 * brackets, isolated from the words around it (U+2068…U+2069, so right-to-left letters in it
 * cannot reorder them), with control and format characters (bidi, zero-width), brackets and
 * double-quote look-alikes taken out, at most 60 characters; else "an untitled note" and its id's end.
 */
export function noteWords(id: string, title: string | undefined): string {
  const isolated = isolatedTitle(title);
  return isolated ? `[${isolated}]` : `an untitled note (…${id.slice(-6)})`;
}

/** The longest the owner check's words get (the password helper's limit). */
const MAX_WORDS = 200;

/**
 * Words for the owner check: no line breaks, at most 200 characters (the helper's limit). A cut
 * never lands inside a character (a surrogate pair) or inside an isolated title (`noteWords`): it
 * goes before the title's bracket instead, so a title is shown whole or not at all.
 */
export function checkWords(text: string): string {
  const flat = text.replace(/\p{Cc}+/gu, ' ').trim();
  if (flat.length <= MAX_WORDS) return flat;
  let cut = MAX_WORDS - 3;
  const open = flat.lastIndexOf('\u2068', cut);
  if (open >= 0) {
    const close = flat.indexOf('\u2069', open);
    // The title and its closing bracket must both come before the cut.
    if (close < 0 || close + 2 > cut) cut = open > 0 && flat[open - 1] === '[' ? open - 1 : open;
  }
  if (cut > 0 && /[\uD800-\uDBFF]/u.test(flat[cut - 1] ?? '')) cut--;
  return `${flat.slice(0, cut).trimEnd()}…`;
}

/**
 * `before` + `path` + `after` as the owner check's words, shortening only `path` (a repository or
 * a folder on this Mac) with an ellipsis in its middle, so the note `after` names always shows
 * whole within the 200 characters. `checkWords` cuts the end when even that cannot fit.
 */
export function fitWords(before: string, path: string, after: string): string {
  const flat = (text: string) => text.replace(/\p{Cc}+/gu, ' ');
  const shown = flat(path);
  const room = MAX_WORDS - flat(before).length - flat(after).length;
  if (shown.length <= room || room < 9) return checkWords(before + shown + after);
  let head = Math.ceil((room - 1) / 2);
  let tail = room - 1 - head;
  if (/[\uD800-\uDBFF]/u.test(shown[head - 1] ?? '')) head--;
  if (/[\uDC00-\uDFFF]/u.test(shown[shown.length - tail] ?? '')) tail--;
  return checkWords(`${before}${shown.slice(0, head)}…${shown.slice(shown.length - tail)}${after}`);
}

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

interface Registry {
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

export class GitNotebooks {
  private readonly registryPath: string;
  private readonly secretsPath: string;
  private readonly transports = new Map<string, NodeGitTransport>();
  /** Commits made with confirmed purges in them, until their push lands. */
  private readonly commitPurges = new Map<string, readonly string[]>();
  /** Per notebook: purges a commit main let through carried, until they land (no TTL then). */
  private readonly approvedPurges = new Map<string, Set<string>>();
  /** Per notebook: the notes main's last refused commit would have deleted for good unconfirmed. */
  private readonly refusedPurges = new Map<string, readonly string[]>();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly options: GitNotebooksOptions) {
    this.registryPath = join(options.dir, 'git-notebooks.json');
    this.secretsPath = join(options.dir, 'git-secrets.json');
    this.now = options.now ?? Date.now;
  }

  /** Clones live here (A837): `git-notebooks/<localId>/repo.git`. */
  cloneDir(localId: string): string {
    return join(this.options.dir, 'git-notebooks', localId);
  }

  /** One change to the files at a time (main is one process, but calls interleave). */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async readRegistry(): Promise<Registry> {
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

  private change(edit: (registry: Registry) => Registry): Promise<void> {
    return this.serial(async () => {
      await this.writeJson(this.registryPath, edit(await this.readRegistry()));
      this.options.onChange?.();
    });
  }

  private async entry(localId: unknown): Promise<GitNotebookEntry | null> {
    if (typeof localId !== 'string' || !LOCAL_ID.test(localId)) return null;
    return (await this.readRegistry()).notebooks.find((each) => each.localId === localId) ?? null;
  }

  // --- secrets: sealed with the Keychain key, never written in the clear ---

  private async readSecrets(): Promise<Record<string, string>> {
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

  private async getSecret(key: string): Promise<string | null> {
    const sealed = (await this.readSecrets())[key];
    return sealed ? this.options.unseal(sealed).catch(() => null) : null;
  }

  private setSecret(key: string, plain: string | null): Promise<boolean> {
    return this.serial(async () => {
      const secrets = await this.readSecrets();
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

  private token(entry: GitNotebookEntry): Promise<string | null> {
    return this.getSecret(`token:${entry.localId}`);
  }

  /**
   * What an agent's clone of this notebook needs (T54, A993): its target, token, signing and
   * commit identity. For main alone, never the page: the token is in it.
   */
  async forAgent(localId: unknown): Promise<{
    readonly entry: GitNotebookEntry;
    readonly token: string | null;
  } | null> {
    const entry = await this.entry(localId);
    if (!entry) return null;
    return { entry, token: await this.token(entry) };
  }

  /** Every notebook with its token, for main only: the agents' clones made for each (D52). */
  async forAgents(): Promise<
    { readonly entry: GitNotebookEntry; readonly token: string | null }[]
  > {
    const registry = await this.readRegistry();
    return Promise.all(
      registry.notebooks.map(async (entry) => ({ entry, token: await this.token(entry) })),
    );
  }

  // --- the list ---

  async list(): Promise<GitNotebookView[]> {
    const registry = await this.readRegistry();
    const secrets = await this.readSecrets();
    return registry.notebooks.map((entry) => this.view(entry, `token:${entry.localId}` in secrets));
  }

  private view(entry: GitNotebookEntry, hasToken: boolean): GitNotebookView {
    const parts = remoteParts(entry.remote);
    return {
      localId: entry.localId,
      notebookId: entry.notebookId,
      ...(entry.salt !== undefined ? { salt: entry.salt } : {}),
      name: entry.name,
      pendingName: entry.pendingName ?? null,
      create: entry.create,
      remote: redactRemote(entry.remote),
      repository: repositoryName(entry.remote),
      host: parts?.host || 'this Mac',
      branch: entry.branch,
      dir: entry.dir,
      pushDelayS: entry.pushDelayS,
      pullEveryMin: entry.pullEveryMin,
      sign: entry.sign !== false,
      author: entry.author ?? null,
      hasToken,
      filterIgnored: entry.filterIgnored === true,
    };
  }

  // --- add and remove ---

  /**
   * Settings → Notebooks → Add (A856). Joins the notebook the target holds, or makes one when
   * it holds none and a name is given; asks for a name otherwise. Any repository will do (D61).
   */
  async add(input: {
    readonly remote: unknown;
    readonly branch: unknown;
    readonly dir: unknown;
    readonly name?: unknown;
    /**
     * The notebook's own token from the start (A1171): Penmoss's GitHub sign-in, when the
     * repository was picked with it. Main passes it; the page never has it.
     */
    readonly token?: string | null;
  }): Promise<
    GitAnswer<
      | { readonly kind: 'added'; readonly notebook: GitNotebookView; readonly created: boolean }
      | { readonly kind: 'needs-name' }
    >
  > {
    const remote = typeof input.remote === 'string' ? input.remote.trim() : '';
    const parts = remoteParts(remote);
    if (!parts || remote.length > 2000) {
      return {
        ok: false,
        error: refuse(
          'invalid_remote',
          'That is not a git remote: give an https:// or ssh:// URL, or git@host:owner/repo.',
        ),
      };
    }
    if (parts.credentials) {
      return {
        ok: false,
        error: refuse(
          'remote_credentials',
          'The remote has a user name or password in it. Give the remote without it, and the token in its own field.',
        ),
      };
    }
    const branch =
      typeof input.branch === 'string' && input.branch.trim() ? input.branch.trim() : 'main';
    if (!(await this.branchOk(branch))) {
      return {
        ok: false,
        error: refuse('invalid_branch', `“${branch}” is not a branch name git takes.`),
      };
    }
    const dir = cleanDir(input.dir ?? '');
    if (dir === null) {
      return {
        ok: false,
        error: refuse(
          'invalid_dir',
          'The directory must be a path inside the repository, such as docs/notes.',
        ),
      };
    }
    const name =
      typeof input.name === 'string' && input.name.trim()
        ? input.name.trim().slice(0, MAX_NAME)
        : null;
    const registry = await this.readRegistry();
    if (
      registry.notebooks.some(
        (each) => each.remote === remote && each.branch === branch && each.dir === dir,
      )
    ) {
      return {
        ok: false,
        error: refuse('notebook_exists', 'This notebook is on this Mac already.'),
      };
    }
    const localId = ulid(this.now());
    const draft: GitNotebookEntry = {
      localId,
      notebookId: '0'.repeat(26),
      name: name ?? '',
      create: false,
      remote,
      branch,
      dir,
      pushDelayS: CADENCE.pushDelayS,
      pullEveryMin: CADENCE.pullEveryMin,
      cadence: 2,
      added: new Date(this.now()).toISOString(),
    };
    const token = typeof input.token === 'string' && SECRET.test(input.token) ? input.token : null;
    if (token !== null && !(await this.setSecret(`token:${localId}`, token))) {
      return {
        ok: false,
        error: refuse(
          'no_keychain',
          'Penmoss could not keep the token: the Keychain is not available.',
        ),
      };
    }
    const forget = async () => {
      if (token !== null) await this.setSecret(`token:${localId}`, null).catch(() => undefined);
    };
    const transport = this.transportFor(draft);
    try {
      await transport.init();
      const head = await transport.fetch();
      const root = dir ? `${dir}/` : '';
      const info = head
        ? (await transport.read(head, [`${root}.penmoss/notebook.json`])).get(
            `${root}.penmoss/notebook.json`,
          )
        : undefined;
      let notebookId: string;
      let notebookName: string;
      let salt: string | undefined;
      let create = false;
      if (info) {
        const parsed = JSON.parse(new TextDecoder().decode(info)) as {
          id?: unknown;
          name?: unknown;
          salt?: unknown;
        };
        if (typeof parsed.id !== 'string' || !NOTEBOOK_ID.test(parsed.id)) {
          throw new GitTransportError(
            'git',
            'The target holds a notebook.json Penmoss cannot read.',
          );
        }
        notebookId = parsed.id;
        // The imported workspace's notebook keeps its ids unsalted (A1021): the page derives
        // its Journal with this.
        if (typeof parsed.salt === 'string') salt = parsed.salt;
        notebookName =
          typeof parsed.name === 'string' && parsed.name
            ? parsed.name.slice(0, MAX_NAME)
            : 'Notebook';
      } else {
        if (!name) {
          await rm(this.cloneDir(localId), { recursive: true, force: true });
          this.transports.delete(localId);
          await forget();
          return { ok: true, value: { kind: 'needs-name' } };
        }
        notebookId = ulid(this.now());
        notebookName = name;
        create = true;
      }
      if (registry.notebooks.some((each) => each.notebookId === notebookId)) {
        await rm(this.cloneDir(localId), { recursive: true, force: true });
        this.transports.delete(localId);
        await forget();
        return {
          ok: false,
          error: refuse(
            'notebook_exists',
            `The notebook “${notebookName}” is on this Mac already.`,
          ),
        };
      }
      const entry: GitNotebookEntry = {
        ...draft,
        notebookId,
        ...(salt !== undefined ? { salt } : {}),
        name: notebookName,
        create,
        ...(transport.notes.filterIgnored ? { filterIgnored: true } : {}),
      };
      await this.change((current) => ({ version: 1, notebooks: [...current.notebooks, entry] }));
      return {
        ok: true,
        value: { kind: 'added', notebook: this.view(entry, token !== null), created: create },
      };
    } catch (error) {
      await rm(this.cloneDir(localId), { recursive: true, force: true }).catch(() => undefined);
      this.transports.delete(localId);
      await forget();
      return { ok: false, error: this.refusal(error) };
    }
  }

  /**
   * Remove (A856): asks the Mac's owner first, then forgets the clone and its secrets. The page
   * says how many changes are not pushed (notes, and the folder tree as one: its engine knows,
   * main does not): with any, or
   * when it cannot tell, the owner check says they are lost. The words are main's own, and name
   * the repository, never the notebook's name (the repository sets that).
   */
  async remove(
    localId: unknown,
    unpushed: unknown = 0,
  ): Promise<GitAnswer<{ readonly notebookId: string }>> {
    const entry = await this.entry(localId);
    if (!entry) return { ok: false, error: refuse('not_found', 'No such git notebook.') };
    const repository = repositoryWords(entry.remote);
    const lost =
      typeof unpushed === 'number' && Number.isInteger(unpushed) && unpushed >= 0
        ? unpushed === 0
          ? ''
          : ` and lose ${unpushed} ${unpushed === 1 ? 'change' : 'changes'} never pushed`
        : ' and lose any changes not pushed yet';
    const asked = await this.options.ownerCheck(
      fitWords('remove the git notebook at ', repository, ` from this Mac${lost}`),
    );
    if (!asked.ok) return { ok: false, error: refuse('not_confirmed', asked.message) };
    await this.change((registry) => ({
      version: 1,
      notebooks: registry.notebooks.filter((each) => each.localId !== entry.localId),
    }));
    this.transports.get(entry.localId)?.cancel();
    this.transports.delete(entry.localId);
    await rm(this.cloneDir(entry.localId), { recursive: true, force: true });
    await this.setSecret(`token:${entry.localId}`, null);
    await this.setSecret(`writer:${entry.localId}`, null);
    return { ok: true, value: { notebookId: entry.notebookId } };
  }

  /**
   * Delete for good in a git notebook (D34, A828, A855): the owner check, in main's own words,
   * for one note of one notebook. Only a commit that deletes for good a note confirmed here gets
   * through `op` (the page's own word is not enough); the confirmation goes once its push lands.
   */
  async purgeCheck(localId: unknown, noteIds: unknown): Promise<GitAnswer<null>> {
    const entry = await this.entry(localId);
    if (!entry) return { ok: false, error: refuse('not_found', 'No such git notebook.') };
    const list = typeof noteIds === 'string' ? [noteIds] : noteIds;
    if (
      !Array.isArray(list) ||
      list.length === 0 ||
      list.length > MAX_PURGES ||
      !list.every((id) => typeof id === 'string' && NOTE_ID.test(id))
    ) {
      return { ok: false, error: refuse('invalid_request', 'Not a note id.') };
    }
    let wanted = [...new Set(list as string[])];
    const where = repositoryWords(entry.remote);
    let words: string;
    if (!Array.isArray(noteIds)) {
      // The note named as the branch has it, never as the page says (a page script may ask for
      // any id): the count and its title first, so the 200-character cut only trims the path.
      const transport = this.transportFor(entry);
      const id = wanted[0]!;
      const titles = await titlesAt(
        transport,
        entry.dir ? `${entry.dir}/` : '',
        await transport.head(),
        [id],
      );
      words = fitWords(
        'delete 1 note for good (git history keeps it) in the git notebook at ',
        where,
        `: ${noteWords(id, titles.get(id))}`,
      );
    } else {
      // Confirming again (a confirmation ran out before its sync): only notes this Mac confirmed
      // once already, whose confirmation ran out, and not deleted on the branch yet. A note the
      // owner never confirmed here (a page script marked it) is refused, never confirmed with them.
      const transport = this.transportFor(entry);
      const landed = await purgedAt(
        transport,
        entry.dir ? `${entry.dir}/` : '',
        await transport.head(),
      );
      wanted = wanted.filter((id) => !landed.has(id));
      const held = new Map((entry.purges ?? []).map((one) => [one.id, one.at]));
      const never = wanted.filter((id) => !held.has(id));
      if (never.length > 0) {
        return {
          ok: false,
          error: refuse(
            'never_confirmed',
            `${never.length === 1 ? 'A note' : `${never.length} notes`} here ${never.length === 1 ? 'was' : 'were'} never confirmed for Delete for good on this Mac, so none was confirmed again and the sync stays stopped.`,
          ),
        };
      }
      const now = this.now();
      const approved = this.approvedPurges.get(entry.localId);
      wanted = wanted.filter((id) => now - held.get(id)! >= PURGE_TTL_MS && !approved?.has(id));
      if (wanted.length === 0) return { ok: true, value: null };
      const count = wanted.length === 1 ? '1 note' : `${wanted.length} notes`;
      // The count and "once already" first: a long path is what gets cut.
      words = fitWords(
        `delete ${count} for good, confirmed once already on this Mac (git history keeps ${wanted.length === 1 ? 'it' : 'them'}), in the git notebook at `,
        where,
        '',
      );
    }
    const asked = await this.options.ownerCheck(words);
    if (!asked.ok) return { ok: false, error: refuse('not_confirmed', asked.message) };
    const at = this.now();
    await this.change((registry) => ({
      version: 1,
      notebooks: registry.notebooks.map((each) => {
        if (each.localId !== entry.localId) return each;
        const kept = (each.purges ?? []).filter((one) => !wanted.includes(one.id));
        return {
          ...each,
          purges: [...kept, ...wanted.map((id) => ({ id, at }))].slice(-MAX_PURGES),
        };
      }),
    }));
    return { ok: true, value: null };
  }

  /**
   * History's restore or revert in a git notebook (A877, A901): the owner check, in main's own
   * words, naming the note as the branch has it, as Android's does. Both are ordinary edits that
   * History undoes, so nothing is recorded: the answer is the page's to wait for.
   */
  async restoreCheck(localId: unknown, noteId: unknown, revert: unknown): Promise<GitAnswer<null>> {
    const entry = await this.entry(localId);
    if (!entry) return { ok: false, error: refuse('not_found', 'No such git notebook.') };
    if (typeof noteId !== 'string' || !NOTE_ID.test(noteId)) {
      return { ok: false, error: refuse('invalid_request', 'Not a note id.') };
    }
    const transport = this.transportFor(entry);
    const titles = await titlesAt(
      transport,
      entry.dir ? `${entry.dir}/` : '',
      await transport.head(),
      [noteId],
    );
    const what =
      revert === true
        ? 'undo an earlier change (the note as it is now is saved as a version first)'
        : 'restore an earlier version (the note as it is now is saved as a version first)';
    const asked = await this.options.ownerCheck(
      fitWords(
        `${what} in the git notebook at `,
        repositoryWords(entry.remote),
        `: ${noteWords(noteId, titles.get(noteId))}`,
      ),
    );
    if (!asked.ok) return { ok: false, error: refuse('not_confirmed', asked.message) };
    return { ok: true, value: null };
  }

  /**
   * What "Confirm Delete for good" in Settings would confirm again (A855), named by main from the
   * branch: the notes the last refused sync would have deleted for good, and those confirmed here
   * whose confirmation ran out, not deleted on the branch yet. `confirmedBefore` false: never
   * confirmed on this Mac, so it cannot be confirmed again.
   */
  async purgesToConfirm(
    localId: unknown,
    also: unknown = [],
  ): Promise<GitAnswer<readonly PendingPurge[]>> {
    const entry = await this.entry(localId);
    if (!entry) return { ok: false, error: refuse('not_found', 'No such git notebook.') };
    // `also`: notes asked about by id (Keep note checks one has not landed), listed whatever
    // their confirmation, unless deleted on the branch.
    if (
      !Array.isArray(also) ||
      also.length > MAX_PURGES ||
      !also.every((id) => typeof id === 'string' && NOTE_ID.test(id))
    ) {
      return { ok: false, error: refuse('invalid_request', 'Not a note id.') };
    }
    const now = this.now();
    const approved = this.approvedPurges.get(entry.localId);
    const held = new Map((entry.purges ?? []).map((one) => [one.id, one.at]));
    const needs = (id: string) =>
      !held.has(id) || (now - held.get(id)! >= PURGE_TTL_MS && !approved?.has(id));
    const ids = [
      ...new Set([
        ...[...new Set([...(this.refusedPurges.get(entry.localId) ?? []), ...held.keys()])].filter(
          needs,
        ),
        ...(also as string[]),
      ]),
    ];
    if (ids.length === 0) return { ok: true, value: [] };
    const transport = this.transportFor(entry);
    const root = entry.dir ? `${entry.dir}/` : '';
    const head = await transport.head();
    const landed = await purgedAt(transport, root, head);
    const left = ids.filter((id) => !landed.has(id));
    const titles = await titlesAt(transport, root, head, left);
    return {
      ok: true,
      value: left.map((id) => ({
        id,
        title: titles.get(id) ?? '',
        confirmedBefore: held.has(id),
      })),
    };
  }

  /**
   * The cadence and signing, per notebook on this Mac (A825), and its name (Ryan's review of PR
   * #192): `name` is Rename's (written to `notebook.json` by the engine's window at its next
   * sync), `branchName` what a sync found there (another device's rename, or this Mac's landing).
   */
  async update(localId: unknown, patch: unknown): Promise<GitAnswer<GitNotebookView>> {
    if (typeof localId !== 'string' || !LOCAL_ID.test(localId)) {
      return { ok: false, error: refuse('invalid_request', 'No such git notebook.') };
    }
    // Read and written in one turn: a sync's name report never undoes a change made meanwhile.
    const answer = await this.serial(async (): Promise<GitAnswer<GitNotebookEntry>> => {
      const registry = await this.readRegistry();
      const entry = registry.notebooks.find((each) => each.localId === localId);
      if (!entry || typeof patch !== 'object' || patch === null) {
        return { ok: false, error: refuse('invalid_request', 'No such git notebook.') };
      }
      const patched = this.patched(entry, patch as Record<string, unknown>);
      // Nothing changed (a sync reporting the name it had): no write, and no list sent again.
      if (patched.ok && JSON.stringify(patched.value) !== JSON.stringify(entry)) {
        await this.writeJson(this.registryPath, {
          version: 1,
          notebooks: registry.notebooks.map((each) =>
            each.localId === entry.localId ? patched.value : each,
          ),
        });
        this.options.onChange?.();
      }
      return patched;
    });
    if (!answer.ok) return answer;
    const secrets = await this.readSecrets();
    return { ok: true, value: this.view(answer.value, `token:${answer.value.localId}` in secrets) };
  }

  /** `update`'s patch on one entry, or why not. */
  private patched(
    entry: GitNotebookEntry,
    value: Record<string, unknown>,
  ): GitAnswer<GitNotebookEntry> {
    const next: { -readonly [K in keyof GitNotebookEntry]: GitNotebookEntry[K] } = { ...entry };
    if (value['name'] !== undefined) {
      const name = cleanNotebookName(value['name']);
      if (name === null) {
        return { ok: false, error: refuse('invalid_request', 'A notebook needs a name.') };
      }
      next.name = name;
      next.pendingName = name;
    }
    if (value['branchName'] !== undefined) {
      const name = cleanNotebookName(value['branchName']);
      if (name === null) {
        return { ok: false, error: refuse('invalid_request', 'Not a notebook name.') };
      }
      if (next.pendingName === undefined) next.name = name;
      else if (next.pendingName === name) delete next.pendingName;
    }
    if (value['pushDelayS'] !== undefined) {
      const seconds = Number(value['pushDelayS']);
      if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600) {
        return { ok: false, error: refuse('invalid_request', 'Push after: 5 seconds to an hour.') };
      }
      next.pushDelayS = seconds;
    }
    if (value['pullEveryMin'] !== undefined) {
      const minutes = Number(value['pullEveryMin']);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
        return { ok: false, error: refuse('invalid_request', 'Pull every: 1 minute to a day.') };
      }
      next.pullEveryMin = minutes;
    }
    if (value['sign'] !== undefined) {
      if (typeof value['sign'] !== 'boolean') {
        return { ok: false, error: refuse('invalid_request', 'sign is true or false.') };
      }
      if (value['sign']) delete next.sign;
      else next.sign = false;
      this.transports.delete(entry.localId);
    }
    if (value['author'] !== undefined) {
      const author = commitAuthor(value['author']);
      if (author === undefined) {
        return {
          ok: false,
          error: refuse(
            'invalid_request',
            'A commit identity is a name and an email address (such as 1234+you@users.noreply.github.com), on one line each.',
          ),
        };
      }
      if (author === null) delete next.author;
      else next.author = author;
    }
    if (value['tokenUser'] !== undefined) {
      const user = value['tokenUser'];
      if (user !== null && (typeof user !== 'string' || !TOKEN_USER.test(user))) {
        return {
          ok: false,
          error: refuse('invalid_request', 'A token user name is letters, digits, ., _ and -.'),
        };
      }
      if (user === null) delete next.tokenUser;
      else next.tokenUser = user;
      this.transports.delete(entry.localId);
    }
    return { ok: true, value: next };
  }

  /**
   * Settings → Notebooks → Use a personal access token (A857): written only, never read back
   * by the page; null forgets it.
   */
  async setToken(localId: unknown, token: unknown): Promise<GitAnswer<null>> {
    const entry = await this.entry(localId);
    if (!entry) return { ok: false, error: refuse('not_found', 'No such git notebook.') };
    if (token !== null && (typeof token !== 'string' || !SECRET.test(token.trim()))) {
      return { ok: false, error: refuse('invalid_token', 'That does not look like a token.') };
    }
    const kept = await this.setSecret(
      `token:${entry.localId}`,
      token === null ? null : token.trim(),
    );
    if (!kept) {
      return {
        ok: false,
        error: refuse(
          'no_keychain',
          'Penmoss could not keep the token: the Keychain is not available.',
        ),
      };
    }
    this.options.onChange?.();
    return { ok: true, value: null };
  }

  /** The writer's secret (A821), for the page's engine: get, or set once made. */
  async writerSecret(localId: unknown, value?: unknown): Promise<GitAnswer<string | null>> {
    const entry = await this.entry(localId);
    if (!entry) return { ok: false, error: refuse('not_found', 'No such git notebook.') };
    const key = `writer:${entry.localId}`;
    if (value === undefined) return { ok: true, value: await this.getSecret(key) };
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
      return { ok: false, error: refuse('invalid_request', 'Not a writer secret.') };
    }
    // Without the Keychain the writer is new at every launch (A821 keeps that safe).
    if (!(await this.setSecret(key, value)))
      this.options.log?.('no Keychain: a new git writer each launch');
    return { ok: true, value: null };
  }

  /** Who commits from this Mac: git's own identity (A825). */
  async identity(): Promise<{ readonly name: string; readonly email: string }> {
    const git = gitRunner({ env: { GIT_DIR: undefined, ...this.options.gitEnv } });
    const read = async (key: string) => {
      for (const scope of ['--global', '--system']) {
        try {
          const value = (await git(['config', scope, '--get', key], { ok: [0, 1] })).stdout
            .toString('utf8')
            .trim();
          if (value) return value;
        } catch {
          // No such file: the next scope.
        }
      }
      return '';
    };
    return {
      name: (await read('user.name')) || 'Penmoss on this Mac',
      email: (await read('user.email')) || 'penmoss@localhost',
    };
  }

  private async branchOk(branch: string): Promise<boolean> {
    if (branch.startsWith('-') || branch.length > 200) return false;
    try {
      const done = await gitRunner({ env: { GIT_DIR: undefined, ...this.options.gitEnv } })(
        ['check-ref-format', '--branch', branch],
        { ok: [0, 1, 128] },
      );
      return done.code === 0;
    } catch {
      return false;
    }
  }

  /**
   * Who commits a notebook's next commit (#170 F3, F6): its own identity when it has one, else
   * git's, read again for each commit, so a changed `user.email` applies without a relaunch.
   */
  private async authorOf(localId: string): Promise<{ name: string; email: string }> {
    const entry = await this.entry(localId);
    return entry?.author ?? this.identity();
  }

  private transportFor(entry: GitNotebookEntry): NodeGitTransport {
    const known = this.transports.get(entry.localId);
    if (known) return known;
    const author = () => this.authorOf(entry.localId);
    const transport = new NodeGitTransport({
      gitDir: join(this.cloneDir(entry.localId), 'repo.git'),
      remote: entry.remote,
      branch: entry.branch,
      root: entry.dir ? `${entry.dir}/` : '',
      author,
      token: () => this.token(entry),
      ...(entry.tokenUser ? { tokenUser: entry.tokenUser } : {}),
      ...(entry.sign === false ? { sign: false } : {}),
      // Nobody answers a signer's prompt from a sync in the background (A838).
      signTimeoutMs: 15_000,
      platform: this.options.platform,
      ...(this.options.gitEnv ? { env: this.options.gitEnv } : {}),
    });
    this.transports.set(entry.localId, transport);
    return transport;
  }

  /** A git failure as the page shows it: the code, our words, the host's (A824). */
  refusal(error: unknown): GitRefusal {
    if (error instanceof Refused) return refuse(error.code, error.message);
    if (error instanceof GitTransportError) {
      return refuse(error.code, error.message, error.hostMessage);
    }
    return refuse('git', error instanceof Error ? error.message : String(error));
  }

  /**
   * One transport call for the page's engine (A836, A853). Arguments are checked here, never
   * trusted from the page.
   */
  async op(localId: unknown, op: unknown, args: unknown): Promise<GitAnswer<unknown>> {
    const entry = await this.entry(localId);
    if (!entry) return { ok: false, error: refuse('not_found', 'No such git notebook.') };
    if (typeof op !== 'string' || !(TRANSPORT_OPS as readonly string[]).includes(op)) {
      return { ok: false, error: refuse('invalid_request', 'Unknown git call.') };
    }
    const call = op as TransportOp;
    const list = Array.isArray(args) ? (args as unknown[]) : [];
    if (remoteParts(entry.remote)?.credentials !== false) {
      return {
        ok: false,
        error: refuse('remote_credentials', 'The remote has a user name or password in it.'),
      };
    }
    try {
      const transport = this.transportFor(entry);
      await transport.init();
      return { ok: true, value: await this.run(transport, call, list, entry) };
    } catch (error) {
      return { ok: false, error: this.refusal(error) };
    }
  }

  private async run(
    transport: NodeGitTransport,
    op: TransportOp,
    args: readonly unknown[],
    entry: GitNotebookEntry,
  ): Promise<unknown> {
    const sha = (value: unknown) => {
      if (typeof value !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value)) {
        throw new GitTransportError('git', 'Not a commit id.');
      }
      return value;
    };
    const paths = (value: unknown) => {
      if (!Array.isArray(value) || value.length > 100_000) {
        throw new GitTransportError('git', 'Not a list of paths.');
      }
      return value.map((path) => {
        if (typeof path !== 'string' || path.length > 4096) {
          throw new GitTransportError('git', 'Not a path.');
        }
        return path;
      });
    };
    switch (op) {
      case 'fetch': {
        const head = await transport.fetch();
        if (transport.notes.filterIgnored && entry.filterIgnored !== true) {
          await this.change((registry) => ({
            version: 1,
            notebooks: registry.notebooks.map((each) =>
              each.localId === entry.localId ? { ...each, filterIgnored: true } : each,
            ),
          }));
        }
        return head;
      }
      case 'list':
        return [...(await transport.list(sha(args[0])))];
      case 'sizes':
        return [...(await transport.sizes(sha(args[0]), paths(args[1])))];
      case 'changed':
        return transport.changed(sha(args[0]), sha(args[1]));
      case 'read':
        return [...(await transport.read(sha(args[0]), paths(args[1])))];
      case 'commit': {
        const head = args[0] === null ? null : sha(args[0]);
        const raw = args[1];
        if (!Array.isArray(raw)) throw new GitTransportError('git', 'Not a list of changes.');
        const changes = new Map<string, Uint8Array | null>();
        for (const item of raw as unknown[]) {
          if (!Array.isArray(item)) throw new GitTransportError('git', 'Not a change.');
          const [path, bytes] = item as unknown[];
          if (typeof path !== 'string') throw new GitTransportError('git', 'Not a change.');
          if (bytes !== null && !(bytes instanceof Uint8Array)) {
            throw new GitTransportError('git', 'Not file bytes.');
          }
          changes.set(path, bytes);
        }
        const message = typeof args[2] === 'string' ? args[2].slice(0, 10_000) : 'Penmoss';
        // Delete for good only for notes the owner confirmed here (A855).
        const purges = await commitPurges(
          transport,
          entry.dir ? `${entry.dir}/` : '',
          head,
          changes,
        );
        if (purges.reversed.length > 0) {
          throw new Refused(
            'purge_reversed',
            `This sync would take back ${purges.reversed.length === 1 ? 'a note' : `${purges.reversed.length} notes`} already deleted for good in the repository, which would bring ${purges.reversed.length === 1 ? 'it' : 'them'} back from any device with an old copy, so nothing was pushed.`,
          );
        }
        if (purges.raced.length > 0) {
          // A copy brought back after a store was cleared whose original another device deleted
          // for good at head (A886): the engine withholds one; a page that sends one is refused.
          // The Mac never brings copies back (that is Android's), so no Keep and sync confirms one
          // here.
          throw new Refused(
            'purge_raced',
            'This sync would add a copy of a note already deleted for good in the repository, so nothing was pushed.',
          );
        }
        // Only a person's writer marks an agent's change undone (#174 delta review).
        if (purges.undoneMarks.length > 0 && commitWriter(message)?.kind === 'agent') {
          throw new Refused(
            'agent_undone',
            'This sync would mark an agent’s change undone from an agent’s writer, but only you mark an agent’s change undone, so nothing was pushed.',
          );
        }
        if (purges.shrunk.length > 0) {
          throw new Refused(
            'log_shrunk',
            'This sync would replace a log in the repository with less than it holds, which would wipe notes or folders without deleting them, so nothing was pushed.',
          );
        }
        const now = this.now();
        const approved = this.approvedPurges.get(entry.localId) ?? new Set<string>();
        const confirmed = new Set([
          ...(entry.purges ?? []).filter((one) => now - one.at < PURGE_TTL_MS).map((one) => one.id),
          ...approved,
        ]);
        const unconfirmed = [...purges.added.filter((id) => !confirmed.has(id)), ...purges.stray];
        if (unconfirmed.length > 0) {
          this.refusedPurges.set(entry.localId, unconfirmed);
          throw new Refused(
            'purge_unconfirmed',
            `This sync would delete ${unconfirmed.length === 1 ? 'a note' : `${unconfirmed.length} notes`} for good that nobody confirmed on this Mac in the last ${PURGE_TTL_MS / 60_000} minutes, so nothing was pushed. Confirm Delete for good again in Settings → Notebooks (Touch ID).`,
          );
        }
        this.refusedPurges.delete(entry.localId);
        const commit = await transport.commit(head, changes, message);
        if (commit && purges.added.length > 0) {
          this.commitPurges.set(commit, purges.added);
          for (const id of purges.added) approved.add(id);
          this.approvedPurges.set(entry.localId, approved);
        }
        return commit;
      }
      case 'push': {
        const commit = sha(args[0]);
        const pushed = await transport.push(commit);
        const landed = this.commitPurges.get(commit);
        if (pushed === 'pushed' && landed) {
          // Those purges are on the branch: their confirmations are spent.
          this.commitPurges.delete(commit);
          const spent = new Set(landed);
          for (const id of spent) this.approvedPurges.get(entry.localId)?.delete(id);
          await this.change((registry) => ({
            version: 1,
            notebooks: registry.notebooks.map((each) => {
              if (each.localId !== entry.localId || !each.purges) return each;
              const left = each.purges.filter((one) => !spent.has(one.id));
              const next = { ...each };
              if (left.length > 0) next.purges = left;
              else delete (next as { purges?: unknown }).purges;
              return next;
            }),
          }));
        }
        return pushed;
      }
      case 'log': {
        const options = (typeof args[0] === 'object' && args[0] !== null ? args[0] : {}) as {
          paths?: unknown;
          limit?: unknown;
        };
        return transport.log({
          ...(options.paths !== undefined ? { paths: paths(options.paths) } : {}),
          ...(typeof options.limit === 'number' &&
          Number.isInteger(options.limit) &&
          options.limit > 0
            ? { limit: Math.min(options.limit, 10_000) }
            : {}),
        });
      }
      case 'readAt': {
        const [path] = paths([args[1]]);
        return transport.readAt(sha(args[0]), path!);
      }
      case 'readDir': {
        // History's reads: a note's directory at many commits (Ryan's review of #192). The
        // transport refuses a directory outside the notebook.
        if (!Array.isArray(args[0]) || args[0].length > 2_000) {
          throw new GitTransportError('git', 'Not a list of commits.');
        }
        const [dir] = paths([args[1]]);
        const read = await transport.readDir(args[0].map(sha), dir!);
        return {
          files: [...read.files].map(([commit, listed]) => [commit, [...listed]]),
          blobs: [...read.blobs],
        };
      }
      case 'maintain':
        await transport.maintain();
        return null;
    }
  }

  /** Stops every git of a notebook now (Sync now while one hangs; quitting). */
  cancel(localId: string): void {
    this.transports.get(localId)?.cancel();
  }
}

/**
 * A notebook's own commit identity from the page (#170 F6): a name and an email on one line each;
 * null takes it away (git's own again); undefined when it is neither.
 */
export function commitAuthor(value: unknown): { name: string; email: string } | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'object') return undefined;
  const { name, email } = value as Record<string, unknown>;
  if (typeof name !== 'string' || typeof email !== 'string') return undefined;
  const cleanName = name.trim();
  const cleanEmail = email.trim();
  // Plain text only: no NUL, control, bidi or format character (#174 review).
  if (!validCommitName(cleanName) || !validCommitEmail(cleanEmail)) return undefined;
  return { name: cleanName, email: cleanEmail };
}
