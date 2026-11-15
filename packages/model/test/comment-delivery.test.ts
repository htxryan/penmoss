/**
 * The rescued server helpers (T60, A1061, A1064, A1066): planning changes as the server did
 * (quote and occurrence, Trash, agents' limits), the views, and delivery: who is due what, how
 * states advance, what seen and replied write, and the channel's message.
 */
import * as Y from '@y/y';
import { describe, expect, it } from 'vitest';
import {
  createThread,
  readThread,
  setThreadDelivery,
  setThreadStatus,
  setThreadTarget,
  addComment,
  type CommentAuthor,
  type CommentTarget,
} from '../src/comments';
import {
  deliveryAdvances,
  deliveryCandidates,
  deliveryPayload,
  dueComments,
  planCommentChange,
  repliedDelivery,
  seenDelivery,
  viewThread,
  viewThreads,
  type CommentChange,
  type CommentFailure,
  type CommentPlan,
} from '../src/comment-delivery';
import { initNote, setDeleted } from '../src/note';
import { NOTE_ROOT } from '../src/replica';

const RYAN: CommentAuthor = { id: 'device:mac', kind: 'device', label: 'MacBook' };
const WRITER = '01JBAGENTWRITER00000000001';
const CLAUDE: CommentAuthor = { id: WRITER, kind: 'agent', label: 'Claude Code' };
const SESSION = 'a'.repeat(24);
const TARGET: CommentTarget = { writer: WRITER, session: SESSION, label: 'Claude Code · penmoss' };
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

function note(...lines: string[]): Y.Doc {
  const doc = new Y.Doc();
  initNote(doc, { id: '01NOTE', created: '2026-10-28T09:00:00-05:00', kind: 'note' }, 'Plan');
  lines.forEach((line, index) => {
    const node = new Y.Node('paragraph');
    doc.get(NOTE_ROOT).insert(index, [node]);
    if (line) node.insert(0, line);
  });
  return doc;
}

function apply(
  doc: Y.Doc,
  author: CommentAuthor,
  change: CommentChange,
  now = NOW,
): CommentPlan | CommentFailure {
  const plan = planCommentChange(doc, author, change, now);
  if ('write' in plan && plan.write) plan.write(doc);
  return plan;
}

const ok = (plan: CommentPlan | CommentFailure): CommentPlan => {
  if ('ok' in plan) throw new Error(`refused: ${plan.code}`);
  return plan;
};

