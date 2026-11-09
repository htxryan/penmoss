/**
 * `nodeExec` with a signal (F7, F8, F13): a proof that runs past its timeout is stopped with
 * everything it started (the VM script's `tart run`, an emulator), its traps get to clean up
 * first, and it is stopped as well when the daemon itself dies.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeExec } from '../src/exec.ts';

/** Running: not gone, and not a zombie its new parent has yet to reap. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A zombie still answers kill -0. The factory's sandbox refuses ps, so there kill -0 is all
  // there is, and the stopped processes' new parent reaps them soon enough.
  const stat = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return !(stat.stdout ?? '').trim().startsWith('Z');
}

async function until(test: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const dir = () => mkdtempSync(join(tmpdir(), 'factory-exec-'));

describe('nodeExec', { timeout: 30_000 }, () => {
  it('runs a command and returns its output, as before', async () => {
    const r = await nodeExec('sh', ['-c', 'cat; echo err >&2; exit 3'], { input: 'hi' });
    expect(r).toEqual({ code: 3, stdout: 'hi', stderr: 'err\n' });
  });

  it('stops the whole process group when the signal aborts', async () => {
    const d = dir();
    const pids = join(d, 'pids');
    const controller = new AbortController();
    // A background child that would outlive its parent, as `tart run` does in the VM script.
    const running = nodeExec('sh', ['-c', `sleep 30 & echo $! >"${pids}"; sleep 30; wait`], {
      signal: controller.signal,
      killGraceMs: 200,
    });
    await until(() => existsSync(pids) && readFileSync(pids, 'utf8').trim() !== '');
    const grandchild = Number(readFileSync(pids, 'utf8').trim());
    expect(alive(grandchild)).toBe(true);
    controller.abort();
    const r = await running;
    expect(r.aborted).toBe(true);
    await until(() => !alive(grandchild));
  });

  it("sends SIGTERM first, so the command's trap cleans up before it ends", async () => {
    const d = dir();
    const cleaned = join(d, 'cleaned');
    const started = join(d, 'started');
    const controller = new AbortController();
    const running = nodeExec(
      'sh',
      [
        '-c',
        `trap 'echo stopped-the-vm >"${cleaned}"; exit 143' TERM; sleep 30 & touch "${started}"; wait`,
      ],
      { signal: controller.signal, killGraceMs: 5000 },
    );
    await until(() => existsSync(started));
    controller.abort();
    const r = await running;
    expect(r.aborted).toBe(true);
    expect(readFileSync(cleaned, 'utf8')).toBe('stopped-the-vm\n');
  });

  it('kills a command that ignores SIGTERM once the grace has passed', async () => {
    const d = dir();
    const started = join(d, 'started');
    const controller = new AbortController();
    const t0 = Date.now();
    const running = nodeExec('sh', ['-c', `trap '' TERM; touch "${started}"; sleep 30`], {
      signal: controller.signal,
      killGraceMs: 300,
    });
    await until(() => existsSync(started));
    controller.abort();
    const r = await running;
    expect(r.aborted).toBe(true);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('stops the group when the process that started it dies, even by SIGKILL', async () => {
    const d = dir();
    const pids = join(d, 'pids');
    const exec = join(import.meta.dirname, '../src/exec.ts');
    // A stand-in daemon: starts a long command with a signal, then waits to be killed.
    const daemon = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { nodeExec } from ${JSON.stringify(exec)};
         void nodeExec('sh', ['-c', 'echo $$ >"${pids}"; sleep 30'], {
           signal: new AbortController().signal,
           killGraceMs: 200,
         });
         setInterval(() => {}, 1000);`,
      ],
      { stdio: 'ignore' },
    );
    try {
      await until(() => existsSync(pids) && readFileSync(pids, 'utf8').trim() !== '', 20_000);
      const command = Number(readFileSync(pids, 'utf8').trim());
      expect(alive(command)).toBe(true);
      daemon.kill('SIGKILL');
      await until(() => !alive(command), 20_000);
    } finally {
      daemon.kill('SIGKILL');
    }
  }, 60_000);
});
