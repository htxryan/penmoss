import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ignoreClosedOutput } from '../../src/stdio';

// PEN-122 (A1338): a closed stdout or stderr never makes logging an uncaught exception.

const STDIO = new URL('../../src/stdio.ts', import.meta.url).href;

/** A stream like a pipe whose reader has gone: each write fails later with EPIPE. */
function closedPipe(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      setImmediate(() =>
        callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write' })),
      );
    },
  });
}

describe('logging to a closed pipe', () => {
  it('is an unhandled error without the guard, which is what Electron shows as a dialog', async () => {
    const stream = closedPipe();
    const failed = new Promise<NodeJS.ErrnoException>((resolve) => stream.once('error', resolve));
    stream.write('[penmoss] hello\n');
    expect((await failed).code).toBe('EPIPE');
  });

  it('drops the failed write and every one after it once guarded', async () => {
    const stream = closedPipe();
    ignoreClosedOutput([stream]);
    expect(stream.listenerCount('error')).toBe(1);
    // An 'error' with no listener would throw from emit; the guard's listener takes it.
    stream.write('[penmoss] first\n');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(() => stream.write('[penmoss] after the pipe closed\n')).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stream.destroyed).toBe(true);
  });

  it.each([
    ['without the guard', false],
    ['with the guard', true],
  ])('a real process whose reader exits early, %s', async (_name, guarded) => {
    // As `Penmoss | head -1`: the process logs a line, its reader exits, and it logs again.
    const script = `
      ${guarded ? `const { ignoreClosedOutput } = await import(${JSON.stringify(STDIO)}); ignoreClosedOutput();` : ''}
      process.stdout.write('[penmoss] one\\n');
      setTimeout(() => {
        for (let i = 0; i < 5; i++) process.stdout.write('[penmoss] after the reader left\\n');
        setTimeout(() => process.stderr.write('still running\\n'), 100);
      }, 300);`;
    const child = spawn('/bin/sh', ['-c', '"$NODE" --input-type=module -e "$SCRIPT" | head -1'], {
      env: { ...process.env, NODE: process.execPath, SCRIPT: script },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
    await new Promise((resolve) => child.on('close', resolve));
    expect(out).toBe('[penmoss] one\n');
    if (guarded) {
      expect(err).toBe('still running\n');
    } else {
      expect(err).toContain('write EPIPE');
      expect(err).not.toContain('still running');
    }
  });
});
