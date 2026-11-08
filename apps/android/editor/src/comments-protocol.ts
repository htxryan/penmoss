/**
 * The bridge messages for comment threads (T48, D40, A770–A784), beside `protocol.ts`: the page
 * owns the note's Yjs document and so its `comments` root; the app shows the Comments sheet
 * from what the page sends (`comments`) and asks the page for every change. Kotlin never reads
 * Yjs (A11), so a thread's anchor never leaves the page: the app sees its quote, its place in
 * the list, and whether it is orphaned.
 *
 * App → page:
 * - `commentAuthor`: who this phone writes as (review S5): its device actor's id and label, as
 *   the server names it, sent when the page is ready and whenever the account changes. New
 *   threads, replies and resolves carry it, so the server need not rewrite them (A781).
 * - `commentDraft`: start a new thread on the selection the selection menu captured
 *   (`selection`), at the caret (`caret`), or on the note as a whole (`note`, T52 item 5: Add
 *   Note Comment); the page answers `commentDraft` with its quote.
 * - `commentCreate`: write the draft's thread with its first comment, sent to `target` or not.
 * - `commentReply`, `commentEdit`, `commentDelete` (a thread's first comment is only marked
 *   removed, its replies kept, A784), `commentDeleteThread` (the only way a thread goes), `commentStatus` (resolve, reopen), `commentTarget` (Send to…, or
 *   null to stop sending) and `commentActive` (highlight one thread, and scroll to it).
 * - `commentSessions` (T60, A1077): the agent sessions the notebook's WorkspaceDoc lists, each
 *   with its last-seen time, read from the engine page by the app when the note's comments are
 *   shown. The page fails each delivery still waiting for a session gone (A1062).
 *
 * Page → app:
 * - `comments`: every thread in document order, orphans last, with the open count and the
 *   active thread, whenever any of it changes (here or synced from elsewhere).
 * - `commentOpen`: a highlighted passage or a point's marker was tapped.
 * - `commentDraft`: the new thread's quote and kind, for the sheet's composer.
 * - `commentSent` (T60, A1078): a thread was sent to an agent session just now (Send to…, or
 *   Ryan's comment on a thread already sent), its update posted before this: the app syncs the
 *   notebook at once.
 *
 * A thread's `kind` is `range`, `point`, or `note` (T52 item 5): on the note as a whole, with no
 * passage, listed first and never orphaned.
 */

import { MAX_COMMENT_CHARS } from '@penmoss/sync-client/comments';

export { MAX_COMMENT_CHARS };

/** A thread's or comment's id, as the server checks them (`COMMENT_ID`). */
export const COMMENT_ID = /^[0-9A-Za-z_-]{1,40}$/;
/** An agent clone's writer id (T54; a ULID), as a thread's target names it (A1060). */
export const WRITER_ID = /^[A-Za-z0-9_-]{1,80}$/;
/** A channel session's key: 24 hex digits of `sessionKey(writer, name)` (A1060). */
export const SESSION_KEY = /^[0-9a-f]{24}$/;
/** The longest target label kept: what Send to… showed for the session. */
export const MAX_TARGET_LABEL = 300;
/** At most this many sessions in one `commentSessions`. */
export const MAX_SESSIONS = 500;
/** A device's actor id, as the server makes it: `device:` and the device's id. */
export const DEVICE_ACTOR_ID = /^device:[A-Za-z0-9_-]{1,80}$/;
/** The longest device name kept for the phone's own comments. */
export const MAX_AUTHOR_LABEL = 300;

export const DRAFT_SOURCES = ['selection', 'caret', 'note'] as const;
export type DraftSource = (typeof DRAFT_SOURCES)[number];

/** Where a thread is: on a passage, at a point, or on the note as a whole (T52 item 5). */
export type ThreadKind = 'range' | 'point' | 'note';

export const THREAD_STATUSES = ['open', 'resolved'] as const;
export type ThreadStatusWire = (typeof THREAD_STATUSES)[number];

export const DELIVERY_STATES = ['waiting', 'sent', 'seen', 'replied', 'failed'] as const;
export type DeliveryStateWire = (typeof DELIVERY_STATES)[number];

/**
 * Why a delivery failed: the session has not been seen for a week (`gone`, A1062). `scope` and
 * `revoked` were the server's (a token's folder, a revoked token) and are only read.
 */
export const DELIVERY_FAILURES = ['gone', 'scope', 'revoked'] as const;
export type DeliveryFailureWire = (typeof DELIVERY_FAILURES)[number];

/** The agent session a thread is sent to (A1060): the agent's writer, the session, its label. */
export interface TargetWire {
  readonly writer: string;
  readonly session: string;
  readonly label: string;
}

