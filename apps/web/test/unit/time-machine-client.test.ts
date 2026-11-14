/**
 * The Time Machine's reader (PEN-21): in its worker, the page answers the worker's git reads and
 * only those; a worker that cannot start, or stops, leaves the page reading itself.
 */
import type { CommitInfo, GitTransport } from '@penmoss/git-notebook';
import { describe, expect, it } from 'vitest';
import { WorkerTimeline } from '../../src/time-machine/client';
import type { FromWorker, ToWorker } from '../../src/time-machine/protocol';

const COMMIT: CommitInfo = {
  id: 'a'.repeat(40),
  parents: [],
  author: { name: 'Ryan', email: 'ryan@example.invalid' },
  at: Date.UTC(2026, 9, 1),
  message: 'Penmoss\n\nPenmoss-Writer: 01JBWRITER0000000000000001 (device "Work MacBook")',
};

/** A transport with one commit and no files, counting what it was asked. */
function transport(): GitTransport & { asked: string[] } {
  const asked: string[] = [];
  const refused = () => Promise.reject(new Error('not here'));
  return {
    asked,
    root: '',
    log: () => {
      asked.push('log');
      return Promise.resolve([COMMIT]);
    },
    list: () => {
      asked.push('list');
      return Promise.resolve(new Map());
    },
    read: () => {
      asked.push('read');
      return Promise.resolve(new Map());
    },
    fetch: refused,
    changed: refused,
    commit: refused,
    push: () => {
      asked.push('push');
      return Promise.resolve('pushed');
    },
    readAt: refused,
  };
}

/** A stand-in Worker: `script` answers what the page posts. */
class FakeWorker {
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  terminated = false;
  constructor(private readonly script: (message: ToWorker, worker: FakeWorker) => void) {}
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  postMessage(message: ToWorker): void {
    queueMicrotask(() => this.script(message, this));
  }
  emit(type: 'message' | 'error', data: FromWorker | { message: string }): void {
    const event = type === 'message' ? { data } : data;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  terminate(): void {
    this.terminated = true;
  }
}

describe('the Time Machine’s worker client (PEN-21)', () => {
  it('reads on the page when its worker cannot start', async () => {
    const git = transport();
    let made: FakeWorker | null = null;
    const client = new WorkerTimeline(git, () => {
      made = new FakeWorker((_message, worker) =>
        worker.emit('error', { message: 'document is not defined' }),
      );
      return made as unknown as Worker;
    });
    const commits = await client.commits();
    expect(commits.map((commit) => commit.author.label)).toEqual(['Work MacBook']);
    expect(client.where()).toBe('page');
    expect(made!.terminated).toBe(true);
  });

  it('answers the worker’s reads, and refuses anything that writes', async () => {
    const git = transport();
    const replies: ToWorker[] = [];
    const client = new WorkerTimeline(
      git,
      () =>
        new FakeWorker((message, worker) => {
          if (message.type === 'init') worker.emit('message', { type: 'ready' });
          if (message.type === 'call') {
            // As the worker does: it asks the page for git reads, then answers the call.
            worker.emit('message', { type: 'git', id: 1, op: 'log', args: [{ limit: 5 }] });
            worker.emit('message', {
              type: 'git',
              id: 2,
              op: 'push' as 'log',
              args: ['b'.repeat(40)],
            });
            setTimeout(
              () => worker.emit('message', { type: 'reply', id: message.id, ok: true, value: [] }),
              20,
            );
          }
          if (message.type === 'git-reply') replies.push(message);
        }) as unknown as Worker,
    );
    await expect(client.commits()).resolves.toEqual([]);
    expect(client.where()).toBe('worker');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(git.asked).toEqual(['log']);
    expect(replies.find((reply) => reply.type === 'git-reply' && reply.id === 1)).toMatchObject({
      ok: true,
      value: [COMMIT],
    });
    expect(replies.find((reply) => reply.type === 'git-reply' && reply.id === 2)).toMatchObject({
      ok: false,
      error: 'Not a read.',
    });
  });
});
