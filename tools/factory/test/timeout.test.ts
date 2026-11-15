import { describe, expect, it } from 'vitest';

describe('timeouts (F13)', async () => {
  const { withTimeout } = await import('../src/timeout.ts');
  it('rejects a step that runs past its minutes, and passes one that finishes', async () => {
    await expect(
      withTimeout(new Promise(() => undefined), 0.0001, 'recording web proof'),
    ).rejects.toThrow('recording web proof took longer than 0.0001 min');
    await expect(withTimeout(Promise.resolve(7), 1, 'x')).resolves.toBe(7);
  });
  it('aborts the signal at the timeout, and rejects once the stopped step has wound down', async () => {
    let seen: AbortSignal | undefined;
    let stopped = false;
    const step = (signal: AbortSignal) => {
      seen = signal;
      // Stopping takes a moment (the VM script stops the VM), then resolves with what it had.
      return new Promise<string[]>((resolve) =>
        signal.addEventListener('abort', () =>
          setTimeout(() => {
            stopped = true;
            resolve([]);
          }, 30),
        ),
      );
    };
    await expect(withTimeout(step, 0.0001, 'recording mac proof')).rejects.toThrow(
      'recording mac proof took longer than 0.0001 min',
    );
    expect(seen?.aborted).toBe(true);
    expect(stopped).toBe(true);
    // A step that ignores the signal still times out, after the settle time.
    await expect(withTimeout(() => new Promise(() => undefined), 0.0001, 'x', 20)).rejects.toThrow(
      'x took longer than 0.0001 min',
    );
    // In time, the step's own result.
    await expect(withTimeout(() => Promise.resolve(7), 1, 'x')).resolves.toBe(7);
  });
  it("stops the gate's command when it runs past gateMinutes (F2)", async () => {
    const { gateExec } = await import('../src/gate-run.ts');
    let seen: AbortSignal | undefined;
    const gate = {
      worktreePath: '/w',
      exec: (_command: string, options?: { readonly signal?: AbortSignal }) => {
        seen = options?.signal;
        // As the sandbox's does: it ends once what it runs is stopped.
        return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) =>
          seen?.addEventListener('abort', () => resolve({ exitCode: 143, stdout: '', stderr: '' })),
        );
      },
      close: () => Promise.resolve(),
    };
    await expect(gateExec(gate, 'task check', 0.0001)).rejects.toThrow(
      '`task check` took longer than 0.0001 min',
    );
    expect(seen?.aborted).toBe(true);
  });
});
