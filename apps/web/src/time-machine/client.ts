/**
 * Where the Time Machine reads a git notebook's past (PEN-21): `NotebookTimeline`
 * (packages/git-notebook) runs in a worker of its own, off the page's thread, so merging old logs
 * and rendering old markdown never holds up typing. Git itself stays in the Mac app's main
 * process (A853): the worker asks the page for each git read, and the page passes it on over IPC.
 *
 * One reader per notebook for the window's life, so what it has read stays cached. Where a worker
 * cannot start (a test's DOM, a policy that refuses it), the same reader runs on the page.
 */
import {
  Layout,
  NotebookTimeline,
  type GitTransport,
  type TimelineChanges,
  type TimelineCommit,
  type TimelineDiff,
  type TimelineNoteText,
  type TimelineTree,
} from '@penmoss/git-notebook/timeline';
import type { GitSource } from '../sources/git-source';
import { IpcGitTransport } from '../sources/ipc-transport';
import {
  runMethod,
  type FromWorker,
  type Method,
  type TimelineClient,
  type ToWorker,
} from './protocol';

export type { TimelineClient } from './protocol';

/** How long a worker has to say it started before the page reads on its own. */
const START_MS = 5_000;

class WorkerBroken extends Error {}

/** A reader on the page, over a transport (tests; the fallback). */
export function pageTimeline(transport: GitTransport): TimelineClient {
  const timeline = new NotebookTimeline(transport, new Layout(transport.root));
  return {
    commits: (refresh) => timeline.commits(refresh),
    tree: (commit) => timeline.tree(commit),
    note: (noteId, commit) => timeline.note(noteId, commit),
    changes: (from, to) => timeline.changes(from, to),
    diff: (noteId, from, to) => timeline.diff(noteId, from, to),
    where: () => 'page',
  };
}

/** The reader in a worker, falling back to the page when the worker cannot run. */
export class WorkerTimeline implements TimelineClient {
  private worker: Worker | null = null;
  private readonly started: Promise<boolean>;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  private next = 0;
  private fallback: TimelineClient | null = null;

  constructor(
    private readonly transport: GitTransport,
    makeWorker: () => Worker,
  ) {
    this.started = new Promise<boolean>((resolve) => {
      let worker: Worker;
      try {
        worker = makeWorker();
      } catch {
        resolve(false);
        return;
      }
      this.worker = worker;
      const timer = setTimeout(() => {
        this.broken();
        resolve(false);
      }, START_MS);
      worker.addEventListener('message', (event: MessageEvent<FromWorker>) => {
        const message = event.data;
        if (message.type === 'ready') {
          clearTimeout(timer);
          resolve(true);
        } else if (message.type === 'reply') {
          const waiting = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (!waiting) return;
          if (message.ok) waiting.resolve(message.value);
          else waiting.reject(new Error(message.error ?? 'The Time Machine could not read that.'));
        } else if (message.type === 'git') {
          void this.git(message);
        }
      });
      worker.addEventListener('error', (event) => {
        clearTimeout(timer);
        // Said, not thrown: the page reads the history itself instead.
        console.warn(
          '[time-machine] the worker stopped; reading on the page',
          `${event.message} (${event.filename}:${event.lineno})`,
        );
        this.broken();
        resolve(false);
      });
      const init: ToWorker = { type: 'init', root: transport.root };
      worker.postMessage(init);
    });
  }

  /** The worker failed: what it was asked is asked again on the page. */
  private broken(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const waiting of this.pending.values()) waiting.reject(new WorkerBroken());
    this.pending.clear();
  }

  private async git(message: Extract<FromWorker, { type: 'git' }>): Promise<void> {
    let reply: ToWorker;
    try {
      const [first, second] = message.args;
      const value =
        message.op === 'list'
          ? await this.transport.list(String(first))
          : message.op === 'read'
            ? await this.transport.read(String(first), (second ?? []) as string[])
            : message.op === 'log'
              ? await this.transport.log(first ?? {})
              : await Promise.reject(new Error('Not a read.'));
      reply = { type: 'git-reply', id: message.id, ok: true, value };
    } catch (error) {
      reply = {
        type: 'git-reply',
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    this.worker?.postMessage(reply);
  }

  private page(): TimelineClient {
    this.fallback ??= pageTimeline(this.transport);
    return this.fallback;
  }

  private async call<T>(method: Method, args: unknown[]): Promise<T> {
    if ((await this.started) && this.worker) {
      const id = ++this.next;
      try {
        return await new Promise<T>((resolve, reject) => {
          this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
          const call: ToWorker = { type: 'call', id, method, args };
          this.worker!.postMessage(call);
        });
      } catch (error) {
        if (!(error instanceof WorkerBroken)) throw error;
      }
    }
    return runMethod(this.page(), method, args) as Promise<T>;
  }

  commits(refresh?: boolean): Promise<TimelineCommit[]> {
    return this.call('commits', [refresh ?? false]);
  }
  tree(commit: string | null): Promise<TimelineTree> {
    return this.call('tree', [commit]);
  }
  note(noteId: string, commit: string): Promise<TimelineNoteText | null> {
    return this.call('note', [noteId, commit]);
  }
  changes(from: number, to: number): Promise<TimelineChanges> {
    return this.call('changes', [from, to]);
  }
  diff(noteId: string, from: string | null, to: string | null): Promise<TimelineDiff> {
    return this.call('diff', [noteId, from, to]);
  }
  where(): 'worker' | 'page' {
    return this.worker ? 'worker' : 'page';
  }
}

const readers = new WeakMap<GitSource, TimelineClient>();

/** The Time Machine's reader of a git notebook, made once per window. */
export function timelineOf(source: GitSource): TimelineClient {
  let reader = readers.get(source);
  if (!reader) {
    const info = source.info;
    const transport = new IpcGitTransport(source.git, info.localId, info.dir ? `${info.dir}/` : '');
    reader =
      typeof Worker === 'undefined'
        ? pageTimeline(transport)
        : new WorkerTimeline(
            transport,
            () =>
              new Worker(new URL('./timeline.worker.ts', import.meta.url), {
                type: 'module',
                name: 'Time Machine',
              }),
          );
    readers.set(source, reader);
  }
  return reader;
}
