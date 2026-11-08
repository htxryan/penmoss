/**
 * git's own GitHub credential (T81, A1163): real `git credential fill`, with git's
 * configuration isolated in a temporary file so no keychain helper (Apple's, Homebrew's) and no
 * real Keychain is reached.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitHubCredential } from '../../src/git-credential';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'penmoss-credential-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function gitEnv(config: string) {
  const file = join(dir, 'gitconfig');
  writeFileSync(file, config);
  return { GIT_CONFIG_GLOBAL: file, GIT_CONFIG_NOSYSTEM: '1' };
}

describe('git’s GitHub credential', { timeout: 30_000 }, () => {
  it('answers the password git’s helper has for github.com', async () => {
    const helper = join(dir, 'helper.sh');
    writeFileSync(
      helper,
      '#!/bin/sh\n[ "$1" = get ] || exit 0\nwhile read line; do [ -z "$line" ] && break; done\necho username=x-access-token\necho password=gho_fromthehelper123\n',
      { mode: 0o755 },
    );
    const log = vi.spyOn(console, 'log');
    const answer = await gitHubCredential({
      gitEnv: gitEnv(`[credential]\n\thelper = ${helper}\n`),
    });
    expect(answer).toEqual({ ok: true, token: 'gho_fromthehelper123' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('gho_fromthehelper123');
    log.mockRestore();
  });

  it('says there is none, and never prompts, with no helper', async () => {
    const answer = await gitHubCredential({ gitEnv: gitEnv('') });
    expect(answer).toEqual({ ok: false, reason: 'no_credential' });
  });

  it('gives up on a helper that hangs', async () => {
    const helper = join(dir, 'hang.sh');
    writeFileSync(helper, '#!/bin/sh\nsleep 20\n', { mode: 0o755 });
    const started = Date.now();
    const answer = await gitHubCredential({
      gitEnv: gitEnv(`[credential]\n\thelper = ${helper}\n`),
      timeoutMs: 500,
    });
    expect(answer).toEqual({ ok: false, reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
