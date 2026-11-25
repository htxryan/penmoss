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
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ulid } from '@penmoss/core/ids';
import type { GitTransport } from '@penmoss/git-notebook';
import {
  GitTransportError,
  gitRunner,
  NodeGitTransport,
  redactRemote,
  remoteParts,
} from '@penmoss/git-notebook/system-git';
import { validCommitEmail, validCommitName } from '@penmoss/git-notebook/identity';
import { cleanNotebookName, NOTEBOOK_NAME_MAX } from '@penmoss/git-notebook/layout';
import { commitPurges, purgedAt, titlesAt } from '@penmoss/git-notebook/purge-check';
import { PurgeGuard, Refused } from './git-notebook-guards';
import {
  GitNotebookStore,
  LOCAL_ID,
  NOTE_ID,
  NOTEBOOK_ID,
  CADENCE,
  type GitNotebookEntry,
} from './git-notebook-store';
import { fitWords, noteWords, repositoryName, repositoryWords } from './owner-words';

// What other modules and the tests take from here, wherever it is kept.
export { withCadence, type GitNotebookEntry } from './git-notebook-store';
export { checkWords, fitWords, noteWords, repositoryName } from './owner-words';

/** What the page is told about a notebook: never its token. */
interface GitNotebookView {
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
  /** The host as the remote names it (an SSH alias stays the alias); 'this Mac' for a path. */
  readonly host: string;
  /**
   * The host's real name, where its pages are on the web (A1565): an SSH alias resolved to the
   * `HostName` SSH uses for it, else `host`; '' for a repository on this Mac.
   */
  readonly webHost: string;
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

/**
 * The transport calls the page's engine makes (GitTransport, A836): every GitTransport method
 * but `remoteHead`, which only the CLI's sync asks. A method added to GitTransport fails to
 * compile here until it is listed, or named as one the page never calls.
 */
const TRANSPORT_OPS = [
  'fetch',
  'list',
  'sizes',
  'changed',
  'read',
  'commit',
  'push',
  'log',
  'readDir',
  'maintain',
] as const satisfies readonly TransportMethod[];
type TransportOp = (typeof TRANSPORT_OPS)[number];
type TransportMethod = Exclude<keyof GitTransport, 'root' | 'remoteHead'>;
const EVERY_METHOD_LISTED: Exclude<TransportMethod, TransportOp> extends never ? true : never =
  true;
void EVERY_METHOD_LISTED;

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
  /**
   * An SSH remote's host as SSH resolves it (`ssh -G`, ssh-host.ts): `github-quanta`, a `Host`
   * in `~/.ssh/config`, is `github.com` (A1565). Absent: the host as the remote says it.
   */
  readonly resolveSshHost?: (host: string) => Promise<string>;
}

const SECRET = /^[A-Za-z0-9_.~+/=-]{8,1000}$/;
const TOKEN_USER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** A note a sync would delete for good, as Settings lists it before confirming again (A855). */
interface PendingPurge {
  readonly id: string;
  /** Its title at head ('' for none). */
  readonly title: string;
  /** Confirmed on this Mac once already (its confirmation ran out); false: never confirmed here. */
  readonly confirmedBefore: boolean;
}

/** At most this many confirmed purges wait for their push. */
const MAX_PURGES = 1000;
/** How long a notebook may be named (the sidebar shows it). */
const MAX_NAME = NOTEBOOK_NAME_MAX;

const refuse = (code: string, message: string, hostMessage?: string): GitRefusal => ({
  code,
  message,
  ...(hostMessage ? { hostMessage } : {}),
});

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

export class GitNotebooks {
  private readonly store: GitNotebookStore;
  private readonly transports = new Map<string, NodeGitTransport>();
  /** The confirmations of Delete for good as commits use them (git-notebook-guards.ts). */
  private readonly guard: PurgeGuard;
  private readonly now: () => number;
  /** SSH hosts as SSH resolves them (A1565), learnt before a view names them. */
  private readonly webHosts = new Map<string, string>();

  constructor(private readonly options: GitNotebooksOptions) {
    this.store = new GitNotebookStore({
      dir: options.dir,
      seal: options.seal,
      unseal: options.unseal,
      ...(options.onChange ? { onChange: options.onChange } : {}),
    });
    this.now = options.now ?? Date.now;
    this.guard = new PurgeGuard(this.now);
  }

  /** Clones live here (A837): `git-notebooks/<localId>/repo.git`. */
  cloneDir(localId: string): string {
    return join(this.options.dir, 'git-notebooks', localId);
  }

  /**
   * What an agent's clone of this notebook needs (T54, A993): its target, token, signing and
   * commit identity. For main alone, never the page: the token is in it.
   */
  async forAgent(localId: unknown): Promise<{
    readonly entry: GitNotebookEntry;
    readonly token: string | null;
  } | null> {
    const entry = await this.store.entry(localId);
    if (!entry) return null;
    return { entry, token: await this.store.token(entry) };
  }

  /** Every notebook with its token, for main only: the agents' clones made for each (D52). */
  async forAgents(): Promise<
    { readonly entry: GitNotebookEntry; readonly token: string | null }[]
  > {
    const registry = await this.store.registry();
    return Promise.all(
      registry.notebooks.map(async (entry) => ({ entry, token: await this.store.token(entry) })),
    );
  }

  // --- the list ---

