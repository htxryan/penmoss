import { execFileSync } from 'node:child_process';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appJwt,
  createAppTokens,
  loadAppCredentials,
  READ_ONLY,
  type Fetcher,
} from '../src/github-app.ts';
import { createGh } from '../src/github.ts';
import { TOKEN_HELPER } from '../src/host.ts';
import { botless } from '../src/review.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A fake api.github.com: the installation, two token kinds, the app and its bot user. */
function github() {
  const calls: { path: string; auth: string | null; body: unknown }[] = [];
  let minted = 0;
  const fetcher: Fetcher = (url, init) => {
    const path = url.replace('https://api.github.com', '');
    const auth = (init.headers as Record<string, string>)['Authorization'] ?? null;
    const body = init.body ? (JSON.parse(init.body as string) as unknown) : undefined;
    calls.push({ path, auth, body });
    if (path === '/repos/htxryan/penmoss/installation') return Promise.resolve(json({ id: 77 }));
    if (path === '/app/installations/77/access_tokens')
      return Promise.resolve(
        json({ token: `ghs_${++minted}`, expires_at: '2026-11-08T13:00:00Z' }, 201),
      );
    if (path === '/app') return Promise.resolve(json({ slug: 'penmoss-factory' }));
    if (path === '/users/penmoss-factory%5Bbot%5D') return Promise.resolve(json({ id: 4242 }));
    return Promise.resolve(json({ message: 'Not Found' }, 404));
  };
  return { fetcher, calls };
}

describe('the GitHub App (A1222)', () => {
  it('signs a JWT GitHub accepts: RS256, back-dated a minute, under ten minutes', () => {
    const jwt = appJwt('123', privateKey, 1_000_000);
    const [h, p, sig] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toEqual({
      iat: 999_940,
      exp: 1_000_540,
      iss: '123',
    });
    const verify = createVerify('RSA-SHA256');
    verify.update(`${h}.${p}`);
    expect(verify.verify(publicKey, Buffer.from(sig!, 'base64url'))).toBe(true);
  });

  it('mints tokens for this repository only, read-only for sandboxes, and reuses them', async () => {
    const { fetcher, calls } = github();
    let now = Date.parse('2026-11-08T12:00:00Z');
    const app = createAppTokens({
      appId: '123',
      privateKey,
      repo: 'htxryan/penmoss',
      fetcher,
      now: () => now,
    });
    expect(await app.write()).toBe('ghs_1');
    expect(await app.read()).toBe('ghs_2');
    expect(await app.write()).toBe('ghs_1');
    const mints = calls.filter((c) => c.path.endsWith('/access_tokens'));
    expect(mints.map((c) => c.body)).toEqual([
      { repositories: ['penmoss'] },
      { repositories: ['penmoss'], permissions: READ_ONLY },
    ]);
    expect(mints.every((c) => c.auth?.startsWith('Bearer ey'))).toBe(true);
    // The installation is looked up once.
    expect(calls.filter((c) => c.path.endsWith('/installation'))).toHaveLength(1);
    // Ten minutes before expiry, a new one.
    now = Date.parse('2026-11-08T12:51:00Z');
    expect(await app.write()).toBe('ghs_3');
  });

  it("names its commits as the app's bot user", async () => {
    const app = createAppTokens({
      appId: '1',
      privateKey,
      repo: 'htxryan/penmoss',
      fetcher: github().fetcher,
    });
    expect(await app.identity()).toEqual({
      slug: 'penmoss-factory',
      name: 'penmoss-factory[bot]',
      email: '4242+penmoss-factory[bot]@users.noreply.github.com',
    });
  });

  it('says when the app is not installed on the repository', async () => {
    const app = createAppTokens({
      appId: '1',
      privateKey,
      repo: 'htxryan/other',
      fetcher: github().fetcher,
    });
    await expect(app.write()).rejects.toThrow(
      'GitHub /repos/htxryan/other/installation: Not Found',
    );
  });

  it('reads the ID and a mode-600 key, and refuses an open key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-app-'));
    const key = join(dir, 'app.pem');
    writeFileSync(key, privateKey);
    chmodSync(key, 0o644);
    const env = join(dir, 'github-app.env');
    writeFileSync(env, `GITHUB_APP_ID=123\nGITHUB_APP_PRIVATE_KEY=${key}\n`);
    chmodSync(env, 0o600);
    expect(loadAppCredentials(env)).toEqual({
      ok: false,
      error: `${key} must be readable by you alone: chmod 600 it`,
    });
    chmodSync(key, 0o600);
    expect(loadAppCredentials(env)).toEqual({ ok: true, appId: '123', privateKey });
  });
});

describe('the publisher uses the token, never a stored login', { timeout: 30_000 }, () => {
  it('passes a fresh token to every gh call', async () => {
    const seen: (string | undefined)[] = [];
    let n = 0;
    const gh = createGh({
      exec: (_bin, _args, options) => {
        seen.push(options?.env?.['GH_TOKEN']);
        return Promise.resolve({ code: 0, stdout: '{}', stderr: '' });
      },
      env: { GH_CONFIG_DIR: '/empty' },
      token: () => Promise.resolve(`t${++n}`),
    });
    await gh.run(['pr', 'list']);
    await gh.json(['pr', 'view']);
    expect(seen).toEqual(['t1', 't2']);
  });

  it("gives git the token as x-access-token's password, and only for get", () => {
    const helper = TOKEN_HELPER[3]!.replace(/^credential\.helper=!/, '');
    const out = (op: string) =>
      // git runs a `!` helper through the shell with the operation appended. git ignores a
      // helper that doesn't read its input; here the shell drains it after the helper, keeping
      // its status, or the write races the shell's exit and fails with EPIPE.
      execFileSync('sh', ['-c', `${helper} ${op}; s=$?; cat >/dev/null; exit $s`], {
        env: { PATH: process.env['PATH'] ?? '', GH_TOKEN: 'ghs_x' },
        input: 'protocol=https\nhost=github.com\n\n',
      }).toString();
    expect(out('get')).toBe('username=x-access-token\npassword=ghs_x\n');
    expect(() => out('store')).toThrow();
  });

  it("reads the app's GraphQL and REST names as one", () => {
    expect(botless('penmoss-factory[bot]')).toBe('penmoss-factory');
    expect(botless('penmoss-factory')).toBe('penmoss-factory');
    expect(botless('htxryan')).toBe('htxryan');
  });
});
