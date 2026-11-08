/**
 * The relay Worker (T55, D48): claude.ai's custom connector for a Penmoss git notebook.
 *
 * `/mcp` is MCP over HTTP, behind OAuth 2.1 (`@cloudflare/workers-oauth-provider`, with the
 * sign-in in login.ts). Every call goes to one Durable Object, which holds the notebook's copy
 * and runs the local MCP server's tools on the git-notebook engine over GitHub's API. The relay
 * stores no notes that GitHub does not: its copy is a cache, rebuilt from the repository.
 */
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { DurableObject } from 'cloudflare:workers';
import { readConfig, sameLogin, type RelaySettings } from './config';
import { loginHandler, type GrantProps, type LoginEnv } from './login';
import { Relay } from './relay';
import { SqlBlobs } from './storage';

export interface Env extends LoginEnv, RelaySettings {
  readonly NOTEBOOK: DurableObjectNamespace<RelayNotebook>;
  /** The relay's public origin (default https://mcp.penmoss.app): its OAuth resource. */
  readonly RELAY_ORIGIN?: string;
}

export class RelayNotebook extends DurableObject<Env> {
  private readonly relay: Relay | { readonly problem: string };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const config = readConfig(env);
    this.relay =
      'problem' in config
        ? config
        : new Relay(config, {
            blobs: new SqlBlobs(ctx.storage),
            scheduleSync: (at) => ctx.storage.setAlarm(at),
            log: (text) => console.log(text),
          });
  }

  override fetch(request: Request): Promise<Response> {
    if ('problem' in this.relay) {
      return Promise.resolve(Response.json({ error: this.relay.problem }, { status: 503 }));
    }
    return this.relay.handle(request);
  }

  override async alarm(): Promise<void> {
    if (!('problem' in this.relay)) await this.relay.alarm();
  }
}

const mcpHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: GrantProps }) {
    const config = readConfig(env);
    // A grant made for another account (the setting changed since) no longer opens the notes.
    if ('problem' in config || !sameLogin(ctx.props?.login, config.allowedLogin)) {
      return Response.json({ error: 'This grant is not for this relay.' }, { status: 403 });
    }
    return env.NOTEBOOK.get(env.NOTEBOOK.idFromName('notebook')).fetch(request);
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
