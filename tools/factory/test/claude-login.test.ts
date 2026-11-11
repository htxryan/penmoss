import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  account,
  FRESH_MS,
  freshLogin,
  hasLogin,
  keychainService,
  loginCheck,
  parseLogin,
  stageLogin,
  stagingDir,
  type OAuthLogin,
} from '../src/claude-login.ts';
import type { Exec, ExecOptions } from '../src/exec.ts';
import { testConfig } from './helpers.ts';

const config = testConfig();
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const login = (over: Partial<OAuthLogin> = {}): OAuthLogin => ({
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: NOW + 7 * HOUR,
  scopes: ['user:inference', 'user:sessions:claude_code'],
  subscriptionType: 'max',
  rateLimitTier: 'tier',
  ...over,
});

/** The keychain, as `security` and `claude auth login` see it: a refresh replaces the login. */
function keychain(start: OAuthLogin | undefined, refreshed: OAuthLogin | undefined) {
  let stored = start;
  const calls: { cmd: string; args: readonly string[]; options?: ExecOptions }[] = [];
  const exec: Exec = (cmd, args, options) => {
    calls.push({ cmd, args, ...(options ? { options } : {}) });
    if (cmd === 'security')
      return Promise.resolve(
        stored
          ? { code: 0, stdout: JSON.stringify({ claudeAiOauth: stored }), stderr: '' }
          : { code: 44, stdout: '', stderr: 'not found' },
      );
    if (!refreshed)
      return Promise.resolve({ code: 1, stdout: '', stderr: 'refresh-1 was already used' });
    stored = refreshed;
    return Promise.resolve({ code: 0, stdout: 'Login successful.', stderr: '' });
  };
  return { exec, calls, refreshes: () => calls.filter((c) => c.cmd !== 'security') };
}

describe("the factory's claude.ai login", () => {
  it("names the keychain item Claude Code keeps a config folder's login in", () => {
    // Claude Code's own name for this folder's login, as the keychain shows it.
    expect(keychainService('/Users/redhale/.config/penmoss-factory/claude')).toBe(
      'Claude Code-credentials-c8518f7d',
    );
  });

  it('reads the login and the account Claude Code recorded', () => {
    expect(parseLogin(JSON.stringify({ claudeAiOauth: login() }))?.accessToken).toBe('access-1');
    expect(parseLogin('{"claudeAiOauth":{}}')).toBeUndefined();
    expect(parseLogin('not json')).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), 'factory-login-'));
    expect(hasLogin(dir)).toBe(false);
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { org: 'o' } }));
    expect(hasLogin(dir)).toBe(true);
    expect(account(dir)).toEqual({ org: 'o' });
  });

  it('uses a login with enough time left as it is', async () => {
    const k = keychain(login(), undefined);
    const got = await freshLogin(k.exec, config, '/f', () => NOW);
    expect(got.accessToken).toBe('access-1');
    expect(k.refreshes()).toHaveLength(0);
  });

  it("refreshes one with less than FRESH_MS left, through Claude Code's own login", async () => {
    const k = keychain(
      login({ expiresAt: NOW + FRESH_MS - 1 }),
      login({ accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: NOW + 8 * HOUR }),
    );
    const got = await freshLogin(k.exec, config, '/f', () => NOW);
    expect(got.accessToken).toBe('access-2');
    const [refresh] = k.refreshes();
    expect(refresh?.args).toEqual(['auth', 'login']);
    expect(refresh?.options?.env).toMatchObject({
      CLAUDE_CONFIG_DIR: '/f',
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'refresh-1',
      CLAUDE_CODE_OAUTH_SCOPES: 'user:inference user:sessions:claude_code',
    });
  });

  it('refreshes once when two slots start together: a refresh token works once', async () => {
    const k = keychain(
      login({ expiresAt: NOW + HOUR }),
      login({ accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: NOW + 8 * HOUR }),
    );
    const [a, b] = await Promise.all([
      freshLogin(k.exec, config, '/f', () => NOW),
      freshLogin(k.exec, config, '/f', () => NOW),
    ]);
    expect([a.accessToken, b.accessToken]).toEqual(['access-2', 'access-2']);
    expect(k.refreshes()).toHaveLength(1);
  });

  it("says why it can't refresh, without the refresh token", async () => {
    const k = keychain(login({ expiresAt: NOW }), undefined);
    const failed = freshLogin(k.exec, config, '/f', () => NOW);
    await expect(failed).rejects.toThrow(/refreshing the factory login failed/);
    await expect(failed).rejects.not.toThrow(/refresh-1/);
    const none = keychain(undefined, undefined);
    await expect(freshLogin(none.exec, config, '/f', () => NOW)).rejects.toThrow(
      /no factory login/,
    );
  });

  it('stages the access token only, for the slot, and takes it away after', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'factory-stage-')), 'slot1');
    const unstage = stageLogin(dir, login(), { org: 'o' });
    const file = join(dir, 'credentials.json');
    const staged = JSON.parse(readFileSync(file, 'utf8')) as { claudeAiOauth: OAuthLogin };
    expect(staged.claudeAiOauth.accessToken).toBe('access-1');
    expect(staged.claudeAiOauth).not.toHaveProperty('refreshToken');
    expect(readFileSync(file, 'utf8')).not.toContain('refresh-1');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(join(dir, 'account.json'), 'utf8'))).toEqual({ org: 'o' });
    unstage();
    expect(existsSync(file)).toBe(false);
  });

  it('keeps each slot its own staging folder', () => {
    expect(stagingDir(config, 1, '/Users/r')).not.toBe(stagingDir(config, 2, '/Users/r'));
  });
});

describe("the doctor's check of the factory login", () => {
  const home = mkdtempSync(join(tmpdir(), 'factory-home-'));
  const withLogin = (dir: string) => ({
    ...config,
    agents: { ...config.agents, claude: { ...config.agents.claude, login: dir } },
  });

  it('warns, with how to make it, when there is no login', async () => {
    const dir = join(home, 'none');
    const got = await loginCheck(withLogin(dir), keychain(undefined, undefined).exec, NOW, home);
    expect(got?.status).toBe('warned');
    expect(got?.detail).toContain(`CLAUDE_CONFIG_DIR=${dir} claude auth login`);
  });

  it('says when the login expires, and warns in its last week', async () => {
    const dir = mkdtempSync(join(home, 'login-'));
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { org: 'o' } }));
    const ok = await loginCheck(
      withLogin(dir),
      keychain(login({ refreshTokenExpiresAt: NOW + 29 * 24 * HOUR }), undefined).exec,
      NOW,
      home,
    );
    expect(ok).toMatchObject({ status: 'ok', detail: `${dir}, expires in 29 days` });
    expect(JSON.stringify(ok)).not.toContain('access-1');
    const soon = await loginCheck(
      withLogin(dir),
      keychain(login({ refreshTokenExpiresAt: NOW + 3 * 24 * HOUR }), undefined).exec,
      NOW,
      home,
    );
    expect(soon).toMatchObject({ status: 'warned' });
    expect(soon?.detail).toContain('expires in 3 days');
  });

  it('has nothing to check without a login configured', async () => {
    const claude = {
      bin: config.agents.claude.bin,
      defaultModel: config.agents.claude.defaultModel,
    };
    const plain = { ...config, agents: { ...config.agents, claude } };
    expect(await loginCheck(plain, keychain(undefined, undefined).exec, NOW, home)).toBeUndefined();
  });
});
