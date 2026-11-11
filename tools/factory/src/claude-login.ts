/**
 * The factory's own claude.ai login (A1287): a second login, separate from Ryan's, in its own
 * Claude Code config folder (`agents.claude.login`, `~/.config/penmoss-factory/claude`), made
 * once with `claude auth login`. Claude Code keeps it in the login keychain under a name of its
 * own for that folder. An agent session with a chat in the Claude app signs in with it, since
 * the setup token can't open Remote Control.
 *
 * The host alone holds the refresh token. It keeps the login fresh (Claude Code itself refreshes
 * it: `claude auth login` with the refresh token), and stages a copy of the access token only, for
 * one session in one slot, in a folder the sandbox reads; the copy goes when the session ends.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome, type FactoryConfig } from './config.ts';
import type { CheckOutcome } from './doctor.ts';
import type { Exec } from './exec.ts';

/** The login as Claude Code stores it (its `claudeAiOauth`); only what the factory reads. */
export interface OAuthLogin {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt: number;
  readonly scopes: readonly string[];
  readonly subscriptionType?: string;
  readonly rateLimitTier?: string;
  readonly refreshTokenExpiresAt?: number;
}

/** A session's access token has at least this long left when it starts. */
export const FRESH_MS = 4 * 60 * 60 * 1000;

/** The config folder of the factory's login, or undefined when none is configured. */
export function loginDir(config: FactoryConfig, home?: string): string | undefined {
  const dir = config.agents.claude.login;
  return dir ? expandHome(dir, home) : undefined;
}

/** Whether the login was made: Claude Code writes the account into the folder's `.claude.json`. */
export function hasLogin(dir: string): boolean {
  return account(dir) !== undefined;
}

/** The keychain item Claude Code keeps a config folder's login in. */
export function keychainService(dir: string): string {
  return `Claude Code-credentials-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`;
}

/** The account Claude Code recorded for the login (Remote Control reads its organization). */
export function account(dir: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')) as {
      oauthAccount?: unknown;
    };
    const a = parsed.oauthAccount;
    return typeof a === 'object' && a !== null ? (a as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function parseLogin(text: string): OAuthLogin | undefined {
  try {
    const o = (JSON.parse(text) as { claudeAiOauth?: Partial<OAuthLogin> }).claudeAiOauth;
    if (!o || typeof o.accessToken !== 'string' || typeof o.expiresAt !== 'number')
      return undefined;
    return { ...o, scopes: Array.isArray(o.scopes) ? o.scopes : [] } as OAuthLogin;
  } catch {
    return undefined;
  }
}

/** Reads the login from the keychain; never logs it. */
export async function readLogin(exec: Exec, dir: string): Promise<OAuthLogin | undefined> {
  const r = await exec('security', ['find-generic-password', '-s', keychainService(dir), '-w']);
  return r.code === 0 ? parseLogin(r.stdout) : undefined;
}

/** Claude Code's own refresh: `claude auth login` with the refresh token saves the new login. */
export async function refreshLogin(
  exec: Exec,
  config: FactoryConfig,
  dir: string,
  login: OAuthLogin,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  if (!login.refreshToken) throw new Error('the factory login has no refresh token');
  const r = await exec(config.agents.claude.bin, ['auth', 'login'], {
    env: {
      PATH: env['PATH'] ?? '/usr/bin:/bin',
      HOME: env['HOME'] ?? '',
      ...(env['USER'] ? { USER: env['USER'] } : {}),
      CLAUDE_CONFIG_DIR: dir,
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: login.refreshToken,
      CLAUDE_CODE_OAUTH_SCOPES: login.scopes.join(' '),
    },
  });
  if (r.code !== 0) {
    // Claude Code's message, without anything that could hold a token.
    const said = (r.stderr || r.stdout).split(login.refreshToken).join('<refresh token>');
    throw new Error(
      `refreshing the factory login failed: ${said.trim().split('\n').slice(-2).join(' ')}`,
    );
  }
}

// One refresh at a time: a refresh token works once, and both slots can start together.
let refreshing: Promise<OAuthLogin> | undefined;

/**
 * The login, with at least `FRESH_MS` left on its access token: refreshed first when it has less.
 * Throws when there is no login, or it can't be refreshed (Ryan logs it in again).
 */
export function freshLogin(
  exec: Exec,
  config: FactoryConfig,
  dir: string,
  now: () => number = Date.now,
): Promise<OAuthLogin> {
  const next = (refreshing ?? Promise.resolve(undefined))
    .catch(() => undefined)
    .then(async () => {
      const login = await readLogin(exec, dir);
      if (!login) throw new Error(`there is no factory login in ${dir}'s keychain item`);
      if (login.expiresAt - now() >= FRESH_MS) return login;
      await refreshLogin(exec, config, dir, login);
      const after = await readLogin(exec, dir);
      if (!after || after.expiresAt - now() < FRESH_MS)
        throw new Error('the factory login was refreshed but its token still expires too soon');
      return after;
    });
  refreshing = next;
  return next;
}

/** Where a slot's sessions find the staged login (mounted read-only into its sandbox). */
export function stagingDir(config: FactoryConfig, slot: number, home?: string): string {
  return join(expandHome(config.stateDir, home), 'claude-login', `slot${slot}`);
}

/**
 * Stages the access token (never the refresh token) and the account for one session; returns
 * the cleanup that removes the token.
 */
export function stageLogin(
  dir: string,
  login: OAuthLogin,
  who: Record<string, unknown> | undefined,
): () => void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const credentials = join(dir, 'credentials.json');
  const { accessToken, expiresAt, scopes, subscriptionType, rateLimitTier } = login;
  writeFileSync(
    credentials,
    JSON.stringify({
      claudeAiOauth: { accessToken, expiresAt, scopes, subscriptionType, rateLimitTier },
    }),
    { mode: 0o600 },
  );
  writeFileSync(join(dir, 'account.json'), JSON.stringify(who ?? {}), { mode: 0o600 });
  return () => {
    rmSync(credentials, { force: true });
  };
}