/** Who wrote a comment, as the sheet names them: a person's device, or an agent. */
export interface AuthorView {
  readonly kind: 'device' | 'agent';
  readonly label: string;
}

export interface CommentView {
  readonly id: string;
  readonly author: AuthorView;
  /** Markdown, shown as written. */
  readonly body: string;
  /** Epoch ms, the writer's clock. */
  readonly at: number;
  readonly edited?: number;
  /** The thread's first comment, removed (A784): its body is empty and the sheet says so. */
  readonly removed?: true;
}

/** A thread as the sheet lists it. */
export interface ThreadView {
  readonly id: string;
  readonly status: ThreadStatusWire;
  readonly quote: string;
  /** Its text was deleted, or its block is gone: listed last, with its quote. */
  readonly orphaned: boolean;
  /** On a passage, at a point, or on the note as a whole (T52 item 5). */
  readonly kind: ThreadKind;
  readonly created: number;
  readonly author: AuthorView;
  readonly comments: readonly CommentView[];
  readonly target?: TargetWire;
  /** `reason` only with `failed`, when it is known why (`gone`, A1062). */
  readonly delivery?: {
    readonly state: DeliveryStateWire;
    readonly at: number;
    readonly reason?: DeliveryFailureWire;
  };
  readonly resolvedAt?: number;
  readonly resolvedBy?: AuthorView;
}

/**
 * Who this phone's comments are by (review S5): its device actor, as `/api/me` names it. About
 * no note in particular; the page keeps it for every note it opens.
 */
export interface CommentAuthorMessage {
  readonly v: 1;
  readonly type: 'commentAuthor';
  /** `device:` and the device's id. */
  readonly id: string;
  readonly label: string;
}

/** A session the WorkspaceDoc lists, as the gone check needs it (A1062, A1077). */
export interface SessionSeenWire {
  readonly key: string;
  /** Epoch ms. */
  readonly lastSeen: number;
}

/** Messages about comments, from the app to the page. */
export type CommentToEditor =
  | {
      readonly v: 1;
      readonly type: 'commentDraft';
      readonly noteId: string;
      readonly from: DraftSource;
    }
  | {
      readonly v: 1;
      readonly type: 'commentCreate';
      readonly noteId: string;
      readonly body: string;
      readonly target: TargetWire | null;
    }
  | {
      readonly v: 1;
      readonly type: 'commentReply';
      readonly noteId: string;
      readonly threadId: string;
      readonly body: string;
    }
  | {
      readonly v: 1;
      readonly type: 'commentEdit';
      readonly noteId: string;
      readonly threadId: string;
      readonly commentId: string;
      readonly body: string;
    }
  | {
      readonly v: 1;
      readonly type: 'commentDelete';
      readonly noteId: string;
      readonly threadId: string;
      readonly commentId: string;
    }
  | {
      readonly v: 1;
      readonly type: 'commentDeleteThread';
      readonly noteId: string;
      readonly threadId: string;
    }
  | {
      readonly v: 1;
      readonly type: 'commentStatus';
      readonly noteId: string;
      readonly threadId: string;
      readonly status: ThreadStatusWire;
    }
  | {
      readonly v: 1;
      readonly type: 'commentTarget';
      readonly noteId: string;
      readonly threadId: string;
      readonly target: TargetWire | null;
    }
  | {
      readonly v: 1;
      readonly type: 'commentActive';
      readonly noteId: string;
      readonly threadId: string | null;
      /** Scroll its passage into view too. */
      readonly reveal: boolean;
    }
  | {
      readonly v: 1;
      readonly type: 'commentSessions';
      readonly noteId: string;
      readonly sessions: readonly SessionSeenWire[];
    };

/** Messages about comments, from the page to the app. */
export type CommentFromEditor =
  | {
      readonly v: 1;
      readonly type: 'comments';
      readonly noteId: string;
      /** How many threads are open (the ⋮ menu's count). */
      readonly open: number;
      readonly active: string | null;
      readonly threads: readonly ThreadView[];
    }
  | {
      readonly v: 1;
      readonly type: 'commentOpen';
      readonly noteId: string;
      readonly threadId: string;
    }
  | {
      readonly v: 1;
      readonly type: 'commentDraft';
      readonly noteId: string;
      readonly quote: string;
      readonly kind: ThreadKind;
    }
  | {
      readonly v: 1;
      readonly type: 'commentSent';
      readonly noteId: string;
      readonly threadId: string;
    };

