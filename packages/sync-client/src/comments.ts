/**
 * Comment threads (T48, D40, A770, A771): a top-level `comments` root in the note's own Yjs
 * document, beside the body, title and meta. They sync, work offline and are attributed like
 * edits, but nothing that renders a note reads them: the markdown codec, the git mirror, the
 * search index and `.md` files never see them, and version restore and revert touch only the
 * body, title and tags (`history.ts`).
 *
 * - `comments`: threadId → a thread node, its fields as attributes (`anchor`, `quote`,
 *   `status`, `created`, `author`, and `target`, `delivery`, `resolvedAt`, `resolvedBy` when
 *   set), its comments as child nodes in the order they were written (`id`, `author`, `body`,
 *   `at`, `edited`). A thread's fields merge independently, and two replies written at once
 *   both land.
 *
 * Anchors (A771) are Yjs relative positions in the body (`prosemirror`), kept as JSON: one for a
 * point, two for a range, the first bound to the quote's first character and the second to its
 * last, so text typed just outside never joins it. They are made and read through delta
 * positions (paths into the body's tree), the same on the server and in the editor. A range
 * whose text is all deleted, or an anchor whose block is gone, orphans its thread, which keeps
 * its quote.
 */
import * as Y from '@y/y';
import { NOTE_ROOT } from './replica';
import { linkLabel, type LinkRef } from '@penmoss/core/links';
import { formatWikiReference } from '@penmoss/core/wikilinks';
import { findAnchorText, type AnchorFound } from '@penmoss/core/anchor-match';

export const NOTE_COMMENTS = 'comments';

/** The longest comment body kept, in UTF-16 code units (about 20 KB of English). */
export const MAX_COMMENT_CHARS = 20_000;
/** The longest quote kept with a thread; longer selections keep their start and an ellipsis. */
export const MAX_QUOTE_CHARS = 2_000;
/** At most this many threads in one note, and comments in one thread (the NoteDoc's size). */
export const MAX_THREADS = 500;
export const MAX_COMMENTS_PER_THREAD = 200;

export type ThreadStatus = 'open' | 'resolved';

/** Who wrote a comment: the writer's actor (A3), as the apps label edits. */
export interface CommentAuthor {
  readonly id: string;
  readonly kind: 'device' | 'agent';
  readonly label: string;
}

/** A Yjs relative position as `Y.relativePositionToJSON` writes it. */
export interface RelativePositionJson {
  readonly type?: { readonly client: number; readonly clock: number };
  readonly tname?: string;
  readonly item?: { readonly client: number; readonly clock: number };
  readonly assoc?: number;
}

/** A point (`to` null) or a range, in the body. */
export interface CommentAnchor {
  readonly from: RelativePositionJson;
  readonly to: RelativePositionJson | null;
}

/**
 * The agent session a thread is sent to (A774, A1060): the agent clone's writer and one of its
 * channel sessions (`sessionKey(writer, name)` in `agent-sessions`).
 */
export interface CommentTarget {
  readonly writer: string;
  readonly session: string;
  /** What the picker showed, so every device can say "waiting for …" without asking. */
  readonly label: string;
}

/**
 * Where delivery of a thread's newest comment to its target stands (A774). `failed`: it will not
 * be delivered, and `reason` says why (A785).
 */
export type DeliveryState = 'waiting' | 'sent' | 'seen' | 'replied' | 'failed';

/**
 * Why a delivery failed: the session has not been seen for GONE_MS (`gone`, A1062). `scope` and
 * `revoked` were the server's (a token's folder scope, a revoked token) and are only read.
 */
export type DeliveryFailure = 'gone' | 'scope' | 'revoked';

export interface CommentDelivery {
  readonly state: DeliveryState;
  readonly commentId: string;
  readonly session: string;
  readonly at: number;
  readonly reason?: DeliveryFailure;
}

export interface CommentData {
  readonly id: string;
  readonly author: CommentAuthor;
  /** Markdown. */
  readonly body: string;
  /** Epoch ms, the writer's clock. */
  readonly at: number;
  readonly edited?: number;
  /**
   * The thread's first comment, removed (A784): its text is gone, its replies stay. A thread's
   * first comment is never deleted on its own; deleting the thread is its own action.
   */
  readonly removed?: true;
}

/**
 * What a thread's place looked like when it was made (T52 item 5): for an agent to understand
 * where it is, and for finding it again by its text when its anchor is lost (`locateThreads`).
 */
export interface AnchorContext {
  /** Up to `CONTEXT_CHARS` of the note's visible text just before the passage (or point). */
  readonly prefix: string;
  /** And just after it. */
  readonly suffix: string;
  /** The headings it sits under, outermost first (`## Plans` under `# Garden`: both). */
  readonly headings: readonly string[];
  /** Its block of text: which one it is in the note (1st, 2nd…), and the start of its text. */
  readonly block: { readonly ordinal: number; readonly text: string };
}

/**
 * `note`: a thread on the note as a whole (T52 item 5), with no passage. Its anchor is a point
 * at the note's start, so apps from before T52 show it as before; those apps list it among the
 * others, and these first.
 */
export type ThreadScope = 'note';

export interface ThreadData {
  readonly id: string;
  readonly anchor: CommentAnchor | null;
  readonly quote: string;
  readonly scope?: ThreadScope;
  /** Where it was when it was made (threads from before T52 have none). */
  readonly context?: AnchorContext;
  readonly status: ThreadStatus;
  readonly created: number;
  readonly author: CommentAuthor;
  readonly target?: CommentTarget;
  readonly delivery?: CommentDelivery;
  readonly resolvedAt?: number;
  readonly resolvedBy?: CommentAuthor;
  readonly comments: readonly CommentData[];
}

// --- reading ---

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function authorOf(value: unknown): CommentAuthor | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, kind, label } = value as Record<string, unknown>;
  if (typeof id !== 'string' || (kind !== 'device' && kind !== 'agent')) return null;
  return { id, kind, label: typeof label === 'string' ? label : id };
}

function positionOf(value: unknown): RelativePositionJson | null {
  if (typeof value !== 'object' || value === null) return null;
  const { type, tname, item, assoc } = value as Record<string, unknown>;
  const id = (v: unknown) =>
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { client?: unknown }).client === 'number' &&
    typeof (v as { clock?: unknown }).clock === 'number'
      ? { client: (v as { client: number }).client, clock: (v as { clock: number }).clock }
      : undefined;
  const out: { -readonly [K in keyof RelativePositionJson]: RelativePositionJson[K] } = {};
  const t = id(type);
  const i = id(item);
  if (t) out.type = t;
  if (typeof tname === 'string') out.tname = tname;
  if (i) out.item = i;
  if (typeof assoc === 'number') out.assoc = assoc;
  return out.type || out.tname ? out : null;
}

function anchorOf(value: unknown): CommentAnchor | null {
  if (typeof value !== 'object' || value === null) return null;
  const { from, to } = value as Record<string, unknown>;
  const start = positionOf(from);
  if (!start) return null;
  return { from: start, to: to == null ? null : positionOf(to) };
}

function targetOf(value: unknown): CommentTarget | null {
  if (typeof value !== 'object' || value === null) return null;
  // A target from the server's time names a token, not a writer: it can no longer be delivered.
  const { writer, session, label } = value as Record<string, unknown>;
  if (typeof writer !== 'string' || typeof session !== 'string') return null;
  return { writer, session, label: typeof label === 'string' ? label : session };
}

const DELIVERY_STATES: readonly DeliveryState[] = ['waiting', 'sent', 'seen', 'replied', 'failed'];