  async list(): Promise<GitNotebookView[]> {
    const registry = await this.store.registry();
    const secrets = await this.store.secrets();
    await this.learnHosts(registry.notebooks);
    return registry.notebooks.map((entry) => this.view(entry, `token:${entry.localId}` in secrets));
  }

  /** Resolves the SSH hosts of these notebooks' remotes, for `view`'s `webHost` (A1565). */
  private async learnHosts(entries: readonly GitNotebookEntry[]): Promise<void> {
    const resolve = this.options.resolveSshHost;
    if (!resolve) return;
    const hosts = new Set<string>();
    for (const entry of entries) {
      const parts = remoteParts(entry.remote);
      if (parts?.protocol === 'ssh' && parts.host && !this.webHosts.has(parts.host)) {
        hosts.add(parts.host);
      }
    }
    await Promise.all(
      [...hosts].map(async (host) => {
        this.webHosts.set(host, await resolve(host).catch(() => host));
      }),
    );
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
      webHost:
        parts?.protocol === 'ssh'
          ? (this.webHosts.get(parts.host) ?? parts.host)
          : (parts?.host ?? ''),
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
    const registry = await this.store.registry();
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
    if (token !== null && !(await this.store.setSecret(`token:${localId}`, token))) {
      return {
        ok: false,
        error: refuse(
          'no_keychain',
          'Penmoss could not keep the token: the Keychain is not available.',
        ),
      };
    }
    const forget = async () => {
      if (token !== null)
        await this.store.setSecret(`token:${localId}`, null).catch(() => undefined);
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
      await this.store.change((current) => ({
        version: 1,
        notebooks: [...current.notebooks, entry],
      }));
      await this.learnHosts([entry]);
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
    const entry = await this.store.entry(localId);
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
    await this.store.change((registry) => ({
      version: 1,
      notebooks: registry.notebooks.filter((each) => each.localId !== entry.localId),
    }));
    this.transports.get(entry.localId)?.cancel();
    this.transports.delete(entry.localId);
    await rm(this.cloneDir(entry.localId), { recursive: true, force: true });
    await this.store.setSecret(`token:${entry.localId}`, null);
    await this.store.setSecret(`writer:${entry.localId}`, null);
    return { ok: true, value: { notebookId: entry.notebookId } };
  }

  /**
   * Delete for good in a git notebook (D34, A828, A855): the owner check, in main's own words,
   * for one note of one notebook. Only a commit that deletes for good a note confirmed here gets
   * through `op` (the page's own word is not enough); the confirmation goes once its push lands.
   */
  async purgeCheck(localId: unknown, noteIds: unknown): Promise<GitAnswer<null>> {
    const entry = await this.store.entry(localId);
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
      wanted = wanted.filter((id) => this.guard.needsConfirming(entry.localId, id, held.get(id)));
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
    await this.store.change((registry) => ({
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
    const entry = await this.store.entry(localId);
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
    const entry = await this.store.entry(localId);
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
    const held = new Map((entry.purges ?? []).map((one) => [one.id, one.at]));
    const needs = (id: string) => this.guard.needsConfirming(entry.localId, id, held.get(id));
    const ids = [
      ...new Set([
        ...[...new Set([...this.guard.lastRefused(entry.localId), ...held.keys()])].filter(needs),
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
    const answer = await this.store.serial(async (): Promise<GitAnswer<GitNotebookEntry>> => {
      const registry = await this.store.registry();
      const entry = registry.notebooks.find((each) => each.localId === localId);
      if (!entry || typeof patch !== 'object' || patch === null) {
        return { ok: false, error: refuse('invalid_request', 'No such git notebook.') };
      }
      const patched = this.patched(entry, patch as Record<string, unknown>);
      // Nothing changed (a sync reporting the name it had): no write, and no list sent again.
      if (patched.ok && JSON.stringify(patched.value) !== JSON.stringify(entry)) {
        await this.store.write({
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
    const secrets = await this.store.secrets();
    await this.learnHosts([answer.value]);
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
    const entry = await this.store.entry(localId);
    if (!entry) return { ok: false, error: refuse('not_found', 'No such git notebook.') };
    if (token !== null && (typeof token !== 'string' || !SECRET.test(token.trim()))) {
      return { ok: false, error: refuse('invalid_token', 'That does not look like a token.') };
    }
    const kept = await this.store.setSecret(
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
    const entry = await this.store.entry(localId);
    if (!entry) return { ok: false, error: refuse('not_found', 'No such git notebook.') };
    const key = `writer:${entry.localId}`;
    if (value === undefined) return { ok: true, value: await this.store.secret(key) };
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
      return { ok: false, error: refuse('invalid_request', 'Not a writer secret.') };
    }
    // Without the Keychain the writer is new at every launch (A821 keeps that safe).
    if (!(await this.store.setSecret(key, value)))
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
    const entry = await this.store.entry(localId);
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
      token: () => this.store.token(entry),
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
    const entry = await this.store.entry(localId);
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
          await this.store.change((registry) => ({
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
        this.guard.check(entry.localId, purges, entry.purges ?? [], message);
        const commit = await transport.commit(head, changes, message);
        this.guard.committed(entry.localId, commit, purges.added);
        return commit;
      }
      case 'push': {
        const commit = sha(args[0]);
        const pushed = await transport.push(commit);
        // Those purges are on the branch: their confirmations are spent.
        const spent = this.guard.pushed(entry.localId, commit, pushed);
        if (spent) {
          await this.store.change((registry) => ({
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
