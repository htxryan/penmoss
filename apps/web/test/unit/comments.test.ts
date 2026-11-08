import type { ThreadData } from '@penmoss/sync-client/comments';
import { describe, expect, it } from 'vitest';
import { canEdit, deliveryText, deviceAuthor, floats, shownInNote } from '../../src/notes/comments';

const thread = (extra: Partial<ThreadData> = {}): ThreadData => ({
  id: 't1',
  anchor: null,
  quote: 'garden plan',
  status: 'open',
  created: 1,
  author: { id: 'device:d', kind: 'device', label: 'MacBook' },
  comments: [],
  ...extra,
});

describe('comment threads in the app (T48)', () => {
  it('says where delivery to an agent session stands (A1061, A1062)', () => {
    const target = { writer: 'W', session: 'key', label: 'Claude Code · laptop:/src' };
    const at = (state: 'waiting' | 'sent' | 'seen' | 'replied') =>
      deliveryText(thread({ target, delivery: { state, commentId: 'c', session: 'key', at: 1 } }));
    expect(deliveryText(thread())).toBeNull();
    expect(deliveryText(thread({ target }))).toBe('Sending to Claude Code · laptop:/src…');
    expect(at('waiting')).toBe('Waiting for Claude Code · laptop:/src');
    expect(at('sent')).toBe('Sent to Claude Code · laptop:/src');
    expect(at('seen')).toBe('Seen');
    expect(at('replied')).toBe('Replied');
    const failed = (reason?: 'gone' | 'scope' | 'revoked') =>
      deliveryText(
        thread({
          target,
          delivery: {
            state: 'failed',
            commentId: 'c',
            session: 'key',
            at: 1,
            ...(reason ? { reason } : {}),
          },
        }),
      );
    expect(failed('gone')).toBe('Not sent: the session is gone');
    // The server's reasons are still read.
    expect(failed('scope')).toBe('Not sent: Claude Code · laptop:/src can’t see this note');
    expect(failed('revoked')).toBe('Not sent: Claude Code · laptop:/src’s token was revoked');
    expect(failed()).toBe('Not sent to Claude Code · laptop:/src');
  });

  // T59 (D49): no server actor to learn; a git notebook's commits carry the author.
  it('writes as this device, and edits only people’s comments', () => {
    expect(deviceAuthor()).toEqual({ id: 'device:this-device', kind: 'device', label: 'You' });
    expect(canEdit(deviceAuthor())).toBe(true);
    expect(canEdit({ id: 'device:x', kind: 'device', label: 'Pixel' })).toBe(true);
    expect(canEdit({ id: 'agent:x', kind: 'agent', label: 'Claude' })).toBe(false);
  });
});

describe('threads on the note as a whole, and floating ones (T52 item 5)', () => {
  const point = { from: { tname: 'prosemirror' }, to: null };
  const range = { from: { tname: 'prosemirror' }, to: { tname: 'prosemirror' } };
  const placed = (data: ThreadData, orphaned = false) => ({
    thread: data,
    anchor: orphaned
      ? ({ orphaned: true } as const)
      : ({ orphaned: false, from: { path: [0, 0], assoc: 1 }, to: null } as const),
  });

  it('draws no marker for a thread on the note, and floats only threads with a passage', () => {
    const whole = placed(thread({ id: 'whole', anchor: point, quote: '', scope: 'note' }));
    const legacy = placed(thread({ id: 'legacy', anchor: point, quote: '' }));
    const passage = placed(thread({ id: 'passage', anchor: range }));
    const orphan = placed(thread({ id: 'orphan', anchor: range }), true);
    expect(shownInNote([whole, legacy, passage], null).map((each) => each.id)).toEqual(['passage']);
    expect([whole, legacy, passage, orphan].map(floats)).toEqual([false, false, true, false]);
  });
});
