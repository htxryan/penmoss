/**
 * The Mac app's main process for the web suite (T59, D48, D49): a real `GitNotebooks` from
 * apps/desktop, with system git and `file://` bare repositories on this machine as the remotes.
 *
 * In the shipped product the page reaches git only through the Mac app's bridge
 * (`window.penmossDesktop.git` → `IpcGitTransport` → main's `GitNotebooks`). Here the page runs
 * in Chromium against Vite, and `fake-bridge.ts` sends each git call to this object through a
 * Playwright binding. One host per test serves every page of the test, so several tabs and note
 * windows see the same notebooks, as several windows of the Mac app do.
 *
 * What only a person can answer on a Mac (Touch ID before Remove, Delete for good, Restore) is
 * answered yes, as apps/desktop's own suite does with its stand-in owner check.
 * Nothing is sealed with the Keychain: tokens and writer secrets are kept reversibly encoded.
 *
 * Send feedback is filed as main files it (T57, A1010): apps/desktop's `GitHubToken`, with the
 * person's GitHub token, against core's fake GitHub in this process (`github`).
 *
 * Add a Git Notebook browses GitHub as main does (T81): apps/desktop's `GitHubBrowseHost`, with a
 * stand-in for git's credential (none until a test signs in) and a fake GitHub whose repositories
 * are bare repositories here (`githubRepos`), so Add clones exactly what the folder step showed.
 * Sign in with GitHub (T82) is apps/desktop's `DeviceSignIn` against that fake's device flow;
 * it is offered only once a test says this build has Penmoss's OAuth app (`offerSignIn`).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GitNotebookEngine,
  MemorySecrets,
  MemoryStorage,
  NotebookOps,
} from '@penmoss/git-notebook';
import { GitNotebooks } from '../../../../desktop/src/git-notebooks';
import type { CredentialAnswer } from '../../../../desktop/src/git-credential';
import { GitHubBrowseHost } from '../../../../desktop/src/github-browse-host';
import { DeviceSignIn, type SignInState } from '../../../../desktop/src/github-device-sign-in';
import { GitHubToken } from '../../../../desktop/src/github-token';
import { keptLoginPath } from '../../../../desktop/src/local-agents';
import { Updates, type Updater, type UpdateState } from '../../../../desktop/src/updater';
import { FakeFeedbackGitHub } from '../../../../../packages/core/test/support/fake-github-feedback';
import {
  FakeGitHubBrowse,
  type FakeBrowseRepo,
} from '../../../../../packages/git-notebook/test/support/fake-github-browse';
import type { DesktopGit, GitNotebookInfo } from '../../../src/desktop/bridge';
import { IpcGitTransport } from '../../../src/sources/ipc-transport';
import { MeaningHost } from './meaning-host';

/** Who commits from the stand-in Mac, and no signing (CI has no signer). */
const GIT_CONFIG = [
  '[user]',
  '  name = Penmoss E2E',
  '  email = e2e@example.invalid',
  '[commit]',
  '  gpgSign = false',
  '[init]',
  '  defaultBranch = main',
  '',
].join('\n');

