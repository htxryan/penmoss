/**
 * Comment threads for agents, and their delivery (T60, D50; rescued from the deleted server's
 * `do/comments.ts`, T48): how a thread is shown to an agent (`viewThreads`), how a change to the
 * threads is checked and planned (`planCommentChange`), and what goes to an agent session and
 * how its state moves (A1061): `deliveryCandidates`, `deliveryAdvances`, `deliveryPayload`.
 *
 * The local MCP server (`penmoss mcp`, A1064) and its channel (`--channel`, A1063) call these
 * over a git notebook's own documents; the apps read the same states. Nothing here is about a
 * server, a token or a socket: a target is `{writer, session, label}` (A1060), and whoever reads
 * a thread knows only its own writer.
 */
import { ulid } from '@penmoss/core';
import * as Y from '@y/y';
import {
  addComment,
  anchorAtStart,
  anchorForQuote,
  createThread,
  deleteComment,
  deleteThread,
  editComment,
  isNoteThread,
  locateThreads,
  MAX_COMMENT_CHARS,
  MAX_COMMENTS_PER_THREAD,
  MAX_THREADS,
  orderThreads,
  readThread,
  readThreads,
  resolveAnchor,
  setThreadStatus,
  setThreadTarget,
  type AnchorContext,
  type CommentAnchor,
  type CommentAuthor,
  type CommentData,
  type CommentDelivery,
  type CommentTarget,
  type DeliveryState,
  type PlacedThread,
  type ThreadData,
  type ThreadPlace,
  type ThreadStatus,
} from './comments';
import { isDeleted } from './note';

// --- views ---

/** A thread as an agent's tools read it. */
export interface ThreadView {
  readonly id: string;
  readonly status: ThreadStatus;
  /** The text the thread was started on, kept as it was (empty for a point). */
  readonly quote: string;
  /** Its text was deleted, or its block: it stays with its quote (A771). */
  readonly orphaned: boolean;
  /** `range` or `point`, and the anchor itself for an editor to place it. */
  readonly kind: 'range' | 'point';
  readonly anchor: CommentAnchor | null;
  /** `note`: on the note as a whole, with no passage (T52 item 5); null otherwise. */
  readonly scope: 'note' | null;
  /** Where it was when it was made (null for threads from before T52, and on the note). */
  readonly context: AnchorContext | null;
  /** Where it is now: its text, headings and block, found again by its text if lost. */
  readonly place: ThreadPlace;
  readonly created: number;
  readonly author: CommentAuthor;
  readonly target: CommentTarget | null;
  readonly delivery: CommentDelivery | null;
  readonly resolvedAt: number | null;
  readonly resolvedBy: CommentAuthor | null;
  readonly comments: readonly CommentData[];
}

export function threadView(placed: PlacedThread, place: ThreadPlace): ThreadView {
  const { thread, anchor } = placed;
  const note = isNoteThread(thread);
  return {
    id: thread.id,
    status: thread.status,
    quote: thread.quote,
    // A thread on the note has no text to lose.
    orphaned: !note && anchor.orphaned,
    kind: thread.anchor?.to ? 'range' : 'point',
    anchor: thread.anchor,
    scope: note ? 'note' : null,
    context: thread.context ?? null,
    place,
    created: thread.created,
    author: thread.author,
    target: thread.target ?? null,
    delivery: thread.delivery ?? null,
    resolvedAt: thread.resolvedAt ?? null,
    resolvedBy: thread.resolvedBy ?? null,
    comments: thread.comments,
  };
}

export type StatusFilter = 'open' | 'resolved' | 'all';

export const STATUS_FILTERS: readonly StatusFilter[] = ['open', 'resolved', 'all'];