function deliveryOf(value: unknown): CommentDelivery | null {
  if (typeof value !== 'object' || value === null) return null;
  const { state, commentId, session, at, reason } = value as Record<string, unknown>;
  if (!DELIVERY_STATES.includes(state as DeliveryState)) return null;
  if (typeof commentId !== 'string' || typeof session !== 'string') return null;
  return {
    state: state as DeliveryState,
    commentId,
    session,
    at: num(at) ?? 0,
    ...(reason === 'gone' || reason === 'scope' || reason === 'revoked' ? { reason } : {}),
  };
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : [];

function contextOf(value: unknown): AnchorContext | null {
  if (typeof value !== 'object' || value === null) return null;
  const { prefix, suffix, headings, block } = value as Record<string, unknown>;
  const { ordinal, text } = (typeof block === 'object' && block !== null ? block : {}) as Record<
    string,
    unknown
  >;
  return {
    prefix: str(prefix) ?? '',
    suffix: str(suffix) ?? '',
    headings: strings(headings),
    block: { ordinal: num(ordinal) ?? 0, text: str(text) ?? '' },
  };
}

function commentOf(node: Y.Node): CommentData | null {
  const id = str(node.getAttr('id'));
  const author = authorOf(node.getAttr('author'));
  if (!id || !author) return null;
  const edited = num(node.getAttr('edited'));
  const removed = node.getAttr('removed') === true;
  return {
    id,
    author,
    body: removed ? '' : (str(node.getAttr('body')) ?? ''),
    at: num(node.getAttr('at')) ?? 0,
    ...(edited !== null ? { edited } : {}),
    ...(removed ? { removed: true as const } : {}),
  };
}

function threadOf(id: string, node: Y.Node): ThreadData | null {
  const author = authorOf(node.getAttr('author'));
  if (!author) return null;
  const comments: CommentData[] = [];
  for (const child of node.toArray()) {
    if (!(child instanceof Y.Node)) continue;
    const comment = commentOf(child);
    if (comment) comments.push(comment);
  }
  const target = targetOf(node.getAttr('target'));
  const delivery = deliveryOf(node.getAttr('delivery'));
  const resolvedAt = num(node.getAttr('resolvedAt'));
  const resolvedBy = authorOf(node.getAttr('resolvedBy'));
  const context = contextOf(node.getAttr('context'));
  return {
    id,
    anchor: anchorOf(node.getAttr('anchor')),
    quote: str(node.getAttr('quote')) ?? '',
    ...(node.getAttr('scope') === 'note' ? { scope: 'note' as const } : {}),
    ...(context ? { context } : {}),
    status: node.getAttr('status') === 'resolved' ? 'resolved' : 'open',
    created: num(node.getAttr('created')) ?? 0,
    author,
    ...(target ? { target } : {}),
    ...(delivery ? { delivery } : {}),
    ...(resolvedAt !== null ? { resolvedAt } : {}),
    ...(resolvedBy ? { resolvedBy } : {}),
    comments,
  };
}

function threadNode(doc: Y.Doc, id: string): Y.Node | null {
  const value: unknown = doc.get(NOTE_COMMENTS).getAttr(id);
  return value instanceof Y.Node ? value : null;
}

/** Every thread, in no particular order (`orderThreads` sorts them as the panel lists them). */
export function readThreads(doc: Y.Doc): ThreadData[] {
  const threads: ThreadData[] = [];
  for (const [id, value] of doc.get(NOTE_COMMENTS).attrEntries()) {
    if (!(value instanceof Y.Node)) continue;
    const thread = threadOf(String(id), value);
    if (thread) threads.push(thread);
  }
  return threads;
}

export function readThread(doc: Y.Doc, id: string): ThreadData | null {
  const node = threadNode(doc, id);
  return node ? threadOf(id, node) : null;
}

/** How many threads are open (the note's top bar, and Send feedback's "This note"). */
export function openThreadCount(doc: Y.Doc): number {
  let count = 0;
  for (const value of doc.get(NOTE_COMMENTS).attrValues()) {
    if (value instanceof Y.Node && value.getAttr('status') !== 'resolved') count++;
  }
  return count;
}

// --- writing ---

/** A quote as kept: trimmed of surrounding blank lines, at most MAX_QUOTE_CHARS. */
export function keptQuote(text: string): string {
  const trimmed = text.replace(/^\s*\n|\n\s*$/g, '');
  return trimmed.length > MAX_QUOTE_CHARS
    ? `${trimmed.slice(0, MAX_QUOTE_CHARS - 1).trimEnd()}…`
    : trimmed;
}

function writeComment(comment: CommentData): Y.Node {
  const node = new Y.Node();
  node.setAttr('id', comment.id);
  node.setAttr('author', { ...comment.author });
  node.setAttr('body', comment.body);
  node.setAttr('at', comment.at);
  return node;
}

export interface NewThread {
  readonly id: string;
  /** Null only for a thread on the note as a whole, placed at the note's start. */
  readonly anchor: CommentAnchor | null;
  readonly quote: string;
  readonly scope?: ThreadScope;
  /** Where it is; worked out from the anchor when absent (T52 item 5). */
  readonly context?: AnchorContext;
  readonly author: CommentAuthor;
  readonly at: number;
  /** The first comment. */
  readonly comment: { readonly id: string; readonly body: string };
  readonly target?: CommentTarget;
}

/**
 * Starts a thread with its first comment, in one transaction. A thread on a passage or a point
 * keeps where it is (`context`, T52 item 5): the text around it, its headings and its block.
 */
export function createThread(doc: Y.Doc, thread: NewThread, origin: unknown = null): void {
  const note = thread.scope === 'note';
  const anchor = thread.anchor ?? (note ? anchorAtStart(doc) : null);
  if (!anchor && !note) throw new Error('A thread on a passage needs its anchor');
  const context = note ? null : (thread.context ?? anchorContext(doc, anchor));
  doc.transact(() => {
    const node = new Y.Node();
    doc.get(NOTE_COMMENTS).setAttr(thread.id, node);
    node.setAttr(
      'anchor',
      anchor ? { from: { ...anchor.from }, to: anchor.to ? { ...anchor.to } : null } : null,
    );
    node.setAttr('quote', note ? '' : keptQuote(thread.quote));
    if (note) node.setAttr('scope', 'note');
    if (context) node.setAttr('context', copyContext(context));
    node.setAttr('status', 'open');
    node.setAttr('created', thread.at);
    node.setAttr('author', { ...thread.author });
    if (thread.target) node.setAttr('target', { ...thread.target });
    node.push([
      writeComment({
        id: thread.comment.id,
        author: thread.author,
        body: thread.comment.body,
        at: thread.at,
      }),
    ]);
  }, origin);
}

/** A thread on the note as a whole (T52 item 5): no passage, listed first. */
export function createNoteThread(
  doc: Y.Doc,
  thread: Omit<NewThread, 'anchor' | 'quote' | 'scope' | 'context'>,
  origin: unknown = null,
): void {
  createThread(doc, { ...thread, anchor: null, quote: '', scope: 'note' }, origin);
}

/**
 * Whether a thread is on the note as a whole: made so (`scope`), or, from before T52, a point
 * with no quote (what create_comment_thread without a quote made, "On the note as a whole").
 */
export function isNoteThread(thread: Pick<ThreadData, 'scope' | 'quote' | 'anchor'>): boolean {
  return thread.scope === 'note' || (thread.quote === '' && thread.anchor?.to == null);
}

const copyContext = (context: AnchorContext) => ({
  prefix: context.prefix,
  suffix: context.suffix,
  headings: [...context.headings],
  block: { ordinal: context.block.ordinal, text: context.block.text },
});

/** Adds a reply at the end of a thread; false when the thread is gone. */
export function addComment(
  doc: Y.Doc,
  threadId: string,
  comment: CommentData,
  origin: unknown = null,
): boolean {
  const node = threadNode(doc, threadId);
  if (!node) return false;
  doc.transact(() => node.push([writeComment(comment)]), origin);
  return true;
}

function commentIndex(node: Y.Node, commentId: string): number {
  return node
    .toArray()
    .findIndex((child) => child instanceof Y.Node && child.getAttr('id') === commentId);
}

/** Changes a comment's text, marking it edited; false when it is gone or unchanged. */
export function editComment(
  doc: Y.Doc,
  threadId: string,
  commentId: string,
  body: string,
  at: number,
  origin: unknown = null,
): boolean {
  const node = threadNode(doc, threadId);
  const index = node ? commentIndex(node, commentId) : -1;
  if (!node || index < 0) return false;
  const comment = node.get(index) as Y.Node;
  if (comment.getAttr('body') === body || comment.getAttr('removed') === true) return false;
  doc.transact(() => {
    comment.setAttr('body', body);
    comment.setAttr('edited', at);
  }, origin);
  return true;
}

/**
 * Deletes one comment (an agent's, which Ryan undoes, A779, or his own). The thread's first
 * comment is only marked removed (A784): its text goes, the thread and its replies stay, so one
 * click never takes anyone's replies; `deleteThread` deletes a thread. False when nothing changed.
 */
export function deleteComment(
  doc: Y.Doc,
  threadId: string,
  commentId: string,
  origin: unknown = null,
): boolean {
  const node = threadNode(doc, threadId);
  const index = node ? commentIndex(node, commentId) : -1;
  if (!node || index < 0) return false;
  if (index === 0) {
    const first = node.get(0) as Y.Node;
    if (first.getAttr('removed') === true) return false;
    doc.transact(() => {
      first.setAttr('removed', true);
      first.setAttr('body', '');
    }, origin);
    return true;
  }
  doc.transact(() => node.delete(index, 1), origin);
  return true;
}

/**
 * Names a comment's true writer (the NoteDoc's check, A781): the actor whose connection wrote
 * it, as A3 maps Yjs client ids. A thread's first comment names the thread's author too.
 */
export function setCommentAuthor(
  doc: Y.Doc,
  threadId: string,
  commentId: string,
  author: CommentAuthor,
  origin: unknown = null,
): boolean {
  const node = threadNode(doc, threadId);
  const index = node ? commentIndex(node, commentId) : -1;
  if (!node || index < 0) return false;
  const comment = node.get(index) as Y.Node;
  doc.transact(() => {
    comment.setAttr('author', { ...author });
    if (index === 0) node.setAttr('author', { ...author });
  }, origin);
  return true;
}

export function deleteThread(doc: Y.Doc, threadId: string, origin: unknown = null): boolean {
  if (!threadNode(doc, threadId)) return false;
  doc.transact(() => doc.get(NOTE_COMMENTS).deleteAttr(threadId), origin);
  return true;
}

/** Resolves or reopens a thread (A777: resolved threads are kept for good). False: no change. */
export function setThreadStatus(
  doc: Y.Doc,
  threadId: string,
  status: ThreadStatus,
  by: CommentAuthor,
  at: number,
  origin: unknown = null,
): boolean {
  const node = threadNode(doc, threadId);
  if (!node) return false;
  const current = node.getAttr('status') === 'resolved' ? 'resolved' : 'open';
  if (current === status) return false;
  doc.transact(() => {
    node.setAttr('status', status);
    if (status === 'resolved') {
      node.setAttr('resolvedAt', at);
      node.setAttr('resolvedBy', { ...by });
    } else {
      if (node.hasAttr('resolvedAt')) node.deleteAttr('resolvedAt');
      if (node.hasAttr('resolvedBy')) node.deleteAttr('resolvedBy');
    }
  }, origin);
  return true;
}

/** Sends the thread to an agent session, or stops sending it (null). False: no change. */
export function setThreadTarget(
  doc: Y.Doc,
  threadId: string,
  target: CommentTarget | null,
  origin: unknown = null,
): boolean {
  const node = threadNode(doc, threadId);
  if (!node) return false;
  const current = targetOf(node.getAttr('target'));
  if (
    (current === null && target === null) ||
    (current && target && current.writer === target.writer && current.session === target.session)
  ) {
    return false;
  }
  doc.transact(() => {
    if (target) node.setAttr('target', { ...target });
    else node.deleteAttr('target');
    if (node.hasAttr('delivery')) node.deleteAttr('delivery');
  }, origin);
  return true;
}

/**
 * Moves a thread's anchor (A771): an editor re-anchors the threads in a block it moved, as Yjs
 * has no move (a moved block is a copy, and anchors in the original would be orphaned).
 */
export function setThreadAnchor(
  doc: Y.Doc,
  threadId: string,
  anchor: CommentAnchor,
  origin: unknown = null,
): boolean {
  const node = threadNode(doc, threadId);
  if (!node) return false;
  doc.transact(
    () =>
      node.setAttr('anchor', { from: { ...anchor.from }, to: anchor.to ? { ...anchor.to } : null }),
    origin,
  );
  return true;
}

/** Records where delivery stands (the app writes waiting and failed, the agent's clone the rest; A1061). */
export function setThreadDelivery(
  doc: Y.Doc,
  threadId: string,
  delivery: CommentDelivery,
  origin: unknown = null,
): boolean {
  const node = threadNode(doc, threadId);
  if (!node) return false;
  const current = deliveryOf(node.getAttr('delivery'));
  if (
    current &&
    current.state === delivery.state &&
    current.commentId === delivery.commentId &&
    current.session === delivery.session &&
    current.reason === delivery.reason
  ) {
    return false;
  }
  doc.transact(() => node.setAttr('delivery', { ...delivery }), origin);
  return true;
}

// --- comment-only changes (A770) ---

/** Whether `type` is the comments root or inside it. */
function withinComments(type: Y.Node, root: Y.Node): boolean {
  for (let node: Y.Node | null = type; node; node = node.parent) {
    if (node === root) return true;
  }
  return false;
}

/**
 * Whether a transaction changed the comments and nothing else (A770): such a change is not an
 * edit, so it marks nothing changed (no `updated`, version, index, mirror commit or Recent).
 * False for a transaction that changed nothing.
 */
export function touchesOnlyComments(doc: Y.Doc, transaction: Y.Transaction): boolean {
  if (transaction.changed.size === 0) return false;
  const root = doc.get(NOTE_COMMENTS);
  for (const type of transaction.changed.keys()) {
    if (!withinComments(type as Y.Node, root)) return false;
  }
  return true;
}

/** Whether a transaction changed the comments at all (the NoteDoc's delivery watch, A774). */
export function touchesComments(doc: Y.Doc, transaction: Y.Transaction): boolean {
  const root = doc.get(NOTE_COMMENTS);
  for (const type of transaction.changed.keys()) {
    if (withinComments(type as Y.Node, root)) return true;
  }
  return false;
}

// --- anchors (A771) ---

/** A position in the body's tree, as lib0's delta positions and @y/prosemirror take it. */
export interface BodyPosition {
  readonly path: readonly number[];
  readonly assoc: -1 | 1;
}

interface DeltaJson {
  readonly name?: string;
  readonly insert?: string | DeltaJson[];
  readonly children?: DeltaJson[];
  readonly attrs?: Readonly<Record<string, unknown>>;
}

/** One character of the body's text, with where it is. */
interface TextChar {
  /** The path to its block, then its index there (an inline node's, for its label). */
  readonly path: readonly number[];
}

/**
 * The body's visible text, blocks joined by line breaks, with each character's place: what a
 * quote is matched against. A link reads as its label (`labels`) or as its markdown, `[[Bob]]`,
 * as read_note shows it; its characters all sit at the link. A hard break is a line break. Runs
 * of line breaks (blank lines between blocks) read as one. Other inline nodes have no text.
 */
interface BodyText {
  readonly text: string;
  /** One entry per UTF-16 code unit of `text`; null for the joining line breaks. */
  readonly chars: ReadonlyArray<TextChar | null>;
}

function attrText(node: DeltaJson, name: string): string | null {
  const raw = node.attrs?.[name];
  const value = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** What an inline node reads as in the body's text. */
function inlineText(node: DeltaJson, links: 'label' | 'markdown'): string {
  if (node.name === 'hardBreak') return '\n';
  if (node.name !== 'wikilink') return '';
  const ref: LinkRef = {
    noteId: attrText(node, 'noteId'),
    target: attrText(node, 'target') ?? '',
    heading: attrText(node, 'heading'),
    alias: attrText(node, 'alias'),
  };
  if (!ref.target && !ref.alias) return '';
  return links === 'label' ? linkLabel(ref, null) : `[[${formatWikiReference(ref, false)}]]`;
}

function bodyText(doc: Y.Doc, links: 'label' | 'markdown' = 'label'): BodyText {
  let text = '';
  const chars: Array<TextChar | null> = [];
  const add = (part: string, at: readonly number[] | null) => {
    for (const char of part) {
      if (char === '\n' && (text.length === 0 || text.endsWith('\n'))) continue;
      text += char;
      for (let unit = 0; unit < char.length; unit++) chars.push(at ? { path: at } : null);
    }
  };
  const walk = (node: DeltaJson, path: readonly number[]) => {
    let index = 0;
    let started = false;
    const start = () => {
      if (!started) add('\n', null);
      started = true;
    };
    for (const op of node.children ?? []) {
      if (typeof op.insert === 'string') {
        start();
        for (let i = 0; i < op.insert.length; i++) {
          text += op.insert[i]!;
          chars.push({ path: [...path, index + i] });
        }
        index += op.insert.length;
      } else if (Array.isArray(op.insert)) {
        for (const child of op.insert) {
          const own = child.children === undefined ? inlineText(child, links) : '';
          if (own) {
            start();
            add(own, [...path, index]);
          } else {
            walk(child, [...path, index]);
          }
          index++;
        }
      }
    }
  };
  walk(doc.get(NOTE_ROOT).toDeltaDeep().toJSON() as DeltaJson, []);
  return collapseBlankLines({ text, chars });
}

/** Runs of blank lines read as one break, in the quote as in the note (a code block's too). */
const BLANK_LINES = /\n(?:[ \t]*\n)+/g;

function collapseBlankLines(body: BodyText): BodyText {
  let text = '';
  const chars: Array<TextChar | null> = [];
  let from = 0;
  for (const run of body.text.matchAll(BLANK_LINES)) {
    // Keeps the run's first break, mapped to its own place.
    const keep = run.index + 1;
    text += body.text.slice(from, keep);
    chars.push(...body.chars.slice(from, keep));
    from = run.index + run[0].length;
  }
  text += body.text.slice(from);
  chars.push(...body.chars.slice(from));
  return { text, chars };
}

/** Relative positions for body positions (null where one cannot be anchored). */
export function anchorPositions(
  doc: Y.Doc,
  positions: readonly BodyPosition[],
): Array<RelativePositionJson | null> {
  const root = doc.get(NOTE_ROOT);
  const made = Y.createRelativePositionsFromDeltaPositions(
    root,
    positions.map((pos) => ({ path: [...pos.path], assoc: pos.assoc })),
    { renderer: null },
  );
  return made.map((rpos) =>
    rpos ? (Y.relativePositionToJSON(rpos) as RelativePositionJson) : null,
  );
}

/**
 * The anchor for body positions: a range from `from` (bound to the character after it) to `to`
 * (bound to the character before it), or a point at `from` when `to` is absent or the same.
 */
export function anchorBetween(
  doc: Y.Doc,
  from: BodyPosition,
  to?: BodyPosition | null,
): CommentAnchor | null {
  const point = !to || samePlace(from, to);
  const [start, end] = anchorPositions(
    doc,
    point
      ? [from]
      : [
          { path: from.path, assoc: 1 },
          { path: to.path, assoc: -1 },
        ],
  );
  if (!start) return null;
  if (point) return { from: start, to: null };
  return end ? { from: start, to: end } : null;
}

function samePlace(a: BodyPosition, b: BodyPosition): boolean {
  return a.path.length === b.path.length && a.path.every((step, i) => step === b.path[i]);
}

/** Where a quote's `occurrence` (1st, 2nd…) is in the body's text, with how many there are. */
export interface QuoteMatch {
  readonly anchor: CommentAnchor;
  readonly quote: string;
  readonly occurrences: number;
}

export type QuoteFailure =
  | { readonly error: 'not_found'; readonly occurrences: 0 }
  | { readonly error: 'occurrence'; readonly occurrences: number };

/**
 * The anchor for a quote of the body's visible text (A775): the `occurrence`th match (1-based),
 * a range over exactly the quoted characters. Line breaks in a quote match block boundaries and
 * hard breaks, and blank lines count as one; a link matches as its label or as `[[…]]`; runs of
 * spaces match as written.
 */
export function anchorForQuote(
  doc: Y.Doc,
  quote: string,
  occurrence = 1,
): QuoteMatch | QuoteFailure {
  // Blank lines read as one break, in the quote as in the note.
  const wanted = quote.replace(/\r\n?/g, '\n').replace(BLANK_LINES, '\n');
  // A link as the note shows it, else as read_note's markdown shows it (`[[Bob]]`).
  let found: QuoteMatch | QuoteFailure = { error: 'not_found', occurrences: 0 };
  for (const links of ['label', 'markdown'] as const) {
    if (links === 'markdown' && !wanted.includes('[[')) break;
    found = matchQuote(doc, bodyText(doc, links), wanted, occurrence);
    if (!('error' in found) || found.error === 'occurrence') return found;
  }
  return found;
}

function matchQuote(
  doc: Y.Doc,
  body: BodyText,
  wanted: string,
  occurrence: number,
): QuoteMatch | QuoteFailure {
  const starts: number[] = [];
  if (wanted.length > 0) {
    for (let at = body.text.indexOf(wanted); at >= 0; at = body.text.indexOf(wanted, at + 1)) {
      starts.push(at);
    }
  }
  if (starts.length === 0) return { error: 'not_found', occurrences: 0 };
  const start = starts[occurrence - 1];
  if (start === undefined) return { error: 'occurrence', occurrences: starts.length };
  const first = body.chars[start];
  const last = body.chars[start + wanted.length - 1];
  if (!first || !last) return { error: 'not_found', occurrences: 0 };
  const lastPath = [...last.path];
  lastPath[lastPath.length - 1]! += 1;
  const anchor = anchorBetween(doc, { path: first.path, assoc: 1 }, { path: lastPath, assoc: -1 });
  if (!anchor) return { error: 'not_found', occurrences: 0 };
  return { anchor, quote: keptQuote(wanted), occurrences: starts.length };
}

/** A point at the start of the note's body (a thread with no quote, A775). */
export function anchorAtStart(doc: Y.Doc): CommentAnchor | null {
  const root = doc.get(NOTE_ROOT);
  // Inside the first block when there is one, so it reads as a place in the text.
  const first: unknown = root.length > 0 ? root.get(0) : null;
  return anchorBetween(doc, { path: first instanceof Y.Node ? [0, 0] : [0], assoc: 1 });
}

/** Whether `type` or any node above it in the body was deleted. */
function inDeletedNode(type: Y.Node): boolean {
  for (let node: Y.Node | null = type; node; node = node.parent) {
    if (node._item?.deleted) return true;
  }
  return false;
}

function toPosition(doc: Y.Doc, json: RelativePositionJson, follow: boolean): BodyPosition | null {
  const rpos = Y.createRelativePositionFromJSON(json);
  const absolute = Y.createAbsolutePositionFromRelativePosition(rpos, doc, follow);
  if (!absolute || inDeletedNode(absolute.type as Y.Node)) return null;
  const [delta] = Y.createDeltaPositionsFromRelativePositions(doc.get(NOTE_ROOT), [rpos], {
    renderer: null,
    followUndoneDeletions: follow,
  });
  if (!delta) return null;
  const path = delta.path.filter((step): step is number => typeof step === 'number');
  if (path.length !== delta.path.length) return null;
  return { path, assoc: delta.assoc };
}

/** Where an anchor is now. */
export type ResolvedAnchor =
  | { readonly orphaned: true }
  | {
      readonly orphaned: false;
      readonly from: BodyPosition;
      /** Null for a point. */
      readonly to: BodyPosition | null;
    };

export interface ResolveOptions {
  /**
   * Follow text an Undo or Redo made again (Yjs's `followUndoneDeletions`). Only the client that
   * undid knows where that text went, so every other reader leaves this off and agrees on the
   * same answer; the undoing client writes a fresh anchor instead (`reanchorAfterUndo`).
   */
  readonly followUndone?: boolean;
}

/**
 * Where an anchor is now (A771): its positions, or orphaned when its text was deleted (a range
 * with nothing left between its ends) or its block is gone.
 */
export function resolveAnchor(
  doc: Y.Doc,
  anchor: CommentAnchor | null,
  options: ResolveOptions = {},
): ResolvedAnchor {
  if (!anchor) return { orphaned: true };
  const follow = options.followUndone === true;
  const from = toPosition(doc, anchor.from, follow);
  if (!from) return { orphaned: true };
  if (!anchor.to) return { orphaned: false, from, to: null };
  const to = toPosition(doc, anchor.to, follow);
  if (!to) return { orphaned: true };
  if (comparePositions(from, to) >= 0) return { orphaned: true };
  return { orphaned: false, from, to };
}

/** A thread this client re-anchored, with the anchor it had. */
export interface Reanchored {
  readonly id: string;
  readonly previous: CommentAnchor;
}

/**
 * After this client's own Undo or Redo (A771): each thread the Undo left orphaned whose text it
 * brought back gets a fresh anchor on that text. Yjs's relative positions do not follow text an
 * Undo makes again on other clients (only the undoing client knows where it went), so without
 * this a deleted sentence came back without its thread. `earlier` holds anchors a thread had
 * before this client re-anchored it (a block move moves its threads to the block's copy, and
 * undoing the move brings back the original), tried after the thread's own.
 */
export function reanchorAfterUndo(
  doc: Y.Doc,
  earlier: ReadonlyMap<string, readonly CommentAnchor[]> = new Map(),
  origin: unknown = null,
): Reanchored[] {
  const fresh: Array<Reanchored & { readonly anchor: CommentAnchor }> = [];
  for (const thread of readThreads(doc)) {
    if (!thread.anchor || !resolveAnchor(doc, thread.anchor).orphaned) continue;
    for (const candidate of [thread.anchor, ...[...(earlier.get(thread.id) ?? [])].reverse()]) {
      const found = resolveAnchor(doc, candidate, { followUndone: true });
      if (found.orphaned) continue;
      const anchor = anchorBetween(doc, found.from, found.to);
      if (!anchor || resolveAnchor(doc, anchor).orphaned) continue;
      fresh.push({ id: thread.id, previous: thread.anchor, anchor });
      break;
    }
  }
  if (fresh.length > 0) {
    doc.transact(() => {
      for (const each of fresh) setThreadAnchor(doc, each.id, each.anchor, origin);
    }, origin);
  }
  return fresh.map(({ id, previous }) => ({ id, previous }));
}

/** A changed run of the body's text: `[oldStart, oldEnd)` became `[newStart, newEnd)`. */
interface TextHunk {
  readonly oldStart: number;
  readonly oldEnd: number;
  readonly newStart: number;
  readonly newEnd: number;
}

/** Words, runs of spaces and single other characters: what an edit is compared by (A1096). */
const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;
/** Above this many token pairs the changed middle is one hunk, not compared word by word. */
const MAX_TOKEN_PAIRS = 4_000_000;

/** The changed runs between two texts, compared word by word (a longest common subsequence). */
function textHunks(before: string, after: string): TextHunk[] {
  const a = before.match(TOKEN) ?? [];
  const b = after.match(TOKEN) ?? [];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const offsets = (tokens: readonly string[]) => {
    const at = [0];
    for (const token of tokens) at.push(at[at.length - 1]! + token.length);
    return at;
  };
  const offA = offsets(a);
  const offB = offsets(b);
  if (midA.length === 0 && midB.length === 0) return [];
  // Pairs of equal tokens in the middle, in order: the longest common subsequence.
  const kept: Array<[number, number]> = [];
  if (midA.length * midB.length <= MAX_TOKEN_PAIRS) {
    const n = midA.length;
    const m = midB.length;
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i]![j] =
          midA[i] === midB[j]
            ? table[i + 1]![j + 1]! + 1
            : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
      }
    }
    for (let i = 0, j = 0; i < n && j < m;) {
      if (midA[i] === midB[j]) {
        kept.push([head + i, head + j]);
        i++;
        j++;
      } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++;
      else j++;
    }
  }
  const hunks: TextHunk[] = [];
  let i = head;
  let j = head;
  for (const [ka, kb] of [...kept, [a.length - tail, b.length - tail] as [number, number]]) {
    if (ka > i || kb > j) {
      hunks.push({ oldStart: offA[i]!, oldEnd: offA[ka]!, newStart: offB[j]!, newEnd: offB[kb]! });
    }
    i = ka + 1;
    j = kb + 1;
  }
  return hunks;
}

