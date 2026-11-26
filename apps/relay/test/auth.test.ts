/**
 * The relay's settings and GitHub credentials (T55): what must be set, which redirect hosts may
 * receive a grant, and the GitHub App's installation token made from its private key, in either
 * of the PEM forms GitHub and OpenSSL write.
 */
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkPlace, readBasics, readConfig, redirectAllowed, sameLogin } from '../src/config';
import { AppTokens, appJwt, importPrivateKey, tokenSource } from '../src/github-auth';
import { syncedAgo } from '../src/notebooks';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pkcs1 = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const APP = { appId: '1', privateKey: pkcs1 };

describe('settings', () => {
  it('needs the owner, and serves an App notebook only once the App exists', () => {
    expect(readConfig({}, null, [])).toMatchObject({
      problem: expect.stringMatching(/OWNER_GITHUB_LOGIN/) as string,
    });
    expect(readConfig({ OWNER_GITHUB_LOGIN: 'not a login' }, null, [])).toMatchObject({
      problem: expect.stringMatching(/OWNER_GITHUB_LOGIN/) as string,
    });
    const places = [
      { repository: 'ryan/notes', branch: 'main', root: '', access: { kind: 'app' } },
      { repository: 'ryan/work', branch: 'dev', root: 'p/', access: { kind: 'token', token: 't' } },
    ] as const;
    expect(readConfig({ OWNER_GITHUB_LOGIN: 'htxryan' }, null, places)).toMatchObject({
      notebooks: [{ repository: 'ryan/work' }],
      app: null,
    });
    expect(readConfig({ OWNER_GITHUB_LOGIN: 'htxryan' }, APP, places)).toMatchObject({
      owner: 'htxryan',
      notebooks: [{ repository: 'ryan/notes' }, { repository: 'ryan/work' }],
      app: { appId: '1' },
      agentLabel: 'claude.ai',
      redirectHosts: ['claude.ai', 'claude.com'],
    });
  });

  it('checks a notebook’s place as the Notebooks page takes it', () => {
    expect(checkPlace(' htxryan/penmoss-notes ', 'main', '')).toEqual({
      repository: 'htxryan/penmoss-notes',
      branch: 'main',
      root: '',
    });
    expect(checkPlace('https://github.com/q/scratch.git', 'dev', '/penmoss/')).toEqual({
      repository: 'q/scratch',
      branch: 'dev',
      root: 'penmoss/',
    });
    expect(checkPlace('nope', 'main', '')).toMatchObject({
      problem: expect.stringMatching(/owner\/name/) as string,
    });
    expect(checkPlace('a/b', 'has space', '')).toMatchObject({
      problem: expect.stringMatching(/isn’t a branch name/) as string,
    });
    expect(checkPlace('a/b', 'main', '../up')).toMatchObject({
      problem: expect.stringMatching(/inside the repository/) as string,
    });
  });

  it('needs only the owner for the pages, set up or not', () => {
    expect(readBasics({ OWNER_GITHUB_LOGIN: 'htxryan' })).toMatchObject({
      owner: 'htxryan',
      web: 'https://github.com',
      api: 'https://api.github.com',
    });
    expect(readBasics({})).toMatchObject({ problem: expect.stringMatching(/OWNER/) as string });
  });

  it('grants only to https redirects on an allowed host', () => {
    const hosts = ['claude.ai', 'claude.com'];
    expect(redirectAllowed('https://claude.ai/api/mcp/auth_callback', hosts)).toBe(true);
    expect(redirectAllowed('https://www.claude.com/cb', hosts)).toBe(true);
    expect(redirectAllowed('http://claude.ai/cb', hosts)).toBe(false);
    expect(redirectAllowed('https://claude.ai.evil.example/cb', hosts)).toBe(false);
    expect(redirectAllowed('https://evilclaude.ai/cb', hosts)).toBe(false);
    expect(redirectAllowed('not a url', hosts)).toBe(false);
  });

  it('compares GitHub logins without case', () => {
    expect(sameLogin('HtxRyan', 'htxryan')).toBe(true);
    expect(sameLogin('someone', 'htxryan')).toBe(false);
    expect(sameLogin(undefined, 'htxryan')).toBe(false);
  });
});

