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
import type { NotebookRow } from './notebooks';
import { prefixOf, Relay } from './relay';
import { PrefixedBlobs, SqlBlobs } from './storage';

export interface Env extends LoginEnv, RelaySettings {
  /** The relay's public origin (default https://mcp.penmoss.app): its OAuth resource. */
  readonly RELAY_ORIGIN?: string;
}

type Answer<T> = T | { readonly problem: string };

/** How long step one of Add Notebook… is kept for step two. */
const PENDING_ADD_MS = 15 * 60_000;

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

  async reachable(): Promise<readonly string[]> {
    const app = readApp(this.blobs);
    if (!app) return [];
    const basics = this.basics();
    const tokens = new AppTokens({
      app: credentialsOf(app),
      api: basics.api,
      fetch: (input, init) => fetch(input, init),
    });
    return tokens.repositories().catch(() => []);
  }

  async startAdd(input: {
    readonly repository: string;
    readonly token: string | null;
  }): Promise<Answer<{ pending: string; repository: string; branches: readonly string[] }>> {
    const place = checkPlace(input.repository, 'main', '');
    if ('problem' in place) return place;
    const github = this.github(place.repository, input.token);
    if ('problem' in github) return github;
    const branches = await branchesOf(github, place.repository);
    if ('problem' in branches) return branches;
    const pending = randomId();
    this.blobs.put(
      `pending-add:${pending}`,
      new TextEncoder().encode(
        JSON.stringify({ repository: place.repository, token: input.token, at: Date.now() }),
      ),
    );
    return { pending, repository: place.repository, branches };
  }

  async finishAdd(
    pending: string,
    branch: string,
    folder: string,
  ): Promise<Answer<{ name: string }>> {
    const key = `pending-add:${pending}`;
    const bytes = /^[0-9a-f]{48}$/.test(pending) ? this.blobs.get(key) : null;
    const started = bytes
      ? (JSON.parse(new TextDecoder().decode(bytes)) as {
          repository: string;
          token: string | null;
          at: number;
        })
      : null;
    if (!started || Date.now() - started.at > PENDING_ADD_MS) {
      if (bytes) this.blobs.delete(key);
      return { problem: 'This was started too long ago. Start again.' };
    }
    const place = checkPlace(started.repository, branch, folder);
    if ('problem' in place) return place;
    const list = readNotebookList(this.blobs);
    if (list.some((each) => placeKey(each) === placeKey(place))) {
      return {
        problem: `${place.repository} on ${place.branch}${place.root ? `, in ${place.root}` : ''}, is served already.`,
      };
    }
    const github = this.github(place.repository, started.token);
    if ('problem' in github) return github;
    const file = await notebookFileOf(github, place);
    if ('problem' in file) return file;
    writeNotebookList(this.blobs, [
      ...list,
      { ...place, ...(started.token ? { token: started.token } : {}) },
    ]);
    this.blobs.delete(key);
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

/** The OAuth server, made on the first request: its resource is the relay's own URL. */
let provider: OAuthProvider<Env> | null = null;

function oauth(env: Env): OAuthProvider<Env> {
  const origin = (env.RELAY_ORIGIN?.trim() || 'https://mcp.penmoss.app').replace(/\/+$/, '');
  provider ??= new OAuthProvider<Env>({
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
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return oauth(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
