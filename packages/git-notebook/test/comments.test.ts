/**
 * The comment tools in the local MCP server (T60, A1064), with the deleted server's comment
 * tests brought along (T48, T52 item 5): anchoring by quote and occurrence, summaries and whole
 * threads, where a thread is, Trash, and "sent to me" with seen and replied (A1061), between a
 * Mac and an agent's clone over one in-memory remote.
 */
import { readThread } from '@penmoss/sync-client/comments';
import { NOTE_ROOT } from '@penmoss/sync-client/replica';
import * as Y from '@y/y';
import { describe, expect, it } from 'vitest';
import { deliveryOn, macAndAgent, sendFromMac } from './support/comments';

type AgentThread = Record<string, unknown> & {
  threadId: string;
  position?: Record<string, unknown>;
  context?: Record<string, unknown>;
  comments?: Array<Record<string, unknown>>;
};

const OTHER_SESSION = 'f'.repeat(24);

describe('comment threads over the local MCP (rescued from the server, A1064)', () => {
  it('anchors by quote and occurrence, replies and resolves, behind a Resolved filter', async () => {
    const { serve, macNote, mac } = await macAndAgent();
    const { tool } = serve();
    const id = await macNote('Cats', 'A cat and a cat.\n\nOne more cat here.\n');
    const third = await tool('create_comment_thread', {
      id,
      body: 'Which **cat**?',
      quote: 'cat',
      occurrence: 3,
    });
    expect(third.isError).toBeUndefined();
    expect(third.structuredContent).toMatchObject({
      noteId: id,
      title: 'Cats',
      changed: true,
      occurrences: 3,
      thread: {
        quote: 'cat',
        status: 'open',
        kind: 'range',
        position: { found: 'anchor', text: 'cat', block: 2 },
        comments: [{ author: 'Claude Code', authorKind: 'agent', body: 'Which **cat**?' }],
      },
    });
    const threadId = (third.structuredContent['thread'] as AgentThread).threadId;
    const missing = await tool('create_comment_thread', { id, body: 'x', quote: 'dog' });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toMatch(/quote_not_found[\s\S]*read_note/);
    const tooFar = await tool('create_comment_thread', {
      id,
      body: 'x',
      quote: 'cat',
      occurrence: 4,
    });
    expect(tooFar.content[0]!.text).toMatch(/occurs 3 times[\s\S]*occurrence_not_found/);
    const nowhere = await tool('read_comment_thread', { id, threadId: 'nope' });
    expect(nowhere.content[0]!.text).toMatch(/thread_not_found[\s\S]*list_comment_threads/);
    const noNote = await tool('list_comment_threads', { id: '0'.repeat(26) });
    expect(noNote.content[0]!.text).toContain('in this git notebook');

    const reply = await tool('reply_to_comment_thread', { id, threadId, body: 'The third.' });
    expect(reply.structuredContent).toMatchObject({
      changed: true,
      commentId: expect.any(String) as string,
    });
    const resolved = await tool('resolve_comment_thread', { id, threadId });
    expect(resolved.structuredContent['thread']).toMatchObject({
      status: 'resolved',
      resolvedBy: 'Claude Code',
    });
    // Idempotent.
    expect(
      (await tool('resolve_comment_thread', { id, threadId })).structuredContent,
    ).toMatchObject({ changed: false });
    expect((await tool('list_comment_threads', { id })).structuredContent['threads']).toEqual([]);
    const all = (await tool('list_comment_threads', { id, status: 'resolved' })).structuredContent;
    expect(all['threads']).toEqual([
      expect.objectContaining({ threadId, comments: 2, status: 'resolved' }),
    ]);

    // The Mac sees the agent's thread, written as its writer, once it syncs.
    await mac.engine.sync();
    const onMac = readThread(mac.ops.note(id)!, threadId)!;
    expect(onMac.author).toMatchObject({ kind: 'agent', label: 'Claude Code' });
    expect(onMac.comments.map((c) => c.body)).toEqual(['Which **cat**?', 'The third.']);
    expect(onMac.status).toBe('resolved');
  });

  it("lists a note's threads as summaries, and reads one whole", async () => {
    const { serve, macNote } = await macAndAgent();
    const { tool } = serve();
    const id = await macNote('Summaries', 'Summaries only.\n');
    const made = await tool('create_comment_thread', {
      id,
      body: 'A long question',
      quote: 'Summaries',
    });
    const threadId = (made.structuredContent['thread'] as AgentThread).threadId;
    const listed = (await tool('list_comment_threads', { id })).structuredContent as {
      threads: AgentThread[];
    };
    expect(listed.threads).toEqual([
      expect.objectContaining({
        threadId,
        quote: 'Summaries',
        comments: 1,
        last: expect.objectContaining({ author: 'Claude Code', authorKind: 'agent' }) as unknown,
      }),
    ]);
    expect(JSON.stringify(listed)).not.toContain('A long question');
    const read = (await tool('read_comment_thread', { id, threadId })).structuredContent as {
      thread: { comments: Array<{ body: string }> };
    };
    expect(read.thread.comments.map((each) => each.body)).toEqual(['A long question']);
    // Across the notebook: each thread names its note.
    const across = (await tool('list_comment_threads', {})).structuredContent as {
      threads: Array<Record<string, unknown>>;
    };
    expect(across.threads).toEqual([
      expect.objectContaining({ noteId: id, title: 'Summaries', threadId, comments: 1 }),
    ]);
  });

  it('keeps the text around a passage, its headings and block, and says where it is now', async () => {
    const { serve, macNote } = await macAndAgent();
    const { tool } = serve();
    const id = await macNote(
      'Garden',
      '# Garden\n\nSoil is clay.\n\n## Plans\n\nWe should plant the garden in spring, before the rains come.\n',
    );
    const made = (
      await tool('create_comment_thread', { id, body: 'Which month?', quote: 'plant the garden' })
    ).structuredContent as { thread: AgentThread };
    expect(made.thread).toMatchObject({
      kind: 'range',
      quote: 'plant the garden',
      position: {
        found: 'anchor',
        text: 'plant the garden',
        matchesQuote: true,
        headings: ['Garden', 'Plans'],
        block: 4,
        paragraph: 'We should plant the garden in spring, before the rains come.',
      },
      context: {
        before: 'Garden\nSoil is clay.\nPlans\nWe should ',
        after: ' in spring, before the rains come.',
        headings: ['Garden', 'Plans'],
        block: 4,
      },
    });
    const listed = (await tool('list_comment_threads', { id })).structuredContent as {
      threads: AgentThread[];
    };
    expect(listed.threads[0]!.position).toEqual({
      found: 'anchor',
      text: 'plant the garden',
      matchesQuote: true,
      headings: ['Garden', 'Plans'],
      block: 4,
    });
    expect(listed.threads[0]!.context).toBeUndefined();
  });

  it('keeps a thread on the new words when replace_text rewrites its words (A1096)', async () => {
    // Found on the emulator, 5 Nov 2026: the thread was left on the one "s" the words share.
    const { serve, macNote } = await macAndAgent();
    const { tool } = serve();
    const id = await macNote('Test', 'A scratch note for checking.\n');
    const made = (await tool('create_comment_thread', { id, body: 'Rename it', quote: 'scratch' }))
      .structuredContent as { thread: AgentThread };
    const read = (await tool('read_note', { id })).structuredContent as { baseVersion: number };
    const replaced = await tool('replace_text', {
      id,
      find: 'scratch',
      replace: 'test',
      baseVersion: read.baseVersion,
    });
    expect(replaced.isError).toBeFalsy();
    const after = (await tool('read_comment_thread', { id, threadId: made.thread.threadId }))
      .structuredContent as { thread: AgentThread };
    expect(after.thread.position).toMatchObject({ found: 'anchor', text: 'test' });
  });

  it('finds a thread whose text was replaced again by its quote and surroundings', async () => {
    const { serve, macNote, mac, agent } = await macAndAgent();
    const { tool } = serve();
    const id = await macNote('Plans', '## Plans\n\nWe should plant the garden in spring.\n');
    const made = (
      await tool('create_comment_thread', { id, body: 'Which month?', quote: 'plant the garden' })
    ).structuredContent as { thread: AgentThread };
    // The Mac pastes over the paragraph with nearly the same text: its anchor is lost.
    await mac.engine.sync();
    const doc = mac.ops.note(id)!;
    const root = doc.get(NOTE_ROOT);
    doc.transact(() => {
      root.delete(1, 1);
      const paragraph = new Y.Node('paragraph');
      root.insert(1, [paragraph]);
      paragraph.insert(0, 'We should plant teh garden in spring.');
    });
    await mac.engine.sync();
    await agent.engine.sync();
    const read = (await tool('read_comment_thread', { id, threadId: made.thread.threadId }))
      .structuredContent as { thread: AgentThread };
    expect(read.thread).toMatchObject({
      orphaned: true,
      quote: 'plant the garden',
      position: {
        found: 'refound',
        how: 'fuzzy',
        matchesQuote: false,
        headings: ['Plans'],
        block: 2,
        paragraph: 'We should plant teh garden in spring.',
      },
    });
    expect(read.thread.position!['text']).toContain('plant teh garden');
    expect(read.thread.position!['similarity']).toBeGreaterThan(0.8);
  });

  it('starts a thread on the note as a whole without a quote, and lists it first', async () => {
    const { serve, macNote } = await macAndAgent();
    const { tool } = serve();
    const id = await macNote('Lines', 'First line.\n\nSecond line.\n');
    await tool('create_comment_thread', { id, body: 'On a line', quote: 'Second' });
    const whole = (await tool('create_comment_thread', { id, body: 'Add a summary?' }))
      .structuredContent as { thread: AgentThread };
    expect(whole.thread).toMatchObject({ kind: 'note', quote: '' });
    expect(whole.thread.position).toBeUndefined();
    expect(whole.thread.orphaned).toBeUndefined();
    const listed = (await tool('list_comment_threads', { id })).structuredContent as {
      threads: AgentThread[];
    };
    expect(listed.threads.map((each) => each['kind'])).toEqual(['note', 'range']);
  });

  it('leaves a note in Trash alone: agents do not comment there, and the list leaves it out', async () => {
    const { serve, macNote, agent, notebook } = await macAndAgent();
    const { tool } = serve();
    const id = await macNote('Trash and back', 'Trash and back.\n');
    const made = await tool('create_comment_thread', { id, body: 'A question', quote: 'Trash' });
    const threadId = (made.structuredContent['thread'] as AgentThread).threadId;
    notebook.trash(id);
    await agent.engine.sync();
    const refused = await tool('create_comment_thread', { id, body: 'hi' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/in_trash[\s\S]*restore_note/);
    const reply = await tool('reply_to_comment_thread', { id, threadId, body: 'x' });
    expect(reply.content[0]!.text).toContain('in_trash');
    expect(
      (await tool('list_comment_threads', { status: 'all' })).structuredContent['threads'],
    ).toEqual([]);
    // The note's own list still has it (A770: Trash keeps threads).
    expect(
      (await tool('list_comment_threads', { id, status: 'all' })).structuredContent['threads'],
    ).toHaveLength(1);
  });
});

describe('threads sent to this agent (A1061, A1064)', () => {
  it('lists what Ryan sent to me, marks it seen when read and replied when answered, and the Mac sees both', async () => {
    const { serve, macNote, mac, agent, notebook } = await macAndAgent();
    const { tool } = serve();
    const writer = notebook.writerId!;
    expect(writer).toMatch(/^[0-9A-Z]{26}$/);
    const id = await macNote('Garden', 'We should plant the garden in spring.\n');
    const other = await macNote('Other', 'Not for this agent.\n');
    const mine = await sendFromMac(mac, id, 'plant the garden', {
      writer,
      session: 'a'.repeat(24),
      label: 'Claude Code · penmoss',
    });
    await sendFromMac(mac, other, 'Not for', {
      writer: '01JBSOMEONEELSE00000000001',
      session: OTHER_SESSION,
      label: 'Claude Code · elsewhere',
    });
    await agent.engine.sync();

    const sent = (await tool('list_comment_threads', { sentToMe: true })).structuredContent as {
      threads: Array<Record<string, unknown>>;
    };
    expect(sent.threads).toEqual([
      expect.objectContaining({
        noteId: id,
        threadId: mine.threadId,
        sentTo: 'Claude Code · penmoss',
        delivery: 'waiting',
      }),
    ]);
    // sentToMe with a note id: only that note's.
    expect(
      (await tool('list_comment_threads', { id: other, sentToMe: true })).structuredContent[
        'threads'
      ],
    ).toEqual([]);
    // Reading another writer's thread does not mark it.
    const theirs = (await tool('list_comment_threads', { id: other })).structuredContent as {
      threads: AgentThread[];
    };
    await tool('read_comment_thread', { id: other, threadId: theirs.threads[0]!.threadId });
    expect(deliveryOn(agent, other, theirs.threads[0]!.threadId)).toBe('waiting');

    const read = await tool('read_comment_thread', { id, threadId: mine.threadId });
    expect(read.structuredContent['thread']).toMatchObject({ delivery: 'seen' });
    await mac.engine.sync();
    expect(deliveryOn(mac, id, mine.threadId)).toBe('seen');

    await tool('reply_to_comment_thread', { id, threadId: mine.threadId, body: 'Planted in May.' });
    await mac.engine.sync();
    expect(deliveryOn(mac, id, mine.threadId)).toBe('replied');
    const onMac = readThread(mac.ops.note(id)!, mine.threadId)!;
    expect(onMac.delivery).toMatchObject({ commentId: mine.commentId, session: 'a'.repeat(24) });
    expect(onMac.comments.at(-1)).toMatchObject({
      body: 'Planted in May.',
      author: { id: writer, kind: 'agent', label: 'Claude Code' },
    });
  });
});
