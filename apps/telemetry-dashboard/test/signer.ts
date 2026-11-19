/**
 * A stand-in for Cloudflare Access in tests (PEN-137): an RSA key pair made on the spot, the
 * team's certs as Access publishes them, and tokens signed as Access signs them. Runs in workerd
 * (the API tests) and in Node (the Playwright spec's server).
 */
import type { AccessKey, FetchCerts } from '../src/access';

export const TEST_TEAM = 'penmoss-test';
export const TEST_ISSUER = `https://${TEST_TEAM}.cloudflareaccess.com`;
export const TEST_AUD = 'penmoss-test-access-audience';

const b64url = (bytes: Uint8Array | string) =>
  btoa(typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export interface TestSigner {
  /** What https://<team>.cloudflareaccess.com/cdn-cgi/access/certs answers. */
  readonly certs: { keys: AccessKey[] };
  readonly fetchCerts: FetchCerts;
  /** A token for the test application, valid for an hour, with `claims` over the defaults. */
  sign(claims?: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
}

async function keyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
}

/** A signer with its own key, `kid`. */
export async function createSigner(kid = 'test-key-1'): Promise<TestSigner> {
  const { privateKey, publicKey } = await keyPair();
  const jwk = (await crypto.subtle.exportKey('jwk', publicKey)) as JsonWebKey;
  const certs = {
    keys: [{ kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig', kid } as AccessKey],
  };
  return {
    certs,
    fetchCerts: (url) => {
      if (url !== `${TEST_ISSUER}/cdn-cgi/access/certs`) {
        return Promise.reject(new Error(`unexpected certs URL ${url}`));
      }
      return Promise.resolve(structuredClone(certs));
    },
    async sign(claims = {}, header = {}) {
      const now = Math.floor(Date.now() / 1000);
      const head = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT', ...header }));
      const body = b64url(
        JSON.stringify({
          aud: [TEST_AUD],
          email: 'ryan@example.invalid',
          exp: now + 3600,
          iat: now,
          nbf: now,
          iss: TEST_ISSUER,
          sub: '7335d417-61da-459d-899c-0a01c76a2f94',
          type: 'app',
          ...claims,
        }),
      );
      const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        privateKey,
        new TextEncoder().encode(`${head}.${body}`),
      );
      return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
    },
  };
}
