/**
 * `task decision:next` (A1253): a decision added by hand takes its number from the counter the
 * gate numbers runs' decisions from, so an open run and a hand-made PR never both take one (both
 * took A1246 in PEN-70's run). Real git: a bare repository stands in for GitHub's main.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FactoryConfig } from '../src/config.ts';
import { decisionNumber, parseCount } from '../src/decision-number.ts';
import { reserveDecisionNumbers } from '../src/decisions.ts';
import { nodeExec, type Exec } from '../src/exec.ts';
import { testConfig } from './helpers.ts';

const env: Record<string, string> = {
  PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  HOME: tmpdir(),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'r',
  GIT_AUTHOR_EMAIL: 'r@example.com',
  GIT_COMMITTER_NAME: 'r',
  GIT_COMMITTER_EMAIL: 'r@example.com',
};
const exec: Exec = (cmd, args, options) => nodeExec(cmd, args, { ...options, env });

async function git(dir: string, ...args: string[]): Promise<string> {
  const r = await exec('git', ['-C', dir, ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const table = (...ids: number[]) =>
  ['| ID | Decision |', '| --- | --- |', ...ids.map((n) => `| A${n} | d${n} |`), ''].join('\n');

describe('task decision:next (A1253)', { timeout: 30_000 }, () => {
  let checkout: string;
  let remote: string;
  let config: FactoryConfig;
  let counter: string;

  beforeEach(async () => {
    const root = mkdtempSync(join(tmpdir(), 'decision-next-'));
    remote = join(root, 'github.git');
    const seed = join(root, 'seed');
    checkout = join(root, 'checkout');
    const state = join(root, 'state');
    mkdirSync(state);
    config = { ...testConfig(), stateDir: state };
    counter = join(state, 'decision-numbers');
    await git(root, 'init', '-q', '--bare', '-b', 'main', remote);
    await git(root, 'init', '-q', '-b', 'main', seed);
    mkdirSync(join(seed, 'docs'));
    writeFileSync(join(seed, 'docs', 'decisions.md'), table(1244, 1245));
    await git(seed, 'add', '-A');
    await git(seed, 'commit', '-qm', 'main');
    await git(seed, 'push', '-q', remote, 'main');
    await git(root, 'clone', '-q', remote, checkout);
  });

  const run = async (args: string[] = [], runEnv: Record<string, string> = {}) => {
    const lines: string[] = [];
    const code = await decisionNumber(
      config,
      args,
      { exec, repo: checkout, log: (l) => lines.push(l) },
      runEnv,
    );
    return { code, out: lines.join('\n') };
  };

  it("reserves the number after main's highest, and the next call gets the one after", async () => {
    expect(await run()).toEqual({ code: 0, out: 'A1246' });
    expect(readFileSync(counter, 'utf8')).toBe('1246\n');
    expect(await run()).toEqual({ code: 0, out: 'A1247' });
  });

  it('never gives out a number the gate has reserved for a run that is still open', async () => {
    // A run's A-NEW-1 took A1246 at its gate; its PR isn't merged, so main doesn't have it.
    expect(reserveDecisionNumbers(['A-NEW-1'], table(1244, 1245), counter)).toEqual({
      'A-NEW-1': 'A1246',
    });
    expect(await run()).toEqual({ code: 0, out: 'A1247' });
    // And the gate's next run comes after the hand-made one.
    expect(reserveDecisionNumbers(['A-NEW-1'], table(1244, 1245), counter)).toEqual({
      'A-NEW-1': 'A1248',
    });
  });

  it('reads main as origin has it now, not as the checkout last fetched it', async () => {
    const other = join(checkout, '..', 'other');
    await git(join(checkout, '..'), 'clone', '-q', remote, other);
    writeFileSync(join(other, 'docs', 'decisions.md'), table(1244, 1245, 1250));
    await git(other, 'commit', '-qam', 'a decision merged meanwhile');
    await git(other, 'push', '-q', 'origin', 'main');
    expect(await run()).toEqual({ code: 0, out: 'A1251' });
  });

  it("counts a number the checkout's own branch already uses", async () => {
    writeFileSync(join(checkout, 'docs', 'decisions.md'), table(1244, 1245, 1246));
    expect(await run(['--count', '2'])).toEqual({ code: 0, out: 'A1247\nA1248' });
    expect(readFileSync(counter, 'utf8')).toBe('1248\n');
  });

  it('is refused inside a factory run, whose agents write A-NEW-n', async () => {
    const r = await run([], { PENMOSS_FACTORY_RUN: '1' });
    expect(r.code).toBe(2);
    expect(r.out).toContain('A-NEW-1');
  });

  it('reserves nothing where the factory is not installed, and says the next free number', async () => {
    config = { ...config, stateDir: join(checkout, '..', 'no-factory') };
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.out).toContain('nothing is reserved');
    expect(r.out).toContain('A1246');
  });

  it('takes --count from 1 to 20', () => {
    expect(parseCount([])).toBe(1);
    expect(parseCount(['--count', '3'])).toBe(3);
    expect(parseCount(['--count', '0'])).toHaveProperty('error');
    expect(parseCount(['--count'])).toHaveProperty('error');
  });
});
