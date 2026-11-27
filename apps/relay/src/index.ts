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
import { AddBridge, keepOwnerToken } from './add-bridge';
import { DurableObject } from 'cloudflare:workers';
import { credentialsOf, keepApp, readApp, summaryOf, type AppSummary, type StoredApp } from './app';
import { placeKey, readBasics, readConfig, sameLogin, type RelaySettings } from './config';
import { AppTokens, type OwnerToken } from './github-auth';
import { branchesOf, type GitHubCall } from './github-api';
import { placesOf, readNotebookList, writeNotebookList } from './notebook-list';
import { loginHandler, storeOf, type GrantProps, type LoginEnv, type RelayStore } from './login';
import type { NotebookRow } from './notebooks';
import { prefixOf, Relay } from './relay';
import { PrefixedBlobs, SqlBlobs } from './storage';

export interface Env extends LoginEnv, RelaySettings {
  /** The relay's public origin, its OAuth resource; unset, the origin it was reached at. */
  readonly RELAY_ORIGIN?: string;
}

type Answer<T> = T | { readonly problem: string };

/** Add Notebook's bridge calls the page may make (`AddBridge`), by name. */
const ADD_CALLS = new Set([
  'list',
  'add',
  'repos',
  'folders',
  'branches',
  'owners',
  'create',
  'gitLogin',
  'status',
  'save',
  'remove',
]);

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
      // Workers take only `follow` or `manual`: a redirect comes back as an answer GitHubBrowse
      // refuses, so the token is still never carried to it.
      fetch: (url, init) => fetch(url, { ...init, redirect: 'manual' }),
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

  private bridge(): AddBridge {
    const basics = this.basics();
    const app = readApp(this.blobs);
    return new AddBridge({
      blobs: this.blobs,
      api: basics.api,
      web: basics.web,
      owner: basics.owner,
      browse: this.browse(),
      app: this.appTokens(),
      client: app ? { id: app.clientId, secret: app.clientSecret } : null,
      rows: () => this.notebooks(),
      changed: () => {
        this.built = null;
      },
      fetch: (input, init) => fetch(input, init),
    });
  }

  /**
   * One of Add Notebook's bridge calls (A1701), as the page's `DesktopGit` makes it: the answer
   * in the bridge's shape, or null for a call it may not make.
   */
  async addCall(name: string, args: readonly unknown[]): Promise<unknown> {
    if (!ADD_CALLS.has(name)) return null;
    const bridge = this.bridge() as unknown as Record<string, (...each: unknown[]) => unknown>;
    return (await bridge[name]!.apply(bridge, args as unknown[])) ?? null;
  }

  /** The owner's sign-in to the relay, kept for Create New Repo (A1701). */
  keepOwnerToken(token: OwnerToken): Promise<void> {
    keepOwnerToken(this.blobs, token);
    return Promise.resolve();
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