/** Where an old offset is in the new text: a start or an end inside a changed run widens to it. */
function mapOffset(hunks: readonly TextHunk[], at: number, edge: 'start' | 'end') {
  let shift = 0;
  for (const hunk of hunks) {
    const inside =
      edge === 'start'
        ? at >= hunk.oldStart && at < hunk.oldEnd
        : at > hunk.oldStart && at <= hunk.oldEnd;
    if (inside) return { at: edge === 'start' ? hunk.newStart : hunk.newEnd, touched: true };
    if (hunk.oldEnd <= at) shift = hunk.newEnd - hunk.oldEnd;
    else break;
  }
  return { at: at + shift, touched: false };
}

/**
 * Runs `edit` (a rewrite of the body, such as an agent's replace_text) and keeps each thread on
 * the words that took its words' place (A1096). The body's diff is by character, so a thread on
 * a word that was rewritten kept only the characters the old and new words share ("scratch" to
 * "test" left it on the "s"). Comparing the text before and after word by word, a thread whose
 * start or end fell inside a changed run is anchored again from the start of that run's new
 * words, or to their end; other threads keep their anchors. Words deleted with nothing in their
 * place leave their thread orphaned, as before.
 */
export function reanchorAcrossEdit<T>(doc: Y.Doc, edit: () => T, origin: unknown = null): T {
  const before = bodyText(doc);
  const spans = new Map<string, { start: number; end: number }>();
  for (const thread of readThreads(doc)) {
    if (!thread.anchor?.to) continue;
    const resolved = resolveAnchor(doc, thread.anchor);
    if (resolved.orphaned || !resolved.to) continue;
    spans.set(thread.id, textSpan(before, resolved));
  }
  const result = edit();
  if (spans.size === 0) return result;
  const after = bodyText(doc);
  if (after.text === before.text) return result;
  const hunks = textHunks(before.text, after.text);
  const fresh: Array<{ id: string; anchor: CommentAnchor }> = [];
  for (const [id, span] of spans) {
    const start = mapOffset(hunks, span.start, 'start');
    const end = mapOffset(hunks, span.end, 'end');
    if (!start.touched && !end.touched) continue;
    let from = start.at;
    let to = end.at;
    while (from < to && !after.chars[from]) from++;
    while (to > from && !after.chars[to - 1]) to--;
    if (from >= to) continue;
    const first = after.chars[from]!.path;
    const last = after.chars[to - 1]!.path;
    const anchor = anchorBetween(
      doc,
      { path: first, assoc: 1 },
      { path: [...last.slice(0, -1), last[last.length - 1]! + 1], assoc: -1 },
    );
    if (anchor) fresh.push({ id, anchor });
  }
  if (fresh.length > 0) {
    doc.transact(() => {
      for (const each of fresh) setThreadAnchor(doc, each.id, each.anchor, origin);
    }, origin);
  }
  return result;
}

