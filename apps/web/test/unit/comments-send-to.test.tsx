// @vitest-environment happy-dom
import { recordAgentSession, OFFERED_MS } from '@penmoss/sync-client/agent-sessions';
import {
  orderThreads,
  readThread,
  readThreads,
  setThreadDelivery,
  setThreadTarget,
} from '@penmoss/sync-client/comments';
import { createYjs14Replica, type Yjs14Replica } from '@penmoss/sync-client/yjs14';
import { act, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommentDraft, CommentThread } from '../../src/notes/CommentsPanel';
import {
  markWaiting,
  newestByRyan,
  reply,
  sendTo,
  startThread,
  useGoneDeliveries,
} from '../../src/notes/comments';
import { SourceContext } from '../../src/sources/hooks';
import type { Source } from '../../src/sources/registry';

// T60 (A1060, A1061, A1062, A1065; lifts A908): Send to… in a git notebook lists the agent
// sessions in the notebook's WorkspaceDoc, writes the target and `waiting`, and asks the notebook
// to sync at once; a session gone a week fails the thread, which offers Send to again.

const NOTE = '01JNOTE000000000000000000A';
const RYAN = { id: 'device:this-device', kind: 'device', label: 'You' } as const;
const CLAUDE = { id: 'agent:W1', kind: 'agent', label: 'Claude Code' } as const;
const NOW = Date.UTC(2026, 10, 4, 18, 0, 0);
const HOUR = 60 * 60_000;

/** A notebook's WorkspaceDoc with two sessions: one running, one seen two days ago. */
function workspace() {
  const doc = createYjs14Replica().doc;
  recordAgentSession(doc, {
    key: 'old0000000000000000000000',
    writer: 'W2',
    label: 'Claude Code · notes',
    name: 'mac:/src/notes',
    host: 'mac',
    lastSeen: NOW - 48 * HOUR,
  });
  recordAgentSession(doc, {
    key: 'run0000000000000000000000',
    writer: 'W1',
    label: 'Claude Code · penmoss',
    name: 'mac:/src/penmoss',
    host: 'mac',
    lastSeen: NOW - HOUR,
  });
  return doc;
}

function sourceWith(doc: Yjs14Replica['doc']) {
  const listeners = new Set<() => void>();
  const agentSent = vi.fn<(noteId: string, threadId: string) => Promise<void>>(() =>
    Promise.resolve(),
  );
  let loaded = true;
  const source = {
    id: 'git-1',
    kind: 'git',
    workspace: {
      doc,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getState: () => ({ loaded }),
    },
    agentSent,
  } as unknown as Source;
  return {
    source,
    agentSent,
    setLoaded: (value: boolean) => {
      loaded = value;
      for (const listener of listeners) listener();
    },
  };
}

let unmount = () => undefined as void;
afterEach(() => {
  unmount();
  vi.useRealTimers();
});

function mount(node: React.ReactNode, source: Source | null) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  const render = (next: React.ReactNode) =>
    act(() => root.render(<SourceContext.Provider value={source}>{next}</SourceContext.Provider>));
  render(node);
  return { container, render };
}

/** A thread with Ryan's comment on "garden plan". */
function noteWithThread() {
  const replica = createYjs14Replica();
  const id = startThread(
    replica,
    { anchor: { from: { tname: 'prosemirror' }, to: null }, quote: 'garden plan', kind: 'point' },
    'Plant the tomatoes?',
    RYAN,
    null,
  );
  return { replica, id };
}

/** The thread, kept current as the replica changes (as the panel's useThreads does). */
function Live({ replica, id }: { replica: Yjs14Replica; id: string }) {
  const [, setVersion] = useState(0);
  useEffect(() => replica.onUpdate(() => setVersion((n) => n + 1)), [replica]);
  const placed = orderThreads(replica.doc, readThreads(replica.doc)).find(
    (p) => p.thread.id === id,
  );
  if (!placed) return null;
  return (
    <CommentThread
      placed={placed}
      noteId={NOTE}
      replica={replica}
      active
      onActivate={() => undefined}
      onResolved={() => undefined}
    />
  );
}

