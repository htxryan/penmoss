import { afterEach, describe, expect, it } from 'vitest';
import { boundedExec, killBoundedGroups } from '../../src/bounded-exec';

// A1480: the main process's short-lived programs (the login shell's PATH, git's credential, the
// owner check's helper) answer once they exit, and out of time their whole group is killed.

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Waits for a process to be gone (a killed one is reaped a moment later). */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 20));
  return !alive(pid);
}

const left: number[] = [];
afterEach(() => {
  for (const pid of left.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Gone already.
    }
  }
});

describe('boundedExec', () => {
  it('answers when the program exits, though a grandchild still holds its pipe', async () => {
    const started = Date.now();
    const ran = await boundedExec({
      command: 'sh',
      args: ['-c', 'sleep 30 & echo $!'],
      timeoutMs: 10_000,
    });
    expect(ran.kind).toBe('exit');
    if (ran.kind !== 'exit') return;
    left.push(Number(ran.stdout.trim()));
    expect(ran.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('kills the whole group when the time is up', async () => {
    let grandchild = 0;
    const ran = await boundedExec({
      command: 'sh',
      args: ['-c', 'sleep 30 & echo $! >&2; wait'],
      timeoutMs: 500,
      onStderr: (chunk) => {
        grandchild = Number(chunk.trim());
      },
    });
    expect(ran.kind).toBe('timeout');
    expect(grandchild).toBeGreaterThan(0);
    left.push(grandchild);
    expect(await gone(grandchild)).toBe(true);
  });

  it('writes the input to stdin and keeps what the program wrote', async () => {
    const ran = await boundedExec({
      command: 'sh',
      args: ['-c', 'cat; echo oops >&2; exit 3'],
      input: 'protocol=https\n',
      timeoutMs: 10_000,
    });
    expect(ran).toEqual({ kind: 'exit', code: 3, stdout: 'protocol=https\n', stderr: 'oops\n' });
  });

  it('says when the program cannot start', async () => {
    const ran = await boundedExec({ command: '/no/such/program', args: [], timeoutMs: 10_000 });
    expect(ran.kind).toBe('error');
  });

  it('kills every group still running as the app quits', async () => {
    let grandchild = 0;
    const running = boundedExec({
      command: 'sh',
      args: ['-c', 'sleep 30 & echo $! >&2; wait'],
      timeoutMs: 20_000,
      onStderr: (chunk) => {
        grandchild = Number(chunk.trim());
      },
    });
    for (let i = 0; i < 100 && grandchild === 0; i++) await new Promise((r) => setTimeout(r, 20));
    left.push(grandchild);
    killBoundedGroups();
    const ran = await running;
    expect(ran.kind).toBe('exit');
    expect(await gone(grandchild)).toBe(true);
  });
});
