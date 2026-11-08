/**
 * Comment threads on the phone (T48, D40, A770–A784): the page lists the open note's threads
 * for the Comments sheet (`comments`), draws them, says when one is tapped (`commentOpen`), and
 * writes what the sheet asks for in the note's own document, which the app stores and uploads
 * as any other edit. A new thread takes its place first (`commentDraft`), then its comment.
 */
import { NOTE_ROOT } from '@penmoss/sync-client';
import { readAgentSessions, recordAgentSession } from '@penmoss/sync-client/agent-sessions';
import {
  addComment,
  readThread,
  readThreads,
  setThreadDelivery,
} from '@penmoss/sync-client/comments';
import { initNote } from '@penmoss/sync-client/note';
import { createYjs14Replica } from '@penmoss/sync-client/yjs14';
import type { JSONContent } from '@tiptap/core';
import * as Y from '@y/y';
import { fromBase64, toBase64 } from 'lib0/buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { select } from '../../../../packages/editor/test/support/editor';
import {
  BODY_SETTLE_MS,
  COMMENT_GONE,
  COMMENT_NO_DRAFT,
  COMMENT_NOT_YOURS,
  COMMENT_READ_ONLY,
  PHONE_AUTHOR,
} from '../src/comments';
import type { CommentFromEditor, ThreadView } from '../src/comments-protocol';
import { EditorHost } from '../src/host';
import { parseToEditor, type FromEditor, type ToEditor } from '../src/protocol';

const NOTE = '01JD2Z7Q8R4T6Y8W0E2R4T6YB1';
const TARGET = {
  writer: '01JD2Z7Q8R4T6Y8W0E2R4T6YW1',
  session: '0123456789abcdef01234567',
  label: 'Codex · garden',
};
const AGENT = { id: 'agent:01JD2Z7Q8R4T6Y8W0E2R4T6YT1', kind: 'agent', label: 'Codex' } as const;

const hosts: EditorHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.close();
  document.body.replaceChildren();
  vi.useRealTimers();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function opened(content: JSONContent[], editable = true) {
  const root = document.createElement('main');
  root.hidden = true;
  const title = document.createElement('textarea');
  const body = document.createElement('div');
  const unsupported = document.createElement('pre');
  root.append(title, body, unsupported);
  document.body.append(root);
  const sent: FromEditor[] = [];
  const host = new EditorHost({ root, title, body, unsupported }, (message) => sent.push(message), {
    textIdleMs: 5,
  });
  hosts.push(host);
  const server = createYjs14Replica();
  initNote(server.doc, { id: NOTE, created: '2026-10-28T10:00:00-05:00', kind: 'note' }, 'Garden');
  server.doc.transact(() => server.doc.get(NOTE_ROOT).push([new Y.Node('paragraph')]));
  const synced = toBase64(server.encodeStateAsUpdate());
  host.handle({
    v: 1,
    type: 'open',
    noteId: NOTE,
    synced: [{ id: '1', update: synced }],
    pending: [],
    editable,
  });
  const { editor } = host.editor!;
  if (editable) editor.commands.setContent({ type: 'doc', content });
  return { host, sent, body, editor, synced };
}

const paragraph = (value: string): JSONContent => ({
  type: 'paragraph',
  content: [{ type: 'text', text: value }],
});
const send = (host: EditorHost, body: Record<string, unknown>) =>
  host.receive(JSON.stringify({ v: 1, noteId: NOTE, ...body }));

function ofType<T extends FromEditor['type']>(sent: FromEditor[], type: T) {
  return sent.filter((each): each is Extract<FromEditor, { type: T }> => each.type === type);
}
const lastList = (sent: FromEditor[]) => ofType(sent, 'comments').at(-1)!;
const notices = (sent: FromEditor[]) => ofType(sent, 'notice').map((each) => each.message);

/** The document position of `needle`'s first character. */
function at(host: EditorHost, needle: string): number {
  let found = -1;
  host.editor!.editor.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text?.includes(needle))
      found = pos + node.text.indexOf(needle);
    return found < 0;
  });
  if (found < 0) throw new Error(`no text "${needle}"`);
  return found;
}

