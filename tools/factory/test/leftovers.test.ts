import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeExec } from '../src/exec.ts';
import { inFolder, signal, stopLeftovers } from '../src/leftovers.ts';

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
        expect(stopped).toEqual([left.pid]);
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
    const exec = () =>
      Promise.resolve({ code: 0, stdout: 'p10\nfcwd\nn/w/a\np11\nfcwd\nn/w/a/b', stderr: '' });
    const stopped = await stopLeftovers(exec, '/w/a', {
      kill: (pid, sig) => {
        sent.push(`${pid} ${sig}`);
        if (sig === 'SIGTERM') alive.delete(pid === 11 ? 11 : -1);
        return sig === 0 ? alive.has(pid) : true;
      },
      sleep: () => Promise.resolve(),
      self: [],
    });
    expect(stopped).toEqual([10, 11]);
    expect(sent).toEqual(['10 SIGTERM', '11 SIGTERM', '10 0', '10 SIGKILL', '11 0']);
  });
});
