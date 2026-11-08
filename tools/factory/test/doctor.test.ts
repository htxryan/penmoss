import { describe, expect, it } from 'vitest';
import { doctorChecks, judge, report, type Check } from '../src/doctor.ts';
import { testConfig } from './helpers.ts';

const config = testConfig();
const slot = config.slots[0]!;

describe('doctorChecks', () => {
  const checks = doctorChecks(config, slot, '/Users/r');

  it("covers F17's acceptance criteria", () => {
    const names = checks.map((c) => c.name);
    for (const expected of [
      'task check',
      'task e2e -- smoke.spec.ts on the slot block',
      'task android:test',
      'wrangler dev --local on the slot block',
      "gh reads htxryan/penmoss with the app's read-only token",
      'Claude Code signs in with the setup token',
      "the GitHub App's key file is unreadable (A1222)",
      "the Linear app's credentials are unreadable (LD4)",
      'no Linear token in the environment (LD4)',
      'wrangler whoami shows the Penmoss account',
      "Ryan's gh login is unreadable",
      '~/.ssh is unreadable',
      'the login keychain is unreadable',
      'a relay deploy is refused',
      'a site deploy (task site:deploy) is refused',
      "the app's read-only token can't write to htxryan/penmoss (A1222)",
      "the Mac app's data folder (git-secrets.json) is unreadable",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('never prints a file it probes', () => {
    for (const check of checks.filter((c) => c.expect === 'refused')) {
      expect(check.command).not.toMatch(/\bcat\b|security find/);
    }
  });

  it('accepts a deploy refusal only when the guard itself refused (FD24)', () => {
    for (const name of [
      'a relay deploy is refused',
      'a site deploy (task site:deploy) is refused',
    ]) {
      const check = checks.find((c) => c.name === name)!;
      expect(check.output, name).toBe('No production deploys from a factory run');
      expect(check.command, name).toMatch(/--dry-run 2>&1$/);
    }
  });

  it("proves the sandbox's GitHub token is read-only by a 403, never a write", () => {
    const check = checks.find((c) => c.name.startsWith("the app's read-only token can't write"))!;
    expect(check).toMatchObject({ expect: 'refused', output: 'HTTP 403', needs: ['GH_TOKEN'] });
    // A zero SHA: even a token that could write creates nothing.
    expect(check.command).toContain('-f sha=0000000000000000000000000000000000000000');
  });

  it('runs wrangler dev on the slot block', () => {
    expect(checks.find((c) => c.name.startsWith('wrangler dev'))?.command).toContain(
      '--port 20187 --inspector-port 20129',
    );
  });
});

describe('judge', () => {
  const pass: Check = { name: 'p', command: 'x', expect: 'pass', output: 'ok' };
  const refused: Check = { name: 'r', command: 'x', expect: 'refused' };
  const refusedWith: Check = { name: 'rw', command: 'x', expect: 'refused', output: 'HTTP 403' };
  it.each([
    [pass, 0, 'all ok', true],
    [pass, 0, 'nope', false],
    [pass, 1, 'ok', false],
    [refused, 1, '', true],
    [refused, 0, '', false],
    [refusedWith, 1, 'gh: Resource not accessible by integration (HTTP 403)', true],
    [refusedWith, 1, 'gh: Validation Failed (HTTP 422)', false],
    [refusedWith, 0, 'HTTP 403', false],
  ])('%#', (check, code, out, ok) => {
    expect(judge(check, code, out).ok).toBe(ok);
  });

  it('reports failures loudly', () => {
    const text = report([
      { check: pass, status: 'ok', detail: 'passed', seconds: 2 },
      {
        check: refused,
        status: 'failed',
        detail: 'succeeded, but the sandbox must refuse it',
        seconds: 1,
      },
    ]);
    expect(text).toContain('✗ r: succeeded, but the sandbox must refuse it');
    expect(text).toContain('1 check(s) FAILED.');
  });
});
