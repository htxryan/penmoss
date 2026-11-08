import * as Y from '@y/y';
import { describe, expect, it } from 'vitest';
import {
  addComment,
  commentsBackup,
  restoreThreads,
  anchorAtStart,
  anchorBetween,
  anchoredText,
  anchorForQuote,
  anchorContext,
  createNoteThread,
  createThread,
  deleteComment,
  isNoteThread,
  locateThreads,
  deleteThread,
  editComment,
  keptQuote,
  MAX_QUOTE_CHARS,
  NOTE_COMMENTS,
  openThreadCount,
  orderThreads,
  readThread,
  readThreads,
  reanchorAcrossEdit,
  reanchorAfterUndo,
  resolveAnchor,
  setThreadDelivery,
  setThreadStatus,
  setThreadTarget,
  touchesComments,
  touchesOnlyComments,
  type CommentAnchor,
  type CommentAuthor,
} from '../src/comments';
import { restoreContent, setBody } from '../src/history';
import { initNote, setTitle } from '../src/note';
import { NOTE_ROOT } from '../src/replica';

const RYAN: CommentAuthor = { id: 'device:mac', kind: 'device', label: 'MacBook' };
const CLAUDE: CommentAuthor = { id: 'agent:tok', kind: 'agent', label: 'Claude Code' };

function paragraph(doc: Y.Doc, index: number, text: string): Y.Node {
  const node = new Y.Node('paragraph');
  doc.get(NOTE_ROOT).insert(index, [node]);
  if (text) node.insert(0, text);
  return node;
}

function block(doc: Y.Doc, index: number): Y.Node {
  return doc.get(NOTE_ROOT).get(index) as Y.Node;
}

function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

function note(...lines: string[]): Y.Doc {
  const doc = new Y.Doc();
  initNote(doc, { id: '01NOTE', created: '2026-10-28T09:00:00-05:00', kind: 'note' }, 'Plan');
  lines.forEach((line, index) => paragraph(doc, index, line));
  return doc;
}

function quoteAnchor(doc: Y.Doc, quote: string, occurrence = 1): CommentAnchor {
  const match = anchorForQuote(doc, quote, occurrence);
  if ('error' in match) throw new Error(`no match for ${quote}`);
  return match.anchor;
}

function start(doc: Y.Doc, id: string, anchor: CommentAnchor, quote: string, author = RYAN) {
  createThread(doc, {
    id,
    anchor,
    quote,
    author,
    at: 1000,
    comment: { id: `${id}-c1`, body: 'make this tighter' },
  });
}

const textOf = (doc: Y.Doc, anchor: CommentAnchor) => anchoredText(doc, resolveAnchor(doc, anchor));