export const COMMENT_TO_EDITOR_TYPES: ReadonlySet<string> = new Set([
  'commentDraft',
  'commentCreate',
  'commentReply',
  'commentEdit',
  'commentDelete',
  'commentDeleteThread',
  'commentStatus',
  'commentTarget',
  'commentActive',
  'commentSessions',
]);

const isString = (value: unknown): value is string => typeof value === 'string';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const id = (value: unknown): value is string => isString(value) && COMMENT_ID.test(value);

/** A comment's text: something besides spaces, at most MAX_COMMENT_CHARS. */
const body = (value: unknown): value is string =>
  isString(value) && value.trim().length > 0 && value.length <= MAX_COMMENT_CHARS;

/** A target, null (no target), or undefined when malformed. */
function target(value: unknown): TargetWire | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const { writer, session, label } = value;
  if (!isString(writer) || !WRITER_ID.test(writer)) return undefined;
  if (!isString(session) || !SESSION_KEY.test(session)) return undefined;
  if (!isString(label) || !label.trim() || label.length > MAX_TARGET_LABEL) return undefined;
  return { writer, session, label };
}

/** The sessions of `commentSessions`, or null when any is malformed. */
function sessions(value: unknown): SessionSeenWire[] | null {
  if (!Array.isArray(value) || value.length > MAX_SESSIONS) return null;
  const out: SessionSeenWire[] = [];
  for (const each of value as unknown[]) {
    if (!isRecord(each)) return null;
    const { key, lastSeen } = each;
    if (!isString(key) || !SESSION_KEY.test(key)) return null;
    if (typeof lastSeen !== 'number' || !Number.isFinite(lastSeen) || lastSeen < 0) return null;
    out.push({ key, lastSeen });
  }
  return out;
}

/** Reads `commentAuthor` from the app; null when malformed. */
export function parseCommentAuthor(value: Record<string, unknown>): CommentAuthorMessage | null {
  const { id, label } = value;
  if (!isString(id) || !DEVICE_ACTOR_ID.test(id)) return null;
  if (!isString(label) || !label.trim() || label.length > MAX_AUTHOR_LABEL) return null;
  return { v: 1, type: 'commentAuthor', id, label };
}

/**
 * Reads a comment message from the app (its type is one of COMMENT_TO_EDITOR_TYPES and its
 * `noteId` already checked); null for anything malformed.
 */
export function parseCommentMessage(
  value: Record<string, unknown>,
  noteId: string,
): CommentToEditor | null {
  switch (value['type']) {
    case 'commentDraft': {
      const from = value['from'];
      if (!DRAFT_SOURCES.includes(from as DraftSource)) return null;
      return { v: 1, type: 'commentDraft', noteId, from: from as DraftSource };
    }
    case 'commentCreate': {
      const to = target(value['target']);
      if (!body(value['body']) || to === undefined) return null;
      return { v: 1, type: 'commentCreate', noteId, body: value['body'], target: to };
    }
    case 'commentReply': {
      const { threadId } = value;
      if (!id(threadId) || !body(value['body'])) return null;
      return { v: 1, type: 'commentReply', noteId, threadId, body: value['body'] };
    }
    case 'commentEdit': {
      const { threadId, commentId } = value;
      if (!id(threadId) || !id(commentId) || !body(value['body'])) return null;
      return { v: 1, type: 'commentEdit', noteId, threadId, commentId, body: value['body'] };
    }
    case 'commentDelete': {
      const { threadId, commentId } = value;
      if (!id(threadId) || !id(commentId)) return null;
      return { v: 1, type: 'commentDelete', noteId, threadId, commentId };
    }
    case 'commentDeleteThread': {
      const { threadId } = value;
      return id(threadId) ? { v: 1, type: 'commentDeleteThread', noteId, threadId } : null;
    }
    case 'commentStatus': {
      const { threadId, status } = value;
      if (!id(threadId) || !THREAD_STATUSES.includes(status as ThreadStatusWire)) return null;
      return { v: 1, type: 'commentStatus', noteId, threadId, status: status as ThreadStatusWire };
    }
    case 'commentTarget': {
      const { threadId } = value;
      const to = target(value['target']);
      if (!id(threadId) || to === undefined) return null;
      return { v: 1, type: 'commentTarget', noteId, threadId, target: to };
    }
    case 'commentActive': {
      const { threadId, reveal } = value;
      if (threadId !== null && !id(threadId)) return null;
      if (typeof reveal !== 'boolean') return null;
      return { v: 1, type: 'commentActive', noteId, threadId, reveal };
    }
    case 'commentSessions': {
      const listed = sessions(value['sessions']);
      return listed ? { v: 1, type: 'commentSessions', noteId, sessions: listed } : null;
    }
    default:
      return null;
  }
}