/** Document order of two body positions. */
export function comparePositions(a: BodyPosition, b: BodyPosition): number {
  return comparePaths(a.path, b.path);
}

function comparePaths(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const difference = a[i]! - b[i]!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

/** A thread as the Comments panel lists it: where it is now, and whether it is orphaned. */
export interface PlacedThread {
  readonly thread: ThreadData;
  readonly anchor: ResolvedAnchor;
}

/**
 * Threads in document order, orphans last (oldest first), as the panel and agents list them
 * (A777: resolved threads are kept, listed after the open ones only when asked for).
 */
export function orderThreads(doc: Y.Doc, threads: readonly ThreadData[]): PlacedThread[] {
  const placed = threads.map((thread) => ({ thread, anchor: resolveAnchor(doc, thread.anchor) }));
  return placed.sort((a, b) => {
    // Threads on the note as a whole first (T52 item 5), oldest first: they have no place.
    const noteA = isNoteThread(a.thread);
    const noteB = isNoteThread(b.thread);
    if (noteA || noteB) {
      if (!noteB) return -1;
      if (!noteA) return 1;
      return a.thread.created - b.thread.created || a.thread.id.localeCompare(b.thread.id);
    }
    if (a.anchor.orphaned || b.anchor.orphaned) {
      if (!a.anchor.orphaned) return -1;
      if (!b.anchor.orphaned) return 1;
      return a.thread.created - b.thread.created || a.thread.id.localeCompare(b.thread.id);
    }
    return (
      comparePositions(a.anchor.from, b.anchor.from) ||
      a.thread.created - b.thread.created ||
      a.thread.id.localeCompare(b.thread.id)
    );
  });
}

/** The visible text an anchor covers now (empty for a point or an orphan). */
export function anchoredText(doc: Y.Doc, resolved: ResolvedAnchor): string {
  if (resolved.orphaned || !resolved.to) return '';
  const body = bodyText(doc);
  const from = resolved.from.path;
  const to = resolved.to.path;
  // From the first character at or after `from`, to just after the last one before `to`.
  const start = body.chars.findIndex((char) => char !== null && comparePaths(char.path, from) >= 0);
  if (start < 0) return '';
  let end = start;
  for (let i = start; i < body.chars.length; i++) {
    const char = body.chars[i];
    if (!char) continue;
    if (comparePaths(char.path, to) >= 0) break;
    end = i + 1;
  }
  return body.text.slice(start, end);
}

// --- where a thread is, for agents (T52 item 5) ---

/** Characters of text kept before and after a thread's place, and of its block. */
export const CONTEXT_CHARS = 60;
const BLOCK_CHARS = 280;
/** The most of a block's text an agent is given with a thread's place now. */
const PARAGRAPH_CHARS = 1_000;

/** Blocks that hold text (the rest hold blocks, or nothing). */
const TEXT_BLOCKS = new Set([
  'paragraph',
  'heading',
  'codeBlock',
  'tableCell',
  'tableHeader',
  'rawMarkdown',
]);

interface TextBlock {
  readonly path: readonly number[];
  /** A heading's level, else null. */
  readonly heading: number | null;
  /** Its visible text, links as their labels. */
  readonly text: string;
}

function headingLevel(node: DeltaJson): number {
  const raw = node.attrs?.['level'];
  const value = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
  return typeof value === 'number' ? value : 1;
}

/** The body's blocks of text, in document order. */
function textBlocks(doc: Y.Doc): TextBlock[] {
  const blocks: TextBlock[] = [];
  const own = (node: DeltaJson) => {
    let text = '';
    for (const op of node.children ?? []) {
      if (typeof op.insert === 'string') text += op.insert;
      else if (Array.isArray(op.insert)) {
        for (const child of op.insert) text += inlineText(child, 'label');
      }
    }
    return text;
  };
  const walk = (node: DeltaJson, path: readonly number[]) => {
    let index = 0;
    for (const op of node.children ?? []) {
      if (typeof op.insert === 'string') {
        index += op.insert.length;
        continue;
      }
      if (!Array.isArray(op.insert)) continue;
      for (const child of op.insert) {
        const at = [...path, index];
        if (child.name && TEXT_BLOCKS.has(child.name)) {
          blocks.push({
            path: at,
            heading: child.name === 'heading' ? headingLevel(child) : null,
            text: own(child),
          });
        } else if (child.children !== undefined) {
          walk(child, at);
        }
        index++;
      }
    }
  };
  walk(doc.get(NOTE_ROOT).toDeltaDeep().toJSON() as DeltaJson, []);
  return blocks;
}

const isPrefix = (prefix: readonly number[], path: readonly number[]) =>
  prefix.length < path.length && prefix.every((step, i) => step === path[i]);

/** The index of the block of text a position is in (or the last one before it), or -1. */
function blockAt(blocks: readonly TextBlock[], path: readonly number[]): number {
  let before = -1;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (isPrefix(block.path, path)) return i;
    if (comparePaths(block.path, path) < 0) before = i;
  }
  return before;
}