/** The DesktopGit calls that go to `GitNotebooks` (the rest the fake bridge answers itself). */
export const HOST_CALLS = [
  'list',
  'add',
  'remove',
  'update',
  'setToken',
  'purgeCheck',
  'restoreCheck',
  'purgesToConfirm',
  'writerSecret',
  'op',
  'cancel',
  'identity',
] as const satisfies ReadonlyArray<keyof DesktopGit>;
/** Send feedback's calls (`feedback.file`, `githubToken.*`), which go to `GitHubToken`. */
export const FEEDBACK_CALLS = ['feedbackFile', 'tokenStatus', 'tokenSave', 'tokenRemove'] as const;
/** Auto-Update's calls (A1112), which go to apps/desktop's `Updates` with a stand-in feed. */
export const UPDATE_CALLS = [
  'updatesState',
  'updatesCheck',
  'updatesSetAuto',
  'updatesSetChannel',
  'updatesInstall',
] as const;
/** The penmoss command's state (A992), with the login shell's PATH kept as main keeps it (A1124). */
export const CLI_CALLS = ['cliStatus'] as const;
/** Browsing GitHub in Add a Git Notebook (T81), which go to apps/desktop's `GitHubBrowseHost`. */
export const GITHUB_CALLS = [
  'githubRepos',
  'githubFolders',
  'githubOwners',
  'githubCreate',
  'githubSignInStatus',
  'githubSignInStart',
  'githubSignInCancel',
] as const;
/** Where the stand-in Mac's Sign in with GitHub sends the person (the fake's own address). */
export const GITHUB_WEB = 'https://github.test';
/** The token git's credential helper has for github.com once a test signs in. */
export const BROWSE_TOKEN = 'gho_e2e0browse0token0000000000000000';
/** Search by meaning's calls (T77), which go to the stand-in Mac's `MeaningHost`. */
export const MEANING_CALLS = [
  'meaningStatus',
  'meaningUpdate',
  'meaningClose',
  'meaningSearch',
  'meaningSetEnabled',
] as const;
export type HostCall =
  | (typeof GITHUB_CALLS)[number]
  | (typeof HOST_CALLS)[number]
  | (typeof FEEDBACK_CALLS)[number]
  | (typeof UPDATE_CALLS)[number]
  | (typeof CLI_CALLS)[number]
  | (typeof MEANING_CALLS)[number];

/** How long the stand-in Mac's login shell takes to say its PATH: a heavy profile's (A1124). */
export const SLOW_SHELL_MS = 3000;

/**
 * electron-updater as the stand-in Mac has it: the Stable feed offers `offered` and the Alpha
 * feed `offeredAlpha` (null: nothing newer), a download goes 0 → 100, and quitAndInstall is only
 * counted. Setting the channel turns downgrades on, as electron-updater's does (A1196).
 */
