/**
 * The ref key (PEN-177): 32 random bytes, kept as 64 hex characters in `~/.penmoss/analytics-key`
 * (mode 0600) beside the consent file, never in it. That file is shared by the app, the CLI and
 * the MCP server, and a released CLI rewrites it with only the fields it knows, which would drop
 * a key kept there and change every ref.
 *
 * A note's or folder's ref is `hex(HMAC-SHA256(key, type + ":" + id))[0..16]`, `type` being
 * `note` or `folder` and the key its 32 bytes: the same note always has the same ref on one
 * install, no one without the key can turn it back into the id, and installs differ. Kotlin
 * makes the same refs (javax.crypto.Mac), pinned by analytics-v1.json's `refVectors`.
 *
 * The key never leaves the device: it is not in a batch, `penmoss analytics status`, Copy as
 * JSON, a log line (the scrubber replaces long hex) or a bug report. Resetting the analytics ID
 * (Reset My Analytics ID, Delete My Shared Data, `penmoss analytics reset` and `forget`) makes a
 * new key in the same step (`resetInstall`), so the same note gets a different ref from then on.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resetId, type ConsentFile } from '../consent';
import { consentPath, penmossHome, updateConsentFile } from './consent-file';

/** A ref key as it is kept: 64 lower-case hex characters. */
export const REF_KEY_PATTERN = /^[0-9a-f]{64}$/;

/** Where the key lives: `PENMOSS_HOME` (tests) or `~/.penmoss`. */
export function refKeyPath(env?: Readonly<Record<string, string | undefined>>): string {
  return join(penmossHome(env), 'analytics-key');
}

/** The key's file beside a consent file. */
export function refKeyPathFor(consentFile: string): string {
  return join(dirname(consentFile), 'analytics-key');
}

/** A new key: 32 random bytes as hex. */
export function newRefKey(): string {
  return randomBytes(32).toString('hex');
}

function readKey(path: string): string | null {
  try {
    const text = readFileSync(path, 'utf8').trim();
    return REF_KEY_PATTERN.test(text) ? text : null;
  } catch {
    return null;
  }
}

export interface ReadRefKeyOptions {
  /** Tests: runs between finding no key and creating one (another process creating it then). */
  readonly beforeCreate?: () => void;
}

/**
 * The key, created when there is none. Created with an exclusive create (`wx`): of two processes
 * that start at once, the one that loses reads the winner's key, so both agree. A file holding
 * something else is replaced. A home that can't be written gives a key for this process only.
 */
export function readRefKey(path: string = refKeyPath(), options: ReadRefKeyOptions = {}): string {
  const kept = readKey(path);
  if (kept) return kept;
  let exists = true;
  try {
    readFileSync(path);
  } catch (error) {
    exists = (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  if (exists) return renewRefKey(path);
  options.beforeCreate?.();
  const key = newRefKey();
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${key}\n`, { flag: 'wx', mode: 0o600 });
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return readKey(path) ?? renewRefKey(path);
    }
    return key;
  }
}

/** Replaces the key with a new one (a temporary file renamed over it); the new key. */
export function renewRefKey(path: string = refKeyPath()): string {
  const key = newRefKey();
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${key}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    // A read-only home: the key lives for this process only.
  }
  return key;
}

/** A note's or folder's ref under `key`: 16 hex characters. */
export function refOf(key: string, type: 'note' | 'folder', id: string): string {
  return createHmac('sha256', Buffer.from(key, 'hex'))
    .update(`${type}:${id}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
}

/**
 * A new analytics ID and a new ref key, in one step: the key first, so a process that sees the
 * new ID in the consent file finds the new key too.
 */
export function resetInstall(
  path: string = consentPath(),
  keyPath: string = refKeyPathFor(path),
  change: (file: ConsentFile) => ConsentFile = resetId,
): ConsentFile {
  renewRefKey(keyPath);
  return updateConsentFile(change, path);
}
