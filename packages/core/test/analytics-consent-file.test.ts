/**
 * `~/.penmoss/analytics.json` (PEN-137, N4, AC20): where it lives (PENMOSS_HOME in tests), that
 * it is written atomically with mode 0600, read fresh, and that an unreadable file reads as a
 * fresh one without throwing. Every test works in its own folder under $TMPDIR.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { answer, newConsentFile } from '../src/analytics/consent';
import { INSTALL_PATTERN } from '../src/analytics/events';
import {
  consentPath,
  eventsPath,
  penmossHome,
  readConsentFile,
  updateConsentFile,
  writeConsentFile,
} from '../src/analytics/node/consent-file';

let home: string;
let env: Record<string, string>;
let path: string;

beforeEach(() => {
  home = join(mkdtempSync(join(tmpdir(), 'penmoss-consent-')), 'home');
  env = { PENMOSS_HOME: home };
  path = consentPath(env);
});

afterEach(() => {
  chmodSync(join(home, '..'), 0o700);
  if (existsSync(home)) chmodSync(home, 0o700);
  rmSync(join(home, '..'), { recursive: true, force: true });
});

const mode = (file: string) => statSync(file).mode & 0o777;

describe('where the files live', () => {
  it('is PENMOSS_HOME when set, else ~/.penmoss', () => {
    expect(penmossHome(env)).toBe(home);
    expect(penmossHome({})).toBe(join(homedir(), '.penmoss'));
    expect(penmossHome({ PENMOSS_HOME: '  ' })).toBe(join(homedir(), '.penmoss'));
    expect(consentPath(env)).toBe(join(home, 'analytics.json'));
    expect(eventsPath(env)).toBe(join(home, 'analytics', 'events.db'));
  });
});

describe('readConsentFile', () => {
  it('writes a fresh file when there is none, so its ID holds', () => {
    const first = readConsentFile(path);
    expect(first.consent).toBeNull();
    expect(first.install).toMatch(INSTALL_PATTERN);
    expect(existsSync(path)).toBe(true);
    expect(mode(path)).toBe(0o600);
    expect(mode(home)).toBe(0o700);
    expect(readConsentFile(path)).toEqual(first);
  });

  it('reads what another process wrote, each time', () => {
    const file = readConsentFile(path);
    writeConsentFile(answer(file, 'no', 5, '1.4.0'), path);
    expect(readConsentFile(path)).toMatchObject({ consent: 'no', install: file.install });
  });

  it('reads a file that is not JSON as a fresh one, leaving the file alone', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(path, '{ not json');
    const file = readConsentFile(path);
    expect(file.consent).toBeNull();
    expect(file.install).toMatch(INSTALL_PATTERN);
    expect(readFileSync(path, 'utf8')).toBe('{ not json');
  });

  it('reads a file it may not open as a fresh one, without throwing', () => {
    writeConsentFile(answer(newConsentFile(), 'yes', 5, '1.4.0'), path);
    chmodSync(path, 0o000);
    try {
      readFileSync(path);
      // Running as root: the file is readable whatever its mode, so there is nothing to test.
      return;
    } catch {
      // Expected: the file cannot be read.
    }
    expect(readConsentFile(path).consent).toBeNull();
    chmodSync(path, 0o600);
  });

  it('does not throw when the home folder cannot be written', () => {
    mkdirSync(join(home, '..'), { recursive: true });
    chmodSync(join(home, '..'), 0o500);
    const file = readConsentFile(path);
    expect(file.consent).toBeNull();
    expect(file.install).toMatch(INSTALL_PATTERN);
  });
});

describe('writeConsentFile', () => {
  it('writes atomically with mode 0600, leaving no temporary file', () => {
    const file = answer(newConsentFile(), 'yes', 1000, '1.4.0');
    writeConsentFile(file, path);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(file);
    expect(readFileSync(path, 'utf8').endsWith('}\n')).toBe(true);
    expect(mode(path)).toBe(0o600);
    expect(readdirSync(home)).toEqual(['analytics.json']);
  });

  it('makes a file another tool left readable to others 0600 again', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(path, '{}', { mode: 0o644 });
    chmodSync(path, 0o644);
    writeConsentFile(newConsentFile(), path);
    expect(mode(path)).toBe(0o600);
  });

  it('replaces the file whole, so a reader sees the old or the new, never half', () => {
    const files = Array.from({ length: 20 }, (_, i) => answer(newConsentFile(), 'yes', i, '1.4.0'));
    for (const file of files) {
      writeConsentFile(file, path);
      expect(readConsentFile(path)).toEqual(file);
    }
    expect(readdirSync(home)).toEqual(['analytics.json']);
  });
});

describe('updateConsentFile', () => {
  it('reads, changes and writes the file', () => {
    const before = readConsentFile(path);
    const after = updateConsentFile((file) => answer(file, 'yes', 7, '1.5.0'), path);
    expect(after).toMatchObject({ consent: 'yes', install: before.install, sharingSince: 7 });
    expect(readConsentFile(path)).toEqual(after);
  });

  it('keeps the limits it is given, as the CLI’s limits set does', () => {
    updateConsentFile((file) => ({ ...file, limits: { 'events.days': 30 } }), path);
    expect(readConsentFile(path).limits).toEqual({ 'events.days': 30 });
  });
});
