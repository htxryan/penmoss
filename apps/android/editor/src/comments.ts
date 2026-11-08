/**
 * Comment threads on the phone (T48, D40, A770–A784): the page's side of the Comments sheet.
 * Threads live in the open note's own Yjs document (`@penmoss/sync-client/comments`), which only
 * the page reads, so every change the sheet asks for is written here, offline included, and
 * reaches the app as an ordinary `update` to store and upload. Comments are not edits (A770):
 * they leave the offline index's text alone.
 *
 * The page sends the app the threads as the sheet lists them (`comments`, document order,
 * orphans last) whenever they change here or arrive from elsewhere, draws the open ones (and the
 * active one) in the note with the editor's highlights, and says when one is tapped
 * (`commentOpen`). A new thread is made in two steps, as the web's panel does: its place (the
 * selection, or the caret) is taken first (`commentDraft`), so the sheet can show its quote while
 * Ryan writes, then the thread is written with its first comment (`commentCreate`).
 *
 * Send to… (T60, D50, A1061): the page writes a thread's target and `delivery {state: waiting,
 * commentId}` for Ryan's newest comment, again for each comment he adds to a thread already sent,
 * and then says so (`commentSent`, its update flushed first) so the app syncs the notebook at
 * once. The agent's own clone writes `sent`, `seen` and `replied`. A delivery still waiting for a
 * session the WorkspaceDoc no longer shows as seen this week fails as `gone` when the app lists
 * the sessions (`commentSessions`, A1062).
 */
import { failGoneDeliveriesSeen } from '@penmoss/sync-client/agent-sessions';
import { ulid } from '@penmoss/core/ids';
import {
  COMMENT_ADD_EVENT,
  COMMENT_OPEN_EVENT,
  revealThread,
  selectionAnchor,
  showCommentThreads,
  type SelectionAnchor,
  type ShownThread,
} from '@penmoss/editor';
import {
  addComment,
  createNoteThread,
  createThread,
  deleteComment,
  deleteThread,
  editComment,
  isNoteThread,
  MAX_COMMENTS_PER_THREAD,
  MAX_THREADS,
  orderThreads,
  readThread,
  readThreads,
  setThreadDelivery,
  setThreadStatus,
  setThreadTarget,
  type CommentAuthor,
  type CommentDelivery,
  type CommentTarget,
  type ThreadData,
} from '@penmoss/sync-client/comments';
import type { Yjs14Replica } from '@penmoss/sync-client/yjs14';
import type { Editor } from '@tiptap/core';
import {
  COMMENT_ID,
  type AuthorView,
  type CommentFromEditor,
  type CommentToEditor,
  type CommentView,
  type DraftSource,
  type ThreadView,
} from './comments-protocol';

/**
 * Who writes from the phone until the app says (`commentAuthor`, review S5). The server puts a
 * comment a device wrote under that device's own actor and label (A781), so a comment written
 * before the app said reads "You" until it syncs, as on the web.
 */
export const PHONE_AUTHOR: CommentAuthor = {
  id: 'device:this-device',
  kind: 'device',
  label: 'You',
};

/** How long a change to the body waits before the list is placed again (typing moves anchors). */
export const BODY_SETTLE_MS = 400;

/** What the page says when a comment cannot be written. */
export const COMMENT_READ_ONLY = "This note can't be changed here.";
export const COMMENT_NO_PLACE = 'Put the caret in the note, or select some text, to comment on it.';
export const COMMENT_NO_DRAFT =
  'Choose where the comment goes first: select text, or tap in the note.';
export const COMMENT_GONE = 'That comment is no longer in the note.';
export const COMMENT_TOO_MANY_THREADS = `A note holds at most ${MAX_THREADS} comment threads.`;
export const COMMENT_TOO_MANY_REPLIES = `A thread holds at most ${MAX_COMMENTS_PER_THREAD} comments.`;
export const COMMENT_NOT_YOURS = 'Only your own comments can be edited.';

