/**
 * The relay's GitHub App (PEN-193, R7, R8): made by the setup page from a manifest, on the
 * owner's account, and kept in the Durable Object's storage, never in a page, a response or a
 * log. Its key makes the notebooks' installation tokens; its client id and secret sign people in.
 */
import type { AppCredentials } from './config';
import type { Blobs } from './storage';

/** What GitHub's manifest conversion hands back, as the relay keeps it. */
export interface StoredApp {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  /** The account that made it: the relay's owner, checked before it is kept. */
  readonly owner: string;
  readonly htmlUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly pem: string;
}

/** What the relay's pages may show of the App: nothing secret. */
export interface AppSummary {
  readonly slug: string;
  readonly name: string;
  readonly owner: string;
  readonly htmlUrl: string;
}

const KEY = 'settings:app';

export function readApp(blobs: Blobs): StoredApp | null {
  const bytes = blobs.get(KEY);
  return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as StoredApp) : null;
}

/** Keeps the App, unless one is kept already: a relay has one App, made once. */
export function keepApp(blobs: Blobs, app: StoredApp): 'kept' | 'exists' {
  let outcome: 'kept' | 'exists' = 'exists';
  blobs.transaction(() => {
    if (blobs.get(KEY)) return;
    blobs.put(KEY, new TextEncoder().encode(JSON.stringify(app)));
    outcome = 'kept';
  });
  return outcome;
}

export const credentialsOf = (app: StoredApp): AppCredentials => ({
  appId: String(app.id),
  privateKey: app.pem,
});

export const summaryOf = (app: StoredApp): AppSummary => ({
  slug: app.slug,
  name: app.name,
  owner: app.owner,
  htmlUrl: app.htmlUrl,
});

/** The manifest the setup page posts to GitHub (contents write, metadata read, no webhook). */
export function manifest(origin: string, owner: string) {
  return {
    // GitHub's names are unique and at most 34 characters; the owner can change it there.
    name: `${owner.slice(0, 20)} Penmoss Relay`,
    url: origin,
    description: 'Lets Claude read and write your Penmoss notebooks through your relay.',
    hook_attributes: { url: origin, active: false },
    redirect_url: `${origin}/setup`,
    callback_urls: [`${origin}/callback`],
    setup_url: `${origin}/notebooks`,
    setup_on_update: false,
    request_oauth_on_install: false,
    public: false,
    default_permissions: { contents: 'write', metadata: 'read' },
    default_events: [],
  };
}
