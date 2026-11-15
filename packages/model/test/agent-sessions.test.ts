import * as Y from '@y/y';
import { describe, expect, it } from 'vitest';
import { createThread, readThread, setThreadDelivery } from '../src/comments';
import {
  ACTIVE_MS,
  failGoneDeliveries,
  failGoneDeliveriesSeen,
  GONE_MS,
  FORGET_MS,
  OFFERED_MS,
  offeredSessions,
  readAgentSession,
  readAgentSessions,
  recordAgentSession,
  sessionKey,
} from '../src/agent-sessions';

const WRITER = '01JBWRITER0000000000000001';
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

function entry(key: string, lastSeen: number, label = key) {
  return { key, writer: WRITER, label, name: `mac:/src/${key}`, host: 'mac', lastSeen };
}

describe('agent sessions', () => {
  it('keys a session by its writer and name, stably', async () => {
    const a = await sessionKey(WRITER, 'mac:/src/penmoss');
    expect(a).toMatch(/^[0-9a-f]{24}$/);
    expect(await sessionKey(WRITER, 'mac:/src/penmoss')).toBe(a);
    expect(await sessionKey(WRITER, 'mac:/src/other')).not.toBe(a);
    expect(await sessionKey('01JBWRITER0000000000000002', 'mac:/src/penmoss')).not.toBe(a);
  });

  it('keeps startedAt across heartbeats and merges between replicas', () => {
    const a = new Y.Doc();
    recordAgentSession(a, entry('s1', NOW));
    recordAgentSession(a, entry('s1', NOW + 60_000));
    expect(readAgentSession(a, 's1')).toMatchObject({ startedAt: NOW, lastSeen: NOW + 60_000 });
    const b = new Y.Doc();
    recordAgentSession(b, entry('s2', NOW));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    expect(readAgentSessions(a).map((s) => s.key)).toEqual(['s1', 's2']);
    expect(readAgentSessions(b).map((s) => s.key)).toEqual(['s1', 's2']);
  });

  it('offers running sessions first, then recent ones, and forgets old ones', () => {
    const doc = new Y.Doc();
    recordAgentSession(doc, entry('old', NOW - FORGET_MS - 10_000));
    recordAgentSession(doc, entry('week', NOW - OFFERED_MS - 1));
    recordAgentSession(doc, entry('idle', NOW - ACTIVE_MS - 1));
    recordAgentSession(doc, entry('live', NOW - 1000));
    expect(offeredSessions(doc, NOW).map((s) => s.key)).toEqual(['live', 'idle']);
    // The newest write removed what had not been seen for FORGET_MS.
    expect(readAgentSession(doc, 'old')).toBeNull();
    expect(readAgentSession(doc, 'week')).not.toBeNull();
  });

  it('skips entries it cannot read', () => {
    const doc = new Y.Doc();
    doc.get('agentSessions').setAttr('bad', { writer: 1 });
    expect(readAgentSessions(doc)).toEqual([]);
  });

  it('fails a delivery waiting for a session gone for a week, and only that one', () => {
    const ws = new Y.Doc();
    recordAgentSession(ws, entry('live', NOW - 1000));
    recordAgentSession(ws, entry('away', NOW - GONE_MS - 1));
    const note = new Y.Doc();
    const author = { id: 'ryan', kind: 'device' as const, label: 'Mac' };
    for (const [id, session] of [
      ['t-live', 'live'],
      ['t-away', 'away'],
      ['t-none', 'none'],
    ]) {
      createThread(note, {
        id: id!,
        anchor: null,
        quote: '',
        scope: 'note',
        author,
        at: NOW,
        comment: { id: `c-${id}`, body: 'Look' },
        target: { writer: WRITER, session: session!, label: session! },
      });
      setThreadDelivery(note, id!, {
        state: 'waiting',
        commentId: `c-${id}`,
        session: session!,
        at: NOW,
      });
    }
    expect(failGoneDeliveries(note, ws, NOW).sort()).toEqual(['t-away', 't-none']);
    expect(readThread(note, 't-away')?.delivery).toMatchObject({ state: 'failed', reason: 'gone' });
    expect(readThread(note, 't-live')?.delivery?.state).toBe('waiting');
    expect(failGoneDeliveries(note, ws, NOW)).toEqual([]);
  });

  it('fails the same deliveries from last-seen times alone, for a page without the WorkspaceDoc', () => {
    const note = new Y.Doc();
    const author = { id: 'ryan', kind: 'device' as const, label: 'Pixel' };
    for (const id of ['live', 'away', 'none']) {
      createThread(note, {
        id,
        anchor: null,
        quote: '',
        scope: 'note',
        author,
        at: NOW,
        comment: { id: `c-${id}`, body: 'Look' },
        target: { writer: WRITER, session: id, label: id },
      });
      setThreadDelivery(note, id, { state: 'waiting', commentId: `c-${id}`, session: id, at: NOW });
    }
    const seen = new Map([
      ['live', NOW - GONE_MS],
      ['away', NOW - GONE_MS - 1],
    ]);
    expect(failGoneDeliveriesSeen(note, (key) => seen.get(key) ?? null, NOW).sort()).toEqual([
      'away',
      'none',
    ]);
    expect(readThread(note, 'live')?.delivery?.state).toBe('waiting');
  });
});