/** Removes a slot's staged token left by a session that never got to clean up (a crash). */
export function clearStaged(dir: string): void {
  if (existsSync(dir)) rmSync(join(dir, 'credentials.json'), { force: true });
}

/** Warn this long before the login itself (its refresh token) expires: Ryan logs in again. */
export const LOGIN_WARN_DAYS = 7;

/**
 * The doctor's check of the factory login: there, readable, and not about to expire. Missing is a
 * warning, not a failure: sessions then run on the setup token, with no chat in the Claude app.
 */
export async function loginCheck(
  config: FactoryConfig,
  exec: Exec,
  now: number = Date.now(),
  home?: string,
): Promise<CheckOutcome | undefined> {
  const dir = loginDir(config, home);
  if (!dir) return undefined;
  const check = {
    name: "the factory's own claude.ai login, for agent sessions' chats in the Claude app",
    command: `CLAUDE_CONFIG_DIR=${dir} ${config.agents.claude.bin} auth status`,
    expect: 'pass' as const,
  };
  const again = `make it with: CLAUDE_CONFIG_DIR=${dir} ${config.agents.claude.bin} auth login`;
  const warned = (detail: string): CheckOutcome => ({
    check,
    status: 'warned',
    detail,
    seconds: 0,
  });
  if (!hasLogin(dir)) return warned(`no login in ${dir}, so sessions have no chat; ${again}`);
  const login = await readLogin(exec, dir);
  if (!login?.refreshToken) return warned(`the login's keychain item can't be read; ${again}`);
  const ends = login.refreshTokenExpiresAt;
  const days = ends === undefined ? undefined : Math.floor((ends - now) / 86_400_000);
  if (days !== undefined && days < LOGIN_WARN_DAYS)
    return warned(`the login expires in ${Math.max(days, 0)} days; ${again}`);
  return {
    check,
    status: 'ok',
    detail: days === undefined ? dir : `${dir}, expires in ${days} days`,
    seconds: 0,
  };
}
