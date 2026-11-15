/**
 * A git notebook's comment threads on this device (T60, A1064): one note's threads, threads
 * across the notebook, reading one (which marks it seen, A1061) and changing them as this
 * clone's writer (A775).
 */
import {
  readThread,
  readThreads,
  setThreadDelivery,
  type CommentAuthor,
  type ThreadData,
} from '@penmoss/sync-client/comments';
import {
  planCommentChange,
  repliedDelivery,
  seenDelivery,
  threadUpdated,
  viewThread,
  viewThreads,
  type CommentChange,
  type StatusFilter,
} from '@penmoss/sync-client/comment-delivery';
import { LocalError, type NoteCatalog } from './catalog';

/** The most threads one list across the notebook returns. */
export const MAX_LISTED_THREADS = 200;

/** One thread as a list across the notebook gives it. */
export interface ListedThread {
  noteId: string;
  title: string;
  threadId: string;
  status: ThreadData['status'];
  quote: string;
  comments: number;
  updated: number;
  sentTo?: string;
  delivery?: string;
}

export class LocalComments {
  constructor(
    private readonly notes: NoteCatalog,
    private readonly clock: () => number,
  ) {}

  /** This clone's writer id: the comments' author, and who "sent to me" means (A1064). */
  get writerId(): string | null {
    return this.notes.engine.writer?.id ?? null;
  }

  /** Who this clone comments as: its writer, self-declared (A781 needs a server). */
  private author(): CommentAuthor {
    const self = this.notes.self();
    return { id: self.id, kind: self.kind, label: self.label };
  }

  noteThreads(id: string, status: StatusFilter = 'open') {
    const { doc, info } = this.notes.require(id);
    return {
      noteId: id,
      title: info.title,
      deleted: info.deleted,
      status,
      threads: viewThreads(doc, status),
    };
  }

  allThreads(input: {
    readonly status?: StatusFilter;
    readonly sentToMe?: boolean;
    readonly noteId?: string;
    readonly limit?: number;
  }) {
    const status = input.status ?? 'open';
    const writer = this.writerId;
    const out: ListedThread[] = [];
    for (const note of this.notes.live()) {
      if (input.noteId !== undefined && note.id !== input.noteId) continue;
      const doc = this.notes.ops.note(note.id);
      if (!doc) continue;
      for (const thread of readThreads(doc)) {
        if (status !== 'all' && thread.status !== status) continue;
        if (input.sentToMe && (writer === null || thread.target?.writer !== writer)) continue;
        out.push({
          noteId: note.id,
          title: note.title,
          threadId: thread.id,
          status: thread.status,
          quote: thread.quote.slice(0, 200),
          comments: thread.comments.length,
          updated: threadUpdated(thread),
          ...(thread.target ? { sentTo: thread.target.label } : {}),
          ...(thread.delivery ? { delivery: thread.delivery.state } : {}),
        });
      }
    }
    out.sort((a, b) => b.updated - a.updated || a.threadId.localeCompare(b.threadId));
    return {
      status,
      threads: out.slice(0, Math.min(input.limit ?? MAX_LISTED_THREADS, MAX_LISTED_THREADS)),
    };
  }

  readCommentThread(id: string, threadId: string) {
    const { doc, info } = this.notes.require(id);
    const thread = readThread(doc, threadId);
    if (!thread) throw new LocalError(404, 'thread_not_found', 'No such thread');
    const writer = this.writerId;
    const seen = writer ? seenDelivery(thread, writer, this.clock()) : null;
    if (seen) setThreadDelivery(doc, thread.id, seen);
    return { noteId: id, title: info.title, thread: viewThread(doc, thread.id)! };
  }

  changeComments(id: string, change: CommentChange) {
    const { doc, info } = this.notes.require(id);
    const now = this.clock();
    const plan = planCommentChange(doc, this.author(), change, now);
    if ('ok' in plan) throw new LocalError(plan.status, plan.code, plan.message, plan.details);
    const rev = this.notes.engine.replica.rev(id);
    plan.write?.(doc);
    const changed = this.notes.engine.replica.rev(id) !== rev;
    const writer = this.writerId;
    if (changed && change.op === 'reply' && writer) {
      const thread = readThread(doc, plan.threadId);
      const replied = thread ? repliedDelivery(thread, writer, now) : null;
      if (replied) setThreadDelivery(doc, plan.threadId, replied);
    }
    return {
      noteId: id,
      title: info.title,
      changed,
      thread: viewThread(doc, plan.threadId),
      ...(plan.commentId ? { commentId: plan.commentId } : {}),
      ...(plan.occurrences !== undefined ? { occurrences: plan.occurrences } : {}),
    };
  }
}
