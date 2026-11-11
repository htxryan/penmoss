import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeExec } from '../src/exec.ts';
import {
  inFolder,
  leftoversLine,
  processesIn,
  shortArgs,
  signal,
  stopLeftovers,
} from '../src/leftovers.ts';

describe('processes left in a worktree (A1297)', () => {
  it("reads lsof's working folders, and only what is in the worktree", () => {
    const lsof = [
      'p10',
      'fcwd',
      'n/w/factory-71',
      'p11',
      'fcwd',
      'n/w/factory-71/apps/web',
      'p12',
      'fcwd',
      'n/w/factory-710',
      'p13',
      'fcwd',
      'n/',
      'p14',
      'fcwd',
      'n/w/factory-71',
    ].join('\n');
    expect(inFolder(lsof, '/w/factory-71', [14])).toEqual([10, 11]);
  });

  it.skipIf(process.platform !== 'darwin')(
    'stops a dev server left running, and nothing outside the worktree',
    { timeout: 30_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'factory-leftovers-'));
      const worktree = join(root, 'factory-71');
      const elsewhere = join(root, 'other');
      for (const d of [join(worktree, 'apps', 'web'), elsewhere]) mkdirSync(d, { recursive: true });
      // A background command's server, detached as a session's background work is.
      const left = spawn('sleep', ['300'], {
        cwd: join(worktree, 'apps', 'web'),
        detached: true,
        stdio: 'ignore',
      });
      const other = spawn('sleep', ['300'], { cwd: elsewhere, detached: true, stdio: 'ignore' });
      left.unref();
      other.unref();
      await new Promise((r) => setTimeout(r, 300));
      try {
        const stopped = await stopLeftovers(nodeExec, worktree, {
          kill: signal,
          sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 500))),
        });
        expect(stopped.map((p) => p.pid)).toEqual([left.pid]);
        expect(stopped[0]?.command).toBe('sleep');
        expect(leftoversLine(stopped, 'when the sandbox closed')).toBe(
          `stopped 1 process left in the worktree when the sandbox closed: ${left.pid} sleep (300)`,
        );
        await new Promise((r) => setTimeout(r, 200));
        expect(signal(left.pid!, 0)).toBe(false);
        expect(signal(other.pid!, 0)).toBe(true);
      } finally {
        signal(left.pid!, 'SIGKILL');
        signal(other.pid!, 'SIGKILL');
      }
    },
  );

  it('sends SIGKILL only to what outlived SIGTERM', async () => {
    const sent: string[] = [];
    const alive = new Set([10]);
    const exec = (cmd: string) =>
      Promise.resolve({
        code: 0,
        stdout: cmd === 'lsof' ? 'p10\nfcwd\nn/w/a\np11\nfcwd\nn/w/a/b' : '',
        stderr: '',
      });
    const stopped = await stopLeftovers(exec, '/w/a', {
      kill: (pid, sig) => {
        sent.push(`${pid} ${sig}`);
        if (sig === 'SIGTERM') alive.delete(pid === 11 ? 11 : -1);
        return sig === 0 ? alive.has(pid) : true;
      },
      sleep: () => Promise.resolve(),
      self: [],
    });
    expect(stopped.map((p) => p.pid)).toEqual([10, 11]);
    expect(sent).toEqual(['10 SIGTERM', '11 SIGTERM', '10 0', '10 SIGKILL', '11 0']);
  });

  it('names each process it stopped: pid, command and what it ran', async () => {
    const lsof = ['p4123', 'cnode', 'fcwd', 'n/w/a/apps/web', 'p4124', 'cesbuild', 'fcwd', 'n/w/a'];
    const ps = [
      ' 4123 node /w/a/node_modules/.bin/vite preview --port 20173 --token=abc',
      ' 4124 /w/a/node_modules/esbuild/bin/esbuild --service=0.25.0 --ping',
    ].join('\n');
    const calls: string[] = [];
    const exec = (cmd: string, args: readonly string[]) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return Promise.resolve({
        code: 0,
        stdout: cmd === 'lsof' ? lsof.join('\n') : ps,
        stderr: '',
      });
    };
    const stopped = await stopLeftovers(exec, '/w/a', {
      kill: (_pid, sig) => sig !== 0,
      sleep: () => Promise.resolve(),
      self: [],
    });
    expect(calls).toEqual(['lsof -w -d cwd -Fpcn', 'ps -o pid=,args= -p 4123,4124']);
    expect(stopped).toEqual([
      { pid: 4123, command: 'node', args: 'vite preview' },
      { pid: 4124, command: 'esbuild' },
    ]);
    expect(leftoversLine(stopped, 'when the sandbox closed')).toBe(
      'stopped 2 processes left in the worktree when the sandbox closed: 4123 node (vite preview), 4124 esbuild',
    );
  });

  it("keeps flags, and so any token on a command line, out of the log's arguments", () => {
    expect(shortArgs('node /x/playwright/cli.js test e2e/a.spec.ts more --project=web')).toBe(
      'cli.js test a.spec.ts',
    );
    expect(shortArgs('gh --token secret api')).toBe('');
    expect(shortArgs('')).toBe('');
    expect(processesIn('p1\ncsh\nn/w/a\np2\nn/w/a', '/w/a', [])).toEqual([
      { pid: 1, command: 'sh' },
      { pid: 2, command: '' },
    ]);
  });
});