/** Starts a thread on `needle` (selected) with `body`, as the sheet does; its id. */
async function thread(host: EditorHost, sent: FromEditor[], needle: string, body: string) {
  const view = host.editor!.editor.view;
  select(view, at(host, needle), at(host, needle) + needle.length);
  send(host, { type: 'commentDraft', from: 'caret' });
  send(host, { type: 'commentCreate', body, target: null });
  await settle();
  return lastList(sent).active!;
}

/** Every update the page sent, and the synced note, as one document: what the server holds. */
function serverCopy(host: EditorHost, sent: FromEditor[], synced: string): Y.Doc {
  host.flush();
  const doc = new Y.Doc();
  Y.applyUpdate(doc, fromBase64(synced));
  for (const update of ofType(sent, 'update')) Y.applyUpdate(doc, fromBase64(update.update));
  return doc;
}

describe('comment threads on the phone (T48)', () => {
  it('lists none for a note without threads, as it opens', () => {
    const { sent } = opened([paragraph('Raised beds by the fence.')]);
    expect(ofType(sent, 'comments')[0]).toEqual({
      v: 1,
      type: 'comments',
      noteId: NOTE,
      open: 0,
      active: null,
      threads: [],
    });
  });

  it('starts a thread on the selection: its quote first, then the comment, written as an edit', async () => {
    const { host, sent, body, synced } = opened([paragraph('Raised beds by the fence.')]);
    select(
      host.editor!.editor.view,
      at(host, 'beds'),
      at(host, 'beds') + 'beds by the fence'.length,
    );
    send(host, { type: 'commentDraft', from: 'caret' });
    expect(ofType(sent, 'commentDraft')).toEqual([
      { v: 1, type: 'commentDraft', noteId: NOTE, quote: 'beds by the fence', kind: 'range' },
    ]);
    send(host, { type: 'commentCreate', body: 'Still the plan?', target: TARGET });
    await settle();
    const list = lastList(sent);
    expect(list.open).toBe(1);
    expect(list.threads).toHaveLength(1);
    const [made] = list.threads as ThreadView[];
    expect(list.active).toBe(made!.id);
    expect(made).toMatchObject({
      status: 'open',
      quote: 'beds by the fence',
      orphaned: false,
      kind: 'range',
      author: { kind: 'device', label: 'You' },
      target: TARGET,
    });
    expect(made!.comments).toMatchObject([
      { author: { kind: 'device', label: 'You' }, body: 'Still the plan?' },
    ]);
    // Drawn in the note, picked out as the open one.
    expect(body.querySelector('.pm-comment.pm-comment-active')?.textContent).toBe(
      'beds by the fence',
    );
    // The app stores and uploads it like any edit: the server's copy has the thread.
    const server = serverCopy(host, sent, synced);
    expect(readThreads(server).map((each) => each.comments[0]!.body)).toEqual(['Still the plan?']);
    expect(readThreads(server)[0]!.author).toEqual(PHONE_AUTHOR);
  });

  it('takes the selection the selection menu kept, which the WebView cleared as it closed', () => {
    const { host, sent } = opened([paragraph('Raised beds by the fence.')]);
    const view = host.editor!.editor.view;
    select(view, at(host, 'fence'), at(host, 'fence') + 'fence'.length);
    send(host, { type: 'captureSelection' });
    select(view, at(host, 'Raised'));
    send(host, { type: 'commentDraft', from: 'selection' });
    expect(ofType(sent, 'commentDraft').at(-1)).toMatchObject({ quote: 'fence', kind: 'range' });
  });

  it('puts a thread at the caret, quoting its line, when nothing is selected', () => {
    const { host, sent } = opened([paragraph('Water in the morning.')]);
    select(host.editor!.editor.view, at(host, 'morning'));
    send(host, { type: 'commentDraft', from: 'caret' });
    expect(ofType(sent, 'commentDraft').at(-1)).toMatchObject({
      quote: 'Water in the morning.',
      kind: 'point',
    });
  });

  it('writes nothing without a place, and nothing in a note that cannot change', async () => {
    const { host, sent } = opened([paragraph('Raised beds.')]);
    send(host, { type: 'commentCreate', body: 'Where does this go?', target: null });
    await settle();
    expect(notices(sent)).toContain(COMMENT_NO_DRAFT);
    expect(lastList(sent).threads).toEqual([]);

    const readOnly = opened([], false);
    send(readOnly.host, { type: 'commentDraft', from: 'caret' });
    expect(notices(readOnly.sent)).toContain(COMMENT_READ_ONLY);
    expect(ofType(readOnly.sent, 'commentDraft')).toEqual([]);
  });

  it('replies, edits Ryan’s own comments only, resolves and reopens, and sends to an agent', async () => {
    const { host, sent, synced } = opened([paragraph('Raised beds by the fence.')]);
    const id = await thread(host, sent, 'fence', 'First');
    send(host, { type: 'commentReply', threadId: id, body: 'Second' });
    await settle();
    let shown = lastList(sent).threads[0]!;
    expect(shown.comments.map((each) => each.body)).toEqual(['First', 'Second']);

    send(host, {
      type: 'commentEdit',
      threadId: id,
      commentId: shown.comments[1]!.id,
      body: 'Second, edited',
    });
    await settle();
    shown = lastList(sent).threads[0]!;
    expect(shown.comments[1]).toMatchObject({ body: 'Second, edited' });
    expect(shown.comments[1]!.edited).toEqual(expect.any(Number));

    // An agent's reply arrives from the server; it can be removed (its undo), never rewritten.
    const server = serverCopy(host, sent, synced);
    addComment(server, id, {
      id: '01JD3A0C0MM3NT0AGENT00001',
      author: AGENT,
      body: 'On it',
      at: 5,
    });
    setThreadDelivery(server, id, {
      state: 'replied',
      commentId: '01JD3A0C0MM3NT0AGENT00001',
      session: TARGET.session,
      at: 5,
    });
    send(host, { type: 'remote', update: toBase64(Y.encodeStateAsUpdate(server)) });
    await settle();
    shown = lastList(sent).threads[0]!;
    expect(shown.comments.at(-1)).toMatchObject({
      author: { kind: 'agent', label: 'Codex' },
      body: 'On it',
    });
    expect(shown.delivery).toEqual({ state: 'replied', at: 5 });
    send(host, {
      type: 'commentEdit',
      threadId: id,
      commentId: '01JD3A0C0MM3NT0AGENT00001',
      body: 'Mine now',
    });
    expect(notices(sent)).toContain(COMMENT_NOT_YOURS);
    send(host, { type: 'commentDelete', threadId: id, commentId: '01JD3A0C0MM3NT0AGENT00001' });
    await settle();
    expect(lastList(sent).threads[0]!.comments.map((each) => each.body)).toEqual([
      'First',
      'Second, edited',
    ]);

    send(host, { type: 'commentStatus', threadId: id, status: 'resolved' });
    await settle();
    expect(lastList(sent)).toMatchObject({ open: 0 });
    expect(lastList(sent).threads[0]).toMatchObject({
      status: 'resolved',
      resolvedBy: { kind: 'device', label: 'You' },
    });
    expect(typeof lastList(sent).threads[0]!.resolvedAt).toBe('number');
    send(host, { type: 'commentStatus', threadId: id, status: 'open' });
    await settle();
    expect(lastList(sent).threads[0]!.status).toBe('open');
    expect(lastList(sent).threads[0]!.resolvedBy).toBeUndefined();

    send(host, { type: 'commentTarget', threadId: id, target: TARGET });
    await settle();
    expect(lastList(sent).threads[0]!.target).toEqual(TARGET);
    send(host, { type: 'commentTarget', threadId: id, target: null });
    await settle();
    expect(lastList(sent).threads[0]!.target).toBeUndefined();
  });

  it('marks a thread’s first comment removed, keeping its replies; only Delete thread deletes it (A784)', async () => {
    const { host, sent, synced } = opened([paragraph('Raised beds by the fence.')]);
    const first = await thread(host, sent, 'Raised', 'One');
    const second = await thread(host, sent, 'fence', 'Two');
    send(host, { type: 'commentReply', threadId: first, body: 'A reply' });
    await settle();
    const [opening, reply] = lastList(sent).threads.find((each) => each.id === first)!.comments;
    send(host, { type: 'commentDelete', threadId: first, commentId: opening!.id });
    await settle();
    // The thread stays, its first comment marked removed and its text gone, the reply kept.
    expect(lastList(sent).threads.map((each) => each.id)).toEqual([first, second]);
    const kept = lastList(sent).threads.find((each) => each.id === first)!;
    expect(kept.comments).toEqual([
      expect.objectContaining({ id: opening!.id, body: '', removed: true }),
      expect.objectContaining({ id: reply!.id, body: 'A reply' }),
    ]);
    expect(kept.comments[1]).not.toHaveProperty('removed');
    // So it syncs: the server's copy has it removed too.
    const server = serverCopy(host, sent, synced);
    expect(readThreads(server).find((each) => each.id === first)!.comments[0]).toMatchObject({
      body: '',
      removed: true,
    });
    // A removed comment has no text to edit, and is removed once.
    send(host, { type: 'commentEdit', threadId: first, commentId: opening!.id, body: 'Back' });
    send(host, { type: 'commentDelete', threadId: first, commentId: opening!.id });
    await settle();
    expect(notices(sent).filter((each) => each === COMMENT_GONE)).toHaveLength(2);
    expect(lastList(sent).threads.find((each) => each.id === first)!.comments[0]).toMatchObject({
      body: '',
      removed: true,
    });
    // Delete thread deletes it, replies and all, as it does a thread of one comment.
    send(host, { type: 'commentDeleteThread', threadId: first });
    send(host, { type: 'commentDeleteThread', threadId: second });
    await settle();
    expect(lastList(sent)).toMatchObject({ open: 0, active: null, threads: [] });
  });

  it('writes new threads, replies and resolves as the device the app names (review S5)', async () => {
    const { host, sent, synced } = opened([paragraph('Raised beds by the fence.')]);
    // Before the app has said, "You".
    const before = await thread(host, sent, 'Raised', 'Before');
    const pixel = { id: 'device:01JD2Z7Q8R4T6Y8W0E2R4T6YD1', label: 'Android app (Pixel 9)' };
    host.receive(JSON.stringify({ v: 1, type: 'commentAuthor', ...pixel }));
    const after = await thread(host, sent, 'fence', 'After');
    send(host, { type: 'commentReply', threadId: before, body: 'Reply' });
    send(host, { type: 'commentStatus', threadId: after, status: 'resolved' });
    await settle();
    const server = serverCopy(host, sent, synced);
    const device = { ...pixel, kind: 'device' };
    const made = readThreads(server).find((each) => each.id === after)!;
    expect(made.author).toEqual(device);
    expect(made.comments[0]!.author).toEqual(device);
    expect(made.resolvedBy).toEqual(device);
    const earlier = readThreads(server).find((each) => each.id === before)!;
    expect(earlier.author).toEqual(PHONE_AUTHOR);
    expect(earlier.comments.map((each) => each.author)).toEqual([PHONE_AUTHOR, device]);
    // The sheet names it so at once.
    expect(lastList(sent).threads.find((each) => each.id === after)!.author).toEqual({
      kind: 'device',
      label: 'Android app (Pixel 9)',
    });
  });

  it('says when a delivery failed, and why', async () => {
    const { host, sent, synced } = opened([paragraph('Raised beds by the fence.')]);
    const id = await thread(host, sent, 'fence', 'Can you check?');
    send(host, { type: 'commentTarget', threadId: id, target: TARGET });
    await settle();
    const commentId = lastList(sent).threads[0]!.comments[0]!.id;
    const server = serverCopy(host, sent, synced);
    for (const reason of ['gone', 'scope', 'revoked', undefined] as const) {
      setThreadDelivery(server, id, {
        state: 'failed',
        commentId,
        session: TARGET.session,
        at: 7,
        ...(reason ? { reason } : {}),
      });
      send(host, { type: 'remote', update: toBase64(Y.encodeStateAsUpdate(server)) });
      await settle();
      expect(lastList(sent).threads[0]!.delivery).toEqual({
        state: 'failed',
        at: 7,
        ...(reason ? { reason } : {}),
      });
    }
  });

  it('lists threads in document order, and shows only the open ones and the active one', async () => {
    const { host, sent, body } = opened([paragraph('Raised beds by the fence.')]);
    const later = await thread(host, sent, 'fence', 'Later');
    const earlier = await thread(host, sent, 'Raised', 'Earlier');
    expect(lastList(sent).threads.map((each) => each.id)).toEqual([earlier, later]);
    send(host, { type: 'commentStatus', threadId: later, status: 'resolved' });
    send(host, { type: 'commentActive', threadId: null, reveal: false });
    await settle();
    expect([...body.querySelectorAll('.pm-comment')].map((each) => each.textContent)).toEqual([
      'Raised',
    ]);
    // The sheet opens the resolved one: it shows, picked out, until another is chosen.
    send(host, { type: 'commentActive', threadId: later, reveal: true });
    expect(lastList(sent).active).toBe(later);
    expect(body.querySelector('.pm-comment-active')?.textContent).toBe('fence');
  });

  it('starts a thread on the note as a whole, listed first and never orphaned (T52 item 5)', async () => {
    const { host, sent, body, synced } = opened([paragraph('Raised beds by the fence.')]);
    const passage = await thread(host, sent, 'fence', 'On the fence');
    send(host, { type: 'commentDraft', from: 'note' });
    expect(ofType(sent, 'commentDraft').at(-1)).toEqual({
      v: 1,
      type: 'commentDraft',
      noteId: NOTE,
      quote: '',
      kind: 'note',
    });
    send(host, { type: 'commentCreate', body: 'Is this note still current?', target: null });
    await settle();
    const list = lastList(sent);
    expect(list.threads.map((each) => [each.kind, each.orphaned, each.quote])).toEqual([
      ['note', false, ''],
      ['range', false, 'fence'],
    ]);
    expect(list.threads[1]!.id).toBe(passage);
    // No passage to mark: only the other thread is drawn, whichever is active.
    expect([...body.querySelectorAll('.pm-comment')].map((each) => each.textContent)).toEqual([
      'fence',
    ]);
    // Stored as the server reads it: a note-scoped thread.
    const server = serverCopy(host, sent, synced);
    expect(readThreads(server).find((each) => each.id === list.threads[0]!.id)?.scope).toBe('note');
  });

  it('takes a note comment in an empty note too, which has no place for a passage', async () => {
    const { host, sent } = opened([]);
    send(host, { type: 'commentDraft', from: 'note' });
    send(host, { type: 'commentCreate', body: 'Fill this in', target: null });
    await settle();
    expect(lastList(sent).threads).toMatchObject([{ kind: 'note', orphaned: false }]);
  });

  it('says which thread a tap on a highlight opens', async () => {
    const { host, sent, body } = opened([paragraph('Raised beds by the fence.')]);
    const id = await thread(host, sent, 'fence', 'Tap me');
    send(host, { type: 'commentActive', threadId: null, reveal: false });
    body
      .querySelector<HTMLElement>('.pm-comment')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(ofType(sent, 'commentOpen')).toEqual([
      { v: 1, type: 'commentOpen', noteId: NOTE, threadId: id },
    ]);
    expect(lastList(sent).active).toBe(id);
  });

  it('follows threads changed on another device while the note is open', async () => {
    const { host, sent, synced } = opened([paragraph('Raised beds by the fence.')]);
    const id = await thread(host, sent, 'beds', 'Here');
    const server = serverCopy(host, sent, synced);
    addComment(server, id, {
      id: '01JD3A0C0MM3NT0REMOTE0001',
      author: { id: 'device:mac', kind: 'device', label: 'MacBook' },
      body: 'From the Mac',
      at: 9,
    });
    const before = ofType(sent, 'comments').length;
    send(host, { type: 'remote', update: toBase64(Y.encodeStateAsUpdate(server)) });
    await settle();
    expect(ofType(sent, 'comments').length).toBe(before + 1);
    expect(lastList(sent).threads[0]!.comments.at(-1)).toMatchObject({
      author: { kind: 'device', label: 'MacBook' },
      body: 'From the Mac',
    });
  });

  it('never reports a comment as the note’s text for the offline index (A770)', async () => {
    const { host, sent } = opened([paragraph('Raised beds by the fence.')]);
    // No sleeps for the text's idle timer: a flush sends the text now when, and only when, an
    // edit is waiting for it (as the app going to the background does). The opening's goes first.
    host.flush();
    const texts = ofType(sent, 'text').length;
    expect(texts).toBe(1);
    const updates = ofType(sent, 'update').length;
    await thread(host, sent, 'fence', 'Not text');
    host.flush();
    expect(ofType(sent, 'text').length).toBe(texts);
    // But it is stored and uploaded: an update goes to the app.
    expect(ofType(sent, 'update').length).toBeGreaterThan(updates);
  });

  it('refuses comment messages it cannot read', () => {
    const bad: unknown[] = [
      { type: 'commentReply', threadId: 'x/y', body: 'x' },
      { type: 'commentReply', threadId: 'T1', body: '' },
      { type: 'commentCreate', body: 'x', target: { ...TARGET, session: 'Z' } },
      { type: 'commentActive', threadId: 'T1' },
    ];
    // Nor an author that is not a device's actor, or has no name.
    for (const author of [
      { id: 'agent:T1', label: 'Codex' },
      { id: 'device:', label: 'Pixel' },
      { id: 'device:D1', label: ' ' },
      { id: 'device:D1' },
    ]) {
      expect(parseToEditor(JSON.stringify({ v: 1, type: 'commentAuthor', ...author }))).toBeNull();
    }
    for (const body of bad) {
      expect(parseToEditor(JSON.stringify({ v: 1, noteId: NOTE, ...(body as object) }))).toBeNull();
    }
    const good: ToEditor = { v: 1, type: 'commentReply', noteId: NOTE, threadId: 'T1', body: 'x' };
    expect(parseToEditor(JSON.stringify(good))).toEqual(good);
  });

  it('sends only the list’s changes, never the same list twice', async () => {
    // The page's clock is the test's: "once it settles" is the settle timer having run, not a
    // sleep a little longer than it, which a loaded machine can outlast.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { host, sent } = opened([paragraph('Raised beds by the fence.')]);
    const made = thread(host, sent, 'fence', 'Once');
    await vi.advanceTimersByTimeAsync(0);
    await made;
    const lists = ofType(sent, 'comments').map((each) => JSON.stringify(each as CommentFromEditor));
    expect(new Set(lists).size).toBe(lists.length);
    // Typing elsewhere moves nothing the sheet shows: no new list once it settles.
    host.editor!.editor.commands.insertContentAt(1, 'Two ');
    await vi.advanceTimersByTimeAsync(BODY_SETTLE_MS);
    expect(ofType(sent, 'comments').map((each) => JSON.stringify(each))).toEqual(lists);
  });
});

