/**
 * The person's GitHub token on the Mac (T57, A1010–A1012) and updates read with it (A1015): kept
 * sealed, checked when saved, never kept when GitHub refuses it; Send feedback filed with it
 * against the fake GitHub, once per submission across restarts; the updater waiting for it.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fieldGroup } from '@penmoss/core/feedback';
import { TOKEN_MESSAGES } from '@penmoss/core/feedback-github';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeFeedbackGitHub } from '../../../../packages/core/test/support/fake-github-feedback';
import { chromiumInit, GitHubToken, screenshotsOf } from '../../src/github-token';

const TOKEN = 'fake-feedback-token';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 7]);
let dir: string;
let fake: FakeFeedbackGitHub;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'penmoss-github-token-'));
  fake = new FakeFeedbackGitHub();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A seal that is not the clear text, as safeStorage's is not. */
const seal = (plain: string) => Promise.resolve(`sealed:${Buffer.from(plain).toString('base64')}`);
const unseal = (sealed: string) =>
  Promise.resolve(Buffer.from(sealed.replace(/^sealed:/, ''), 'base64').toString());

function store(options: { keychain?: boolean; onChange?: () => void } = {}) {
  return new GitHubToken({
    dir,
    seal: options.keychain === false ? () => Promise.resolve(null) : seal,
    unseal,
    fetch: fake.fetch,
    api: fake.base,
    ...(options.onChange ? { onChange: options.onChange } : {}),
  });
}

const payload = (submissionId = '01JD0000000000000000000001') =>
  JSON.stringify({
    submissionId,
    type: 'feature',
    priority: 3,
    title: 'Pin folders',
    description: 'Please.',
    version: '0.1.400 (400)',
    context: { groups: [fieldGroup('app', [['Client', 'Mac']])] },
  });

describe('GitHubToken (A1012)', () => {
  it('keeps a token GitHub accepts, sealed, and says whose it is but never what it is', async () => {
    const changed = vi.fn();
    const tokens = store({ onChange: changed });
    expect(await tokens.status()).toEqual({
      saved: false,
      login: null,
      problem: null,
      keychain: true,
      signedIn: false,
    });
    const saved = await tokens.save(` ${TOKEN}\n`);
    expect(saved).toMatchObject({ ok: true, note: null });
    expect(changed).toHaveBeenCalledOnce();
    const status = await tokens.status();
    expect(status).toEqual({
      saved: true,
      login: 'htxryan',
      problem: null,
      keychain: true,
      signedIn: false,
    });
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    const onDisk = await readFile(join(dir, 'github-token.json'), 'utf8');
    expect(onDisk).not.toContain(TOKEN);
    // A new launch reads it back.
    expect(await store().token()).toBe(TOKEN);
  });

  it('refuses, in plain words, a token GitHub does not accept or that cannot open issues', async () => {
    const tokens = store();
    expect(await tokens.save('ghp_wrong')).toEqual({ ok: false, message: TOKEN_MESSAGES.invalid });
    fake.fail('/repos/htxryan/penmoss', 404, 1, { message: 'Not Found' }, {}, { method: 'GET' });
    expect(await tokens.save(TOKEN)).toEqual({ ok: false, message: TOKEN_MESSAGES.cannotFile });
    expect(await tokens.token()).toBeNull();
    expect(await tokens.save('two words')).toMatchObject({ ok: false });
  });

  it('keeps Sign in with GitHub’s token without the feedback check, and marks it refused (T82, A1171)', async () => {
    const changed = vi.fn();
    const tokens = store({ onChange: changed });
    expect(await tokens.saveSignedIn('gho_signedin', 'ryan')).toBe(true);
    // GitHub was not asked about the feedback repository.
    expect(fake.calls).toEqual([]);
    expect(await tokens.status()).toEqual({
      saved: true,
      login: 'ryan',
      problem: null,
      keychain: true,
      signedIn: true,
    });
    // A new launch knows it came from Sign in with GitHub.
    expect((await store().status()).signedIn).toBe(true);
    expect(await readFile(join(dir, 'github-token.json'), 'utf8')).not.toContain('gho_signedin');
    await tokens.refused();
    expect((await tokens.status()).problem).toMatch(/Sign in again/);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(await tokens.saveSignedIn('two words', null)).toBe(false);
    expect(await store({ keychain: false }).saveSignedIn('gho_x', null)).toBe(false);
  });

  it('keeps nothing without the Keychain', async () => {
    const tokens = store({ keychain: false });
    expect(await tokens.save(TOKEN)).toMatchObject({ ok: false, message: /Keychain/ });
    expect((await tokens.status()).keychain).toBe(false);
  });

  it('removes it', async () => {
    const tokens = store();
    await tokens.save(TOKEN);
    expect((await tokens.remove()).saved).toBe(false);
    expect(await store().token()).toBeNull();
  });
});

describe('Send feedback filed by the Mac (A1010, A1011)', () => {
  it('waits without a token: the outbox keeps it, nothing reaches GitHub', async () => {
    const answer = await store().file(payload(), []);
    expect(answer).toEqual({
      status: 0,
      body: { error: { code: 'no_github_token', message: TOKEN_MESSAGES.missing } },
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('files with the screenshot, once, even after the app restarts', async () => {
    const tokens = store();
    await tokens.save(TOKEN);
    const first = await tokens.file(payload(), [{ type: 'image/png', bytes: PNG }]);
    expect(first.status).toBe(201);
    expect(fake.uploads.map((upload) => upload.bytes)).toEqual([PNG]);
    expect(fake.issues[0]!.body).toContain('Sent from Penmoss Mac 0.1.400 (400)');
    // A new launch: the ledger on disk answers with the same issue.
    const again = await store().file(payload(), [{ type: 'image/png', bytes: PNG }]);
    expect(again.status).toBe(200);
    expect(fake.issues).toHaveLength(1);
  });

  it('says in Settings what GitHub refused the token for, and clears it once one is filed', async () => {
    const tokens = store();
    await tokens.save(TOKEN);
    fake.fail('/repos/htxryan/penmoss/issues', 403, 1, {
      message: 'Resource not accessible by personal access token',
    });
    const refused = await tokens.file(payload('01JD0000000000000000000002'), []);
    expect(refused.status).toBe(424);
    expect((await tokens.status()).problem).toBe(TOKEN_MESSAGES.cannotFile);
    expect((await tokens.file(payload('01JD0000000000000000000003'), [])).status).toBe(201);
    expect((await tokens.status()).problem).toBeNull();
  });

  it('leaves Content-Length to Chromium, which refuses one set by hand', () => {
    const init = chromiumInit({
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'Content-Length': '13' },
    });
    const headers = new Headers(init?.headers);
    expect(headers.get('content-length')).toBeNull();
    expect(headers.get('content-type')).toBe('image/png');
    expect(chromiumInit(undefined)).toBeUndefined();
  });

  it('takes only screenshots it can read', () => {
    expect(screenshotsOf([{ type: 'image/png', bytes: PNG }])).toHaveLength(1);
    expect(screenshotsOf([{ type: 'image/png', bytes: 'not bytes' }])).toBeNull();
    expect(screenshotsOf('nope')).toBeNull();
    expect(
      screenshotsOf(Array.from({ length: 7 }, () => ({ type: 'image/png', bytes: PNG }))),
    ).toBeNull();
  });
});
