/**
 * Send feedback's outbox (T49, A796): sent once, retried when it may pass, kept when it can't,
 * and the answers sorted (A792). Sending one is the Mac's (feedback-send-mac.test.ts, A1010).
 */
import { describe, expect, it } from 'vitest';
import {
  backoff,
  BACKOFF_FIRST_MS,
  BACKOFF_MAX_MS,
  FeedbackOutbox,
  retryable,
  type SendResult,
} from '../../src/feedback/outbox';
import { memoryFeedbackStore, type OutboxEntry } from '../../src/feedback/store';

function entry(id: string, createdAt = 1): OutboxEntry {
  return {
    id,
    createdAt,
    title: `Report ${id}`,
    payload: JSON.stringify({ submissionId: id }),
    screenshots: [],
    state: 'queued',
    attempts: 0,
    nextAt: 0,
    error: null,
  };
}

function harness(answers: SendResult[], online = { value: true }) {
  const store = memoryFeedbackStore();
  let now = 1_000;
  const sent: string[] = [];
  const timers: number[] = [];
  const outbox = new FeedbackOutbox({
    store,
    online: () => online.value,
    now: () => now,
    send: (item) => {
      sent.push(item.id);
      const answer = answers.shift();
      if (!answer) throw new Error('no answer');
      return Promise.resolve(answer);
    },
    schedule: (_run, ms) => {
      timers.push(ms);
      return () => undefined;
    },
  });
  return { store, outbox, sent, timers, advance: (ms: number) => (now += ms) };
}

const ok = (number: number): SendResult => ({
  ok: true,
  issue: { number, url: `https://github.com/htxryan/penmoss/issues/${number}` },
});
const fail = (status: number, code: string, retry: boolean, retryAfterMs?: number): SendResult => ({
  ok: false,
  retryable: retry,
  error: { status, code, message: code },
  ...(retryAfterMs ? { retryAfterMs } : {}),
});

describe('the feedback outbox', () => {
  it('sends what waited for a GitHub token as soon as one is saved, whatever its backoff (A1012)', async () => {
    const { outbox, sent } = harness([
      fail(0, 'no_github_token', true),
      fail(0, 'no_github_token', true),
      ok(102),
    ]);
    await outbox.enqueue(entry('a'));
    await outbox.flush();
    // Waiting, backed off: a plain flush leaves it.
    expect(sent).toEqual(['a']);
    await outbox.flushWaiting('no_github_token');
    expect(sent).toEqual(['a', 'a']);
    await outbox.flushWaiting('no_github_token');
    expect(sent).toEqual(['a', 'a', 'a']);
    expect(outbox.entries()).toEqual([]);
    // Other waiting codes are not hurried.
    const other = harness([fail(503, 'github_failed', true)]);
    await other.outbox.enqueue(entry('b'));
    await other.outbox.flushWaiting('no_github_token');
    expect(other.sent).toEqual(['b']);
  });

  it('sends at once when online, removes it and tells the toast', async () => {
    const { outbox, store, sent } = harness([ok(101)]);
    const toasts: number[] = [];
    outbox.onSent((_entry, issue) => toasts.push(issue.number));
    const attempt = await outbox.enqueue(entry('a'));
    expect(attempt).toEqual({
      kind: 'sent',
      issue: { number: 101, url: 'https://github.com/htxryan/penmoss/issues/101' },
    });
    expect(sent).toEqual(['a']);
    expect(toasts).toEqual([101]);
    expect(await store.listOutbox()).toEqual([]);
    expect(outbox.entries()).toEqual([]);
  });

  it('queues offline and sends when the connection is back', async () => {
    const online = { value: false };
    const { outbox, sent, store } = harness([ok(102)], online);
    expect(await outbox.enqueue(entry('a'))).toEqual({ kind: 'queued', error: null });
    expect(sent).toEqual([]);
    expect((await store.listOutbox()).map((item) => item.state)).toEqual(['queued']);
    online.value = true;
    await outbox.flush();
    expect(sent).toEqual(['a']);
    expect(outbox.entries()).toEqual([]);
  });

  it('backs off a failure that may pass, and honours Retry-After', async () => {
    const { outbox, sent, advance, timers } = harness([
      fail(503, 'github_failed', true),
      fail(429, 'rate_limited', true, 600_000),
      ok(103),
    ]);
    const first = await outbox.enqueue(entry('a'));
    expect(first.kind).toBe('queued');
    const [queued] = outbox.entries();
    expect(queued!.attempts).toBe(1);
    expect(queued!.nextAt).toBe(1_000 + BACKOFF_FIRST_MS);
    expect(timers.at(-1)).toBe(BACKOFF_FIRST_MS);
    await outbox.flush();
    expect(sent).toEqual(['a']); // not due yet
    advance(BACKOFF_FIRST_MS);
    await outbox.flush();
    expect(outbox.entries()[0]!.nextAt).toBe(1_000 + BACKOFF_FIRST_MS + 600_000);
    advance(600_000);
    await outbox.flush();
    expect(sent).toEqual(['a', 'a', 'a']);
    expect(outbox.entries()).toEqual([]);
  });

  it('keeps a final refusal for Retry or Discard', async () => {
    const { outbox, store, sent } = harness([fail(400, 'invalid', false), ok(104)]);
    const attempt = await outbox.enqueue(entry('a'));
    expect(attempt).toEqual({
      kind: 'failed',
      error: { status: 400, code: 'invalid', message: 'invalid' },
    });
    await outbox.flush();
    expect(sent).toEqual(['a']); // a failed entry is not tried by itself
    expect(await outbox.retry('a')).toMatchObject({ kind: 'sent' });
    expect(await store.listOutbox()).toEqual([]);

    const again = harness([fail(424, 'github_refused', false)]);
    await again.outbox.enqueue(entry('b'));
    await again.outbox.discard('b');
    expect(await again.store.listOutbox()).toEqual([]);
  });

  it('sends oldest first and stops at the first network failure', async () => {
    const { outbox, store, sent } = harness([fail(0, 'network', true)]);
    await store.putOutbox(entry('old', 1));
    await store.putOutbox(entry('new', 2));
    // A flush reads the store first, so what another window queued is sent too.
    await outbox.flush();
    expect(sent).toEqual(['old']);
  });

  it('queues again an entry a closed window left sending', async () => {
    const { outbox, store, sent } = harness([ok(105)]);
    await store.putOutbox({ ...entry('a'), state: 'sending' });
    await outbox.start();
    await outbox.flush();
    expect(sent).toEqual(['a']);
  });

  it('a thrown send is a network failure', async () => {
    const { outbox } = harness([]);
    const attempt = await outbox.enqueue(entry('a'));
    expect(attempt).toEqual({
      kind: 'queued',
      error: { status: 0, code: 'network', message: 'no answer' },
    });
  });
});