describe('comment threads in the note (T48, A770)', () => {
  it('keeps threads, replies, resolve and reopen in the comments root', () => {
    const doc = note('The garden plan needs work.');
    start(doc, 't1', quoteAnchor(doc, 'garden plan'), 'garden plan');
    expect(addComment(doc, 't1', { id: 'c2', author: CLAUDE, body: 'Done.', at: 2000 })).toBe(true);
    expect(editComment(doc, 't1', 'c2', 'Done: tightened.', 2500)).toBe(true);
    expect(setThreadStatus(doc, 't1', 'resolved', CLAUDE, 3000)).toBe(true);
    let thread = readThread(doc, 't1')!;
    expect(thread).toMatchObject({
      quote: 'garden plan',
      status: 'resolved',
      author: RYAN,
      resolvedBy: CLAUDE,
      resolvedAt: 3000,
    });
    expect(thread.comments.map((c) => [c.author.label, c.body, c.edited])).toEqual([
      ['MacBook', 'make this tighter', undefined],
      ['Claude Code', 'Done: tightened.', 2500],
    ]);
    // Resolved threads are kept for good and can be reopened (A777).
    expect(openThreadCount(doc)).toBe(0);
    expect(setThreadStatus(doc, 't1', 'open', RYAN, 4000)).toBe(true);
    thread = readThread(doc, 't1')!;
    expect(thread.status).toBe('open');
    expect(thread.resolvedBy).toBeUndefined();
    expect(openThreadCount(doc)).toBe(1);
    // An agent's reply can be taken back (A779).
    expect(addComment(doc, 't1', { id: 'c3', author: RYAN, body: 'Thanks', at: 5000 })).toBe(true);
    expect(deleteComment(doc, 't1', 'c2')).toBe(true);
    expect(readThread(doc, 't1')!.comments.map((each) => each.id)).toEqual(['t1-c1', 'c3']);
    // The first comment is only marked removed (A784): the replies stay.
    expect(deleteComment(doc, 't1', 't1-c1')).toBe(true);
    expect(deleteComment(doc, 't1', 't1-c1')).toBe(false);
    thread = readThread(doc, 't1')!;
    expect(thread.comments.map((each) => [each.id, each.body, each.removed])).toEqual([
      ['t1-c1', '', true],
      ['c3', 'Thanks', undefined],
    ]);
    expect(editComment(doc, 't1', 't1-c1', 'back', 6000)).toBe(false);
    // Deleting the thread is its own action.
    expect(deleteThread(doc, 't1')).toBe(true);
    expect(readThreads(doc)).toEqual([]);
  });

  it('merges replies written at once on two devices', () => {
    const a = note('One line.');
    start(a, 't1', quoteAnchor(a, 'One'), 'One');
    const b = new Y.Doc();
    sync(a, b);
    addComment(a, 't1', { id: 'ca', author: RYAN, body: 'from the Mac', at: 2000 });
    addComment(b, 't1', { id: 'cb', author: CLAUDE, body: 'from the agent', at: 2001 });
    setThreadTarget(b, 't1', {
      writer: '01JBWRITER0000000000000001',
      session: 's1',
      label: 'Claude · repo',
    });
    sync(a, b);
    for (const doc of [a, b]) {
      const thread = readThread(doc, 't1')!;
      expect(thread.comments.map((c) => c.id).sort()).toEqual(['ca', 'cb', 't1-c1']);
      expect(thread.target).toEqual({
        writer: '01JBWRITER0000000000000001',
        session: 's1',
        label: 'Claude · repo',
      });
    }
  });

  it('a target change clears the old delivery state; the same state twice changes nothing', () => {
    const doc = note('Text.');
    start(doc, 't1', quoteAnchor(doc, 'Text'), 'Text');
    setThreadTarget(doc, 't1', {
      writer: '01JBWRITER0000000000000001',
      session: 's1',
      label: 'one',
    });
    const delivery = { state: 'sent', commentId: 't1-c1', session: 's1', at: 5 } as const;
    expect(setThreadDelivery(doc, 't1', delivery)).toBe(true);
    expect(setThreadDelivery(doc, 't1', { ...delivery, at: 9 })).toBe(false);
    expect(readThread(doc, 't1')!.delivery).toEqual(delivery);
    expect(
      setThreadTarget(doc, 't1', {
        writer: '01JBWRITER0000000000000001',
        session: 's1',
        label: 'one',
      }),
    ).toBe(false);
    expect(
      setThreadTarget(doc, 't1', {
        writer: '01JBWRITER0000000000000001',
        session: 's2',
        label: 'two',
      }),
    ).toBe(true);
    expect(readThread(doc, 't1')!.delivery).toBeUndefined();
  });

  it('tells a comment-only transaction from an edit (A770)', () => {
    const doc = note('Text.');
    const seen: Array<{ only: boolean; any: boolean }> = [];
    doc.on('afterTransaction', (transaction: Y.Transaction) => {
      seen.push({
        only: touchesOnlyComments(doc, transaction),
        any: touchesComments(doc, transaction),
      });
    });
    start(doc, 't1', quoteAnchor(doc, 'Text'), 'Text');
    addComment(doc, 't1', { id: 'c2', author: RYAN, body: 'more', at: 2 });
    setThreadStatus(doc, 't1', 'resolved', RYAN, 3);
    block(doc, 0).insert(0, 'New ');
    setTitle(doc, 'Plan B');
    doc.transact(() => {
      addComment(doc, 't1', { id: 'c3', author: RYAN, body: 'and', at: 4 });
      block(doc, 0).insert(0, 'X');
    });
    doc.transact(() => undefined);
    expect(seen).toEqual([
      { only: true, any: true },
      { only: true, any: true },
      { only: true, any: true },
      { only: false, any: false },
      { only: false, any: false },
      { only: false, any: true },
      { only: false, any: false },
    ]);
  });

  it('restore and revert leave the comments as they are', () => {
    const doc = note('First idea', 'Second idea');
    const version = new Y.Doc();
    Y.applyUpdate(version, Y.encodeStateAsUpdate(doc));
    start(doc, 't1', quoteAnchor(doc, 'First'), 'First');
    block(doc, 1).insert(0, 'Changed ');
    expect(restoreContent(doc, version)).toBe(true);
    expect(readThread(doc, 't1')?.quote).toBe('First');
    // A version that already had threads does not bring them back, nor remove newer ones.
    const withThread = new Y.Doc();
    Y.applyUpdate(withThread, Y.encodeStateAsUpdate(doc));
    deleteThread(doc, 't1');
    start(doc, 't2', quoteAnchor(doc, 'Second'), 'Second');
    block(doc, 0).insert(0, 'Again ');
    restoreContent(doc, withThread);
    expect(readThreads(doc).map((t) => t.id)).toEqual(['t2']);
    expect(doc.get(NOTE_COMMENTS).attrSize).toBe(1);
  });
});

