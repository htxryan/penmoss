/**
 * The relay Worker (T55, D48): claude.ai's custom connector for Penmoss git notebooks.
 *
 * `/mcp` is MCP over HTTP, behind OAuth 2.1 (`@cloudflare/workers-oauth-provider`, with the
 * sign-in and the relay's own pages in login.ts). Every call goes to one Durable Object, which
 * holds the relay's settings (its GitHub App, made at `/setup`) and each notebook's copy, and runs
 * the local MCP server's tools on the git-notebook engine over GitHub's API. The relay stores no
 * notes that GitHub does not: each copy is a cache, rebuilt from its repository.
 */
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { GitHubBrowse } from '@penmoss/git-notebook/github-browse';
import { DurableObject } from 'cloudflare:workers';
import { credentialsOf, keepApp, readApp, summaryOf, type AppSummary, type StoredApp } from './app';
import {
  checkPlace,
  placeKey,
  readBasics,
  readConfig,
  sameLogin,
  type RelaySettings,
} from './config';
import { AppTokens } from './github-auth';
import { branchesOf, notebookFileOf, type GitHubCall } from './github-api';
import { placesOf, readNotebookList, writeNotebookList } from './notebook-list';
import { randomId } from './session';
import { loginHandler, storeOf, type GrantProps, type LoginEnv, type RelayStore } from './login';
import type { FoundNotebook, NotebookRow, RepoChoice } from './notebooks';
import { prefixOf, Relay } from './relay';
import { PrefixedBlobs, SqlBlobs } from './storage';

export interface Env extends LoginEnv, RelaySettings {
  /** The relay's public origin, its OAuth resource; unset, the origin it was reached at. */
  readonly RELAY_ORIGIN?: string;
}

type Answer<T> = T | { readonly problem: string };

/** How long a token pasted into Add Notebook… is kept for its next steps, from its last use. */
const PENDING_ADD_MS = 15 * 60_000;
const PENDING = 'pending-add:';

/** How many branches Add Notebook… looks on for notebooks, the default first. */
const SCAN_BRANCHES = 8;