/** The agent's clone writes `sent`, then its reply and `replied`, as `penmoss mcp --channel` does. */
function agentWrites(server: Y.Doc, threadId: string, commentId: string, reply?: string) {
  setThreadDelivery(server, threadId, {
    state: 'sent',
    commentId,
    session: TARGET.session,
    at: 20,
  });
  if (!reply) return;
  addComment(server, threadId, {
    id: '01JD3A0C0MM3NT0AGENT00009',
    author: AGENT,
    body: reply,
    at: 30,
  });
  setThreadDelivery(server, threadId, {
    state: 'replied',
    commentId,
    session: TARGET.session,
    at: 30,
  });
}

/**
 * What the server's copy held when the page said `commentSent` the `n`th time; `also`: the
 * agent's writes it had already, which the page's later ones build on.
 */
function copyAtSent(sent: FromEditor[], synced: string, n: number, also?: Y.Doc): Y.Doc {
  const at = sent.indexOf(ofType(sent, 'commentSent')[n]!);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, fromBase64(synced));
  if (also) Y.applyUpdate(doc, Y.encodeStateAsUpdate(also));
  for (const each of sent.slice(0, at)) {
    if (each.type === 'update') Y.applyUpdate(doc, fromBase64(each.update));
  }
  return doc;
}

