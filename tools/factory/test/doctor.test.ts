import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  baseNote,
  doctorChecks,
  findOnPath,
  hostChecks,
  hostCommands,
  judge,
  READ_REFUSED,
  readProbe,
  report,
  TASK_CHECK_NO_BAIL,
  type Check,
} from '../src/doctor.ts';
import { nodeExec, type Exec } from '../src/exec.ts';
import { testConfig } from './helpers.ts';

const config = testConfig();
const slot = config.slots[0]!;
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

describe('doctorChecks', () => {
  const checks = doctorChecks(config, slot, '/Users/r');

  it("covers F17's acceptance criteria", () => {
    const names = checks.map((c) => c.name);
    for (const expected of [
      'task check, every step and package (no bail)',
      'task e2e -- smoke.spec.ts on the slot block',
      'task android:test',
      'wrangler dev --local on the slot block',
      "gh reads htxryan/penmoss with the app's read-only token",
      'Claude Code signs in with the setup token',
      'OpenCode answers with the Go key and the default model',
      "OpenCode Go lists every opencode model in the factory's config",
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

  it("checks a push with the sandbox's own token is refused, without putting it on a command line", () => {
    const push = checks.find(
      (c) => c.name === "a push with the sandbox's token is refused (A1222)",
    );
    expect(push).toMatchObject({ expect: 'refused', needs: ['GH_TOKEN'] });
    expect(push?.command).toMatch(
      /^git .* push --dry-run .*https:\/\/github\.com\/htxryan\/penmoss\.git /,
    );
    // The token reaches git only through the helper, which reads it from the environment.
    expect(push?.command).toContain(`'credential.helper=!f() {`);
    expect(push?.command).not.toMatch(/\$\{?GH_TOKEN\}?@/);
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

  it("runs OpenCode with the config's Go model and key, as a run starts it", () => {
    const model = config.models[config.agents.opencode.defaultModel]!.model;
    expect(model).toBe('opencode-go/kimi-k3');
    const run = checks.find((c) => c.name.startsWith('OpenCode answers'))!;
    expect(run).toMatchObject({
      expect: 'pass',
      output: 'factory-ok',
      needs: ['OPENCODE_API_KEY'],
    });
    expect(run.command).toContain(`'opencode' run --standalone -m '${model}' `);
    // The prompt asks for the word in capitals, so an echo of it doesn't pass.
    expect(run.command).not.toContain('factory-ok');
    expect(run.command).toMatch(/< \/dev\/null$/);
    // The factory's own permissions, with nothing from the worktree.
    expect(run.command).toContain(`OPENCODE_CONFIG_CONTENT='{`);
    expect(run.command).toContain('OPENCODE_DISABLE_PROJECT_CONFIG=1');
    expect(run.command).not.toMatch(/OPENCODE_API_KEY=/);
  });

  it('checks OpenCode Go lists each configured model ID exactly', () => {
    const list = checks.find((c) => c.name.startsWith('OpenCode Go lists'))!;
    expect(list).toMatchObject({
      expect: 'pass',
      output: 'all listed',
      needs: ['OPENCODE_API_KEY'],
    });
    expect(list.command).toContain(
      `'opencode' models --standalone < /dev/null | grep -Fxq 'opencode-go/kimi-k3'`,
    );
    expect(list.command).toMatch(/&& echo 'all listed'$/);
  });

  it('runs wrangler dev on the slot block', () => {
    expect(checks.find((c) => c.name.startsWith('wrangler dev'))?.command).toContain(
      '--port 20187 --inspector-port 20129',
    );
  });
});

describe("the unreadable-file checks' probe (A1258)", () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-probe-'));
  // Stand-ins only: no real secret file is read here, and only exit codes and stdout are checked.
  const file = join(dir, 'stand-in.env');
  writeFileSync(file, 'NOT_A_SECRET=1\n');
  const locked = join(dir, 'locked.env');
  writeFileSync(locked, 'NOT_A_SECRET=1\n');
  chmodSync(locked, 0o000);
  const check = (path: string): Check => ({
    name: 'unreadable',
    expect: 'refused',
    output: READ_REFUSED,
    command: readProbe(path),
  });
  /** The probe in sh, with `head` replaced by a stub that fails with `message` when given. */
  async function probe(path: string, message?: string) {
    let env: Record<string, string> = { PATH: '/usr/bin:/bin' };
    if (message !== undefined) {
      const bin = mkdtempSync(join(tmpdir(), 'doctor-head-'));
      writeFileSync(join(bin, 'head'), `#!/bin/sh\necho '${message}' >&2\nexit 1\n`);
      chmodSync(join(bin, 'head'), 0o755);
      env = { PATH: `${bin}:/usr/bin:/bin` };
    }
    const r = await nodeExec('sh', ['-c', check(path).command], { env });
    return { ...r, verdict: judge(check(path), r.code, r.stdout) };
  }

  it('every unreadable-file check uses it', () => {
    const checks = doctorChecks(config, slot, '/Users/r').filter(
      (c) => c.name.includes('unreadable') && !c.command.startsWith('ls '),
    );
    expect(checks).toHaveLength(5);
    for (const c of checks) {
      expect(c.command).toContain("head -c 1 '/Users/r/");
      expect(c.output).toBe(READ_REFUSED);
      expect(c.command).not.toContain('head -c 0');
    }
  });

  it('passes only when the read is refused', async () => {
    const sandbox = await probe(file, `head: ${file}: Operation not permitted`);
    expect(sandbox.code).toBe(1);
    expect(sandbox.verdict.ok).toBe(true);
    if (process.getuid?.() !== 0) {
      const denied = await probe(locked);
      expect(denied.stdout.trim()).toBe(READ_REFUSED);
      expect(denied.verdict.ok).toBe(true);
    }
  });

  it('fails when the file can be read', async () => {
    const r = await probe(file);
    expect(r.code).toBe(0);
    expect(r.verdict).toEqual({ ok: false, detail: 'succeeded, but the sandbox must refuse it' });
  });

  it('fails, and says so, when the file does not exist', async () => {
    const r = await probe(join(dir, 'missing.env'));
    expect(r.code).toBe(1);
    expect(r.verdict.ok).toBe(false);
    expect(r.verdict.detail).toContain("the file doesn't exist");
  });

  it('fails when the read errors for any other reason, as head -c 0 did', async () => {
    const r = await probe(file, 'head: illegal byte count -- 0');
    expect(r.code).toBe(1);
    expect(r.verdict.ok).toBe(false);
    expect(r.verdict.detail).toContain('another reason: head: illegal byte count -- 0');
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

describe(
  'task check in the sandbox, without stopping at the first failure',
  { timeout: 30_000 },
  () => {
    it("runs every step of the Taskfile's check:all, and every package's tests with --no-bail", async () => {
      // Only the line that reads the steps runs here, against the repo's own Taskfile.
      const read = TASK_CHECK_NO_BAIL.split('\n')[0] ?? '';
      const r = await nodeExec('sh', ['-c', `${read} && echo $steps`], { cwd: ROOT });
      expect(r.code).toBe(0);
      const steps = r.stdout.trim().split(' ');
      expect(steps.slice(0, 3)).toEqual(['lint', 'typecheck', 'test']);
      expect(steps).toEqual(expect.arrayContaining(['audit:secrets', 'ports:test', 'vm:test']));
      expect(TASK_CHECK_NO_BAIL).toContain('corepack pnpm -r --no-bail');
      expect(TASK_CHECK_NO_BAIL).not.toMatch(/task check\b/);
      // Each failing step is named at the end; only the last line says it all passed.
      expect(TASK_CHECK_NO_BAIL).toContain('echo "failed:$failed"; exit 1');
      const check = doctorChecks(config, slot, '/Users/r').find(
        (c) => c.command === TASK_CHECK_NO_BAIL,
      );
      expect(check?.slow).toBe(true);
      expect(judge(check!, 0, '=== task lint\nevery step passed').ok).toBe(true);
    });
  },
);

describe("the host's commands, on the LaunchAgent's PATH", () => {
  const path = '/n/bin:/Users/r/.local/bin:/opt/homebrew/bin:/usr/bin:/bin';
  const have = (files: string[]) => (file: string) => files.includes(file);
  const everything = hostCommands(config).map((c) =>
    c.command.startsWith('/') ? c.command : `/usr/bin/${c.command}`,
  );

  it('finds each one on the given PATH, not the shell running the doctor', () => {
    const outcomes = hostChecks(config, path, have(everything));
    expect(outcomes.every((o) => o.status === 'ok')).toBe(true);
    const names = outcomes.map((o) => o.check.name).join('\n');
    for (const c of ['git', 'gh', 'node', 'osascript', 'terminal-notifier'])
      expect(names).toContain(`\`${c}\``);
    expect(findOnPath('claude', path, have(['/Users/r/.local/bin/claude']))).toBe(
      '/Users/r/.local/bin/claude',
    );
  });

  it('fails a missing required command and only warns for an optional one', () => {
    // PEN-75: claude lived only on the shell's PATH; terminal-notifier wasn't installed.
    const missing = new Set(['/usr/bin/claude', '/usr/bin/terminal-notifier']);
    const outcomes = hostChecks(config, path, have(everything.filter((f) => !missing.has(f))));
    const by = (cmd: string) => outcomes.find((o) => o.check.name.includes(`\`${cmd}\``));
    expect(by('claude')).toMatchObject({ status: 'failed', detail: `not on ${path}` });
    expect(by('terminal-notifier')).toMatchObject({ status: 'warned' });
    expect(by('git')?.status).toBe('ok');
    const text = report(outcomes.filter((o) => o.status !== 'failed'));
    expect(text).toContain('! the host finds `terminal-notifier`');
    expect(text).toMatch(/All checks passed, 1 warning\(s\)\.$/);
    expect(report(outcomes)).toContain('1 check(s) FAILED.');
  });
});

describe('baseNote', () => {
  const git =
    (ancestor: boolean): Exec =>
    (_cmd, args) =>
      Promise.resolve(
        args.includes('merge-base')
          ? { code: ancestor ? 0 : 1, stdout: '', stderr: '' }
          : { code: 0, stdout: 'factory-run-followups\n', stderr: '' },
      );

  it("says when the checks' code isn't on the base the sandbox runs", async () => {
    expect(await baseNote(git(true), '/repo', 'origin/main')).toBeUndefined();
    expect(await baseNote(git(false), '/repo', 'origin/main')).toBe(
      "Note: the checks come from this checkout (factory-run-followups), which origin/main doesn't contain, and the sandbox runs origin/main. A check that tests code only on factory-run-followups fails until that code is on origin/main; run with -- --base factory-run-followups to check the branch itself.",
    );
  });
});
