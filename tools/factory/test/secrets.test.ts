import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSecrets, missingSecrets, parseSecrets } from '../src/secrets.ts';

describe('parseSecrets', () => {
  it('keeps only the allowed keys and names the rest, a GitHub token included (A1222)', () => {
    const result = parseSecrets(
      [
        '# tokens',
        'GH_TOKEN=abc',
        'export CLAUDE_CODE_OAUTH_TOKEN="q r"',
        "OPENCODE_API_KEY='k'",
        '',
        'AWS_SECRET=x',
      ].join('\n'),
    );
    expect(result).toEqual({
      ok: true,
      secrets: { CLAUDE_CODE_OAUTH_TOKEN: 'q r', OPENCODE_API_KEY: 'k' },
      ignored: ['GH_TOKEN', 'AWS_SECRET'],
    });
  });

  it('names a bad line by number, never by its value', () => {
    const result = parseSecrets('GH_TOKEN=abc\nthis is not a pair sekrit');
    expect(result).toEqual({ ok: false, error: 'line 2 is not KEY=value' });
  });
});

describe('loadSecrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-secrets-'));

  it('refuses a file other users can read', () => {
    const path = join(dir, 'open.env');
    writeFileSync(path, 'OPENCODE_API_KEY=x\n');
    chmodSync(path, 0o644);
    expect(loadSecrets(path)).toEqual({
      ok: false,
      error: `${path} must be readable by you alone: chmod 600 it`,
    });
  });

  it('reads a mode-600 file', () => {
    const path = join(dir, 'ok.env');
    writeFileSync(path, 'OPENCODE_API_KEY=x\n');
    chmodSync(path, 0o600);
    expect(loadSecrets(path)).toMatchObject({ ok: true, secrets: { OPENCODE_API_KEY: 'x' } });
  });

  it('says when the file is missing', () => {
    expect(loadSecrets(join(dir, 'nope.env')).ok).toBe(false);
  });

  it('lists missing keys', () => {
    expect(
      missingSecrets({ OPENCODE_API_KEY: 'x' }, ['OPENCODE_API_KEY', 'CLOUDFLARE_API_TOKEN']),
    ).toEqual(['CLOUDFLARE_API_TOKEN']);
  });
});