describe('anchors (A771)', () => {
  it('anchors a quote and its occurrence, and refuses what is not there', () => {
    const doc = note('a cat and a cat', 'one more cat');
    expect(textOf(doc, quoteAnchor(doc, 'cat'))).toBe('cat');
    const third = anchorForQuote(doc, 'cat', 3);
    expect(third).toMatchObject({ occurrences: 3, quote: 'cat' });
    expect(resolveAnchor(doc, (third as { anchor: CommentAnchor }).anchor)).toMatchObject({
      orphaned: false,
      from: { path: [1, 9] },
      to: { path: [1, 12] },
    });
    expect(anchorForQuote(doc, 'cat', 4)).toEqual({ error: 'occurrence', occurrences: 3 });
    expect(anchorForQuote(doc, 'dog')).toEqual({ error: 'not_found', occurrences: 0 });
    // A quote across blocks matches the line break between them.
    expect(textOf(doc, quoteAnchor(doc, 'a cat\none'))).toBe('a cat\none');
  });

  it('follows inserts before, inside and after the quote; text typed at its edges stays out', () => {
    const doc = note('The garden plan needs work.');
    const anchor = quoteAnchor(doc, 'garden plan');
    const line = block(doc, 0);
    line.insert(0, 'Today: ');
    line.insert('Today: The garden'.length, ' vegetable');
    // Typed just after the quote's end and just before its start.
    line.insert('Today: The garden vegetable plan'.length, '!');
    line.insert('Today: The '.length, '>');
    expect(textOf(doc, anchor)).toBe('garden vegetable plan');
    paragraph(doc, 0, 'A new first line');
    expect(textOf(doc, anchor)).toBe('garden vegetable plan');
  });

  it('follows deletes; deleting all of the text, or its block, orphans the thread', () => {
    const doc = note('Keep this sentence.', 'Second line.');
    const anchor = quoteAnchor(doc, 'this sentence');
    const line = block(doc, 0);
    line.delete('Keep this '.length, 'sent'.length);
    expect(textOf(doc, anchor)).toBe('this ence');
    line.delete('Keep '.length, 'this ence'.length);
    expect(resolveAnchor(doc, anchor)).toEqual({ orphaned: true });

    const other = quoteAnchor(doc, 'Second');
    doc.get(NOTE_ROOT).delete(1, 1);
    expect(resolveAnchor(doc, other)).toEqual({ orphaned: true });
  });

  it('follows a remote agent edit that replaces the body around the quote', () => {
    const app = note('Intro.', 'The garden plan needs work.', 'Outro.');
    const server = new Y.Doc();
    sync(app, server);
    const anchor = quoteAnchor(app, 'garden plan');
    start(app, 't1', anchor, 'garden plan');
    sync(app, server);
    // The agent rewrites the note on the server (the edit engine's minimal diff, A79).
    const target = new Y.Doc();
    initNote(target, { id: '01NOTE', created: '2026-10-28T09:00:00-05:00', kind: 'note' });
    paragraph(target, 0, 'A new intro.');
    paragraph(target, 1, 'The garden plan needs work, soon.');
    setBody(server, target.get(NOTE_ROOT).toDeltaDeep());
    sync(server, app);
    // Both sides read the same place, through each one's own copy.
    expect(textOf(server, readThread(server, 't1')!.anchor!)).toBe('garden plan');
    expect(textOf(app, anchor)).toBe('garden plan');
  });

  it('an edit that rewrites the quoted words moves the thread onto the new words (A1096)', () => {
    // Found on the emulator, 5 Nov 2026: replace_text turned "scratch" into "test", the body's
    // character diff kept the one "s" the words share, and the thread was left on that "s".
    const doc = note('A scratch note for checking.', 'Tomatoes need staking by June.');
    start(doc, 'word', quoteAnchor(doc, 'scratch'), 'scratch');
    start(doc, 'phrase', quoteAnchor(doc, 'scratch note'), 'scratch note');
    start(doc, 'after', quoteAnchor(doc, 'note for'), 'note for');
    start(doc, 'other', quoteAnchor(doc, 'Tomatoes need staking'), 'Tomatoes need staking');
    start(doc, 'gone', quoteAnchor(doc, 'by June'), 'by June');
    const target = note('A test note for checking.', 'Tomatoes need staking.');
    reanchorAcrossEdit(doc, () => setBody(doc, target.get(NOTE_ROOT).toDeltaDeep()));
    const text = (id: string) => textOf(doc, readThread(doc, id)!.anchor!);
    expect(text('word')).toBe('test');
    expect(text('phrase')).toBe('test note');
    expect(text('after')).toBe('note for');
    expect(text('other')).toBe('Tomatoes need staking');
    // Words deleted with nothing in their place stay orphaned, as before.
    expect(resolveAnchor(doc, readThread(doc, 'gone')!.anchor)).toEqual({ orphaned: true });
  });

  it('an edit elsewhere in the note leaves every anchor as it was (A1096)', () => {
    const doc = note('First line.', 'The garden plan needs work.');
    const anchor = quoteAnchor(doc, 'garden plan');
    start(doc, 't1', anchor, 'garden plan');
    const target = note('The first line, longer.', 'The garden plan needs work.');
    reanchorAcrossEdit(doc, () => setBody(doc, target.get(NOTE_ROOT).toDeltaDeep()));
    expect(readThread(doc, 't1')!.anchor).toEqual(anchor);
    expect(textOf(doc, anchor)).toBe('garden plan');
  });

  it('points: one position, which survives text around it and orphans with its block', () => {
    const doc = note('Point here', 'Next');
    const point = anchorBetween(doc, { path: [0, 5], assoc: 1 })!;
    expect(point.to).toBeNull();
    block(doc, 0).insert(0, '>> ');
    expect(resolveAnchor(doc, point)).toEqual({
      orphaned: false,
      from: { path: [0, 8], assoc: 1 },
      to: null,
    });
    const top = anchorAtStart(doc)!;
    expect(resolveAnchor(doc, top)).toMatchObject({ orphaned: false, from: { path: [0, 0] } });
    doc.get(NOTE_ROOT).delete(0, 1);
    expect(resolveAnchor(doc, point)).toEqual({ orphaned: true });
    // An empty note: the start is still a place.
    const empty = note();
    expect(resolveAnchor(empty, anchorAtStart(empty))).toMatchObject({ orphaned: false });
  });

  it('re-anchors a thread whose text the undoing client brought back; other clients then agree', () => {
    for (const remove of ['text', 'block'] as const) {
      const doc = note('First line.', 'The garden plan needs work.', 'Last line.');
      const other = new Y.Doc();
      sync(doc, other);
      createThread(doc, {
        id: 't1',
        anchor: quoteAnchor(doc, 'garden plan'),
        quote: 'garden plan',
        author: RYAN,
        at: 1,
        comment: { id: 'c1', body: 'tighter' },
      });
      const undo = new Y.UndoManager(doc.get(NOTE_ROOT), { trackedOrigins: new Set(['editor']) });
      doc.transact(() => {
        if (remove === 'text') block(doc, 1).delete(4, 11);
        else doc.get(NOTE_ROOT).delete(1, 1);
      }, 'editor');
      const anchor = () => readThread(doc, 't1')!.anchor;
      expect(resolveAnchor(doc, anchor()).orphaned).toBe(true);
      undo.undo();
      // Yjs leaves it orphaned for everyone: only the undoing client can follow the undone delete.
      expect(resolveAnchor(doc, anchor()).orphaned).toBe(true);
      expect(resolveAnchor(doc, anchor(), { followUndone: true }).orphaned).toBe(false);
      expect(reanchorAfterUndo(doc).map((each) => each.id)).toEqual(['t1']);
      expect(anchoredText(doc, resolveAnchor(doc, anchor()))).toBe('garden plan');
      sync(doc, other);
      expect(anchoredText(other, resolveAnchor(other, readThread(other, 't1')!.anchor))).toBe(
        'garden plan',
      );
      // Nothing left to do: a second pass writes nothing.
      expect(reanchorAfterUndo(doc)).toEqual([]);
    }
  });

  it('matches quotes across links, hard breaks and blank lines (A771)', () => {
    const doc = note('', 'Last line.');
    const line = block(doc, 0);
    const link = new Y.Node('wikilink');
    line.insert(0, 'Call ');
    line.insert(5, [link]);
    link.setAttr('target', 'Bob');
    line.insert(6, ' about the garden');
    line.insert(23, [new Y.Node('hardBreak')]);
    line.insert(24, 'then rest.');
    const aliased = new Y.Node('wikilink');
    line.insert(34, [aliased]);
    aliased.setAttr('target', 'Plans');
    aliased.setAttr('alias', 'the plan');
    // A link as its label, as the note shows it, or as read_note's markdown.
    for (const quote of [
      'Call Bob about',
      'Call [[Bob]] about',
      'Bob',
      'the plan',
      '[[Plans|the plan]]',
    ]) {
      const match = anchorForQuote(doc, quote);
      expect(match, quote).not.toHaveProperty('error');
      if ('error' in match) continue;
      expect(textOf(doc, match.anchor), quote).toBe(
        quote.replace('[[Bob]]', 'Bob').replace('[[Plans|the plan]]', 'the plan'),
      );
    }
    // A hard break is a line break, as is the end of a block.
    expect(anchorForQuote(doc, 'garden\nthen')).not.toHaveProperty('error');
    expect(anchorForQuote(doc, 'Call  about')).toMatchObject({ error: 'not_found' });

    // Blank lines between blocks are one break, in the note and in the quote.
    const spaced = note('First para.', '', '', 'Second para.');
    for (const quote of ['para.\n\nSecond', 'para.\nSecond', 'para.\n\n\nSecond']) {
      const match = anchorForQuote(spaced, quote);
      expect(match, JSON.stringify(quote)).not.toHaveProperty('error');
      if (!('error' in match)) expect(textOf(spaced, match.anchor)).toBe('para.\nSecond');
    }

    // A code block's own blank lines read the same way, so its quote still matches.
    const code = note('Before.');
    const fence = new Y.Node('codeBlock');
    code.get(NOTE_ROOT).insert(1, [fence]);
    fence.insert(0, 'x = 1\n\n  \ny = 2');
    for (const quote of ['x = 1\n\n  \ny = 2', 'x = 1\n\ny = 2', 'x = 1\ny = 2']) {
      const match = anchorForQuote(code, quote);
      expect(match, JSON.stringify(quote)).not.toHaveProperty('error');
      // Read back as the note's visible text reads, blank lines as one break.
      if (!('error' in match)) expect(textOf(code, match.anchor)).toBe('x = 1\ny = 2');
    }
    expect(anchorForQuote(code, '1\ny')).not.toHaveProperty('error');
  });

  it('lists threads in document order, orphans last', () => {
    const doc = note('alpha beta gamma', 'delta');
    start(doc, 'g', quoteAnchor(doc, 'gamma'), 'gamma');
    start(doc, 'd', quoteAnchor(doc, 'delta'), 'delta');
    start(doc, 'a', quoteAnchor(doc, 'alpha'), 'alpha');
    start(doc, 'b', quoteAnchor(doc, 'beta'), 'beta');
    block(doc, 0).delete('alpha '.length, 'beta'.length);
    const order = orderThreads(doc, readThreads(doc));
    expect(order.map((p) => [p.thread.id, p.anchor.orphaned])).toEqual([
      ['a', false],
      ['g', false],
      ['d', false],
      ['b', true],
    ]);
  });

  it('keeps long quotes short and trims blank lines around them', () => {
    expect(keptQuote('\n\nquoted\n')).toBe('quoted');
    const long = keptQuote('x'.repeat(MAX_QUOTE_CHARS + 50));
    expect(long).toHaveLength(MAX_QUOTE_CHARS);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('the comments backup (A786)', () => {
  it('writes each thread with its text and occurrence, and makes it again in a rebuilt note', () => {
    const doc = note('A cat and a cat.', 'One more cat here.', 'Last line.');
    start(doc, 't1', quoteAnchor(doc, 'cat', 2), 'cat');
    addComment(doc, 't1', { id: 'r1', author: CLAUDE, body: 'Which cat?', at: 2000 });
    deleteComment(doc, 't1', 't1-c1');
    setThreadTarget(doc, 't1', {
      writer: '01JBWRITER0000000000000001',
      session: 'key',
      label: 'Claude · garden',
    });
    setThreadDelivery(doc, 't1', { state: 'sent', commentId: 'r1', session: 'key', at: 3000 });
    // A point at the start of a line, and one at its end.
    start(doc, 'p1', anchorBetween(doc, { path: [1, 0], assoc: 1 })!, 'One more cat here.');
    start(doc, 'p2', anchorBetween(doc, { path: [2, 10], assoc: 1 })!, 'Last line.');
    start(doc, 'gone', quoteAnchor(doc, 'Last'), 'Last');
    setThreadStatus(doc, 'gone', 'resolved', RYAN, 4000);
    block(doc, 2).delete(0, 4);

    const backup = commentsBackup(doc, '01NOTE', 5000);
    const written = JSON.parse(JSON.stringify(backup)) as typeof backup;
    expect(written).toMatchObject({ version: 1, noteId: '01NOTE', at: 5000 });
    const t1 = written.threads.find((each) => each.id === 't1')!;
    expect(t1).toMatchObject({ text: 'cat', occurrence: 2, kind: 'range', status: 'open' });
    expect(t1.comments.map((each) => [each.id, each.body, each.removed])).toEqual([
      ['t1-c1', '', true],
      ['r1', 'Which cat?', undefined],
    ]);
    expect(written.threads.find((each) => each.id === 'gone')).toMatchObject({
      orphaned: true,
      status: 'resolved',
    });

    // The note rebuilt from its markdown: new Yjs items, the same text.
    const rebuilt = note('A cat and a cat.', 'One more cat here.', ' line.');
    expect(restoreThreads(rebuilt, written)).toEqual({ restored: 4, orphaned: 1 });
    const anchorText = (id: string) => textOf(rebuilt, readThread(rebuilt, id)!.anchor!);
    expect(anchorText('t1')).toBe('cat');
    // The second "cat": the text before it is the same in the rebuilt note.
    const second = resolveAnchor(rebuilt, readThread(rebuilt, 't1')!.anchor);
    expect(second.orphaned ? null : second.from.path).toEqual([0, 12]);
    const point = (id: string) => {
      const found = resolveAnchor(rebuilt, readThread(rebuilt, id)!.anchor);
      return found.orphaned ? null : found.from.path;
    };
    expect(point('p1')).toEqual([1, 0]);
    expect(point('p2')).toEqual([2, 6]);
    expect(resolveAnchor(rebuilt, readThread(rebuilt, 'gone')!.anchor).orphaned).toBe(true);
    const back = readThread(rebuilt, 't1')!;
    expect(back.target).toEqual({
      writer: '01JBWRITER0000000000000001',
      session: 'key',
      label: 'Claude · garden',
    });
    expect(back.delivery).toMatchObject({ state: 'sent', commentId: 'r1' });
    expect(back.comments[0]).toMatchObject({ removed: true, body: '' });
    expect(readThread(rebuilt, 'gone')).toMatchObject({ status: 'resolved', resolvedBy: RYAN });
    // Threads the note has already are left as they are.
    expect(restoreThreads(rebuilt, written)).toEqual({ restored: 0, orphaned: 0 });
  });
});

function heading(doc: Y.Doc, index: number, level: number, text: string): Y.Node {
  const node = new Y.Node('heading');
  doc.get(NOTE_ROOT).insert(index, [node]);
  node.setAttr('level', level);
  node.insert(0, text);
  return node;
}

/** A note with headings: # Garden, ## Plans (T52 item 5). */
function plans(): Y.Doc {
  const doc = note();
  heading(doc, 0, 1, 'Garden');
  paragraph(doc, 1, 'Soil is clay.');
  heading(doc, 2, 2, 'Plans');
  paragraph(doc, 3, 'We should plant the garden in spring, before the rains come.');
  heading(doc, 4, 2, 'Costs');
  paragraph(doc, 5, 'Seeds cost little.');
  return doc;
}

describe('where a thread is (T52 item 5)', () => {
  it('keeps the text around a new thread, its headings and its block', () => {
    const doc = plans();
    start(doc, 't1', quoteAnchor(doc, 'plant the garden'), 'plant the garden');
    expect(readThread(doc, 't1')!.context).toEqual({
      prefix: 'Garden\nSoil is clay.\nPlans\nWe should ',
      suffix: ' in spring, before the rains come.\nCosts\nSeeds cost little.',
      headings: ['Garden', 'Plans'],
      block: { ordinal: 4, text: 'We should plant the garden in spring, before the rains come.' },
    });
  });

  it('keeps at most 60 characters on each side, and a point’s on either side of it', () => {
    const doc = note('x'.repeat(100) + 'MIDDLE' + 'y'.repeat(100));
    const context = anchorContext(doc, quoteAnchor(doc, 'MIDDLE'))!;
    expect(context.prefix).toBe('x'.repeat(60));
    expect(context.suffix).toBe('y'.repeat(60));
    const point = anchorBetween(doc, { path: [0, 3], assoc: 1 })!;
    expect(anchorContext(doc, point)).toMatchObject({ prefix: 'xxx', headings: [] });
  });

  it('says where an anchored thread is now and whether its text still matches', () => {
    const doc = plans();
    start(doc, 't1', quoteAnchor(doc, 'plant the garden'), 'plant the garden');
    // An edit inside the passage: still anchored, no longer the quote.
    const body = block(doc, 3);
    body.insert('We should plant the '.length, 'vegetable ');
    const [place] = locateThreads(doc, readThreads(doc));
    expect(place).toMatchObject({
      found: 'anchor',
      text: 'plant the vegetable garden',
      matches: false,
      headings: ['Garden', 'Plans'],
      block: {
        ordinal: 4,
        text: 'We should plant the vegetable garden in spring, before the rains come.',
      },
    });
  });

  it('finds an orphaned thread again by its quote and surroundings, and says how', () => {
    const doc = plans();
    start(doc, 't1', quoteAnchor(doc, 'plant the garden'), 'plant the garden');
    // The block is replaced with nearly the same text (a paste over it): the anchor is lost.
    doc.get(NOTE_ROOT).delete(3, 1);
    paragraph(doc, 3, 'We should plant teh garden in spring, before the rains come.');
    expect(resolveAnchor(doc, readThread(doc, 't1')!.anchor).orphaned).toBe(true);
    const [place] = locateThreads(doc, readThreads(doc));
    expect(place).toMatchObject({ found: 'refound', how: 'fuzzy', headings: ['Garden', 'Plans'] });
    expect(place!.text).toContain('plant teh garden');
    expect(place!.similarity).toBeGreaterThan(0.8);
  });

  it('picks the right one of several exact matches by the text around it', () => {
    const doc = note('Buy milk today.', 'Then buy milk again.');
    start(doc, 't1', quoteAnchor(doc, 'milk', 2), 'milk');
    doc.get(NOTE_ROOT).delete(1, 1);
    paragraph(doc, 1, 'Then buy milk again.');
    const [place] = locateThreads(doc, readThreads(doc));
    expect(place).toMatchObject({ found: 'refound', how: 'exact-context', matches: true });
    expect(place!.block).toEqual({ ordinal: 2, text: 'Then buy milk again.' });
  });

  it('finds an orphan from before T52 (no context) by its quote alone, or says it is lost', () => {
    const doc = note('Plant the garden in spring.');
    start(doc, 'old', quoteAnchor(doc, 'garden'), 'garden');
    // An old thread: no context attribute.
    (doc.get(NOTE_COMMENTS).getAttr('old') as Y.Node).deleteAttr('context');
    expect(readThread(doc, 'old')!.context).toBeUndefined();
    doc.get(NOTE_ROOT).delete(0, 1);
    paragraph(doc, 0, 'Plant the garden in autumn.');
    expect(locateThreads(doc, readThreads(doc))[0]).toMatchObject({
      found: 'refound',
      how: 'exact',
      text: 'garden',
      matches: true,
    });
    doc.get(NOTE_ROOT).delete(0, 1);
    paragraph(doc, 0, 'Nothing like it here.');
    expect(locateThreads(doc, readThreads(doc))[0]).toMatchObject({ found: 'lost' });
  });
});

describe('threads on the note as a whole (T52 item 5)', () => {
  it('start at the note’s start with no quote, are listed first and never orphaned', () => {
    const doc = note('First line.', 'Second line.');
    start(doc, 'range', quoteAnchor(doc, 'Second'), 'Second');
    createNoteThread(doc, {
      id: 'whole',
      author: RYAN,
      at: 2000,
      comment: { id: 'whole-c1', body: 'A summary at the top?' },
    });
    const thread = readThread(doc, 'whole')!;
    expect(thread).toMatchObject({ scope: 'note', quote: '' });
    expect(thread.context).toBeUndefined();
    expect(thread.anchor).not.toBeNull();
    expect(isNoteThread(thread)).toBe(true);
    expect(isNoteThread(readThread(doc, 'range')!)).toBe(false);
    // Its first block deleted: still on the note, still first.
    doc.get(NOTE_ROOT).delete(0, 1);
    expect(orderThreads(doc, readThreads(doc)).map((each) => each.thread.id)).toEqual([
      'whole',
      'range',
    ]);
    expect(locateThreads(doc, [thread])[0]).toMatchObject({ found: 'note' });
  });

  it('read a thread from before T52 with no quote at a point as one', () => {
    const doc = note('Text.');
    start(doc, 'legacy', anchorAtStart(doc)!, '');
    expect(isNoteThread(readThread(doc, 'legacy')!)).toBe(true);
  });

  it('come back from the backup as threads on the note, with their context kept', () => {
    const doc = plans();
    createNoteThread(doc, { id: 'whole', author: RYAN, at: 1, comment: { id: 'c', body: 'Hi' } });
    start(doc, 't1', quoteAnchor(doc, 'plant the garden'), 'plant the garden');
    const backup = commentsBackup(doc, '01NOTE', 5);
    const fresh = plans();
    restoreThreads(fresh, JSON.parse(JSON.stringify(backup)) as typeof backup);
    expect(readThread(fresh, 'whole')).toMatchObject({ scope: 'note' });
    expect(readThread(fresh, 't1')!.context).toEqual(readThread(doc, 't1')!.context);
  });
});