export interface CommentServices {
  /** Posts a message to the app. */
  readonly post: (message: CommentFromEditor) => void;
  readonly notice: (message: string) => void;
  /** Whether the note may be changed now. */
  readonly editable: () => boolean;
  /**
   * Puts back the body selection the selection menu kept (review B2), once; false when none
   * was kept. The WebView clears the selection as its menu closes.
   */
  readonly restoreCaptured: () => boolean;
  readonly now: () => number;
  /** Who this phone writes as: the app's `commentAuthor`, or PHONE_AUTHOR before it has said. */
  readonly author: () => CommentAuthor;
  /**
   * Posts the note's unsent edits to the app now (T60, A1078): before `commentSent`, so the app
   * has stored the target and `waiting` when it syncs.
   */
  readonly flush: () => void;
}

/** Ryan's newest comment in a thread, the one a delivery is for (A1061); null for none. */
export function newestOwnComment(thread: ThreadData): string | null {
  for (let at = thread.comments.length - 1; at >= 0; at--) {
    const comment = thread.comments[at]!;
    if (comment.author.kind === 'device' && !comment.removed) return comment.id;
  }
  return null;
}

const authorView = (author: CommentAuthor): AuthorView => ({
  kind: author.kind,
  label: author.label,
});

function threadView(thread: ThreadData, orphaned: boolean): ThreadView {
  // On the note as a whole (T52 item 5): no passage, so never orphaned.
  const note = isNoteThread(thread);
  const comments: CommentView[] = thread.comments
    .filter((comment) => COMMENT_ID.test(comment.id))
    .map((comment) => ({
      id: comment.id,
      author: authorView(comment.author),
      body: comment.body,
      at: comment.at,
      ...(comment.edited !== undefined ? { edited: comment.edited } : {}),
      ...(comment.removed ? { removed: true as const } : {}),
    }));
  return {
    id: thread.id,
    status: thread.status,
    quote: thread.quote,
    orphaned: note ? false : orphaned,
    kind: note ? 'note' : thread.anchor?.to ? 'range' : 'point',
    created: thread.created,
    author: authorView(thread.author),
    comments,
    ...(thread.target ? { target: { ...thread.target } } : {}),
    ...(thread.delivery ? { delivery: deliveryView(thread.delivery) } : {}),
    ...(thread.resolvedAt !== undefined ? { resolvedAt: thread.resolvedAt } : {}),
    ...(thread.resolvedBy ? { resolvedBy: authorView(thread.resolvedBy) } : {}),
  };
}

/** Where delivery stands, as the sheet shows it: why it failed, when the server said. */
function deliveryView(delivery: CommentDelivery): NonNullable<ThreadView['delivery']> {
  const { state, at, reason } = delivery;
  return { state, at, ...(state === 'failed' && reason ? { reason } : {}) };
}

/** A draft on the note as a whole (T52 item 5), with no passage. */
const WHOLE_NOTE = 'note' as const;

/** One open note's threads, for the Comments sheet. */
export class NoteComments {
  /** The thread the sheet has open: highlighted in the note. */
  private active: string | null = null;
  /** Where the next thread goes, taken by `commentDraft`: a passage or point, or the whole note. */
  private draft: SelectionAnchor | typeof WHOLE_NOTE | null = null;
  private lastSent = '';
  private lastShown = '';
  private bodyTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduled = false;
  private destroyed = false;
  private readonly offs: Array<() => void> = [];

  constructor(
    private readonly noteId: string,
    private readonly replica: Yjs14Replica,
    private readonly editor: Editor,
    private readonly services: CommentServices,
  ) {
    const dom = editor.view.dom;
    const opened = (event: Event) => {
      const threadId = (event as CustomEvent<{ threadId?: unknown }>).detail?.threadId;
      if (typeof threadId !== 'string' || !COMMENT_ID.test(threadId)) return;
      this.setActive(threadId, false);
      this.services.post({ v: 1, type: 'commentOpen', noteId: this.noteId, threadId });
    };
    // A hardware keyboard's Comment key, or the editor's own toolbar: a thread on the selection.
    const add = () => this.startDraft('caret');
    dom.addEventListener(COMMENT_OPEN_EVENT, opened);
    dom.addEventListener(COMMENT_ADD_EVENT, add);
    this.offs.push(() => {
      dom.removeEventListener(COMMENT_OPEN_EVENT, opened);
      dom.removeEventListener(COMMENT_ADD_EVENT, add);
    });
  }

  /** Lists the threads for the first time, once the note has opened. */
  start(): void {
    this.push();
  }

