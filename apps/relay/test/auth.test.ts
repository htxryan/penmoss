/**
 * The relay's settings and GitHub credentials (T55): what must be set, which redirect hosts may
 * receive a grant, and the GitHub App's installation token made from its private key, in either
 * of the PEM forms GitHub and OpenSSL write.
 */
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readConfig, redirectAllowed, sameLogin } from '../src/config';
import { appJwt, importPrivateKey, tokenSource } from '../src/github-auth';

describe('settings', () => {
  it('needs a repository, an account and GitHub credentials', () => {
    expect(readConfig({})).toMatchObject({
      problem: expect.stringMatching(/NOTES_REPOSITORY/) as string,
    });
    expect(readConfig({ NOTES_REPOSITORY: 'ryan/notes' })).toMatchObject({
      problem: expect.stringMatching(/ALLOWED_GITHUB_LOGIN/) as string,
    });
    expect(
      readConfig({ NOTES_REPOSITORY: 'ryan/notes', ALLOWED_GITHUB_LOGIN: 'htxryan' }),
    ).toMatchObject({
      problem: expect.stringMatching(/GITHUB_APP_ID/) as string,
    });
    expect(
      readConfig({
        NOTES_REPOSITORY: 'ryan/notes',
        ALLOWED_GITHUB_LOGIN: 'htxryan',
        NOTES_DIR: '../x',
        GITHUB_TOKEN: 't',
      }),
    ).toMatchObject({ problem: expect.stringMatching(/NOTES_DIR/) as string });
    expect(
      readConfig({
        NOTES_REPOSITORY: 'ryan/notes',
        ALLOWED_GITHUB_LOGIN: 'htxryan',
        NOTES_DIR: '/docs/notes/',
        GITHUB_TOKEN: 't',
      }),
    ).toMatchObject({
      root: 'docs/notes/',
      branch: 'main',
      agentLabel: 'claude.ai',
      redirectHosts: ['claude.ai', 'claude.com'],
    });
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
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pkcs1 = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
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

  it('asks for a token limited to the notes repository, and keeps it until near its end', async () => {
    let time = Date.UTC(2026, 10, 4, 9);
    const asked: { url: string; body: unknown }[] = [];
    const fetcher = ((url: string, init: RequestInit) => {
      asked.push({ url, body: JSON.parse(init.body as string) });
      return Promise.resolve(
        Response.json(
          { token: `ghs_${asked.length}`, expires_at: new Date(time + 60 * 60_000).toISOString() },
          { status: 201 },
        ),
      );
    }) as unknown as typeof fetch;
    const token = tokenSource({
      access: { kind: 'app', appId: '1', installationId: '99', privateKey: pkcs1 },
      repository: 'ryan/notes',
      api: 'https://api.github.test',
      fetch: fetcher,
      clock: () => time,
    });
    expect(await Promise.all([token(), token()])).toEqual(['ghs_1', 'ghs_1']);
    expect(asked).toEqual([
      {
        url: 'https://api.github.test/app/installations/99/access_tokens',
        body: { repositories: ['notes'], permissions: { contents: 'write', metadata: 'read' } },
      },
    ]);
    time += 50 * 60_000;
    expect(await token()).toBe('ghs_1');
    time += 6 * 60_000;
    expect(await token()).toBe('ghs_2');
  });

  it('uses a fine-grained token as it is', async () => {
    const token = tokenSource({
      access: { kind: 'token', token: 'github_pat_x' },
      repository: 'ryan/notes',
      api: 'https://api.github.test',
      fetch: () => {
        throw new Error('no call');
      },
    });
    expect(await token()).toBe('github_pat_x');
  });
});
