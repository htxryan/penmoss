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
import { readBasics, readConfig, sameLogin, type RelaySettings } from './config';
import { loginHandler, storeOf, type GrantProps, type LoginEnv, type RelayStore } from './login';
import type { NotebookRow } from './notebooks';
import { Relay } from './relay';
import { SqlBlobs } from './storage';

export interface Env extends LoginEnv, RelaySettings {
  /** The relay's public origin (default https://mcp.penmoss.app): its OAuth resource. */
  readonly RELAY_ORIGIN?: string;
}

export class RelayNotebook extends DurableObject<Env> implements RelayStore {
  private readonly blobs: SqlBlobs;
  private built: Relay | { readonly problem: string } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.blobs = new SqlBlobs(ctx.storage);
  }

  /** The notebooks' relay, made from the settings and the stored App (again after setup). */
  private relay(): Relay | { readonly problem: string } {
    if (this.built) return this.built;
    const app = readApp(this.blobs);
    const config = readConfig(this.env, app ? credentialsOf(app) : null);
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
    if ('problem' in relay) return Promise.resolve([]);
    return Promise.resolve(relay.repositories());
  }

  notebooks(): Promise<readonly NotebookRow[] | { readonly problem: string }> {
    const relay = this.relay();
    if ('problem' in relay) return Promise.resolve(relay);
    return relay.rows();
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