  /** The note changed: the comments alone (listed now) or its body (listed once typing settles). */
  changed(commentsOnly: boolean): void {
    if (this.destroyed) return;
    if (commentsOnly) {
      this.schedule();
      return;
    }
    this.bodyTimer ??= setTimeout(() => {
      this.bodyTimer = null;
      this.push();
    }, BODY_SETTLE_MS);
  }

  handle(message: CommentToEditor): void {
    if (this.destroyed || message.noteId !== this.noteId) return;
    if (message.type === 'commentActive') {
      this.setActive(message.threadId, message.reveal);
      return;
    }
    if (message.type === 'commentSessions') {
      // Said by the app, not asked by Ryan: a read-only note is left as it is, with no notice.
      if (!this.services.editable()) return;
      const seen = new Map(message.sessions.map((each) => [each.key, each.lastSeen]));
      failGoneDeliveriesSeen(this.replica.doc, (key) => seen.get(key) ?? null, this.services.now());
      return;
    }
    if (!this.services.editable()) {
      this.services.notice(COMMENT_READ_ONLY);
      return;
    }
    const doc = this.replica.doc;
    const now = this.services.now();
    const author = this.services.author();
    switch (message.type) {
      case 'commentDraft':
        this.startDraft(message.from);
        return;
      case 'commentCreate': {
        const draft = this.draft;
        if (!draft) {
          this.services.notice(COMMENT_NO_DRAFT);
          return;
        }
        if (readThreads(doc).length >= MAX_THREADS) {
          this.services.notice(COMMENT_TOO_MANY_THREADS);
          return;
        }
        const id = ulid(now);
        const target = message.target;
        const first = {
          id,
          author,
          at: now,
          comment: { id: ulid(now), body: message.body },
          ...(target ? { target } : {}),
        };
        // One update: the thread, and where its delivery stands.
        doc.transact(() => {
          if (draft === WHOLE_NOTE) createNoteThread(doc, first);
          else createThread(doc, { ...first, anchor: draft.anchor, quote: draft.quote });
          if (target) this.waitFor(id, target, now);
        });
        this.draft = null;
        this.setActive(id, false);
        if (target) this.sent(id);
        return;
      }
      case 'commentReply': {
        const thread = readThread(doc, message.threadId);
        if (!thread) {
          this.services.notice(COMMENT_GONE);
          return;
        }
        if (thread.comments.length >= MAX_COMMENTS_PER_THREAD) {
          this.services.notice(COMMENT_TOO_MANY_REPLIES);
          return;
        }
        // Ryan's comment on a thread already sent goes to the same session (A1061).
        const target =
          thread.status === 'open' && author.kind === 'device' ? thread.target : undefined;
        doc.transact(() => {
          addComment(doc, message.threadId, {
            id: ulid(now),
            author,
            body: message.body,
            at: now,
          });
          if (target) this.waitFor(message.threadId, target, now);
        });
        if (target) this.sent(message.threadId);
        return;
      }
      case 'commentEdit': {
        const comment = readThread(doc, message.threadId)?.comments.find(
          (each) => each.id === message.commentId,
        );
        // A removed first comment (A784) has no text to change.
        if (!comment || comment.removed) {
          this.services.notice(COMMENT_GONE);
          return;
        }
        // Ryan's own, from any of his devices; an agent's comment is removed, never rewritten.
        if (comment.author.kind !== 'device') {
          this.services.notice(COMMENT_NOT_YOURS);
          return;
        }
        editComment(doc, message.threadId, message.commentId, message.body, now);
        return;
      }
      case 'commentDelete':
        // A thread's first comment is only marked removed, its replies kept (A784).
        if (!deleteComment(doc, message.threadId, message.commentId)) {
          this.services.notice(COMMENT_GONE);
        }
        return;
      case 'commentDeleteThread':
        // The only way a thread goes: the sheet asks first.
        deleteThread(doc, message.threadId);
        return;
      case 'commentStatus':
        setThreadStatus(doc, message.threadId, message.status, author, now);
        return;
      case 'commentTarget': {
        const target = message.target;
        if (!readThread(doc, message.threadId)) {
          this.services.notice(COMMENT_GONE);
          return;
        }
        // Stop sending (null) drops the delivery with the target.
        let waiting = false;
        doc.transact(() => {
          setThreadTarget(doc, message.threadId, target);
          if (target) waiting = this.waitFor(message.threadId, target, now);
        });
        if (waiting) this.sent(message.threadId);
        return;
      }
    }
  }