describe('planning comment changes (rescued from the server)', () => {
  it('anchors by quote and occurrence, on the note as a whole without one, and says why not', () => {
    const doc = note('A cat and a cat.', 'One more cat here.');
    const third = ok(
      apply(doc, CLAUDE, { op: 'create', body: 'Which **cat**?', quote: 'cat', occurrence: 3 }),
    );
    expect(third.occurrences).toBe(3);
    expect(viewThread(doc, third.threadId)).toMatchObject({
      quote: 'cat',
      status: 'open',
      kind: 'range',
      author: CLAUDE,
      place: { found: 'anchor', text: 'cat', matches: true, block: { ordinal: 2 } },
    });
    const whole = ok(apply(doc, RYAN, { op: 'create', body: 'Overall?' }));
    expect(viewThread(doc, whole.threadId)).toMatchObject({ quote: '', scope: 'note' });
    // Document order: the note as a whole first.
    expect(viewThreads(doc).map((t) => t.id)).toEqual([whole.threadId, third.threadId]);
    expect(apply(doc, CLAUDE, { op: 'create', body: 'x', quote: 'dog' })).toMatchObject({
      ok: false,
      status: 422,
      code: 'quote_not_found',
    });
    expect(
      apply(doc, CLAUDE, { op: 'create', body: 'x', quote: 'cat', occurrence: 4 }),
    ).toMatchObject({ code: 'occurrence_not_found', details: { occurrences: 3 } });
    expect(apply(doc, CLAUDE, { op: 'create', body: '   ' })).toMatchObject({
      code: 'invalid_request',
    });
    // A retry with the same id answers the same thread and writes nothing.
    expect(apply(doc, CLAUDE, { op: 'create', id: third.threadId, body: 'again' })).toEqual({
      write: null,
      threadId: third.threadId,
    });
  });

  it('replies, resolves and reopens, behind a Resolved filter', () => {
    const doc = note('Resolve me.');
    const made = ok(apply(doc, RYAN, { op: 'create', body: 'Tighter?', quote: 'Resolve' }));
    const reply = ok(apply(doc, CLAUDE, { op: 'reply', threadId: made.threadId, body: 'Done.' }));
    expect(reply.commentId).toBeTruthy();
    ok(apply(doc, CLAUDE, { op: 'status', threadId: made.threadId, status: 'resolved' }));
    expect(viewThreads(doc)).toEqual([]);
    expect(
      viewThreads(doc, 'resolved').map((t) => [t.resolvedBy?.label, t.comments.length]),
    ).toEqual([['Claude Code', 2]]);
    ok(apply(doc, RYAN, { op: 'status', threadId: made.threadId, status: 'open' }));
    expect(viewThreads(doc, 'all')).toHaveLength(1);
    expect(apply(doc, CLAUDE, { op: 'reply', threadId: 'nope', body: 'x' })).toMatchObject({
      status: 404,
      code: 'thread_not_found',
    });
  });

  it('keeps agents to their own: no Trash, no Send to, no deleting, editing only their own', () => {
    const doc = note('Some text to discuss.');
    const made = ok(apply(doc, RYAN, { op: 'create', body: 'Mine', quote: 'text' }));
    const first = readThread(doc, made.threadId)!.comments[0]!.id;
    expect(
      apply(doc, CLAUDE, { op: 'create', body: 'x', quote: 'discuss', target: TARGET }),
    ).toMatchObject({ status: 403, code: 'agent_not_allowed' });
    expect(
      apply(doc, CLAUDE, { op: 'target', threadId: made.threadId, target: TARGET }),
    ).toMatchObject({
      code: 'agent_not_allowed',
    });
    expect(apply(doc, CLAUDE, { op: 'delete', threadId: made.threadId })).toMatchObject({
      code: 'agent_not_allowed',
    });
    expect(
      apply(doc, CLAUDE, { op: 'edit', threadId: made.threadId, commentId: first, body: 'x' }),
    ).toMatchObject({ code: 'not_your_comment' });
    const own = ok(apply(doc, CLAUDE, { op: 'reply', threadId: made.threadId, body: 'Mine too' }));
    ok(
      apply(doc, CLAUDE, {
        op: 'edit',
        threadId: made.threadId,
        commentId: own.commentId!,
        body: 'Edited',
      }),
    );
    expect(readThread(doc, made.threadId)!.comments[1]).toMatchObject({ body: 'Edited' });
    // A person may send and delete.
    ok(apply(doc, RYAN, { op: 'target', threadId: made.threadId, target: TARGET }));
    expect(readThread(doc, made.threadId)!.target).toEqual(TARGET);
    // In Trash: agents do not comment; Ryan still may resolve.
    setDeleted(doc, true);
    expect(apply(doc, CLAUDE, { op: 'reply', threadId: made.threadId, body: 'x' })).toMatchObject({
      status: 409,
      code: 'in_trash',
    });
    expect(apply(doc, CLAUDE, { op: 'create', body: 'x' })).toMatchObject({ code: 'in_trash' });
    ok(apply(doc, RYAN, { op: 'status', threadId: made.threadId, status: 'resolved' }));
    ok(apply(doc, RYAN, { op: 'delete', threadId: made.threadId }));
    expect(readThread(doc, made.threadId)).toBeNull();
  });
});

function targeted(doc: Y.Doc, id = 't1', body = 'make this tighter', at = NOW) {
  createThread(doc, {
    id,
    anchor: null,
    quote: '',
    scope: 'note',
    author: RYAN,
    at,
    comment: { id: `${id}-c1`, body },
    target: TARGET,
  });
  setThreadDelivery(doc, id, { state: 'waiting', commentId: `${id}-c1`, session: SESSION, at });
  return readThread(doc, id)!;
}

