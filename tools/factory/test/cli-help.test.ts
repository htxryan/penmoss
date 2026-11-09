/**
 * Every factory command prints its usage on `--help` or `-h` and exits 0 without doing anything:
 * `task factory:doctor -- --help` ran the doctor (PEN-70's run, 9 Nov 2026).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMANDS, commandUsage, helpFor, usage } from '../src/usage.ts';

const CLI = join(import.meta.dirname, '../src/cli.ts');

/** The CLI in a child, with a home of its own so nothing it might do reaches the real factory. */
function cli(args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const home = mkdtempSync(join(tmpdir(), 'factory-cli-'));
    const child = spawn(process.execPath, [CLI, ...args], {
      timeout: 20_000,
      env: { PATH: '/usr/bin:/bin', HOME: home },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe("the CLI's help", () => {
  it('answers --help and -h for every command, and nothing else does', () => {
    for (const name of Object.keys(COMMANDS)) {
      for (const flag of ['--help', '-h']) {
        const help = helpFor([name, flag]);
        expect(help, `${name} ${flag}`).toMatch(new RegExp(`^Usage: factory ${name}\\b`));
        // Anywhere after the command: `task factory:doctor -- --slot 2 --help`.
        expect(helpFor([name, '--slot', '2', flag])).toBe(help);
      }
      expect(helpFor([name]), name).toBeUndefined();
      expect(helpFor(['help', name])).toBe(commandUsage(name));
    }
    expect(helpFor(['doctor', '--full'])).toBeUndefined();
    expect(helpFor(['no-such-command', '--help'])).toBeUndefined();
    expect(commandUsage('toString')).toBeUndefined();
    for (const bare of ['help', '--help', '-h']) expect(helpFor([bare])).toBe(usage());
  });

  it('lists every command in the whole usage', () => {
    for (const name of Object.keys(COMMANDS)) expect(usage()).toContain(`\n  ${name}`);
  });

  it('prints the doctor’s usage and exits 0 without running it', { timeout: 30_000 }, async () => {
    for (const flag of ['--help', '-h']) {
      const r = await cli(['doctor', '--full', flag]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/^Usage: factory doctor \[--slot n\]/);
      expect(r.stdout).not.toContain('Doctor: slot');
    }
  });

  it('prints the whole usage for help and --help', { timeout: 30_000 }, async () => {
    const r = await cli(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('decision-number');
  });
});
