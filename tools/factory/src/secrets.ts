/**
 * The factory's env file (`~/.config/penmoss-factory/factory.env`, mode 600): the scoped tokens
 * every sandbox gets (FD23, R19). Only the names below pass through, so a stray line can never
 * hand an agent one of Ryan's own logins. Values are never logged: errors name keys and line
 * numbers only.
 */
import { readFileSync, statSync } from 'node:fs';

/** The names a sandbox may receive, and what each is for. */
export const SECRET_KEYS = {
  GH_TOKEN: "penmoss-bot's GitHub token",
  CLAUDE_CODE_OAUTH_TOKEN: "Claude Code's token from `claude setup-token`",
  OPENCODE_API_KEY: 'the OpenCode Go key',
  CLOUDFLARE_API_TOKEN: 'a Penmoss-only Cloudflare API token',
  CLOUDFLARE_ACCOUNT_ID: 'the Penmoss Cloudflare account',
  PLAY_SERVICE_ACCOUNT_JSON: 'the path of the Play service account key',
} as const;

export type SecretKey = keyof typeof SECRET_KEYS;
export type Secrets = Readonly<Partial<Record<SecretKey, string>>>;

export type SecretsResult =
  | { readonly ok: true; readonly secrets: Secrets; readonly ignored: readonly string[] }
  | { readonly ok: false; readonly error: string };

/** Parses `KEY=value` lines (`#` comments, blank lines, optional quotes and `export`). */
export function parseSecrets(text: string): SecretsResult {
  const secrets: Partial<Record<SecretKey, string>> = {};
  const ignored: string[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) return { ok: false, error: `line ${index + 1} is not KEY=value` };
    const [, key = '', rawValue = ''] = match;
    const value = /^(['"])(.*)\1$/.exec(rawValue)?.[2] ?? rawValue;
    if (Object.hasOwn(SECRET_KEYS, key)) secrets[key as SecretKey] = value;
    else ignored.push(key);
  }
  return { ok: true, secrets, ignored };
}

/** Reads the env file, refusing one that other users can read. */
export function loadSecrets(path: string): SecretsResult {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    return { ok: false, error: `${path} doesn't exist yet (docs/factory.md, Setup)` };
  }
  if ((mode & 0o077) !== 0) {
    return { ok: false, error: `${path} must be readable by you alone: chmod 600 it` };
  }
  return parseSecrets(readFileSync(path, 'utf8'));
}

/** The keys that are missing, for the doctor's report. */
export function missingSecrets(secrets: Secrets, needed: readonly SecretKey[]): SecretKey[] {
  return needed.filter((key) => !secrets[key]);
}
