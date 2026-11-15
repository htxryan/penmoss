/** What the CLI and the Mac app share about who commits and which tokens they keep (A825). */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isTokenText, isTokenUser } from '../src/identity';
import { gitUserIdentity } from '../src/node/git';

describe('tokens and their user names', () => {
  it('takes only text nothing must quote', () => {
    expect(isTokenText('ghp_0123456789abcdefABCDEF')).toBe(true);
    expect(isTokenText('a'.repeat(1000))).toBe(true);
    expect(isTokenText('short')).toBe(false);
    expect(isTokenText('a'.repeat(1001))).toBe(false);
    expect(isTokenText('ghp_0123456789 abc')).toBe(false);
    expect(isTokenText("ghp_0123456789'abc")).toBe(false);
    expect(isTokenUser('x-access-token')).toBe(true);
    expect(isTokenUser('ryan.h_2')).toBe(true);
    expect(isTokenUser('-ryan')).toBe(false);
    expect(isTokenUser('ryan@host')).toBe(false);
    expect(isTokenUser('a'.repeat(101))).toBe(false);
  });
});

describe('git’s own identity', () => {
  const made: string[] = [];
  afterAll(async () => {
    for (const dir of made) await rm(dir, { recursive: true, force: true });
  });

  it('is the global config’s, else the fallback name and penmoss@localhost', async () => {
    const none = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    expect(await gitUserIdentity(none, 'Penmoss on this Mac')).toEqual({
      name: 'Penmoss on this Mac',
      email: 'penmoss@localhost',
    });
    const dir = await mkdtemp(join(tmpdir(), 'penmoss-identity-'));
    made.push(dir);
    const config = join(dir, 'gitconfig');
    await writeFile(config, '[user]\n\tname = Ryan\n\temail = ryan@example.invalid\n');
    expect(
      await gitUserIdentity({ GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' }, 'x'),
    ).toEqual({ name: 'Ryan', email: 'ryan@example.invalid' });
  });
});