/** The note's threads in document order, orphans last, filtered by status (A777). */
export function viewThreads(doc: Y.Doc, status: StatusFilter = 'open'): ThreadView[] {
  const threads = readThreads(doc).filter((thread) => status === 'all' || thread.status === status);
  const ordered = orderThreads(doc, threads);
  const places = locateThreads(
    doc,
    ordered.map((placed) => placed.thread),
  );
  return ordered.map((placed, index) => threadView(placed, places[index]!));
}

export function viewThread(doc: Y.Doc, threadId: string): ThreadView | null {
  const thread = readThread(doc, threadId);
  if (!thread) return null;
  const [place] = locateThreads(doc, [thread]);
  return threadView({ thread, anchor: resolveAnchor(doc, thread.anchor) }, place!);
}

/** When a thread last changed: its newest comment, or when it was resolved. */
export function threadUpdated(thread: ThreadData): number {
  return Math.max(
    thread.created,
    thread.resolvedAt ?? 0,
    ...thread.comments.map((comment) => comment.edited ?? comment.at),
  );
}

// --- changes ---

/** A change to the note's threads, by a person (the apps) or an agent (the MCP tools). */
export type CommentChange =
  | {
      readonly op: 'create';
      /** A thread id the client chose (a retry with it answers the same thread). */
      readonly id?: string;
      readonly body: string;
      /** The quoted text and which occurrence (1st, 2nd…) in the note; neither: its start. */
      readonly quote?: string;
      readonly occurrence?: number;
      /** An anchor an editor made, in place of a quote. */
      readonly anchor?: CommentAnchor;
      /** The quote as that editor showed it, kept with its anchor. */
      readonly anchorQuote?: string;
      readonly target?: CommentTarget;
    }
  | { readonly op: 'reply'; readonly threadId: string; readonly id?: string; readonly body: string }
  | {
      readonly op: 'edit';
      readonly threadId: string;
      readonly commentId: string;
      readonly body: string;
    }
  | { readonly op: 'delete'; readonly threadId: string; readonly commentId?: string }
  | { readonly op: 'status'; readonly threadId: string; readonly status: ThreadStatus }
  | { readonly op: 'target'; readonly threadId: string; readonly target: CommentTarget | null };

/** A refusal, in the REST API's shape (status, code, message), which the MCP tools advise on. */
export interface CommentFailure {
  readonly ok: false;
  readonly status: 400 | 403 | 404 | 409 | 422;
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, number | string>>;
}

const failure = (
  status: CommentFailure['status'],
  code: string,
  message: string,
  details?: Readonly<Record<string, number | string>>,
): CommentFailure => ({ ok: false, status, code, message, ...(details ? { details } : {}) });

export const COMMENT_ID = /^[0-9A-Za-z_-]{1,40}$/;

function bodyProblem(body: string): CommentFailure | null {
  if (body.trim().length === 0) return failure(400, 'invalid_request', 'The comment is empty');
  if (body.length > MAX_COMMENT_CHARS) {
    return failure(422, 'too_long', `A comment is at most ${MAX_COMMENT_CHARS} characters`);
  }
  return null;
}

/**
 * A planned change: what to write and what it answers. Planned against the document as it is,
 * and written with no await between.
 */
export interface CommentPlan {
  readonly write: ((doc: Y.Doc) => void) | null;
  readonly threadId: string;
  readonly commentId?: string;
  readonly occurrences?: number;
}

/**
 * Checks and plans a change by `author` (A775, A779): agents do not comment in a note in Trash,
 * send threads, delete comments or edit anyone's comments but their own.
 */