function choose(select: HTMLSelectElement, value: string) {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const picker = (container: HTMLElement, testId = 'comment-send-to') =>
  container.querySelector<HTMLSelectElement>(`[data-testid="${testId}"]`);

describe('Send to… in a git notebook (A1065)', () => {
  it('lists the notebook’s sessions, running ones first, others greyed with when last seen', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const { replica, id } = noteWithThread();
    const { source } = sourceWith(workspace());
    const { container } = mount(<Live replica={replica} id={id} />, source);
    const select = picker(container)!;
    expect(select).not.toBeNull();
    const groups = [...select.querySelectorAll('optgroup')].map((group) => ({
      label: group.label,
      options: [...group.querySelectorAll('option')].map((option) => option.textContent),
    }));
    expect(groups[0]).toEqual({ label: 'Running', options: ['Claude Code · penmoss'] });
    expect(groups[1]!.label).toBe('Not running');
    expect(groups[1]!.options[0]).toMatch(/^Claude Code · notes \(last seen .+\)$/);
    const idle = select.querySelector<HTMLOptionElement>(
      'option[value="old0000000000000000000000"]',
    )!;
    expect(idle.className).toBe('comment-send-idle');
    expect(select.querySelector('option[value=""]')!.textContent).toBe('Nobody');
  });

  it('does not offer a session not seen for a week, and says how to start one when none is', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const doc = createYjs14Replica().doc;
    recordAgentSession(doc, {
      key: 'gone000000000000000000000',
      writer: 'W3',
      label: 'Claude Code · away',
      name: 'mac:/away',
      host: 'mac',
      lastSeen: NOW - OFFERED_MS - HOUR,
    });
    const { replica, id } = noteWithThread();
    const { container } = mount(<Live replica={replica} id={id} />, sourceWith(doc).source);
    expect(picker(container)!.querySelectorAll('option')).toHaveLength(1);
    expect(container.querySelector('[data-testid="comment-send-to-none"]')!.textContent).toContain(
      'penmoss mcp --notebook … --channel',
    );
  });

  it('writes the target and waiting for Ryan’s newest comment, and syncs the notebook at once', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const { replica, id } = noteWithThread();
    const { source, agentSent } = sourceWith(workspace());
    const { container } = mount(<Live replica={replica} id={id} />, source);
    choose(picker(container)!, 'run0000000000000000000000');
    const thread = readThread(replica.doc, id)!;
    expect(thread.target).toEqual({
      writer: 'W1',
      session: 'run0000000000000000000000',
      label: 'Claude Code · penmoss',
    });
    expect(thread.delivery).toEqual({
      state: 'waiting',
      commentId: thread.comments[0]!.id,
      session: 'run0000000000000000000000',
      at: NOW,
    });
    expect(agentSent).toHaveBeenCalledWith(NOTE, id);
    expect(container.querySelector('[data-testid="comment-delivery"]')!.textContent).toBe(
      'Waiting for Claude Code · penmoss',
    );
    // Targeted: the first choice stops sending.
    expect(picker(container)!.querySelector('option[value=""]')!.textContent).toBe('Stop sending');
  });

  it('a later comment by Ryan waits again, for that comment, and syncs at once', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const { replica, id } = noteWithThread();
    const { source, agentSent } = sourceWith(workspace());
    const { container } = mount(<Live replica={replica} id={id} />, source);
    choose(picker(container)!, 'run0000000000000000000000');
    // The agent got it and replied.
    const first = readThread(replica.doc, id)!;
    act(() => {
      setThreadDelivery(replica.doc, id, { ...first.delivery!, state: 'replied', at: NOW + 1 });
    });
    expect(container.querySelector('[data-testid="comment-delivery"]')!.textContent).toBe(
      'Replied',
    );
    const field = container.querySelector<HTMLTextAreaElement>('[data-testid="comment-reply"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        field,
        'And the basil',
      );
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() =>
      container.querySelector<HTMLButtonElement>('[data-testid="comment-reply-send"]')!.click(),
    );
    const thread = readThread(replica.doc, id)!;
    expect(thread.comments).toHaveLength(2);
    expect(thread.delivery).toMatchObject({ state: 'waiting', commentId: thread.comments[1]!.id });
    expect(agentSent).toHaveBeenCalledTimes(2);
  });

  it('Stop sending clears the target and its delivery', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const { replica, id } = noteWithThread();
    const { source, agentSent } = sourceWith(workspace());
    const { container } = mount(<Live replica={replica} id={id} />, source);
    choose(picker(container)!, 'run0000000000000000000000');
    choose(picker(container)!, '');
    const thread = readThread(replica.doc, id)!;
    expect(thread.target).toBeUndefined();
    expect(thread.delivery).toBeUndefined();
    expect(container.querySelector('[data-testid="comment-delivery"]')).toBeNull();
    expect(agentSent).toHaveBeenCalledTimes(1);
  });

  it('shows each state the agent’s clone writes', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const { replica, id } = noteWithThread();
    const { container } = mount(<Live replica={replica} id={id} />, sourceWith(workspace()).source);
    choose(picker(container)!, 'run0000000000000000000000');
    const delivery = readThread(replica.doc, id)!.delivery!;
    const said = () => container.querySelector('[data-testid="comment-delivery"]')!;
    for (const [state, text] of [
      ['sent', 'Sent to Claude Code · penmoss'],
      ['seen', 'Seen'],
      ['replied', 'Replied'],
    ] as const) {
      act(() => void setThreadDelivery(replica.doc, id, { ...delivery, state }));
      expect(said().textContent).toBe(text);
      expect(said().getAttribute('data-state')).toBe(state);
    }
  });

  it('a new thread can be sent as it is written', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const replica = createYjs14Replica();
    const { source, agentSent } = sourceWith(workspace());
    const created = vi.fn();
    const { container } = mount(
      <CommentDraft
        noteId={NOTE}
        replica={replica}
        draft={{ anchor: { from: { tname: 'prosemirror' }, to: null }, quote: 'x', kind: 'point' }}
        onCancel={() => undefined}
        onCreated={created}
      />,
      source,
    );
    choose(picker(container, 'comment-new-send-to')!, 'old0000000000000000000000');
    // Nothing is sent yet: nothing to stop.
    expect(
      picker(container, 'comment-new-send-to')!.querySelector('option[value=""]')!.textContent,
    ).toBe('Nobody');
    const field = container.querySelector<HTMLTextAreaElement>('[data-testid="comment-new"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        field,
        'Look at this',
      );
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() =>
      container.querySelector<HTMLButtonElement>('[data-testid="comment-new-send"]')!.click(),
    );
    const [thread] = readThreads(replica.doc);
    expect(thread!.target?.session).toBe('old0000000000000000000000');
    expect(thread!.delivery).toMatchObject({
      state: 'waiting',
      commentId: thread!.comments[0]!.id,
    });
    expect(agentSent).toHaveBeenCalledWith(NOTE, thread!.id);
    expect(created).toHaveBeenCalledWith(thread!.id);
  });

  it('is not shown outside a notebook (no source)', () => {
    const { replica, id } = noteWithThread();
    const { container } = mount(<Live replica={replica} id={id} />, null);
    expect(picker(container)).toBeNull();
    expect(container.querySelector('[data-testid="comment-reply"]')).not.toBeNull();
  });
});

