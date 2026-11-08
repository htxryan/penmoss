/**
 * A note's comment threads in the web and Mac apps (T48, D40, A770–A777): read from the note's
 * own Yjs document and written there, offline included; the server syncs them like edits but
 * never treats one as an edit. The Comments panel (CommentsPanel.tsx) shows them; the editor
 * draws their passages (`@penmoss/editor`'s comments extension).
 */
import {
  addComment,
  createNoteThread,
  createThread,
  deleteComment,
  deleteThread,
  editComment,
  isNoteThread,
  NOTE_COMMENTS,
  orderThreads,
  readThread,
  readThreads,
  setThreadDelivery,
  setThreadStatus,
  setThreadTarget,
  type CommentAuthor,
  type CommentTarget,
  type PlacedThread,
  type ThreadData,
} from '@penmoss/sync-client/comments';
import { failGoneDeliveries, type AgentSession } from '@penmoss/sync-client/agent-sessions';
import type { Yjs14Replica } from '@penmoss/sync-client/yjs14';
import type { SelectionAnchor } from '@penmoss/editor';
import { ulid } from '@penmoss/core';
import { useEffect, useState } from 'react';

/** How long a change to the body waits before the list is placed again (typing moves anchors). */
const BODY_SETTLE_MS = 400;

/** The note's threads, in document order (orphans last), kept current. */
export function useThreads(replica: Yjs14Replica | null): readonly PlacedThread[] {
  const [threads, setThreads] = useState<readonly PlacedThread[]>([]);
  useEffect(() => {
    if (!replica) {
      setThreads([]);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      timer = null;
      const next = orderThreads(replica.doc, readThreads(replica.doc));
      // No threads before or after: the same list, so nothing renders or redecorates again.
      setThreads((previous) => (previous.length === 0 && next.length === 0 ? previous : next));
    };
    read();
    const off = replica.onUpdate((_update, _origin, info) => {
      if (info?.commentsOnly) {
        if (timer) clearTimeout(timer);
        read();
        return;
      }
      // Typing in a note without threads places nothing.
      if (replica.doc.get(NOTE_COMMENTS).attrSize === 0) return;
      timer ??= setTimeout(read, BODY_SETTLE_MS);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [replica]);
  return threads;
}

export { deviceAuthor } from './comment-author';

/** What the thread says about where its delivery stands (A1061, A1062). */
export function deliveryText(thread: ThreadData): string | null {
  const target = thread.target;
  if (!target) return null;
  const label = target.label;
  switch (thread.delivery?.state) {
    case undefined:
      return `Sending to ${label}…`;
    case 'waiting':
      return `Waiting for ${label}`;
    case 'sent':
      return `Sent to ${label}`;
    case 'seen':
      return 'Seen';
    case 'replied':
      return 'Replied';
    case 'failed':
      // `scope` and `revoked` were the server's (A785); they are still read.
      return thread.delivery.reason === 'gone'
        ? 'Not sent: the session is gone'
        : thread.delivery.reason === 'scope'
          ? `Not sent: ${label} can’t see this note`
          : thread.delivery.reason === 'revoked'
            ? `Not sent: ${label}’s token was revoked`
            : `Not sent to ${label}`;
  }
}

/** The target Send to… writes for a session (A1060). */
export const targetOf = (session: AgentSession): CommentTarget => ({
  writer: session.writer,
  session: session.key,
  label: session.label,
});

/** The newest comment Ryan wrote in a thread (what a delivery delivers, A1061); null: none. */
export function newestByRyan(thread: ThreadData): string | null {
  for (let i = thread.comments.length - 1; i >= 0; i--) {
    const comment = thread.comments[i]!;
    if (comment.author.kind === 'device' && !comment.removed) return comment.id;
  }
  return null;
}

/**
 * The thread waits for its target to get Ryan's newest comment (A1061): written at Send to and
 * for each comment he adds to a targeted thread. False when there is nothing to send.
 */
export function markWaiting(replica: Yjs14Replica, threadId: string, at = Date.now()): boolean {
  const thread = readThread(replica.doc, threadId);
  const commentId = thread ? newestByRyan(thread) : null;
  if (!thread?.target || !commentId) return false;
  setThreadDelivery(replica.doc, threadId, {
    state: 'waiting',
    commentId,
    session: thread.target.session,
    at,
  });
  return true;
}

/**
 * Send to… (A1065): sends the thread to an agent session, waiting for Ryan's newest comment, or
 * stops sending it (null). True when the thread now waits, so the notebook should sync at once.
 */
export function sendTo(
  replica: Yjs14Replica,
  threadId: string,
  target: CommentTarget | null,
  at = Date.now(),
): boolean {
  setThreadTarget(replica.doc, threadId, target);
  return target ? markWaiting(replica, threadId, at) : false;
}

/** Whether Ryan may change a comment's text: his own, written on any of his devices. */
export const canEdit = (author: CommentAuthor): boolean => author.kind === 'device';

/** Starts a thread on what `anchor` describes; its id. */
export function startThread(
  replica: Yjs14Replica,
  anchor: SelectionAnchor,
  body: string,
  author: CommentAuthor,
  target: CommentTarget | null,
): string {
  const id = ulid();
  createThread(replica.doc, {
    id,
    anchor: anchor.anchor,
    quote: anchor.quote,
    author,
    at: Date.now(),
    comment: { id: ulid(), body },
    ...(target ? { target } : {}),
  });
  if (target) markWaiting(replica, id);
  return id;
}

/** Starts a thread on the note as a whole (T52 item 5): no passage, listed first; its id. */
export function startNoteThread(
  replica: Yjs14Replica,
  body: string,
  author: CommentAuthor,
  target: CommentTarget | null,
): string {
  const id = ulid();
  createNoteThread(replica.doc, {
    id,
    author,
    at: Date.now(),
    comment: { id: ulid(), body },
    ...(target ? { target } : {}),
  });
  if (target) markWaiting(replica, id);
  return id;
}

/**
 * Whether a thread opens floating over the note at its passage (T52 item 5): one with a place in
 * the text. A thread on the note as a whole, or one whose text was deleted, opens in the list.
 */
export const floats = (placed: PlacedThread): boolean =>
  !isNoteThread(placed.thread) && !placed.anchor.orphaned;

/** Adds Ryan's reply; true when the thread is sent to an agent session and now waits for it. */
export function reply(
  replica: Yjs14Replica,
  threadId: string,
  body: string,
  author: CommentAuthor,
): boolean {
  if (!addComment(replica.doc, threadId, { id: ulid(), author, body, at: Date.now() })) {
    return false;
  }
  return author.kind === 'device' && markWaiting(replica, threadId);
}

export function resolve(
  replica: Yjs14Replica,
  threadId: string,
  open: boolean,
  author: CommentAuthor,
): void {
  setThreadStatus(replica.doc, threadId, open ? 'open' : 'resolved', author, Date.now());
}

export function edit(replica: Yjs14Replica, threadId: string, commentId: string, body: string) {
  editComment(replica.doc, threadId, commentId, body, Date.now());
}

/**
 * Removes a comment (an agent's, as its undo, or one of Ryan's). The thread's first comment is
 * only marked removed, so its replies stay (A784).
 */
export function remove(replica: Yjs14Replica, threadId: string, commentId: string) {
  deleteComment(replica.doc, threadId, commentId);
}

/** Deletes a thread and all its comments, on every device (the panel asks first). */
export function removeThread(replica: Yjs14Replica, threadId: string) {
  deleteThread(replica.doc, threadId);
}

/**
 * Whether a comment has its own Remove or Delete: a reply always; the first comment only while
 * replies follow it (alone, it is the thread, which Delete thread removes), and not once removed.
 */
export function canRemove(thread: ThreadData, index: number): boolean {
  const comment = thread.comments[index];
  if (!comment || comment.removed) return false;
  return index > 0 || thread.comments.length > 1;
}

/**
 * The threads the editor draws: the open ones, and the one picked even when resolved. Threads on
 * the note as a whole have no passage, so no marker either (T52 item 5).
 */
export function shownInNote(
  threads: readonly PlacedThread[],
  active: string | null,
): Array<Pick<ThreadData, 'id' | 'anchor'>> {
  return threads
    .filter((placed) => !isNoteThread(placed.thread))
    .filter((placed) => placed.thread.status === 'open' || placed.thread.id === active)
    .map((placed) => ({ id: placed.thread.id, anchor: placed.thread.anchor }));
}

/** What `useGoneDeliveries` reads of a notebook's folders service (its WorkspaceDoc). */
export interface SessionsSource {
  readonly doc: Yjs14Replica['doc'];
  getState(): { readonly loaded: boolean };
  subscribe(listener: () => void): () => void;
}

/**
 * When a note is shown (A1062): each of its threads still waiting for a session not seen for a
 * week, or no longer listed, fails as `gone`. Only once the notebook's WorkspaceDoc is loaded, so
 * a session is never taken for gone before its entry is read.
 */
export function useGoneDeliveries(replica: Yjs14Replica | null, sessions: SessionsSource | null) {
  useEffect(() => {
    if (!replica || !sessions) return;
    let done = false;
    const check = () => {
      if (done || !sessions.getState().loaded) return;
      done = true;
      failGoneDeliveries(replica.doc, sessions.doc, Date.now());
    };
    const off = sessions.subscribe(check);
    check();
    return off;
  }, [replica, sessions]);
}
