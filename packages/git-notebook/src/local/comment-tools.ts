/**
 * The comment tools of the local MCP server (T60, A1064; rescued from the deleted server's
 * `mcp/comment-tools.ts`, T48): list, read, start, reply to and resolve threads, over the
 * clone's own notes and as its writer. What an agent reads of a thread is the server's: its
 * quote, its place now and when it was made (T52 item 5), its state and every comment.
 */
import type { ThreadView } from '@penmoss/sync-client/comment-delivery';
import type { StatusFilter } from '@penmoss/sync-client/comment-delivery';
import type { LocalNotebook } from './notebook';

type Args = Record<string, unknown>;

/** What a tool answers (the local server's `LocalToolOutcome`). */
type Outcome =
  | { readonly data: Record<string, unknown>; readonly text?: readonly string[] }
  | { readonly error: string };

const iso = (ms: number | null | undefined) =>
  typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null;

/**
 * Where a thread is (T52 item 5), so an agent knows its exact place even after the note changed:
 * `position` is where it is now (its text there, whether that is still the quote, the headings
 * it is under and its block, found again by its text when its anchor was lost), `context` where
 * it was when it was made (the text just before and after it, its headings and block). A
 * thread on the note as a whole has neither. `full`: the block's text and the context too.
 */
function agentPlace(thread: ThreadView, full: boolean): Record<string, unknown> {
  const { place, context } = thread;
  if (place.found === 'note') return {};
  const position = {
    found: place.found,
    ...(place.how ? { how: place.how, similarity: place.similarity } : {}),
    ...(place.found !== 'lost'
      ? {
          ...(thread.kind === 'range' ? { text: place.text } : {}),
          matchesQuote: place.matches,
          headings: place.headings,
          ...(place.block
            ? full
              ? { block: place.block.ordinal, paragraph: place.block.text }
              : { block: place.block.ordinal }
            : {}),
        }
      : {}),
  };
  return {
    position,
    ...(full && context
      ? {
          context: {
            before: context.prefix,
            after: context.suffix,
            headings: context.headings,
            block: context.block.ordinal,
            paragraph: context.block.text,
          },
        }
      : {}),
  };
}

const kindOf = (thread: ThreadView) => (thread.scope === 'note' ? 'note' : thread.kind);

/** A thread as an agent reads it: its quote, its place, its state and every comment, attributed. */
export function agentThread(thread: ThreadView): Record<string, unknown> {
  return {
    threadId: thread.id,
    status: thread.status,
    kind: kindOf(thread),
    quote: thread.quote,
    ...(thread.orphaned ? { orphaned: true } : {}),
    ...agentPlace(thread, true),
    created: iso(thread.created),
    ...(thread.target ? { sentTo: thread.target.label } : {}),
    ...(thread.delivery ? { delivery: thread.delivery.state } : {}),
    ...(thread.resolvedBy
      ? { resolvedBy: thread.resolvedBy.label, resolvedAt: iso(thread.resolvedAt) }
      : {}),
    comments: thread.comments.map((comment) => ({
      id: comment.id,
      author: comment.author.label,
      authorKind: comment.author.kind === 'agent' ? 'agent' : 'person',
      body: comment.body,
      at: iso(comment.at),
      ...(comment.edited ? { edited: iso(comment.edited) } : {}),
      ...(comment.removed ? { removed: true } : {}),
    })),
  };
}

/**
 * A thread as list_comment_threads gives it: what it is on and where it stands, how many
 * comments, and who wrote the last; read_comment_thread gives the comments themselves.
 */
export function agentThreadSummary(thread: ThreadView): Record<string, unknown> {
  const last = thread.comments.at(-1);
  return {
    threadId: thread.id,
    status: thread.status,
    kind: kindOf(thread),
    quote: thread.quote,
    ...(thread.orphaned ? { orphaned: true } : {}),
    ...agentPlace(thread, false),
    created: iso(thread.created),
    comments: thread.comments.length,
    ...(last
      ? {
          last: {
            author: last.author.label,
            authorKind: last.author.kind === 'agent' ? 'agent' : 'person',
            at: iso(last.edited ?? last.at),
          },
        }
      : {}),
    ...(thread.target ? { sentTo: thread.target.label } : {}),
    ...(thread.delivery ? { delivery: thread.delivery.state } : {}),
  };
}

function threadOutcome(body: {
  noteId: string;
  title?: string;
  thread: ThreadView | null;
  changed?: boolean;
  commentId?: string;
  occurrences?: number;
}): Outcome {
  return {
    data: {
      noteId: body.noteId,
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.changed !== undefined ? { changed: body.changed } : {}),
      ...(body.commentId ? { commentId: body.commentId } : {}),
      ...(body.occurrences !== undefined ? { occurrences: body.occurrences } : {}),
      thread: body.thread ? agentThread(body.thread) : null,
    },
  };
}

const READ_HINT = 'Read one with read_comment_thread (id: the noteId, threadId).';

/** The five tools' handlers, by name. */
export const COMMENT_HANDLERS: Readonly<
  Record<string, (notebook: LocalNotebook, args: Args) => Outcome>
> = {
  list_comment_threads: (notebook, args) => {
    const id = args['id'] as string | undefined;
    const status = (args['status'] as StatusFilter | undefined) ?? 'open';
    if (id !== undefined && args['sentToMe'] !== true) {
      const listed = notebook.noteThreads(id, status);
      const data = {
        noteId: id,
        title: listed.title,
        status: listed.status,
        threads: listed.threads.map(agentThreadSummary),
      };
      return { data, text: [JSON.stringify(data), READ_HINT] };
    }
    const listed = notebook.allThreads({
      status,
      sentToMe: args['sentToMe'] === true,
      ...(id !== undefined ? { noteId: id } : {}),
    });
    const data = {
      status: listed.status,
      threads: listed.threads.map((thread) => ({ ...thread, updated: iso(thread.updated) })),
    };
    return { data, text: [JSON.stringify(data), READ_HINT] };
  },
  read_comment_thread: (notebook, args) =>
    threadOutcome(notebook.readCommentThread(args['id'] as string, args['threadId'] as string)),
  create_comment_thread: (notebook, args) =>
    threadOutcome(
      notebook.changeComments(args['id'] as string, {
        op: 'create',
        body: args['body'] as string,
        ...(args['quote'] !== undefined ? { quote: args['quote'] as string } : {}),
        ...(args['occurrence'] !== undefined ? { occurrence: args['occurrence'] as number } : {}),
      }),
    ),
  reply_to_comment_thread: (notebook, args) =>
    threadOutcome(
      notebook.changeComments(args['id'] as string, {
        op: 'reply',
        threadId: args['threadId'] as string,
        body: args['body'] as string,
      }),
    ),
  resolve_comment_thread: (notebook, args) =>
    threadOutcome(
      notebook.changeComments(args['id'] as string, {
        op: 'status',
        threadId: args['threadId'] as string,
        status: 'resolved',
      }),
    ),
};