describe('delivery (A1061, A1066)', () => {
  it("lists Ryan's comments after the agent's last one, in open targeted threads", () => {
    const doc = note('Text.');
    targeted(doc);
    addComment(doc, 't1', { id: 'a1', author: CLAUDE, body: 'Done', at: NOW + 1 });
    addComment(doc, 't1', { id: 'r2', author: RYAN, body: 'Also this', at: NOW + 2 });
    expect(deliveryCandidates([readThread(doc, 't1')!]).map((c) => c.commentId)).toEqual(['r2']);
    setThreadStatus(doc, 't1', 'resolved', RYAN, NOW + 3);
    expect(deliveryCandidates([readThread(doc, 't1')!])).toEqual([]);
  });

  it('moves states forward only, and a failure ends what was not seen', () => {
    const at = 1;
    const waiting = { state: 'waiting' as const, commentId: 'c', session: SESSION, at };
    expect(deliveryAdvances(undefined, waiting)).toBe(true);
    expect(deliveryAdvances(waiting, { ...waiting, state: 'sent' })).toBe(true);
    expect(deliveryAdvances({ ...waiting, state: 'seen' }, { ...waiting, state: 'sent' })).toBe(
      false,
    );
    expect(deliveryAdvances({ ...waiting, state: 'sent' }, { ...waiting, state: 'failed' })).toBe(
      true,
    );
    expect(deliveryAdvances({ ...waiting, state: 'seen' }, { ...waiting, state: 'failed' })).toBe(
      false,
    );
    expect(deliveryAdvances({ ...waiting, state: 'failed' }, { ...waiting, state: 'sent' })).toBe(
      false,
    );
    // A newer comment, or another session, always replaces it.
    expect(deliveryAdvances({ ...waiting, state: 'replied' }, { ...waiting, commentId: 'd' })).toBe(
      true,
    );
    expect(deliveryAdvances({ ...waiting, state: 'replied' }, { ...waiting, session: 'b' })).toBe(
      true,
    );
  });

  it('is due what was not sent: from the waiting comment on, after the sent one, nothing after a failure', () => {
    const doc = note('Text.');
    let thread = targeted(doc);
    expect(dueComments(thread, SESSION).map((c) => c.id)).toEqual(['t1-c1']);
    expect(dueComments(thread, 'b'.repeat(24))).toEqual([]);
    setThreadDelivery(doc, 't1', { state: 'sent', commentId: 't1-c1', session: SESSION, at: 2 });
    expect(dueComments(readThread(doc, 't1')!, SESSION)).toEqual([]);
    // Ryan adds one before the agent answered: the app writes waiting for it; only it is due.
    addComment(doc, 't1', { id: 'r2', author: RYAN, body: 'And this', at: 3 });
    setThreadDelivery(doc, 't1', { state: 'waiting', commentId: 'r2', session: SESSION, at: 3 });
    expect(dueComments(readThread(doc, 't1')!, SESSION).map((c) => c.id)).toEqual(['r2']);
    // The agent replied; a new comment of Ryan's after that is due, whatever the old record says.
    addComment(doc, 't1', { id: 'a1', author: CLAUDE, body: 'Done', at: 4 });
    addComment(doc, 't1', { id: 'r3', author: RYAN, body: 'Thanks, one more', at: 5 });
    expect(dueComments(readThread(doc, 't1')!, SESSION).map((c) => c.id)).toEqual(['r3']);
    setThreadDelivery(doc, 't1', {
      state: 'failed',
      reason: 'gone',
      commentId: 'r3',
      session: SESSION,
      at: 6,
    });
    expect(dueComments(readThread(doc, 't1')!, SESSION)).toEqual([]);
    // Retargeted: the record goes with it, so the new session gets what is open.
    setThreadTarget(doc, 't1', { ...TARGET, session: 'c'.repeat(24) });
    thread = readThread(doc, 't1')!;
    expect(dueComments(thread, 'c'.repeat(24)).map((c) => c.id)).toEqual(['r3']);
  });

  it('writes seen and replied only for the writer it was sent to', () => {
    const doc = note('Text.');
    const thread = targeted(doc);
    expect(seenDelivery(thread, 'someone-else', NOW)).toBeNull();
    const seen = seenDelivery(thread, WRITER, NOW + 1)!;
    expect(seen).toEqual({ state: 'seen', commentId: 't1-c1', session: SESSION, at: NOW + 1 });
    setThreadDelivery(doc, 't1', seen);
    // Read again: no change.
    expect(seenDelivery(readThread(doc, 't1')!, WRITER, NOW + 2)).toBeNull();
    // A sent that arrives after the read does not take seen back.
    expect(deliveryAdvances(readThread(doc, 't1')!.delivery, { ...seen, state: 'sent' })).toBe(
      false,
    );
    addComment(doc, 't1', { id: 'a1', author: CLAUDE, body: 'Done', at: NOW + 3 });
    const replied = repliedDelivery(readThread(doc, 't1')!, WRITER, NOW + 3)!;
    expect(replied).toMatchObject({ state: 'replied', commentId: 't1-c1', session: SESSION });
    expect(repliedDelivery(readThread(doc, 't1')!, 'someone-else', NOW + 3)).toBeNull();
    setThreadDelivery(doc, 't1', replied);
    expect(repliedDelivery(readThread(doc, 't1')!, WRITER, NOW + 4)).toBeNull();
  });

  it("says who commented, where, on which note, and the comment (the old channel's message)", () => {
    const doc = note('We should plant the garden.');
    const plan = ok(
      apply(doc, RYAN, { op: 'create', body: 'Which month?', quote: 'plant the garden' }),
    );
    const thread = readThread(doc, plan.threadId)!;
    const payload = deliveryPayload('01NOTE', 'Garden', thread, thread.comments[0]!);
    expect(payload).toEqual({
      content:
        'MacBook commented on the note “Garden”.\n\nOn this text:\n> plant the garden\n\nComment:\nWhich month?',
      meta: { thread_id: plan.threadId, note_id: '01NOTE', comment_id: thread.comments[0]!.id },
    });
    const whole = targeted(doc, 't2', 'Add a summary');
    expect(deliveryPayload('01NOTE', '', whole, whole.comments[0]!).content).toBe(
      'MacBook commented on the note “Untitled”.\n\nThe note as a whole.\n\nComment:\nAdd a summary',
    );
  });
});