  /**
   * Writes `waiting` for Ryan's newest comment (A1061); false when nothing changed: the delivery
   * already stands for that comment and session (a Send to the same session again), or he has no
   * comment in the thread. A failed one (`gone`) is written again: Send to again.
   */
  private waitFor(threadId: string, target: CommentTarget, now: number): boolean {
    const doc = this.replica.doc;
    const thread = readThread(doc, threadId);
    const commentId = thread ? newestOwnComment(thread) : null;
    if (!thread || !commentId) return false;
    const current = thread.delivery;
    if (
      current &&
      current.state !== 'failed' &&
      current.commentId === commentId &&
      current.session === target.session
    ) {
      return false;
    }
    return setThreadDelivery(doc, threadId, {
      state: 'waiting',
      commentId,
      session: target.session,
      at: now,
    });
  }

  /** The thread is waiting for its session: its update goes to the app first, then the word. */
  private sent(threadId: string): void {
    this.services.flush();
    this.services.post({ v: 1, type: 'commentSent', noteId: this.noteId, threadId });
  }

  destroy(): void {
    this.destroyed = true;
    if (this.bodyTimer !== null) clearTimeout(this.bodyTimer);
    this.bodyTimer = null;
    for (const off of this.offs.splice(0)) off();
  }

  /** The thread the sheet has open, for tests. */
  get activeThread(): string | null {
    return this.active;
  }

  /** Takes the new thread's place and tells the app its quote. */
  private startDraft(from: DraftSource): void {
    if (!this.services.editable()) {
      this.services.notice(COMMENT_READ_ONLY);
      return;
    }
    // Add Note Comment (T52 item 5): no passage to take.
    if (from === 'note') {
      this.draft = WHOLE_NOTE;
      this.services.post({
        v: 1,
        type: 'commentDraft',
        noteId: this.noteId,
        quote: '',
        kind: 'note',
      });
      return;
    }
    // The selection the menu kept, put back first: the WebView cleared it as the menu closed.
    if (from === 'selection') this.services.restoreCaptured();
    const anchor = this.editor.isDestroyed ? null : selectionAnchor(this.editor.state);
    if (!anchor) {
      this.services.notice(COMMENT_NO_PLACE);
      return;
    }
    this.draft = anchor;
    this.services.post({
      v: 1,
      type: 'commentDraft',
      noteId: this.noteId,
      quote: anchor.quote,
      kind: anchor.kind,
    });
  }

  private setActive(threadId: string | null, reveal: boolean): void {
    this.active = threadId;
    this.push();
    if (threadId && reveal && !this.editor.isDestroyed) revealThread(this.editor, threadId);
  }

  /** Lists the threads soon: never inside the Yjs update (or the editor's dispatch) that changed them. */
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.push();
    });
  }

  /** Sends the threads when they changed, and draws the open ones (and the active one). */
  private push(): void {
    if (this.destroyed) return;
    const doc = this.replica.doc;
    const placed = orderThreads(doc, readThreads(doc)).filter((each) =>
      COMMENT_ID.test(each.thread.id),
    );
    if (this.active && !placed.some((each) => each.thread.id === this.active)) this.active = null;
    const threads = placed.map((each) => threadView(each.thread, each.anchor.orphaned));
    const message: CommentFromEditor = {
      v: 1,
      type: 'comments',
      noteId: this.noteId,
      open: threads.filter((thread) => thread.status === 'open').length,
      active: this.active,
      threads,
    };
    const key = JSON.stringify(message);
    if (key !== this.lastSent) {
      this.lastSent = key;
      this.services.post(message);
    }
    const shown: ShownThread[] = placed
      // A thread on the note as a whole has no passage to mark (T52 item 5).
      .filter((each) => !isNoteThread(each.thread))
      .filter((each) => each.thread.status === 'open' || each.thread.id === this.active)
      .map((each) => ({ id: each.thread.id, anchor: each.thread.anchor }));
    const shownKey = JSON.stringify([shown, this.active]);
    if (shownKey !== this.lastShown && !this.editor.isDestroyed) {
      this.lastShown = shownKey;
      showCommentThreads(this.editor, shown, this.active);
    }
  }
}
