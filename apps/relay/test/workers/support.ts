/** The relay in workerd as tests set it up (PEN-193). */
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { StoredApp } from '../../src/app';

export const TEST_APP: StoredApp = {
  id: 4242,
  slug: 'htxryan-penmoss-relay',
  name: 'htxryan Penmoss Relay',
  owner: 'htxryan',
  htmlUrl: 'https://github.test/apps/htxryan-penmoss-relay',
  clientId: 'Iv1.fakeclient',
  clientSecret: 'fake-client-secret-0123456789',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nFAKEKEY\n-----END RSA PRIVATE KEY-----\n',
};

const relayObject = () => env.NOTEBOOK.get(env.NOTEBOOK.idFromName('notebook'));

/** Keeps the test App in the relay's storage, as setup does. */
export async function keepTestApp(): Promise<void> {
  await runInDurableObject(relayObject(), async (instance) => {
    await instance.keepApp(TEST_APP);
  });
}

/** Forgets the relay's App, as a relay not set up yet has none. */
export async function forgetApp(): Promise<void> {
  await runInDurableObject(relayObject(), (_instance, state) => {
    state.storage.sql.exec("DELETE FROM blobs WHERE key = 'settings:app'");
  });
}
