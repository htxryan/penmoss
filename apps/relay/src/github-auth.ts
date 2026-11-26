/**
 * How the relay authenticates to GitHub (T55, PEN-192): a notebook's fine-grained token, or the
 * GitHub App's installation token, made from the App's private key (RS256 JWT) and limited to
 * that notebook's repository. Installation tokens last an hour; one is kept until five minutes
 * before it ends.
 */
import type { AppCredentials, GitHubAccess } from './config';

const REFRESH_BEFORE_MS = 5 * 60_000;

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const textUrl = (text: string) => base64url(new TextEncoder().encode(text));

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

/**
 * A PKCS#1 RSA key (`BEGIN RSA PRIVATE KEY`, what GitHub hands out) wrapped as PKCS#8, which
 * WebCrypto imports: SEQUENCE { 0, SEQUENCE { rsaEncryption, NULL }, OCTET STRING { key } }.
 */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = [0x02, 0x01, 0x00];
  const algorithm = [
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ];
  const octets = [0x04, ...derLength(pkcs1.length)];
  const inner = version.length + algorithm.length + octets.length + pkcs1.length;
  const out = new Uint8Array([0x30, ...derLength(inner), ...version, ...algorithm, ...octets]);
  const full = new Uint8Array(out.length + pkcs1.length);
  full.set(out);
  full.set(pkcs1, out.length);
  return full;
}

export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pkcs1 = /-----BEGIN RSA PRIVATE KEY-----/.test(pem);
  const body = pem
    .replace(/-----(BEGIN|END) (RSA )?PRIVATE KEY-----/g, '')
    .replace(/\\n/g, '')
    .replace(/\s/g, '');
  const raw = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    pkcs1 ? pkcs1ToPkcs8(raw) : raw,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/** The App's own JWT: issued a minute in the past (clock drift), valid for nine minutes. */
export async function appJwt(appId: string, key: CryptoKey, nowMs: number): Promise<string> {
  const now = Math.floor(nowMs / 1000);
  const head = textUrl(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = textUrl(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${base64url(new Uint8Array(signature))}`;
}

const headers = (jwt: string) => ({
  authorization: `Bearer ${jwt}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'penmoss-relay',
  'content-type': 'application/json',
});

export interface AppTokensOptions {
  readonly app: AppCredentials;
  readonly api: string;
  readonly fetch: typeof fetch;
  readonly clock?: () => number;
}

/**
 * The relay's GitHub App, for every notebook it reaches (PEN-192): the App's installation on
 * each repository, found by asking GitHub, and a token limited to that repository, kept until five
 * minutes before it ends.
 */
export class AppTokens {
  private key: Promise<CryptoKey> | null = null;
  private readonly installations = new Map<string, string>();
  private readonly held = new Map<string, { token: string; until: number }>();
  private readonly pending = new Map<string, Promise<string>>();
  private readonly clock: () => number;

  constructor(private readonly options: AppTokensOptions) {
    this.clock = options.clock ?? Date.now;
  }

  private async jwt(): Promise<string> {
    this.key ??= importPrivateKey(this.options.app.privateKey);
    return appJwt(this.options.app.appId, await this.key, this.clock());
  }

  /** The App's installation that holds `repository`. */
  private async installation(repository: string): Promise<string> {
    const known = this.installations.get(repository);
    if (known) return known;
    const response = await this.options.fetch(
      `${this.options.api}/repos/${repository}/installation`,
      { headers: headers(await this.jwt()) },
    );
    if (response.status === 404) {
      throw new Error(
        `The relay's GitHub App is not installed on ${repository}. Install it there, or give the notebook a token of its own.`,
      );
    }
    if (response.status !== 200) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `GitHub would not say where the App is installed on ${repository} (${response.status}): ${text.slice(0, 300)}`,
      );
    }
    const id = String((await response.json<{ id: number | string }>()).id);
    this.installations.set(repository, id);
    return id;
  }

  private async mint(repository: string): Promise<string> {
    const installation = await this.installation(repository);
    const response = await this.options.fetch(
      `${this.options.api}/app/installations/${encodeURIComponent(installation)}/access_tokens`,
      {
        method: 'POST',
        headers: headers(await this.jwt()),
        // Only this repository, and only what the notebook needs.
        body: JSON.stringify({
          repositories: [repository.split('/')[1]],
          permissions: { contents: 'write', metadata: 'read' },
        }),
      },
    );
    if (response.status !== 201) {
      // The App may have been moved to another installation: ask again next time.
      this.installations.delete(repository);
      const text = await response.text().catch(() => '');
      throw new Error(
        `GitHub refused the App's installation token for ${repository} (${response.status}): ${text.slice(0, 300)}`,
      );
    }
    const data = await response.json<{ token: string; expires_at: string }>();
    this.held.set(repository, {
      token: data.token,
      until: Date.parse(data.expires_at) - REFRESH_BEFORE_MS,
    });
    return data.token;
  }

  /** A token that can write `repository`'s contents. */
  token(repository: string): Promise<string> {
    const held = this.held.get(repository);
    if (held && this.clock() < held.until) return Promise.resolve(held.token);
    let pending = this.pending.get(repository);
    if (!pending) {
      pending = this.mint(repository).finally(() => this.pending.delete(repository));
      this.pending.set(repository, pending);
    }
    return pending;
  }
}

/** Asked before every GitHub call for one notebook: its own token, or the App's for its repository. */
export function tokenSource(
  access: GitHubAccess,
  repository: string,
  app: AppTokens | null,
): () => Promise<string> {
  if (access.kind === 'token') return () => Promise.resolve(access.token);
  if (!app)
    throw new Error(`${repository} is reached through the GitHub App, which is not set up.`);
  return () => app.token(repository);
}
