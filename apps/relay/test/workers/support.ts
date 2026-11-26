/** The relay in workerd as tests set it up (PEN-193). */
import { runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import type { StoredApp } from '../../src/app';
import { writeNotebookList } from '../../src/notebook-list';
import { SqlBlobs } from '../../src/storage';

export const TEST_APP: StoredApp = {
  id: 4242,
  slug: 'htxryan-penmoss-relay',
  name: 'htxryan Penmoss Relay',
  owner: 'htxryan',
  htmlUrl: 'https://github.test/apps/htxryan-penmoss-relay',
  clientId: 'Iv1.fakeclient',
  clientSecret: 'fake-client-secret-0123456789',
  // Not a key: nothing here signs with it.
  pem: 'fake-private-key-FAKEKEY',
};

const relayObject = () => env.NOTEBOOK.get(env.NOTEBOOK.idFromName('notebook'));

let pem: Promise<string> | null = null;

/** A real RSA key, as GitHub hands one out, so the App's JWT can be signed. */
function testKey(): Promise<string> {
  pem ??= (async () => {
    const pair = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const der = new Uint8Array(
      (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer,
    );
    const body = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, '$1\n');
    return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
  })();
  return pem;
}

/** Keeps the test App in the relay's storage, as setup does. */
export async function keepTestApp(): Promise<void> {
  const key = await testKey();
  await runInDurableObject(relayObject(), async (instance) => {
    await instance.keepApp({ ...TEST_APP, pem: key });
  });
}

/** Signs in to the relay's pages as whoever GitHub (faked) says: the response to its return. */
export async function signInToPages(): Promise<Response> {
  const start = await call('/sign-in');
  const github = new URL(start.headers.get('location')!);
  const state = github.searchParams.get('state')!;
  const stateCookie = start.headers.get('set-cookie')!.split(';')[0]!;
  return call(`/callback?code=c&state=${state}`, { headers: { cookie: stateCookie } });
}

export const ORIGIN = 'https://mcp.penmoss.test';

export const call = (path: string, init: RequestInit = {}) =>
  exports.default.fetch(`${ORIGIN}${path}`, { redirect: 'manual', ...init });

/** Forgets the relay's App, as a relay not set up yet has none. */
export async function forgetApp(): Promise<void> {
  await runInDurableObject(relayObject(), (instance, state) => {
    state.storage.sql.exec("DELETE FROM blobs WHERE key LIKE 'settings:%'");
    (instance as unknown as { built: unknown }).built = null;
  });
}

/** The notebooks the Notebooks page would have added: ryan/notes by the App, quanta/scratch by a token. */
const TEST_NOTEBOOKS = [
  { repository: 'ryan/notes', branch: 'main', root: '' },
  { repository: 'quanta/scratch', branch: 'dev', root: 'penmoss/', token: 'github_pat_quanta0042' },
];

/** Keeps the test notebooks in the relay's storage, as the Notebooks page does. */
export async function keepTestNotebooks(list = TEST_NOTEBOOKS): Promise<void> {
  await runInDurableObject(relayObject(), (instance, state) => {
    writeNotebookList(new SqlBlobs(state.storage), list);
    // The object makes its relay again from what is kept, as after any change on the page.
    (instance as unknown as { built: unknown }).built = null;
  });
}
