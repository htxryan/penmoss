/**
 * The Time Machine's worker (PEN-21): `NotebookTimeline` off the page's thread. Every
 * git read goes back to the page (`git`), which passes it to the Mac app's main process; the
 * worker never reaches git or the network itself, and only ever reads.
 */
import {
  Layout,
  NotebookTimeline,
  type CommitInfo,
  type GitTransport,
} from '@penmoss/git-notebook/timeline';
import { runMethod, type FromWorker, type ToWorker, type WorkerGitOp } from './protocol';

interface WorkerScope {
  postMessage(message: FromWorker): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<ToWorker>) => void): void;
}

const scope = self as unknown as WorkerScope;
const waiting = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (e: Error) => void }
>();
let next = 0;

function ask<T>(op: WorkerGitOp, ...args: unknown[]): Promise<T> {
  const id = ++next;
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
    scope.postMessage({ type: 'git', id, op, args });
  });
}

const refused = () => Promise.reject(new Error('The Time Machine only reads.'));

function transportFor(root: string): GitTransport {
  return {
    root,
    list: (head) => ask<ReadonlyMap<string, string>>('list', head),
    read: (head, paths) => ask<ReadonlyMap<string, Uint8Array>>('read', head, [...paths]),
    log: (options) => ask<CommitInfo[]>('log', options ?? {}),
    fetch: refused,
    changed: refused,
    commit: refused,
    push: refused,
    readAt: refused,
  };
}

let timeline: NotebookTimeline | null = null;

scope.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'init') {
    timeline = new NotebookTimeline(transportFor(message.root), new Layout(message.root));
    scope.postMessage({ type: 'ready' });
    return;
  }
  if (message.type === 'git-reply') {
    const found = waiting.get(message.id);
    waiting.delete(message.id);
    if (!found) return;
    if (message.ok) found.resolve(message.value);
    else found.reject(new Error(message.error ?? 'git could not read that.'));
    return;
  }
  if (message.type === 'call') {
    const { id, method, args } = message;
    void (async () => {
      try {
        if (!timeline) throw new Error('The Time Machine has not started.');
        const value = await runMethod(timeline, method, args);
        scope.postMessage({ type: 'reply', id, ok: true, value });
      } catch (error) {
        scope.postMessage({
          type: 'reply',
          id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }
});