export class FakeUpdateFeed {
  offered: string | null = null;
  offeredAlpha: string | null = null;
  checks = 0;
  installs = 0;
  /** The feed URL each check read. */
  readonly checked: string[] = [];
  url: string | null = null;
  allowDowngrade = false;
  private current: string | null = null;
  private readonly listeners = new Map<string, Array<(value?: unknown) => void>>();
  autoDownload = true;
  autoInstallOnAppQuit = false;
  get channel(): string | null {
    return this.current;
  }
  set channel(value: string | null) {
    this.current = value;
    this.allowDowngrade = true;
  }
  setFeedURL(options: { url: string }): void {
    this.url = options.url;
  }
  private emit(event: string, value?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
  private get offering(): string | null {
    return this.current === 'alpha' ? this.offeredAlpha : this.offered;
  }
  checkForUpdates(): Promise<null> {
    this.checks++;
    this.checked.push(this.url ?? '');
    const offered = this.offering;
    if (offered) this.emit('update-available', { version: offered });
    else this.emit('update-not-available');
    return Promise.resolve(null);
  }
  async downloadUpdate(): Promise<string[]> {
    for (const percent of [25, 60]) {
      this.emit('download-progress', { percent });
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    this.emit('update-downloaded', { version: this.offering });
    return [];
  }
  quitAndInstall(): void {
    this.installs++;
  }
  on(event: string, listener: (value?: unknown) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
}

/** The token core's fake GitHub accepts. */
export const GITHUB_TOKEN = 'fake-feedback-token';

/** A sealed value: reversible only by `unseal`, and never the plain text. */
const seal = (plain: string) => Promise.resolve(`sealed:${Buffer.from(plain).toString('base64')}`);
const unseal = (sealed: string) =>
  Promise.resolve(
    sealed.startsWith('sealed:') ? Buffer.from(sealed.slice(7), 'base64').toString() : null,
  );

/** A note to seed, as `NotebookOps.createNote` takes it. */
export interface SeedNote {
  readonly id?: string;
  readonly title: string;
  readonly markdown?: string;
  readonly folderId?: string | null;
  /** The seeded folder it is filed in, by its path (`Projects/Work`), when no `folderId`. */
  readonly folder?: string;
}

/** A notebook another writer made and pushed, then added on the stand-in Mac. */
export interface SeededNotebook {
  readonly info: GitNotebookInfo;
  readonly remote: string;
  /** The seeded notes' ids, in the order given. */
  readonly noteIds: readonly string[];
  /** The seeded folders' ids by path (`Projects`, `Projects/Work`). */
  readonly folderIds: Readonly<Record<string, string>>;
}

export class GitHost {
  readonly root: string;
  readonly env: Readonly<Record<string, string>>;
  readonly notebooks: GitNotebooks;
  /** The GitHub Send feedback files issues in (core's fake). */
  readonly github = new FakeFeedbackGitHub({ token: GITHUB_TOKEN });
  /** The person's GitHub token, as the Mac's main process keeps it (A1012). */
  readonly githubToken: GitHubToken;
  /** Every `payload` part a page asked main to file, as sent (A791: never a note's text). */
  readonly feedbackPayloads: string[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly tokenListeners = new Set<() => void>();
  private readonly updateListeners = new Set<(state: UpdateState) => void>();
  /** What the update feed offers, and what the page asked of it (A1112). */
  readonly updateFeed = new FakeUpdateFeed();
  /** The stand-in Mac app's version (`app.getVersion()`). */
  appVersion = '0.1.435';
  /** Auto-Update, as the Mac's main process runs it, signed (A1112). */
  readonly updates: Updates;
  /** The login shell's PATH, kept as main keeps it, from a slow shell; asked as the app starts. */
  readonly loginPath = keptLoginPath(
    () =>
      new Promise<string | null>((resolve) =>
        setTimeout(() => resolve('/usr/bin:/bin'), SLOW_SHELL_MS),
      ),
  );
  private remotes = 0;
  /** GitHub as Add a Git Notebook browses it (T81): repositories that are bare ones here. */
  readonly githubRepos = new FakeGitHubBrowse({ token: BROWSE_TOKEN, login: 'ryan' });
  /** What git's credential helper answers for github.com: nothing until a test signs in. */
  gitCredential: CredentialAnswer = { ok: false, reason: 'no_credential' };
  private readonly browse = new GitHubBrowseHost({
    fetch: this.githubRepos.fetch,
    api: this.githubRepos.base,
    credential: () => Promise.resolve(this.gitCredential),
    penmossToken: () => this.githubToken.token(),
    onPenmossRefused: () => this.githubToken.refused(),
  });
  /** Whether this build has Penmoss's OAuth app (T82): off, as release builds are until it does. */
  offerSignIn = false;
  /** Pages main opened in the person's browser (only ever github.com/login/device). */
  readonly opened: string[] = [];
  /** What each Add asked main for, as sent. */
  readonly addInputs: unknown[] = [];
  private readonly signInListeners = new Set<(state: SignInState) => void>();
  readonly signIn = new DeviceSignIn({
    fetch: (url, init) =>
      this.githubRepos.fetch(url, { method: init.method, headers: init.headers, body: init.body }),
    clientId: this.githubRepos.device.clientId,
    web: GITHUB_WEB,
    openExternal: (url) => {
      this.opened.push(url);
      return Promise.resolve();
    },
    keep: async (token) => {
      const login = await this.browse.loginOf(token);
      return { kept: await this.githubToken.saveSignedIn(token, login), login };
    },
    onChange: (state) => {
      for (const listener of this.signInListeners) listener(state);
    },
  });
  /** Search by meaning (T77), once a spec asks for it (`test.use({ meaning: true })`). */
  meaning: MeaningHost | null = null;

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), 'penmoss-web-e2e-'));
    const config = join(this.root, 'gitconfig');
    writeFileSync(config, GIT_CONFIG);
    this.env = { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
    this.notebooks = new GitNotebooks({
      dir: join(this.root, 'userData'),
      seal,
      unseal,
      // Touch ID, or the Mac's password: the owner says yes.
      ownerCheck: () => Promise.resolve({ ok: true }),
      platform: process.platform,
      gitEnv: this.env,
      onChange: () => {
        for (const listener of this.listeners) listener();
      },
    });
    this.githubToken = new GitHubToken({
      dir: join(this.root, 'userData'),
      seal,
      unseal,
      fetch: this.github.fetch,
      api: this.github.base,
      onChange: () => {
        for (const listener of this.tokenListeners) listener();
      },
    });
    this.updates = new Updates({
      mode: () => 'enabled',
      version: () => this.appVersion,
      dir: join(this.root, 'userData'),
      load: () => Promise.resolve(this.updateFeed as unknown as Updater),
      log: () => undefined,
      onChange: (state) => {
        for (const listener of this.updateListeners) listener(state);
      },
    });
    // As main does at launch (A1124).
    this.loginPath.warm();
  }

  /** Gives this Mac search by meaning: its service, with the concept embedder. */
  enableMeaning(): MeaningHost {
    this.meaning ??= new MeaningHost();
    return this.meaning;
  }

  /** Auto-Update's state changed: every window hears it. */
  onUpdateChange(listener: (state: UpdateState) => void): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  /** A sign-in with GitHub moved on (T82): the main window hears it. */
  onSignInChange(listener: (state: SignInState) => void): () => void {
    this.signInListeners.add(listener);
    return () => this.signInListeners.delete(listener);
  }

  /** The GitHub token was saved or removed: every window reads its status again. */
  onTokenChange(listener: () => void): () => void {
    this.tokenListeners.add(listener);
    return () => this.tokenListeners.delete(listener);
  }

  /** The list changed (added, removed, a token set): every window reads it again. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A new empty bare repository on this machine, as a `file://` remote. */
  bare(name = `notes-${++this.remotes}`): string {
    const path = join(this.root, 'remotes', `${name}.git`);
    this.git(this.root, ['init', '--bare', '--quiet', '--initial-branch=main', path]);
    // As GitHub serves a partial clone (A837).
    this.git(path, ['config', 'uploadpack.allowFilter', 'true']);
    this.git(path, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
    return `file://${path}`;
  }

  /** Runs system git with the host's config; throws with git's words when it fails. */
  git(cwd: string, args: readonly string[]): string {
    const result = spawnSync('git', args, {
      cwd,
      env: { ...process.env, ...this.env },
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  }

  /**
   * The stand-in Mac's network for git: `up`; `down`, where a fetch or push fails as git's does
   * with no network; or `held`, where they wait until it is up or down again (a network that
   * never answers). Reads of what the clone holds still answer, as they do offline.
   */
  get network(): 'up' | 'down' | 'held' {
    return this.networkNow;
  }

  set network(next: 'up' | 'down' | 'held') {
    this.networkNow = next;
    if (next !== 'held') for (const release of this.held.splice(0)) release();
  }

  private networkNow: 'up' | 'down' | 'held' = 'up';
  private readonly held: Array<() => void> = [];

  private async reach(): Promise<boolean> {
    while (this.networkNow === 'held') {
      await new Promise<void>((resolve) => this.held.push(resolve));
    }
    return this.networkNow === 'up';
  }

  /** git on the stand-in Mac signs in to GitHub (a credential helper with a token). */
  signInGit(): void {
    this.gitCredential = { ok: true, token: BROWSE_TOKEN };
    // A repository Create makes is a new empty bare one here.
    this.githubRepos.onCreate = (owner, name) => this.bare(`${owner}-${name}`);
  }

  /**
   * A GitHub repository that is a bare repository here: its clone address is the bare one, and
   * its folders are what its `main` holds now.
   */
  githubRepo(
    name: string,
    options: Partial<Omit<FakeBrowseRepo, 'name' | 'cloneUrl' | 'files'>> = {},
  ): { remote: string; fullName: string } {
    const owner = options.owner ?? 'ryan';
    const remote = this.bare(`${owner}-${name}`);
    const path = remote.slice('file://'.length);
    this.githubRepos.repos.push({
      ...options,
      owner,
      name,
      cloneUrl: remote,
      files: () => this.filesOf(path),
    });
    return { remote, fullName: `${owner}/${name}` };
  }

  /** The files on a bare repository's `main` (path → text), or null before its first commit. */
  private filesOf(path: string): Record<string, string> | null {
    const listed = spawnSync('git', ['ls-tree', '-r', '--name-only', 'main'], {
      cwd: path,
      env: { ...process.env, ...this.env },
      encoding: 'utf8',
    });
    if (listed.status !== 0) return null;
    const files: Record<string, string> = {};
    for (const file of listed.stdout.split('\n').filter(Boolean)) {
      files[file] = file.endsWith('notebook.json') ? this.git(path, ['show', `main:${file}`]) : '';
    }
    return files;
  }

  /** One bridge call from a page, with its arguments as the page sent them. */
  async call(method: HostCall, args: readonly unknown[]): Promise<unknown> {
    const n = this.notebooks;
    const [a, b, c] = args;
    if (method === 'op' && (b === 'fetch' || b === 'push') && !(await this.reach())) {
      return {
        ok: false,
        error: { code: 'network', message: 'Could not reach the git host: check the connection.' },
      };
    }
    switch (method) {
      case 'githubRepos':
        return this.browse.repos();
      case 'githubFolders':
        return this.browse.folders(a, b);
      case 'githubOwners':
        return this.browse.owners();
      case 'githubCreate':
        return this.browse.create(a, b);
      case 'githubSignInStatus':
        return {
          available: this.offerSignIn && this.signIn.available,
          state: this.signIn.state(),
          login: (await this.githubToken.status()).login,
        };
      case 'githubSignInStart':
        return this.signIn.start();
      case 'githubSignInCancel':
        this.signIn.cancel();
        return null;
      case 'list':
        return n.list();
      case 'add':
        this.addInputs.push(a);
        return n.add((a ?? {}) as Parameters<GitNotebooks['add']>[0]);
      case 'remove':
        return n.remove(a, b);
      case 'update':
        return n.update(a, b);
      case 'setToken':
        return n.setToken(a, b);
      case 'purgeCheck':
        return n.purgeCheck(a, b);
      case 'restoreCheck':
        return n.restoreCheck(a, b, c);
      case 'purgesToConfirm':
        return n.purgesToConfirm(a, b ?? []);
      case 'writerSecret':
        return args.length > 1 && b !== undefined ? n.writerSecret(a, b) : n.writerSecret(a);
      case 'op':
        return n.op(a, b, c);
      case 'cancel':
        if (typeof a === 'string') n.cancel(a);
        return null;
      case 'identity':
        return n.identity();
      case 'feedbackFile': {
        const shots = Array.isArray(b)
          ? (b as Array<{ type?: unknown; bytes?: unknown }>).flatMap((shot) =>
              typeof shot.type === 'string' && shot.bytes instanceof Uint8Array
                ? [{ type: shot.type, bytes: shot.bytes }]
                : [],
            )
          : [];
        if (typeof a === 'string') this.feedbackPayloads.push(a);
        return this.githubToken.file(a, shots);
      }
      case 'tokenStatus':
        return this.githubToken.status();
      case 'tokenSave':
        return this.githubToken.save(a);
      case 'tokenRemove':
        return { ok: true, status: await this.githubToken.remove() };
      // The page's gesture is checked by main (the preload sends it); the suite's clicks are real.
      case 'meaningStatus':
        return this.meaning?.status() ?? null;
      case 'meaningUpdate':
        return this.meaning && typeof a === 'string'
          ? this.meaning.update(a, b as Parameters<MeaningHost['update']>[1])
          : [];
      case 'meaningClose':
        return null;
      case 'meaningSearch':
        return this.meaning && typeof a === 'string' && typeof b === 'string'
          ? this.meaning.search(a, b, c ?? {})
          : null;
      case 'meaningSetEnabled':
        return this.meaning && typeof a === 'boolean' ? this.meaning.setEnabled(a) : null;
      case 'updatesState':
        return this.updates.current();
      case 'updatesCheck':
        return this.updates.check();
      case 'updatesSetAuto':
        return typeof a === 'boolean' ? this.updates.setAuto(a) : null;
      case 'updatesSetChannel':
        return a === 'stable' || a === 'alpha' ? this.updates.setChannel(a) : null;
      case 'updatesInstall':
        return this.updates.install();
      case 'cliStatus': {
        // Not installed, its folder not on the slow shell's PATH (LocalAgents.cliStatus's view).
        const path = await this.loginPath.get();
        return {
          path: '/Users/me/.local/bin/penmoss',
          state: 'missing',
          onPath: path === null ? null : path.split(':').includes('/Users/me/.local/bin'),
          pathLine: 'export PATH="$HOME/.local/bin:$PATH"',
          profile: '~/.zshrc',
          direct: '/Applications/Penmoss.app/Contents/MacOS/Penmoss --cli',
        };
      }
    }
  }

  /**
   * Makes a notebook in a new bare repository as another writer would (folders and notes,
   * pushed), then adds it on the stand-in Mac, so the page opens it as one already in use and
   * another Mac can add the same remote at once.
   */
  async seed(
    options: {
      readonly name?: string;
      readonly folders?: readonly string[];
      readonly notes?: readonly SeedNote[];
      readonly remote?: string;
      /** Image bytes kept as attachments (`attachments/<sha256>.png`), for notes to show. */
      readonly images?: readonly Uint8Array[];
    } = {},
  ): Promise<SeededNotebook> {
    const name = options.name ?? 'Notes';
    const remote = options.remote ?? this.bare();
    const added = await this.add(remote, name);
    const folderIds: Record<string, string> = {};
    const noteIds: string[] = [];
    const { engine, ops } = await this.writer(added, name);
    // A path makes a subfolder: `Projects/Work` is Work inside Projects (made first if need be).
    const folderAt = (path: string): string => {
      const known = folderIds[path];
      if (known) return known;
      const cut = path.lastIndexOf('/');
      const parentId = cut < 0 ? null : folderAt(path.slice(0, cut));
      const id = ops.createFolder({ name: path.slice(cut + 1), parentId });
      folderIds[path] = id;
      return id;
    };
    for (const folder of options.folders ?? []) folderAt(folder);
    for (const image of options.images ?? []) await ops.keepAttachment(image, 'png');
    for (const { folder, ...note } of options.notes ?? []) {
      noteIds.push(
        ops.createNote(
          folder && note.folderId === undefined ? { ...note, folderId: folderAt(folder) } : note,
        ),
      );
    }
    await engine.save();
    const report = await engine.sync();
    if (!report.commit) throw new Error('The seed made no commit.');
    return { info: added, remote, noteIds, folderIds };
  }

  /** Adds a remote on the stand-in Mac: nobody is asked about it (D51, D61). */
  async add(remote: string, name: string): Promise<GitNotebookInfo> {
    const answer = await this.notebooks.add({
      remote,
      branch: 'main',
      dir: '',
      name,
    });
    if (!answer.ok || answer.value.kind !== 'added') {
      throw new Error(`Could not add ${remote}: ${JSON.stringify(answer)}`);
    }
    return answer.value.notebook;
  }

  /** An engine of another writer on a notebook this Mac has, through main's calls. */
  async writer(info: GitNotebookInfo, name = info.name) {
    const git = {
      op: (localId: string, op: string, args: readonly unknown[]) =>
        this.notebooks.op(localId, op, args),
      cancel: (localId: string) => Promise.resolve(this.notebooks.cancel(localId)),
    } as unknown as DesktopGit;
    const engine = await GitNotebookEngine.open({
      transport: new IpcGitTransport(git, info.localId, info.dir ? `${info.dir}/` : ''),
      storage: new MemoryStorage(),
      secrets: new MemorySecrets(),
      writer: { kind: 'device', label: 'Seed' },
      create: { id: info.notebookId, name },
    });
    return { engine, ops: new NotebookOps(engine) };
  }

  /** Stops every git of the stand-in Mac, then removes its files. */
  async close(): Promise<void> {
    this.listeners.clear();
    this.tokenListeners.clear();
    this.network = 'down';
    for (const notebook of await this.notebooks.list().catch(() => [])) {
      this.notebooks.cancel(notebook.localId);
    }
    // A git stopped a moment ago may still be writing in the directory.
    rmSync(this.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