export class RelayNotebook extends DurableObject<Env> implements RelayStore {
  private readonly blobs: SqlBlobs;
  private built: Relay | { readonly problem: string } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.blobs = new SqlBlobs(ctx.storage);
  }

  /** The notebooks' relay, made from the settings, the App and the list (again on each change). */
  private relay(): Relay | { readonly problem: string } {
    if (this.built) return this.built;
    const app = readApp(this.blobs);
    const config = readConfig(
      this.env,
      app ? credentialsOf(app) : null,
      placesOf(readNotebookList(this.blobs)),
    );
    this.built =
      'problem' in config
        ? config
        : new Relay(config, {
            blobs: this.blobs,
            scheduleSync: (at) => this.ctx.storage.setAlarm(at),
            log: (text) => console.log(text),
          });
    return this.built;
  }

  private basics() {
    const basics = readBasics(this.env);
    if ('problem' in basics) throw new Error(basics.problem);
    return basics;
  }

  /** A way to ask GitHub about `repository`: with `token`, or as the App. */
  private github(
    repository: string,
    token: string | null,
  ): GitHubCall | { readonly problem: string } {
    const basics = this.basics();
    const call = (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init);
    if (token) return { api: basics.api, fetch: call, token: () => Promise.resolve(token) };
    const app = readApp(this.blobs);
    if (!app) return { problem: 'Set up the relay’s GitHub App first.' };
    const tokens = new AppTokens({ app: credentialsOf(app), api: basics.api, fetch: call });
    return { api: basics.api, fetch: call, token: () => tokens.token(repository) };
  }

  override fetch(request: Request): Promise<Response> {
    const relay = this.relay();
    if ('problem' in relay) {
      return Promise.resolve(Response.json({ error: relay.problem }, { status: 503 }));
    }
    return relay.handle(request);
  }

  override async alarm(): Promise<void> {
    const relay = this.relay();
    if (!('problem' in relay)) await relay.alarm();
  }

  summary(): Promise<AppSummary | null> {
    const app = readApp(this.blobs);
    return Promise.resolve(app ? summaryOf(app) : null);
  }

  signIn(): Promise<{ clientId: string; clientSecret: string } | null> {
    const app = readApp(this.blobs);
    return Promise.resolve(app ? { clientId: app.clientId, clientSecret: app.clientSecret } : null);
  }

  keepApp(app: StoredApp): Promise<'kept' | 'exists'> {
    const outcome = keepApp(this.blobs, app);
    if (outcome === 'kept') this.built = null;
    return Promise.resolve(outcome);
  }

  repositories(): Promise<readonly string[]> {
    const relay = this.relay();
    return Promise.resolve('problem' in relay ? [] : relay.repositories());
  }

  async notebooks(): Promise<readonly NotebookRow[]> {
    const relay = this.relay();
    return 'problem' in relay ? [] : relay.rows();
  }

  /** Where the App can be installed on more repositories, or null without an App. */
  installUrl(): Promise<string | null> {
    const app = readApp(this.blobs);
    return Promise.resolve(app ? `${app.htmlUrl.replace(/\/+$/, '')}/installations/new` : null);
  }

  private browse(): GitHubBrowse {
    return new GitHubBrowse({
      api: this.basics().api,
      fetch: (url, init) => fetch(url, init),
    });
  }

  private appTokens(): AppTokens | null {
    const app = readApp(this.blobs);
    if (!app) return null;
    return new AppTokens({
      app: credentialsOf(app),
      api: this.basics().api,
      fetch: (input, init) => fetch(input, init),
    });
  }

  /** The token a pending Add Notebook… holds, kept another while; null for the App. */
  private tokenOf(pending: string | null): Answer<string | null> {
    if (pending === null) return null;
    const key = `${PENDING}${pending}`;
    const bytes = /^[0-9a-f]{48}$/.test(pending) ? this.blobs.get(key) : null;
    const held = bytes
      ? (JSON.parse(new TextDecoder().decode(bytes)) as { token: string; at: number })
      : null;
    if (!held || Date.now() - held.at > PENDING_ADD_MS) {
      if (bytes) this.blobs.delete(key);
      return { problem: 'This was started too long ago. Paste the token again.' };
    }
    this.blobs.put(
      key,
      new TextEncoder().encode(JSON.stringify({ token: held.token, at: Date.now() })),
    );
    return held.token;
  }

  /** A token to read `repository` with: the pending one, or the App's for that repository. */
  private async readToken(pending: string | null, repository: string): Promise<Answer<string>> {
    const token = this.tokenOf(pending);
    if (token !== null) return token;
    const tokens = this.appTokens();
    if (!tokens) return { problem: 'Set up the relay’s GitHub App first.' };
    try {
      return await tokens.token(repository);
    } catch {
      return {
        problem: `The App isn’t installed on ${repository}. Install it there, or use a token.`,
      };
    }
  }

  /** Step one with a token: checked with GitHub, then kept for the next steps, never shown. */
  async startToken(token: string): Promise<Answer<{ pending: string }>> {
    const pasted = token.trim();
    if (!pasted) return { problem: 'Paste a token first.' };
    const listed = await this.browse().repos(pasted);
    if (!listed.ok) {
      return {
        problem:
          listed.error.reason === 'unauthorized'
            ? 'GitHub refused this token. Check that it’s whole and hasn’t expired.'
            : listed.error.message,
      };
    }
    const now = Date.now();
    for (const key of this.blobs.keys(PENDING)) {
      const held = this.blobs.get(key);
      const at = held ? (JSON.parse(new TextDecoder().decode(held)) as { at: number }).at : 0;
      if (now - at > PENDING_ADD_MS) this.blobs.delete(key);
    }
    const pending = randomId();
    this.blobs.put(
      `${PENDING}${pending}`,
      new TextEncoder().encode(JSON.stringify({ token: pasted, at: now })),
    );
    return { pending };
  }

  /** The repositories Add Notebook… offers: the App's, or the pending token's it can write. */
  async repoChoices(
    pending: string | null,
  ): Promise<Answer<{ repos: readonly RepoChoice[]; more: boolean }>> {
    const token = this.tokenOf(pending);
    if (token !== null && typeof token === 'object') return token;
    if (token === null) {
      const tokens = this.appTokens();
      if (!tokens) return { problem: 'Set up the relay’s GitHub App first.' };
      const names = await tokens.repositories().catch(() => [] as string[]);
      return {
        repos: [...names].sort().map((fullName) => ({ fullName, private: null })),
        more: false,
      };
    }
    const listed = await this.browse().repos(token);
    if (!listed.ok) return { problem: listed.error.message };
    return {
      repos: listed.value.repos
        .filter((repo) => repo.canPush)
        .map((repo) => ({ fullName: repo.fullName, private: repo.visibility !== 'public' })),
      more: listed.value.more,
    };
  }

  /**
   * The notebooks in a repository: on `branch`, or on its first branches, the default first. Each
   * says whether the relay serves it already.
   */
  async notebooksIn(
    pending: string | null,
    repository: string,
    branch: string | null,
  ): Promise<
    Answer<{
      repository: string;
      branches: readonly string[];
      looked: readonly string[];
      found: readonly FoundNotebook[];
    }>
  > {
    const place = checkPlace(repository, branch ?? 'main', '');
    if ('problem' in place) return place;
    const token = await this.readToken(pending, place.repository);
    if (typeof token === 'object') return token;
    const github = this.github(place.repository, token);
    if ('problem' in github) return github;
    const branches = await branchesOf(github, place.repository);
    if ('problem' in branches) return branches;
    if (branch !== null && !branches.includes(place.branch)) {
      return { problem: `${place.repository} has no branch “${place.branch}”.` };
    }
    const looked = branch !== null ? [place.branch] : branches.slice(0, SCAN_BRANCHES);
    const served = new Set(readNotebookList(this.blobs).map((each) => placeKey(each)));
    const browse = this.browse();
    const found: FoundNotebook[] = [];
    for (const each of looked) {
      const read = await browse.folders(token, place.repository, each);
      if (!read.ok) return { problem: read.error.message };
      for (const folder of read.value.folders) {
        if (!folder.notebook) continue;
        const root = folder.path ? `${folder.path}/` : '';
        found.push({
          name: folder.notebook.name,
          branch: each,
          folder: folder.path,
          served: served.has(placeKey({ repository: place.repository, branch: each, root })),
        });
      }
    }
    return { repository: place.repository, branches, looked, found };
  }

  /** The last step: the notebook at that place added, by its name. */
  async finishAdd(
    pending: string | null,
    repository: string,
    branch: string,
    folder: string,
  ): Promise<Answer<{ name: string }>> {
    const token = this.tokenOf(pending);
    if (token !== null && typeof token === 'object') return token;
    const place = checkPlace(repository, branch, folder);
    if ('problem' in place) return place;
    const list = readNotebookList(this.blobs);
    if (list.some((each) => placeKey(each) === placeKey(place))) {
      return {
        problem: `${place.repository} on ${place.branch}${place.root ? `, in ${place.root}` : ''}, is served already.`,
      };
    }
    const github = this.github(place.repository, token);
    if ('problem' in github) return github;
    const file = await notebookFileOf(github, place);
    if ('problem' in file) return file;
    writeNotebookList(this.blobs, [...list, { ...place, ...(token ? { token } : {}) }]);
    this.built = null;
    return { name: file.name };
  }

  async remove(key: string): Promise<Answer<{ name: string }>> {
    const list = readNotebookList(this.blobs);
    const gone = list.find((each) => placeKey(each) === key);
    if (!gone) return { problem: 'It isn’t served any more.' };
    const relay = this.relay();
    if (!('problem' in relay)) {
      try {
        await relay.flush(key);
      } catch (error) {
        return {
          problem: `Its edits couldn’t be pushed, so it stays: ${error instanceof Error ? error.message : String(error)} Try again once GitHub answers.`,
        };
      }
    }
    writeNotebookList(
      this.blobs,
      list.filter((each) => each !== gone),
    );
    new PrefixedBlobs(this.blobs, prefixOf(gone)).clear();
    this.built = null;
    return { name: gone.repository };
  }

  async replaceToken(key: string, token: string): Promise<Answer<{ name: string }>> {
    const list = readNotebookList(this.blobs);
    const notebook = list.find((each) => placeKey(each) === key);
    if (!notebook?.token) return { problem: 'It isn’t reached by a token.' };
    if (!token) return { problem: 'Paste the new token.' };
    const github = this.github(notebook.repository, token);
    if ('problem' in github) return github;
    const branches = await branchesOf(github, notebook.repository);
    if ('problem' in branches) return branches;
    writeNotebookList(
      this.blobs,
      list.map((each) => (each === notebook ? { ...each, token } : each)),
    );
    this.built = null;
    return { name: notebook.repository };
  }
}

const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: GrantProps }) {
    const basics = readBasics(env);
    // A grant made for another account (the setting changed since) no longer opens the notes.
    if ('problem' in basics || !sameLogin(ctx.props?.login, basics.owner)) {
      return Response.json({ error: 'This grant is not for this relay.' }, { status: 403 });
    }
    return (storeOf(env) as unknown as { fetch(request: Request): Promise<Response> }).fetch(
      request,
    );
  },
};

/** The OAuth servers, one per origin the relay answers on: each one's resource is its own URL. */
const providers = new Map<string, OAuthProvider<Env>>();

function oauth(env: Env, request: Request): OAuthProvider<Env> {
  const origin = (env.RELAY_ORIGIN?.trim() || new URL(request.url).origin).replace(/\/+$/, '');
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: mcpHandler as unknown as ExportedHandler<Env> & {
        fetch: NonNullable<ExportedHandler<Env>['fetch']>;
      },
      defaultHandler: loginHandler,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register',
      scopesSupported: ['notes'],
      resourceMetadata: { resource: `${origin}/mcp`, resource_name: 'Penmoss' },
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return oauth(env, request).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