export function planCommentChange(
  doc: Y.Doc,
  author: CommentAuthor,
  change: CommentChange,
  now: number,
): CommentPlan | CommentFailure {
  const person = author.kind !== 'agent';
  // A note in Trash keeps its threads (A770), but agents do not write in it: Ryan may still
  // resolve, reopen, edit or delete there, in the apps.
  if (!person && (change.op === 'create' || change.op === 'reply') && isDeleted(doc)) {
    return failure(409, 'in_trash', 'The note is in Trash: restore it to comment on it');
  }
  switch (change.op) {
    case 'create': {
      const problem = bodyProblem(change.body);
      if (problem) return problem;
      const id = change.id ?? ulid(now);
      if (!COMMENT_ID.test(id)) return failure(400, 'invalid_request', 'Invalid thread id');
      if (readThread(doc, id)) return { write: null, threadId: id };
      if (readThreads(doc).length >= MAX_THREADS) {
        return failure(422, 'too_many_threads', `A note holds at most ${MAX_THREADS} threads`);
      }
      if (change.target && !person) {
        return failure(403, 'agent_not_allowed', 'Only Ryan sends a thread to an agent session');
      }
      let anchor: CommentAnchor | null;
      let quote: string;
      let occurrences: number | undefined;
      if (change.anchor) {
        const resolved = resolveAnchor(doc, change.anchor);
        if (resolved.orphaned) {
          return failure(422, 'anchor_not_found', 'The place commented on is not in the note');
        }
        anchor = change.anchor;
        quote = change.anchorQuote ?? '';
      } else if (change.quote !== undefined && change.quote !== '') {
        const match = anchorForQuote(doc, change.quote, change.occurrence ?? 1);
        if ('error' in match) {
          return match.error === 'not_found'
            ? failure(
                422,
                'quote_not_found',
                'That text is not in the note. Quote its words as read_note shows them, leaving out formatting such as ** or `; a link may be quoted as [[Bob]] or as its label, Bob.',
              )
            : failure(
                422,
                'occurrence_not_found',
                `That text occurs ${match.occurrences} time${match.occurrences === 1 ? '' : 's'} in the note`,
                { occurrences: match.occurrences },
              );
        }
        anchor = match.anchor;
        quote = match.quote;
        occurrences = match.occurrences;
      } else {
        // On the note as a whole (A775; T52 item 5): placed at its start, listed first.
        anchor = anchorAtStart(doc);
        quote = '';
      }
      const note = !change.anchor && quote === '';
      if (!anchor && !note) {
        return failure(422, 'anchor_not_found', 'The note has no place to comment on');
      }
      const commentId = ulid(now);
      const placed = anchor;
      return {
        threadId: id,
        commentId,
        ...(occurrences !== undefined ? { occurrences } : {}),
        write: (live) =>
          createThread(live, {
            id,
            anchor: placed,
            quote,
            ...(note ? { scope: 'note' as const } : {}),
            author: { ...author },
            at: now,
            comment: { id: commentId, body: change.body },
            ...(change.target ? { target: change.target } : {}),
          }),
      };
    }
    case 'reply': {
      const problem = bodyProblem(change.body);
      if (problem) return problem;
      const thread = readThread(doc, change.threadId);
      if (!thread) return failure(404, 'thread_not_found', 'No such thread');
      const commentId = change.id ?? ulid(now);
      if (!COMMENT_ID.test(commentId)) return failure(400, 'invalid_request', 'Invalid comment id');
      if (thread.comments.some((comment) => comment.id === commentId)) {
        return { write: null, threadId: thread.id, commentId };
      }
      if (thread.comments.length >= MAX_COMMENTS_PER_THREAD) {
        return failure(
          422,
          'too_many_comments',
          `A thread holds at most ${MAX_COMMENTS_PER_THREAD} comments`,
        );
      }
      return {
        threadId: thread.id,
        commentId,
        write: (live) =>
          addComment(live, thread.id, {
            id: commentId,
            author: { ...author },
            body: change.body,
            at: now,
          }),
      };
    }
    case 'edit': {
      const problem = bodyProblem(change.body);
      if (problem) return problem;
      const thread = readThread(doc, change.threadId);
      const comment = thread?.comments.find((each) => each.id === change.commentId);
      if (!thread || !comment) return failure(404, 'comment_not_found', 'No such comment');
      // An agent edits its own comments; Ryan, on any of his devices, edits any of his.
      const mine =
        author.kind === 'agent'
          ? comment.author.id === author.id
          : comment.author.kind === 'device';
      if (!mine) return failure(403, 'not_your_comment', 'Only its writer edits a comment');
      return {
        threadId: thread.id,
        commentId: comment.id,
        write: (live) => editComment(live, thread.id, comment.id, change.body, now),
      };
    }
    case 'delete': {
      if (!person) return failure(403, 'agent_not_allowed', 'An agent cannot delete comments');
      const thread = readThread(doc, change.threadId);
      if (!thread) return failure(404, 'thread_not_found', 'No such thread');
      const { commentId } = change;
      if (commentId !== undefined && !thread.comments.some((each) => each.id === commentId)) {
        return failure(404, 'comment_not_found', 'No such comment');
      }
      return {
        threadId: thread.id,
        ...(commentId !== undefined ? { commentId } : {}),
        write: (live) =>
          commentId === undefined
            ? deleteThread(live, thread.id)
            : deleteComment(live, thread.id, commentId),
      };
    }
    case 'status': {
      const thread = readThread(doc, change.threadId);
      if (!thread) return failure(404, 'thread_not_found', 'No such thread');
      return {
        threadId: thread.id,
        write: (live) => setThreadStatus(live, thread.id, change.status, { ...author }, now),
      };
    }
    case 'target': {
      if (!person) {
        return failure(403, 'agent_not_allowed', 'Only Ryan sends a thread to an agent session');
      }
      const thread = readThread(doc, change.threadId);
      if (!thread) return failure(404, 'thread_not_found', 'No such thread');
      return {
        threadId: thread.id,
        write: (live) => setThreadTarget(live, thread.id, change.target),
      };
    }
  }
}