describe('Discard, and another window sending', () => {
  it('a Discard during a send that then fails stays discarded', async () => {
    const store = memoryFeedbackStore();
    let release: (result: SendResult) => void = () => undefined;
    const sent: string[] = [];
    const outbox = new FeedbackOutbox({
      store,
      online: () => true,
      send: (item) => {
        sent.push(item.id);
        return new Promise<SendResult>((resolve) => {
          release = resolve;
        });
      },
      schedule: () => () => undefined,
    });
    const sending = outbox.enqueue(entry('a'));
    await expect.poll(() => sent.length).toBe(1);
    const discarding = outbox.discard('a');
    release(fail(503, 'github_failed', true));
    await sending;
    const removed = await discarding;
    expect(removed?.id).toBe('a');
    expect(await store.listOutbox()).toEqual([]);
    await outbox.flush();
    expect(sent).toEqual(['a']);
    // Edit puts it back with the same id: it is sent again.
    const again = outbox.enqueue(entry('a'));
    await expect.poll(() => sent.length).toBe(2);
    release(ok(2));
    expect(await again).toMatchObject({ kind: 'sent' });
  });

  it('says when another window holds the lock, rather than offline', async () => {
    const store = memoryFeedbackStore();
    const outbox = new FeedbackOutbox({
      store,
      online: () => true,
      send: () => Promise.resolve(ok(1)),
      exclusive: () => Promise.resolve(false),
      schedule: () => () => undefined,
    });
    expect(await outbox.enqueue(entry('a'))).toEqual({ kind: 'elsewhere' });
  });

  it('waits for the lock before removing an entry', async () => {
    const order: string[] = [];
    const store = memoryFeedbackStore();
    const outbox = new FeedbackOutbox({
      store,
      online: () => false,
      send: () => Promise.resolve(ok(1)),
      exclusiveWait: async (work) => {
        order.push('lock');
        await work();
        order.push('unlock');
      },
      schedule: () => () => undefined,
    });
    await outbox.enqueue(entry('a'));
    await outbox.discard('a');
    expect(order).toEqual(['lock', 'unlock']);
    expect(await store.listOutbox()).toEqual([]);
  });

  it('Edit hands the entry over under the lock, and removes it only after', async () => {
    const order: string[] = [];
    const store = memoryFeedbackStore();
    const outbox = new FeedbackOutbox({
      store,
      online: () => false,
      send: () => Promise.resolve(ok(1)),
      exclusiveWait: async (work) => {
        order.push('lock');
        await work();
        order.push('unlock');
      },
      schedule: () => () => undefined,
    });
    await outbox.enqueue(entry('a'));
    const taken = await outbox.discard('a', async (stored) => {
      order.push(`keep ${stored.id}`);
      expect((await store.listOutbox()).map((item) => item.id)).toEqual(['a']);
    });
    expect(taken?.id).toBe('a');
    expect(order).toEqual(['lock', 'keep a', 'unlock']);
    expect(await store.listOutbox()).toEqual([]);

    // A keep that fails leaves the entry.
    await outbox.enqueue(entry('b'));
    await expect(
      outbox.discard('b', () => Promise.reject(new Error('the draft could not be written'))),
    ).rejects.toThrow('the draft could not be written');
    expect((await store.listOutbox()).map((item) => item.id)).toEqual(['b']);
    expect(outbox.entries().map((item) => item.id)).toEqual(['b']);

    // Gone meanwhile (sent by another window): nothing is handed over.
    await store.deleteOutbox('b');
    let called = false;
    expect(
      await outbox.discard('b', () => {
        called = true;
        return Promise.resolve();
      }),
    ).toBeNull();
    expect(called).toBe(false);
  });
});

describe('backoff and what may pass', () => {
  it('doubles from 5 s to 10 minutes', () => {
    expect([1, 2, 3, 4].map((n) => backoff(n))).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(backoff(30)).toBe(BACKOFF_MAX_MS);
    expect(backoff(1, 120_000)).toBe(120_000);
  });

  it('sorts the answers', () => {
    expect(retryable(0, 'network')).toBe(true);
    expect(retryable(503, 'github_failed')).toBe(true);
    expect(retryable(429, 'rate_limited')).toBe(true);
    expect(retryable(409, 'in_progress')).toBe(true);
    expect(retryable(409, 'submission_taken')).toBe(false);
    expect(retryable(400, 'invalid')).toBe(false);
    expect(retryable(403, 'device_only')).toBe(false);
    expect(retryable(413, 'too_large')).toBe(false);
    expect(retryable(424, 'github_refused')).toBe(false);
  });
});
