/**
 * What the Time Machine's page and its worker say to each other (PEN-21): the reader's calls,
 * and the git reads the worker asks the page for. Types and one dispatcher only, so the worker
 * loads nothing of the page's.
 */
import type {
  TimelineChanges,
  TimelineCommit,
  TimelineDiff,
  TimelineNoteText,
  TimelineTree,
} from '@penmoss/git-notebook/timeline';

export interface TimelineClient {
  commits(refresh?: boolean): Promise<TimelineCommit[]>;
  tree(commit: string | null): Promise<TimelineTree>;
  note(noteId: string, commit: string): Promise<TimelineNoteText | null>;
  changes(from: number, to: number): Promise<TimelineChanges>;
  diff(noteId: string, from: string | null, to: string | null): Promise<TimelineDiff>;
  /** Where it reads now: in its worker, or on the page. */
  where(): 'worker' | 'page';
}

export type Method = 'commits' | 'tree' | 'note' | 'changes' | 'diff';

/** The git reads the worker may ask for: the timeline only reads. */
export const WORKER_GIT_OPS = ['list', 'read', 'log'] as const;
export type WorkerGitOp = (typeof WORKER_GIT_OPS)[number];

/** Page → worker. */
export type ToWorker =
  | { readonly type: 'init'; readonly root: string }
  | {
      readonly type: 'call';
      readonly id: number;
      readonly method: Method;
      readonly args: unknown[];
    }
  | {
      readonly type: 'git-reply';
      readonly id: number;
      readonly ok: boolean;
      readonly value?: unknown;
      readonly error?: string;
    };

/** Worker → page. */
export type FromWorker =
  | { readonly type: 'ready' }
  | {
      readonly type: 'reply';
      readonly id: number;
      readonly ok: boolean;
      readonly value?: unknown;
      readonly error?: string;
    }
  | {
      readonly type: 'git';
      readonly id: number;
      readonly op: WorkerGitOp;
      readonly args: unknown[];
    };

/** Runs one of the reader's methods with the arguments a message carried. */
export function runMethod(
  reader: Pick<TimelineClient, Method>,
  method: Method,
  args: readonly unknown[],
): Promise<unknown> {
  const [a, b, c] = args;
  switch (method) {
    case 'commits':
      return reader.commits(a === true);
    case 'tree':
      return reader.tree(typeof a === 'string' ? a : null);
    case 'note':
      return reader.note(String(a), String(b));
    case 'changes':
      return reader.changes(Number(a), Number(b));
    case 'diff':
      return reader.diff(
        String(a),
        typeof b === 'string' ? b : null,
        typeof c === 'string' ? c : null,
      );
  }
}