// --- delivery (A774, A1061) ---

/** A comment of Ryan's that should reach a session. */
export interface DeliveryCandidate {
  readonly threadId: string;
  readonly commentId: string;
  readonly target: CommentTarget;
}

/**
 * Ryan's comments in open threads with a target that came after the last agent comment there:
 * what the target session has yet to answer. Oldest first.
 */
export function deliveryCandidates(threads: readonly ThreadData[]): DeliveryCandidate[] {
  const out: DeliveryCandidate[] = [];
  for (const thread of threads) {
    const { target } = thread;
    if (thread.status !== 'open' || !target) continue;
    let lastAgent = -1;
    thread.comments.forEach((comment, index) => {
      if (comment.author.kind === 'agent') lastAgent = index;
    });
    for (const comment of thread.comments.slice(lastAgent + 1)) {
      if (comment.author.kind === 'device' && !comment.removed) {
        out.push({ threadId: thread.id, commentId: comment.id, target });
      }
    }
  }
  return out;
}

const STATE_ORDER: Readonly<Record<Exclude<DeliveryState, 'failed'>, number>> = {
  waiting: 0,
  sent: 1,
  seen: 2,
  replied: 3,
};

/**
 * Whether a delivery state may replace the thread's current one. A newer comment, or another
 * session, always does. For the same comment states only move forward, waiting → sent → seen →
 * replied: a read that came before the channel's "sent" stays seen. `failed` (A785, A1062) ends
 * a delivery that has not been seen, and nothing follows it.
 */
export function deliveryAdvances(
  current: CommentDelivery | undefined,
  next: { readonly commentId: string; readonly state: DeliveryState; readonly session: string },
): boolean {
  if (!current || current.commentId !== next.commentId || current.session !== next.session) {
    return true;
  }
  if (current.state === 'failed') return false;
  if (next.state === 'failed') return current.state === 'waiting' || current.state === 'sent';
  return STATE_ORDER[next.state] > STATE_ORDER[current.state];
}

