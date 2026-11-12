import { describe, expect, it } from 'vitest';
import { usageLimitReset } from '../src/limits.ts';

const now = new Date(2026, 10, 7, 13, 20); // 1:20 pm local

describe('usage limits (F13, R13)', () => {
  it("reads Claude Code's epoch form", () => {
    const at = Math.floor(now.getTime() / 1000) + 3600;
    expect(usageLimitReset(`…\nClaude AI usage limit reached|${at}\n`, now)?.getTime()).toBe(
      at * 1000,
    );
  });
  it('reads "resets 3pm", today or tomorrow', () => {
    expect(usageLimitReset("You've hit your limit · resets 3pm", now)).toEqual(
      new Date(2026, 10, 7, 15, 0),
    );
    expect(usageLimitReset('5-hour limit reached ∙ resets 11:30am', now)).toEqual(
      new Date(2026, 10, 7, 13, 20 + 6 * 60),
    );
  });
  it('waits 30 minutes when no time is given', () => {
    expect(usageLimitReset('Error: rate_limit_error', now)).toEqual(new Date(2026, 10, 7, 13, 50));
  });
  it('is null for ordinary output', () => {
    expect(usageLimitReset('All tests passed; the limit of 5 items is reached', now)).toBeNull();
  });
});

describe('timeouts (F13)', async () => {
  const { withTimeout } = await import('../src/run.ts');
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
  it("waits as long as OpenCode's error says (PEN-117: Go's 5-hour limit, 4.45 hours)", () => {
    const error =
      '{"type":"error","error":{"type":"provider.quota","message":"OpenCode Go usage limit reached","status":429,"retryAfterMs":16032000}}';
    expect(usageLimitReset(`…\n${error}\n`, now)?.getTime()).toBe(now.getTime() + 16_032_000);
  });
});
