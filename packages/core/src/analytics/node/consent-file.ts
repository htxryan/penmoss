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

/**
 * The file's contents. When there is none, or it is there but unreadable as a consent file (not
 * JSON, or without a valid install id), a fresh one is written in its place (atomically), so
 * every process that reads it next agrees on one install id instead of each making its own. A
 * file this process may not open is left alone, and so is one it cannot write over: then the
 * fresh id lives for this process only.
 */
export function readConsentFile(path: string = consentPath()): ConsentFile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const fresh = newConsentFile();
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? kept(fresh, path) : fresh;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return kept(newConsentFile(), path);
  }
  const file = parseConsentFile(raw);
  const install = (raw as { install?: unknown } | null)?.install;
  // parseConsentFile made a new id: the file has none it can keep, so this one is written.
  return install === file.install ? file : kept(file, path);
}

/** Writes `file` in place of a missing or broken one, so the next reader finds its id. */
function kept(file: ConsentFile, path: string): ConsentFile {
  try {
    writeConsentFile(file, path);
  } catch {
    // A read-only home: the id lives for this process only.
  }
  return file;
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
