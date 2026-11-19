/**
 * Cloudflare Access's JWT, checked on every request (PEN-137, AC34). Access stands in front of
 * stats.penmoss.app and adds `Cf-Access-Jwt-Assertion` to each request it lets through; the
 * Worker checks it again so a request that reaches the Worker any other way gets nothing.
 *
 * The token must be RS256, signed by one of the team's keys
 * (https://<team>.cloudflareaccess.com/cdn-cgi/access/certs), for this application's AUD, issued
 * by the team, and not expired. Anything else, or a Worker without its team and AUD, is refused.
 */

export interface AccessEnv {
  /** The Zero Trust team: its name, or its whole <team>.cloudflareaccess.com domain. */
  readonly ACCESS_TEAM?: string;
  /** The Access application's AUD tag. */
  readonly ACCESS_AUD?: string;
}

export interface AccessKey extends JsonWebKey {
  readonly kid?: string;
}

/** Fetches the team's signing keys from `url`. Tests pass their own. */
export type FetchCerts = (url: string) => Promise<{ keys: AccessKey[] }>;

export interface AccessClaims {
  readonly aud: string | string[];
  readonly iss: string;
  readonly exp: number;
  readonly nbf?: number;
  readonly iat?: number;
  readonly email?: string;
  readonly sub?: string;
}

/** The header Access adds. */
export const ACCESS_HEADER = 'cf-access-jwt-assertion';
/** How long the team's keys are kept before they are fetched again. */
const KEYS_FOR_MS = 60 * 60_000;
/** A key id not among the kept keys fetches them again, at most this often (Access rotates). */
const REFETCH_AFTER_MS = 60_000;
/** Clock difference allowed for nbf. */
const SKEW_S = 60;

export const fetchCertsOverNetwork: FetchCerts = async (url) => {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Access certs: ${response.status}`);
  const certs: unknown = await response.json();
  return certs as { keys: AccessKey[] };
};

/** The team's host, or null when the setting is missing or not a host name. */
export function teamHost(team: string | undefined): string | null {
  const value = team?.trim().toLowerCase() ?? '';
  if (!/^[a-z0-9-]+(\.cloudflareaccess\.com)?$/.test(value)) return null;
  return value.includes('.') ? value : `${value}.cloudflareaccess.com`;
}

function base64UrlBytes(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return Uint8Array.from(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)), (c) =>
      c.charCodeAt(0),
    );
  } catch {
    return null;
  }
}

function base64UrlJson(text: string): Record<string, unknown> | null {
  const bytes = base64UrlBytes(text);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Checks Access JWTs, keeping each team's keys for an hour. */
export class AccessVerifier {
  private readonly keys = new Map<string, { keys: AccessKey[]; at: number }>();

  constructor(private readonly fetchCerts: FetchCerts = fetchCertsOverNetwork) {}

  private async keyFor(host: string, kid: string, now: number): Promise<AccessKey | null> {
    let kept = this.keys.get(host);
    const find = () => kept?.keys.find((key) => key.kid === kid) ?? null;
    const stale = !kept || now - kept.at > KEYS_FOR_MS;
    if (stale || (!find() && now - kept!.at > REFETCH_AFTER_MS)) {
      const certs = await this.fetchCerts(`https://${host}/cdn-cgi/access/certs`);
      kept = { keys: Array.isArray(certs.keys) ? certs.keys : [], at: now };
      this.keys.set(host, kept);
    }
    return find();
  }

  /** The token's claims when `request` carries a valid one for `env`'s application, else null. */
  async verify(request: Request, env: AccessEnv, now = Date.now()): Promise<AccessClaims | null> {
    const host = teamHost(env.ACCESS_TEAM);
    const audience = env.ACCESS_AUD?.trim() ?? '';
    const token = request.headers.get(ACCESS_HEADER)?.trim() ?? '';
    if (!host || !audience || !token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    const header = base64UrlJson(headerPart);
    const claims = base64UrlJson(payloadPart);
    const signature = base64UrlBytes(signaturePart);
    if (!header || !claims || !signature || signature.length === 0) return null;
    if (header['alg'] !== 'RS256' || typeof header['kid'] !== 'string') return null;

    // The claims before the signature: a token for another application is refused unread.
    const seconds = now / 1000;
    const aud = claims['aud'];
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (!audiences.includes(audience)) return null;
    if (claims['iss'] !== `https://${host}`) return null;
    const exp = claims['exp'];
    if (typeof exp !== 'number' || exp <= seconds) return null;
    const nbf = claims['nbf'];
    if (nbf !== undefined && (typeof nbf !== 'number' || nbf > seconds + SKEW_S)) return null;

    let key: AccessKey | null;
    try {
      key = await this.keyFor(host, header['kid'], now);
    } catch {
      return null;
    }
    if (!key || key.kty !== 'RSA' || typeof key.n !== 'string' || typeof key.e !== 'string') {
      return null;
    }
    try {
      const cryptoKey = await crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n: key.n, e: key.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      );
      const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
      const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, signed);
      return valid ? (claims as unknown as AccessClaims) : null;
    } catch {
      return null;
    }
  }
}
