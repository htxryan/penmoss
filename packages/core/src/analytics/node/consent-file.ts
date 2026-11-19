/**
 * `~/.penmoss/analytics.json` (PEN-137, N4): the answer, the install id and the limits, shared by
 * the Mac app, the CLI and the local MCP server. Written atomically (a temporary file renamed
 * over it) with mode 0600, and read fresh each time so one process sees another's change. Never
 * in synced settings or a notebook.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { newConsentFile, parseConsentFile, type ConsentFile } from '../consent';

/** Where the files live: `PENMOSS_HOME` (tests) or `~/.penmoss`. */
export function penmossHome(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return env.PENMOSS_HOME?.trim() || join(homedir(), '.penmoss');
}

export function consentPath(env?: Readonly<Record<string, string | undefined>>): string {
  return join(penmossHome(env), 'analytics.json');
}

export function eventsPath(env?: Readonly<Record<string, string | undefined>>): string {
  return join(penmossHome(env), 'analytics', 'events.db');
}

/** The file's contents, or a fresh one (written, so its id holds) when there is none. */
export function readConsentFile(path: string = consentPath()): ConsentFile {
  try {
    return parseConsentFile(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    const fresh = newConsentFile();
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        writeConsentFile(fresh, path);
      } catch {
        // A read-only home: the id lives for this process only.
      }
    }
    return fresh;
  }
}

export function writeConsentFile(file: ConsentFile, path: string = consentPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Reads, changes and writes the file. */
export function updateConsentFile(
  change: (file: ConsentFile) => ConsentFile,
  path: string = consentPath(),
): ConsentFile {
  const next = change(readConsentFile(path));
  writeConsentFile(next, path);
  return next;
}
