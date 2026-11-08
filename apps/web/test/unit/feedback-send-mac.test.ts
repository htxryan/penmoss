/**
 * Send feedback in the Mac app goes through its main process, which files it with the person's
 * own GitHub token (T57, A1010): the entry's payload and screenshot bytes go there, and its answer
 * is sorted as the Worker's was (A796) — filed, waiting (no token yet, a 5xx) or refused for good.
 */
import { describe, expect, it, vi } from 'vitest';
import { sendFeedbackOnMac } from '../../src/feedback/send';
import type { OutboxEntry } from '../../src/feedback/store';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

const entry = {
  id: '01JD0000000000000000000009',
  title: 'It broke',
  payload: '{"submissionId":"01JD0000000000000000000009"}',
  screenshots: [{ name: 'screenshot-1.png', type: 'image/png', blob: new Blob([PNG]) }],
} as unknown as OutboxEntry;

describe('sendFeedbackOnMac (A1010)', () => {
  it('hands main the payload and the screenshots’ bytes, and takes the issue back', async () => {
    const file = vi.fn().mockResolvedValue({
      status: 201,
      body: {
        submissionId: entry.id,
        issue: { number: 7, url: 'https://github.com/o/r/issues/7' },
      },
    });
    expect(await sendFeedbackOnMac(file, entry)).toEqual({
      ok: true,
      issue: { number: 7, url: 'https://github.com/o/r/issues/7' },
    });
    expect(file).toHaveBeenCalledWith(entry.payload, [{ type: 'image/png', bytes: PNG }]);
  });

  it('waits while there is no token, and after a 5xx with GitHub’s Retry-After', async () => {
    const none = await sendFeedbackOnMac(
      () =>
        Promise.resolve({
          status: 0,
          body: { error: { code: 'no_github_token', message: 'Add your GitHub token…' } },
        }),
      entry,
    );
    expect(none).toMatchObject({ ok: false, retryable: true, error: { code: 'no_github_token' } });
    const later = await sendFeedbackOnMac(
      () =>
        Promise.resolve({
          status: 503,
          body: { error: { code: 'github_failed', message: 'GitHub answered 502' } },
          retryAfter: 60,
        }),
      entry,
    );
    expect(later).toMatchObject({ ok: false, retryable: true, retryAfterMs: 60_000 });
    expect(await sendFeedbackOnMac(() => Promise.resolve(null), entry)).toMatchObject({
      ok: false,
      retryable: true,
    });
  });

  it('keeps a refusal of the token for Edit, Retry or Discard, in its plain words', async () => {
    const message = 'This GitHub token cannot open issues in htxryan/penmoss.';
    const refused = await sendFeedbackOnMac(
      () =>
        Promise.resolve({ status: 424, body: { error: { code: 'token_cannot_file', message } } }),
      entry,
    );
    expect(refused).toEqual({
      ok: false,
      retryable: false,
      error: { status: 424, code: 'token_cannot_file', message },
    });
  });

  // T59 (D49): no Worker to fall back on outside the Mac app; it waits in the outbox.
  it('waits, and says why, without the Mac app to file it', async () => {
    expect(await sendFeedbackOnMac(null, entry)).toEqual({
      ok: false,
      retryable: true,
      error: { status: 0, code: 'no_filer', message: 'Send feedback works in the Mac app' },
    });
  });

  it('takes no answer, or a thrown one, as a failure that may pass', async () => {
    for (const file of [
      vi.fn().mockResolvedValue(null),
      vi.fn().mockRejectedValue(new Error('x')),
    ]) {
      expect(await sendFeedbackOnMac(file, entry)).toMatchObject({
        ok: false,
        retryable: true,
        error: { status: 0, code: 'network' },
      });
    }
  });
});