describe('a session gone a week (A1062)', () => {
  function GoneCheck({ replica, source }: { replica: Yjs14Replica; source: Source }) {
    useGoneDeliveries(replica, source.workspace);
    return null;
  }

  it('fails a waiting thread when the note is shown, once the WorkspaceDoc is loaded', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const { replica, id } = noteWithThread();
    const doc = workspace();
    recordAgentSession(doc, {
      key: 'gone000000000000000000000',
      writer: 'W3',
      label: 'Claude Code · away',
      name: 'mac:/away',
      host: 'mac',
      lastSeen: NOW - OFFERED_MS - HOUR,
    });
    sendTo(replica, id, {
      writer: 'W3',
      session: 'gone000000000000000000000',
      label: 'Claude Code · away',
    });
    const { source, setLoaded } = sourceWith(doc);
    setLoaded(false);
    mount(<GoneCheck replica={replica} source={source} />, source);
    // Not before the sessions are read.
    expect(readThread(replica.doc, id)!.delivery!.state).toBe('waiting');
    act(() => setLoaded(true));
    expect(readThread(replica.doc, id)!.delivery).toMatchObject({
      state: 'failed',
      reason: 'gone',
    });
  });

  it('keeps a thread waiting for a session seen this week', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const { replica, id } = noteWithThread();
    const doc = workspace();
    sendTo(replica, id, { writer: 'W2', session: 'old0000000000000000000000', label: 'notes' });
    const { source } = sourceWith(doc);
    mount(<GoneCheck replica={replica} source={source} />, source);
    expect(readThread(replica.doc, id)!.delivery!.state).toBe('waiting');
  });

  it('says so, and Send to again offers the picker; a new session waits again', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const { replica, id } = noteWithThread();
    setThreadTarget(replica.doc, id, {
      writer: 'W3',
      session: 'gone000000000000000000000',
      label: 'away',
    });
    markWaiting(replica, id, NOW);
    const delivery = readThread(replica.doc, id)!.delivery!;
    setThreadDelivery(replica.doc, id, { ...delivery, state: 'failed', reason: 'gone' });
    const { source, agentSent } = sourceWith(workspace());
    const placed = orderThreads(replica.doc, readThreads(replica.doc))[0]!;
    // Not the thread picked: no composer, so the picker shows only once asked.
    const { container, render } = mount(
      <CommentThread
        placed={placed}
        noteId={NOTE}
        replica={replica}
        active={false}
        onActivate={() => undefined}
        onResolved={() => undefined}
      />,
      source,
    );
    expect(container.querySelector('[data-testid="comment-delivery"]')!.textContent).toBe(
      'Not sent: the session is gone Send to again',
    );
    expect(picker(container)).toBeNull();
    act(() =>
      container.querySelector<HTMLButtonElement>('[data-testid="comment-send-again"]')!.click(),
    );
    const select = picker(container)!;
    expect(document.activeElement).toBe(select);
    // The gone session stays named, but cannot be picked again.
    const named = select.querySelector<HTMLOptionElement>(
      'option[value="gone000000000000000000000"]',
    )!;
    expect(named.disabled).toBe(true);
    choose(select, 'run0000000000000000000000');
    const thread = readThread(replica.doc, id)!;
    expect(thread.target?.session).toBe('run0000000000000000000000');
    expect(thread.delivery).toMatchObject({
      state: 'waiting',
      session: 'run0000000000000000000000',
    });
    expect(agentSent).toHaveBeenCalledWith(NOTE, id);
    render(null);
  });
});