/**
 * The comments of a thread a channel session still has to send (A1066), oldest first: Ryan's
 * comments after the agent's last one (`deliveryCandidates`) that come after the one the thread's
 * delivery says reached `session` (`sent`, `seen` or `replied`), or from the one it is `waiting`
 * for. The delivery is the only record, so this is what makes a comment go once across restarts:
 * the channel writes `sent` for the newest comment it sent. A delivery that `failed` sends nothing
 * until the app writes `waiting` again (Send to again). Empty for a thread that is not open, not
 * targeted at `session`, or has nothing new.
 */
export function dueComments(thread: ThreadData, session: string): CommentData[] {
  if (thread.status !== 'open' || thread.target?.session !== session) return [];
  const ids = new Set(deliveryCandidates([thread]).map((candidate) => candidate.commentId));
  const candidates = thread.comments.filter((comment) => ids.has(comment.id));
  if (candidates.length === 0) return [];
  const delivery = thread.delivery;
  if (!delivery || delivery.session !== session) return candidates;
  const at = candidates.findIndex((comment) => comment.id === delivery.commentId);
  // Its comment is older than the agent's last reply: everything here is new.
  if (at < 0) return delivery.state === 'failed' ? [] : candidates;
  if (delivery.state === 'failed') return [];
  return delivery.state === 'waiting' ? candidates.slice(at) : candidates.slice(at + 1);
}

/**
 * The delivery to write when the agent writer `writer` reads a thread (A1061): `seen` for Ryan's
 * newest comment, even when the read came before the channel's "sent". Null when the thread is
 * not sent to that writer, or the state would not advance.
 */
export function seenDelivery(
  thread: ThreadData,
  writer: string,
  now: number,
): CommentDelivery | null {
  const target = thread.target;
  if (!target || target.writer !== writer) return null;
  const newest = deliveryCandidates([thread]).at(-1)?.commentId ?? thread.delivery?.commentId;
  if (!newest) return null;
  const seen = { state: 'seen' as const, commentId: newest, session: target.session, at: now };
  return deliveryAdvances(thread.delivery, seen) ? seen : null;
}

/**
 * The delivery to write once the agent writer `writer` replied in a thread sent to it (A1061):
 * `replied` for the newest comment of Ryan's. Null when not sent to that writer, or no advance.
 */
export function repliedDelivery(
  thread: ThreadData,
  writer: string,
  now: number,
): CommentDelivery | null {
  const target = thread.target;
  if (!target || target.writer !== writer) return null;
  const asked = [...thread.comments].reverse().find((comment) => comment.author.kind === 'device');
  if (!asked) return null;
  const current = thread.delivery?.commentId === asked.id ? thread.delivery : undefined;
  const replied = {
    state: 'replied' as const,
    commentId: asked.id,
    session: target.session,
    at: now,
  };
  return deliveryAdvances(current, replied) ? replied : null;
}

/** What a channel session receives (A772, A1063): `notifications/claude/channel`'s content and meta. */
export interface DeliveryPayload {
  readonly content: string;
  readonly meta: {
    readonly thread_id: string;
    readonly note_id: string;
    readonly comment_id: string;
  };
}

/** The message for one comment: who wrote it, on which note, the quote, then the comment. */
export function deliveryPayload(
  noteId: string,
  title: string,
  thread: ThreadData,
  comment: CommentData,
): DeliveryPayload {
  const lines = [`${comment.author.label} commented on the note “${title || 'Untitled'}”.`];
  if (thread.quote) {
    // A point keeps the line it is in as its quote, for context.
    const where = thread.anchor && !thread.anchor.to ? 'At a point in this text:' : 'On this text:';
    lines.push('', where, ...thread.quote.split('\n').map((line) => `> ${line}`));
  } else {
    lines.push('', 'The note as a whole.');
  }
  lines.push('', 'Comment:', comment.body);
  return {
    content: lines.join('\n'),
    meta: { thread_id: thread.id, note_id: noteId, comment_id: comment.id },
  };
}