describe('Send to… through the notebook (T60, D50, A1061, A1062)', () => {
  it('a new thread sent to a session waits for it, and says so after its update', async () => {
    const { host, sent, synced } = opened([paragraph('Raised beds by the fence.')]);
    const view = host.editor!.editor.view;
    select(view, at(host, 'fence'), at(host, 'fence') + 5);
    send(host, { type: 'commentDraft', from: 'caret' });
    send(host, { type: 'commentCreate', body: 'Can you check?', target: TARGET });
    await settle();
    const shown = lastList(sent).threads[0]!;
    expect(shown.target).toEqual(TARGET);
    expect(shown.delivery).toEqual({ state: 'waiting', at: shown.delivery?.at });
    expect(typeof shown.delivery?.at).toBe('number');
    expect(ofType(sent, 'commentSent')).toEqual([
      { v: 1, type: 'commentSent', noteId: NOTE, threadId: shown.id },
    ]);
    // The update with the target and `waiting` went first, so the app has it when it syncs.
    const server = copyAtSent(sent, synced, 0);
    expect(readThread(server, shown.id)?.delivery).toMatchObject({
      state: 'waiting',
      commentId: shown.comments[0]!.id,
      session: TARGET.session,
    });
    expect(readThread(server, shown.id)?.target).toEqual(TARGET);
  });

  it('Send to waits for Ryan’s newest comment; the agent’s writes show; his next comment waits again', async () => {
    const { host, sent, synced } = opened([paragraph('Raised beds by the fence.')]);
    const id = await thread(host, sent, 'fence', 'First');
    send(host, { type: 'commentReply', threadId: id, body: 'Second' });
    await settle();
    // Not sent anywhere yet: a reply writes no delivery.
    expect(ofType(sent, 'commentSent')).toEqual([]);
    expect(lastList(sent).threads[0]!.delivery).toBeUndefined();
    send(host, { type: 'commentTarget', threadId: id, target: TARGET });
    await settle();
    const second = lastList(sent).threads[0]!.comments[1]!.id;
    expect(ofType(sent, 'commentSent')).toHaveLength(1);
    expect(readThread(copyAtSent(sent, synced, 0), id)?.delivery).toMatchObject({
      state: 'waiting',
      commentId: second,
    });

    // The agent's clone: sent, then its reply and replied.
    const server = serverCopy(host, sent, synced);
    agentWrites(server, id, second);
    send(host, { type: 'remote', update: toBase64(Y.encodeStateAsUpdate(server)) });
    await settle();
    expect(lastList(sent).threads[0]!.delivery).toEqual({ state: 'sent', at: 20 });
    agentWrites(server, id, second, 'Done');
    send(host, { type: 'remote', update: toBase64(Y.encodeStateAsUpdate(server)) });
    await settle();
    expect(lastList(sent).threads[0]!.delivery).toEqual({ state: 'replied', at: 30 });

    // Send to the same session again, with nothing new from Ryan: nothing changes.
    send(host, { type: 'commentTarget', threadId: id, target: TARGET });
    await settle();
    expect(ofType(sent, 'commentSent')).toHaveLength(1);
    expect(lastList(sent).threads[0]!.delivery?.state).toBe('replied');

    // Ryan answers the agent: waiting again, for his new comment.
    send(host, { type: 'commentReply', threadId: id, body: 'Thanks, one more' });
    await settle();
    const third = lastList(sent).threads[0]!.comments.at(-1)!.id;
    expect(ofType(sent, 'commentSent')).toHaveLength(2);
    expect(readThread(copyAtSent(sent, synced, 1, server), id)?.delivery).toMatchObject({
      state: 'waiting',
      commentId: third,
      session: TARGET.session,
    });

    // Stop sending: no target, no delivery, nothing to sync at once.
    send(host, { type: 'commentTarget', threadId: id, target: null });
    await settle();
    expect(lastList(sent).threads[0]!.target).toBeUndefined();
    expect(lastList(sent).threads[0]!.delivery).toBeUndefined();
    expect(ofType(sent, 'commentSent')).toHaveLength(2);
    // And a reply now goes nowhere.
    send(host, { type: 'commentReply', threadId: id, body: 'Never mind' });
    await settle();
    expect(ofType(sent, 'commentSent')).toHaveLength(2);
  });

  it('a resolved thread’s reply is not sent again', async () => {
    const { host, sent } = opened([paragraph('Raised beds by the fence.')]);
    const id = await thread(host, sent, 'fence', 'First');
    send(host, { type: 'commentTarget', threadId: id, target: TARGET });
    send(host, { type: 'commentStatus', threadId: id, status: 'resolved' });
    send(host, { type: 'commentReply', threadId: id, body: 'Late note' });
    await settle();
    expect(ofType(sent, 'commentSent')).toHaveLength(1);
  });

  it('fails a delivery waiting for a session gone a week, or no longer listed; Send to again waits again', async () => {
    const { host, sent, synced } = opened([paragraph('Raised beds by the fence. Paths.')]);
    const now = Date.now();
    const id = await thread(host, sent, 'fence', 'Gone one');
    const kept = await thread(host, sent, 'Paths', 'Live one');
    const other = { ...TARGET, session: '89abcdef0123456789abcdef', label: 'Claude Code · paths' };
    send(host, { type: 'commentTarget', threadId: id, target: TARGET });
    send(host, { type: 'commentTarget', threadId: kept, target: other });
    await settle();
    // The notebook's WorkspaceDoc as the channels wrote it: one seen 8 days ago, one an hour ago.
    const workspace = new Y.Doc();
    const entry = (key: string, lastSeen: number) => ({
      key,
      writer: TARGET.writer,
      label: key,
      name: `mac:/src/${key}`,
      host: 'mac',
      lastSeen,
    });
    recordAgentSession(workspace, entry(TARGET.session, now - 8 * 24 * 60 * 60_000));
    recordAgentSession(workspace, entry(other.session, now - 60 * 60_000));
    const sessions = readAgentSessions(workspace).map(({ key, lastSeen }) => ({ key, lastSeen }));
    send(host, { type: 'commentSessions', sessions });
    await settle();
    const byId = (threadId: string) => lastList(sent).threads.find((each) => each.id === threadId)!;
    const failed = byId(id).delivery;
    expect(failed).toEqual({ state: 'failed', at: failed?.at, reason: 'gone' });
    expect(failed?.at).toBeGreaterThanOrEqual(now);
    expect(byId(kept).delivery?.state).toBe('waiting');
    // Written in the note, so every device says so.
    expect(readThread(serverCopy(host, sent, synced), id)?.delivery).toMatchObject({
      state: 'failed',
      reason: 'gone',
    });

    // Send to again, to the same session: waiting once more.
    send(host, { type: 'commentTarget', threadId: id, target: TARGET });
    await settle();
    expect(byId(id).delivery?.state).toBe('waiting');
    // A list without the other session: it is gone too.
    send(host, { type: 'commentSessions', sessions: [] });
    await settle();
    expect(byId(kept).delivery).toMatchObject({ state: 'failed', reason: 'gone' });
  });

  it('leaves a read-only note’s deliveries alone, and says nothing', async () => {
    const { host, sent } = opened([paragraph('Raised beds by the fence.')]);
    const id = await thread(host, sent, 'fence', 'Gone one');
    send(host, { type: 'commentTarget', threadId: id, target: TARGET });
    await settle();
    host.editor!.editor.setEditable(false);
    const before = notices(sent).length;
    send(host, { type: 'commentSessions', sessions: [] });
    await settle();
    expect(lastList(sent).threads[0]!.delivery?.state).toBe('waiting');
    expect(notices(sent)).toHaveLength(before);
  });

  it('refuses a target that names a token, and sessions it cannot read', () => {
    const { session, label } = TARGET;
    for (const body of [
      {
        type: 'commentTarget',
        threadId: 'T1',
        target: { token: '01JD2Z7Q8R4T6Y8W0E2R4T6YT1', session, label },
      },
      { type: 'commentTarget', threadId: 'T1', target: { ...TARGET, writer: '../x' } },
      { type: 'commentSessions' },
      { type: 'commentSessions', sessions: [{ key: 'Z', lastSeen: 1 }] },
      { type: 'commentSessions', sessions: [{ key: session, lastSeen: -1 }] },
      { type: 'commentSessions', sessions: [{ key: session }] },
    ]) {
      expect(parseToEditor(JSON.stringify({ v: 1, noteId: NOTE, ...body }))).toBeNull();
    }
  });
});
