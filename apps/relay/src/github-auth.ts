/**
 * How the relay authenticates to GitHub (T55): a fine-grained token, or a GitHub App's
 * installation token, made from the App's private key (RS256 JWT) and limited to the notes
 * repository. Installation tokens last an hour; one is kept until five minutes before it ends.
 */
import type { GitHubAccess } from './config';

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
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
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

export interface TokenSourceOptions {
  readonly access: GitHubAccess;
  readonly repository: string;
  readonly api: string;
  readonly fetch: typeof fetch;
  readonly clock?: () => number;
}

/** Asked before every GitHub call: a token that can write the notes repository's contents. */
export function tokenSource(options: TokenSourceOptions): () => Promise<string> {
  const { access } = options;
  if (access.kind === 'token') return () => Promise.resolve(access.token);
  const clock = options.clock ?? Date.now;
  let key: Promise<CryptoKey> | null = null;
  let held: { token: string; until: number } | null = null;
  let pending: Promise<string> | null = null;
  const mint = async (): Promise<string> => {
    key ??= importPrivateKey(access.privateKey);
    const jwt = await appJwt(access.appId, await key, clock());
    const response = await options.fetch(
      `${options.api}/app/installations/${encodeURIComponent(access.installationId)}/access_tokens`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${jwt}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'penmoss-relay',
          'content-type': 'application/json',
        },
        // Only the notes repository, and only what the notebook needs.
        body: JSON.stringify({
          repositories: [options.repository.split('/')[1]],
          permissions: { contents: 'write', metadata: 'read' },
        }),
      },
    );
    if (response.status !== 201) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `GitHub refused the App's installation token (${response.status}): ${text.slice(0, 300)}`,
      );
    }
    const data = await response.json<{ token: string; expires_at: string }>();
    held = { token: data.token, until: Date.parse(data.expires_at) - REFRESH_BEFORE_MS };
    return data.token;
  };
  return () => {
    if (held && clock() < held.until) return Promise.resolve(held.token);
    pending ??= mint().finally(() => {
      pending = null;
    });
    return pending;
  };
}