/** The headings above block `index` (itself excluded), outermost first. */
function headingsAbove(blocks: readonly TextBlock[], index: number): string[] {
  const stack: Array<{ level: number; text: string }> = [];
  for (let i = 0; i < index; i++) {
    const block = blocks[i]!;
    if (block.heading === null) continue;
    while (stack.length > 0 && stack[stack.length - 1]!.level >= block.heading) stack.pop();
    stack.push({ level: block.heading, text: block.text.trim() });
  }
  return stack.map((each) => each.text).filter((text) => text !== '');
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/** A resolved place as offsets in the body's text: a range's characters, or a point's spot. */
function textSpan(body: BodyText, resolved: Exclude<ResolvedAnchor, { orphaned: true }>) {
  const from = resolved.from.path;
  if (!resolved.to) {
    // After the last character before the point.
    let at = 0;
    body.chars.forEach((char, i) => {
      if (char && comparePaths(char.path, from) < 0) at = i + 1;
    });
    return { start: at, end: at };
  }
  const to = resolved.to.path;
  let start = body.chars.findIndex((char) => char !== null && comparePaths(char.path, from) >= 0);
  if (start < 0) start = body.text.length;
  let end = start;
  for (let i = start; i < body.chars.length; i++) {
    const char = body.chars[i];
    if (!char) continue;
    if (comparePaths(char.path, to) >= 0) break;
    end = i + 1;
  }
  return { start, end };
}

/** The block a text offset is in: its index in `blocks`. */
function blockOfOffset(body: BodyText, blocks: readonly TextBlock[], offset: number): number {
  for (let i = Math.min(offset, body.chars.length - 1); i >= 0; i--) {
    const char = body.chars[i];
    if (char) return blockAt(blocks, char.path);
  }
  const next = body.chars.slice(offset).find((char) => char !== null);
  return next ? blockAt(blocks, next.path) : -1;
}

function contextAt(
  body: BodyText,
  blocks: readonly TextBlock[],
  span: { start: number; end: number },
  path: readonly number[] | null,
): AnchorContext {
  const index = path ? blockAt(blocks, path) : blockOfOffset(body, blocks, span.start);
  const block = blocks[index];
  return {
    prefix: body.text.slice(Math.max(0, span.start - CONTEXT_CHARS), span.start),
    suffix: body.text.slice(span.end, span.end + CONTEXT_CHARS),
    headings: index >= 0 ? headingsAbove(blocks, index) : [],
    block: { ordinal: index + 1, text: block ? clip(block.text, BLOCK_CHARS) : '' },
  };
}

/**
 * Where an anchor is, for keeping with a new thread (T52 item 5): the text just before and after
 * it, the headings it is under, and its block. Null when the anchor is not in the note.
 */
export function anchorContext(doc: Y.Doc, anchor: CommentAnchor | null): AnchorContext | null {
  const resolved = resolveAnchor(doc, anchor);
  if (resolved.orphaned) return null;
  const body = bodyText(doc);
  return contextAt(body, textBlocks(doc), textSpan(body, resolved), resolved.from.path);
}

/**
 * Where a thread is now, as an agent reads it (T52 item 5). `found`: `anchor`, where its anchor
 * is; `refound`, its anchor was lost (its text deleted and written again, or its block replaced)
 * and its text found it again (`how`, from core's `findAnchorText`); `note`, on the note as a
 * whole; `lost`, nowhere in the note now.
 */
export interface ThreadPlace {
  readonly found: 'anchor' | 'refound' | 'note' | 'lost';
  readonly how?: AnchorFound;
  /** How close the text found is to the quote, 0–1 (`refound` only). */
  readonly similarity?: number;
  /** The text at its place now: a range's text, empty for a point. */
  readonly text: string;
  /** Whether that is still the thread's quote (a point: whether its line still holds it). */
  readonly matches: boolean;
  /** The headings it is under now, outermost first. */
  readonly headings: readonly string[];
  /** The block of text it is in now (its first 1,000 characters), and which one it is. */
  readonly block: { readonly ordinal: number; readonly text: string } | null;
}

/** The quote as matched: without the ellipsis a long one was cut with (`keptQuote`). */
const matchable = (quote: string) =>
  quote.length >= MAX_QUOTE_CHARS - 1 && quote.endsWith('…') ? quote.slice(0, -1) : quote;

function sameText(found: string, quote: string): boolean {
  const cut = matchable(quote);
  const wanted = cut.replace(BLANK_LINES, '\n');
  return cut === quote ? found === wanted : found.startsWith(wanted);
}

/** Where each thread is now (T52 item 5), reading the body once for all of them. */
export function locateThreads(doc: Y.Doc, threads: readonly ThreadData[]): ThreadPlace[] {
  let read: { body: BodyText; blocks: TextBlock[] } | null = null;
  const body = () => (read ??= { body: bodyText(doc), blocks: textBlocks(doc) });
  return threads.map((thread): ThreadPlace => {
    if (isNoteThread(thread)) {
      return { found: 'note', text: '', matches: true, headings: [], block: null };
    }
    const point = thread.anchor?.to == null;
    const resolved = resolveAnchor(doc, thread.anchor);
    const { body: text, blocks } = body();
    const place = (
      span: { start: number; end: number },
      path: readonly number[] | null,
    ): Omit<ThreadPlace, 'found'> => {
      const now = contextAt(text, blocks, span, path);
      const index = now.block.ordinal - 1;
      const blockText = blocks[index]?.text ?? '';
      const at = text.text.slice(span.start, span.end);
      return {
        text: at,
        matches: point
          ? thread.quote === '' || blockText.includes(thread.quote)
          : sameText(at, thread.quote),
        headings: now.headings,
        block:
          index >= 0
            ? { ordinal: now.block.ordinal, text: clip(blockText, PARAGRAPH_CHARS) }
            : null,
      };
    };
    if (!resolved.orphaned) {
      return { found: 'anchor', ...place(textSpan(text, resolved), resolved.from.path) };
    }
    // Lost: found again by its text. A point from before T52 has only its line to go by.
    const context = thread.context;
    const quote = matchable(thread.quote).replace(BLANK_LINES, '\n');
    const match = context
      ? findAnchorText(text.text, {
          quote: point ? '' : quote,
          prefix: context.prefix,
          suffix: context.suffix,
        })
      : quote
        ? findAnchorText(text.text, { quote, prefix: '', suffix: '' })
        : null;
    if (!match) {
      return { found: 'lost', text: '', matches: false, headings: [], block: null };
    }
    const span = point && !context ? { start: match.start, end: match.start } : match;
    return {
      found: 'refound',
      how: match.how,
      similarity: Math.round(match.similarity * 100) / 100,
      ...place(span, null),
    };
  });
}

// --- the comments backup (A786) ---

/** The backup's format version. */
export const COMMENTS_BACKUP_VERSION = 1;

/** The most characters of text a point keeps to be found again by. */
const POINT_TEXT_CHARS = 60;

/** One thread as the backup keeps it: found again by its text, not by Yjs positions. */
export interface BackupThread {
  readonly id: string;
  readonly kind: 'range' | 'point';
  /** The thread's quote as it was started. */
  readonly quote: string;
  /**
   * The text it is on now: a range's own text; for a point, the text after it in its block
   * (`side` start) or, at a block's end, before it (`side` end). Null when orphaned.
   */
  readonly text: string | null;
  /** Which occurrence of `text` in the note's text (1-based), when it was written. */
  readonly occurrence: number;
  readonly side: 'start' | 'end';
  readonly orphaned: boolean;
  readonly status: ThreadStatus;
  readonly created: number;
  readonly author: CommentAuthor;
  readonly target?: CommentTarget;
  readonly delivery?: CommentDelivery;
  readonly resolvedAt?: number;
  readonly resolvedBy?: CommentAuthor;
  /** On the note as a whole (T52 item 5): restored at the note's start. */
  readonly scope?: ThreadScope;
  /** Where it was when it was made (T52 item 5), kept as it was. */
  readonly context?: AnchorContext;
  readonly comments: readonly CommentData[];
}

/** A note's threads, as written beside its markdown in R2. */
export interface CommentsBackup {
  readonly version: typeof COMMENTS_BACKUP_VERSION;
  readonly noteId: string;
  /** When it was written. */
  readonly at: number;
  readonly threads: readonly BackupThread[];
}

/** The text a thread is on now, and which occurrence of it that is. */
function placeText(
  body: BodyText,
  resolved: ResolvedAnchor,
): Pick<BackupThread, 'text' | 'occurrence' | 'side'> | null {
  if (resolved.orphaned) return null;
  const from = resolved.from.path;
  let start = body.chars.findIndex((char) => char !== null && comparePaths(char.path, from) >= 0);
  if (start < 0) start = body.text.length;
  let end = start;
  let side: 'start' | 'end' = 'start';
  if (resolved.to) {
    const to = resolved.to.path;
    for (let i = start; i < body.chars.length; i++) {
      const char = body.chars[i];
      if (!char) continue;
      if (comparePaths(char.path, to) >= 0) break;
      end = i + 1;
    }
  } else {
    const block = from.slice(0, -1);
    const sameBlock = (i: number) => {
      const char = body.chars[i];
      return (
        !!char &&
        char.path.length === from.length &&
        comparePaths(char.path.slice(0, -1), block) === 0
      );
    };
    if (start < body.chars.length && sameBlock(start)) {
      while (end < body.chars.length && end - start < POINT_TEXT_CHARS && sameBlock(end)) end++;
    } else {
      // At the end of its block: the text before it.
      side = 'end';
      end = start;
      while (start > 0 && end - start < POINT_TEXT_CHARS && sameBlock(start - 1)) start--;
    }
  }
  const text = body.text.slice(start, end);
  if (!text) return null;
  let occurrence = 1;
  for (
    let at = body.text.indexOf(text);
    at >= 0 && at < start;
    at = body.text.indexOf(text, at + 1)
  ) {
    occurrence++;
  }
  return { text, occurrence, side };
}

/** The note's threads for the backup (A786): each with the text it is on, to be found again. */
export function commentsBackup(doc: Y.Doc, noteId: string, at: number): CommentsBackup {
  const body = bodyText(doc);
  const threads = readThreads(doc).map((thread): BackupThread => {
    const placed = placeText(body, resolveAnchor(doc, thread.anchor));
    return {
      id: thread.id,
      kind: thread.anchor && !thread.anchor.to ? 'point' : 'range',
      quote: thread.quote,
      text: placed?.text ?? null,
      occurrence: placed?.occurrence ?? 1,
      side: placed?.side ?? 'start',
      orphaned: placed === null,
      status: thread.status,
      created: thread.created,
      author: thread.author,
      ...(thread.target ? { target: thread.target } : {}),
      ...(thread.delivery ? { delivery: thread.delivery } : {}),
      ...(thread.resolvedAt !== undefined ? { resolvedAt: thread.resolvedAt } : {}),
      ...(thread.resolvedBy ? { resolvedBy: thread.resolvedBy } : {}),
      ...(thread.scope ? { scope: thread.scope } : {}),
      ...(thread.context ? { context: thread.context } : {}),
      comments: thread.comments,
    };
  });
  return { version: COMMENTS_BACKUP_VERSION, noteId, at, threads };
}

/** Reads a backup's JSON, or null when it is not one. */
export function parseCommentsBackup(value: unknown): CommentsBackup | null {
  if (typeof value !== 'object' || value === null) return null;
  const { version, noteId, at, threads } = value as Record<string, unknown>;
  if (
    version !== COMMENTS_BACKUP_VERSION ||
    typeof noteId !== 'string' ||
    !Array.isArray(threads)
  ) {
    return null;
  }
  return { version, noteId, at: num(at) ?? 0, threads: threads as BackupThread[] };
}

/** Where a backed-up thread goes in this note, or null (orphaned) when its text is not there. */
function anchorFromBackup(doc: Y.Doc, thread: BackupThread): CommentAnchor | null {
  if (thread.scope === 'note') return anchorAtStart(doc);
  if (thread.orphaned || !thread.text) return null;
  let match = anchorForQuote(doc, thread.text, Math.max(1, thread.occurrence));
  // The note has fewer occurrences now: the last one is the nearest.
  if ('error' in match && match.error === 'occurrence') {
    match = anchorForQuote(doc, thread.text, match.occurrences);
  }
  if ('error' in match) return null;
  if (thread.kind === 'range') return match.anchor;
  const at = resolveAnchor(doc, match.anchor);
  if (at.orphaned || !at.to) return null;
  return anchorBetween(doc, thread.side === 'end' ? at.to : at.from);
}

/**
 * Makes a backup's threads again in a note rebuilt from its markdown (A786): each on its text,
 * found by quote and occurrence; one whose text is gone comes back orphaned, never dropped.
 * Threads the note already has are left alone. How many came back, and how many orphaned.
 */
export function restoreThreads(
  doc: Y.Doc,
  backup: CommentsBackup,
  origin: unknown = null,
): { restored: number; orphaned: number } {
  let restored = 0;
  let orphaned = 0;
  const root = doc.get(NOTE_COMMENTS);
  doc.transact(() => {
    for (const thread of backup.threads) {
      if (typeof thread?.id !== 'string' || root.hasAttr(thread.id)) continue;
      const author = authorOf(thread.author);
      if (!author) continue;
      const anchor = anchorFromBackup(doc, thread);
      const node = new Y.Node();
      root.setAttr(thread.id, node);
      if (anchor) {
        node.setAttr('anchor', {
          from: { ...anchor.from },
          to: anchor.to ? { ...anchor.to } : null,
        });
      } else {
        orphaned++;
      }
      node.setAttr('quote', keptQuote(str(thread.quote) ?? ''));
      if (thread.scope === 'note') node.setAttr('scope', 'note');
      const context = contextOf(thread.context);
      if (context) node.setAttr('context', copyContext(context));
      node.setAttr('status', thread.status === 'resolved' ? 'resolved' : 'open');
      node.setAttr('created', num(thread.created) ?? 0);
      node.setAttr('author', { ...author });
      const target = targetOf(thread.target);
      if (target) node.setAttr('target', { ...target });
      const delivery = deliveryOf(thread.delivery);
      if (delivery) node.setAttr('delivery', { ...delivery });
      const resolvedAt = num(thread.resolvedAt);
      const resolvedBy = authorOf(thread.resolvedBy);
      if (resolvedAt !== null) node.setAttr('resolvedAt', resolvedAt);
      if (resolvedBy) node.setAttr('resolvedBy', { ...resolvedBy });
      const comments: Y.Node[] = [];
      const listed: unknown[] = Array.isArray(thread.comments) ? thread.comments : [];
      for (const raw of listed) {
        if (typeof raw !== 'object' || raw === null) continue;
        const comment = raw as Record<string, unknown>;
        const writer = authorOf(comment['author']);
        const id = str(comment['id']);
        if (!writer || !id) continue;
        const each = writeComment({
          id,
          author: writer,
          body: str(comment['body']) ?? '',
          at: num(comment['at']) ?? 0,
        });
        const edited = num(comment['edited']);
        if (edited !== null) each.setAttr('edited', edited);
        if (comment['removed'] === true) each.setAttr('removed', true);
        comments.push(each);
      }
      node.push(comments);
      restored++;
    }
  }, origin);
  return { restored, orphaned };
}