describe('the waiting writes (A1061)', () => {
  it('name Ryan’s newest comment, never an agent’s, and nothing without a target', () => {
    const { replica, id } = noteWithThread();
    expect(markWaiting(replica, id)).toBe(false);
    expect(readThread(replica.doc, id)!.delivery).toBeUndefined();
    expect(sendTo(replica, id, { writer: 'W1', session: 's', label: 'L' }, 5)).toBe(true);
    reply(replica, id, 'On it', CLAUDE);
    const thread = readThread(replica.doc, id)!;
    expect(newestByRyan(thread)).toBe(thread.comments[0]!.id);
    // An agent's comment does not wait for anyone.
    expect(thread.delivery).toEqual({
      state: 'waiting',
      commentId: thread.comments[0]!.id,
      session: 's',
      at: 5,
    });
    expect(reply(replica, id, 'Thanks', RYAN)).toBe(true);
    expect(readThread(replica.doc, id)!.delivery!.commentId).toBe(
      readThread(replica.doc, id)!.comments[2]!.id,
    );
  });

  it('a reply in a thread sent to nobody waits for nothing', () => {
    const { replica, id } = noteWithThread();
    expect(reply(replica, id, 'Note to self', RYAN)).toBe(false);
    expect(readThread(replica.doc, id)!.delivery).toBeUndefined();
  });
});