describe('the GitHub App installation token', () => {
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  it.each([
    ['PKCS#1 (as GitHub hands it out)', pkcs1],
    ['PKCS#8', pkcs8],
    ['PKCS#1 with escaped newlines (as pasted into a secret)', pkcs1.replace(/\n/g, '\\n')],
  ])('signs a JWT GitHub can verify from a %s key', async (_, pem) => {
    const jwt = await appJwt('12345', await importPrivateKey(pem), Date.UTC(2026, 10, 4));
    const [head, body, signature] = jwt.split('.');
    const ok = verify(
      'RSA-SHA256',
      Buffer.from(`${head}.${body}`),
      createPublicKey(publicKey.export({ type: 'spki', format: 'pem' })),
      Buffer.from(signature!, 'base64url'),
    );
    expect(ok).toBe(true);
    expect(JSON.parse(Buffer.from(body!, 'base64url').toString())).toEqual({
      iat: Date.UTC(2026, 10, 4) / 1000 - 60,
      exp: Date.UTC(2026, 10, 4) / 1000 + 540,
      iss: '12345',
    });
  });

  it('finds the installation on each repository, and keeps each token until near its end', async () => {
    let time = Date.UTC(2026, 10, 4, 9);
    const asked: { method: string; url: string; body?: unknown }[] = [];
    let minted = 0;
    const fetcher = ((url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      asked.push({
        method,
        url,
        ...(init.body ? { body: JSON.parse(init.body as string) as unknown } : {}),
      });
      if (url.endsWith('/repos/ryan/notes/installation'))
        return Promise.resolve(Response.json({ id: 99 }));
      if (url.endsWith('/repos/ryan/work/installation'))
        return Promise.resolve(Response.json({ id: 7 }));
      if (url.endsWith('/installation')) {
        return Promise.resolve(Response.json({ message: 'Not Found' }, { status: 404 }));
      }
      minted += 1;
      return Promise.resolve(
        Response.json(
          { token: `ghs_${minted}`, expires_at: new Date(time + 60 * 60_000).toISOString() },
          { status: 201 },
        ),
      );
    }) as unknown as typeof fetch;
    const app = new AppTokens({
      app: { appId: '1', privateKey: pkcs1 },
      api: 'https://api.github.test',
      fetch: fetcher,
      clock: () => time,
    });
    const notes = tokenSource({ kind: 'app' }, 'ryan/notes', app);
    const work = tokenSource({ kind: 'app' }, 'ryan/work', app);
    expect(await Promise.all([notes(), notes()])).toEqual(['ghs_1', 'ghs_1']);
    expect(await work()).toBe('ghs_2');
    expect(asked).toEqual([
      { method: 'GET', url: 'https://api.github.test/repos/ryan/notes/installation' },
      {
        method: 'POST',
        url: 'https://api.github.test/app/installations/99/access_tokens',
        body: { repositories: ['notes'], permissions: { contents: 'write', metadata: 'read' } },
      },
      { method: 'GET', url: 'https://api.github.test/repos/ryan/work/installation' },
      {
        method: 'POST',
        url: 'https://api.github.test/app/installations/7/access_tokens',
        body: { repositories: ['work'], permissions: { contents: 'write', metadata: 'read' } },
      },
    ]);
    time += 50 * 60_000;
    expect(await notes()).toBe('ghs_1');
    time += 6 * 60_000;
    expect(await notes()).toBe('ghs_3');
    // The installation is asked for once per repository.
    expect(asked.filter((each) => each.url.endsWith('/installation'))).toHaveLength(2);
    await expect(tokenSource({ kind: 'app' }, 'other/repo', app)()).rejects.toThrow(
      /not installed on other\/repo/,
    );
  });

  it('uses a fine-grained token as it is, never the App', async () => {
    const token = tokenSource({ kind: 'token', token: 'github_pat_x' }, 'ryan/notes', null);
    expect(await token()).toBe('github_pat_x');
  });
});

describe('the Notebooks page’s words', () => {
  it('says when a notebook last synced', () => {
    const now = Date.UTC(2026, 10, 26, 12);
    expect(syncedAgo(now - 1_000, now)).toBe('Synced 1 second ago');
    expect(syncedAgo(now - 12_000, now)).toBe('Synced 12 seconds ago');
    expect(syncedAgo(now - 3 * 60_000, now)).toBe('Synced 3 minutes ago');
    expect(syncedAgo(now - 2 * 3_600_000, now)).toBe('Synced 2 hours ago');
    expect(syncedAgo(now - 86_400_000, now)).toBe('Synced 1 day ago');
  });
});
