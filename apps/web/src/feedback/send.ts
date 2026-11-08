/**
 * One Send feedback request (T49, A792; T57, A1010): the Mac app's main process files it with the
 * person's own GitHub token. The answer is sorted into sent, may pass (try again later) and final
 * (A796).
 */
import type { SendResult } from './outbox';
import { retryable } from './outbox';
import type { OutboxEntry } from './store';
import type { PenmossDesktop } from '../desktop/bridge';

/** Only an issue on github.com is linked: the answer is not trusted to name a page. */
export const issueLink = (url: string): string | null =>
  /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/.test(url) ? url : null;

type AnswerBody = {
  issue?: { number?: unknown; url?: unknown };
  error?: { code?: unknown; message?: unknown };
};

/** The Mac's main process's answer, as the outbox sorts it. */
function sortAnswer(ok: boolean, status: number, body: AnswerBody, after: number): SendResult {
  if (ok && typeof body.issue?.number === 'number' && typeof body.issue.url === 'string') {
    return { ok: true, issue: { number: body.issue.number, url: body.issue.url } };
  }
  const code = typeof body.error?.code === 'string' ? body.error.code : 'error';
  const message =
    typeof body.error?.message === 'string' ? body.error.message : `GitHub answered ${status}`;
  return {
    ok: false,
    retryable: retryable(ok ? 500 : status, code),
    error: { status, code, message },
    ...(Number.isFinite(after) && after > 0 ? { retryAfterMs: after * 1000 } : {}),
  };
}

type FileFeedback = NonNullable<NonNullable<PenmossDesktop['feedback']>['file']>;

/**
 * Sends `entry` through the Mac app's main process, which files it with the person's own GitHub
 * token (T57, A1010); never throws. With no token it waits (status 0, `no_github_token`) and is
 * sent once one is saved.
 */
export async function sendFeedbackOnMac(
  file: FileFeedback | null,
  entry: OutboxEntry,
): Promise<SendResult> {
  if (!file) {
    // Outside the Mac app nothing can file it: it waits in the outbox.
    return {
      ok: false,
      retryable: true,
      error: { status: 0, code: 'no_filer', message: 'Send feedback works in the Mac app' },
    };
  }
  let answer: Awaited<ReturnType<FileFeedback>>;
  try {
    const screenshots = await Promise.all(
      entry.screenshots.map(async (shot) => ({
        type: shot.type,
        bytes: new Uint8Array(await shot.blob.arrayBuffer()),
      })),
    );
    answer = await file(entry.payload, screenshots);
  } catch {
    answer = null;
  }
  if (!answer) {
    return {
      ok: false,
      retryable: true,
      error: { status: 0, code: 'network', message: 'Penmoss could not file it just now' },
    };
  }
  const { status } = answer;
  return sortAnswer(status >= 200 && status < 300, status, answer.body, answer.retryAfter ?? 0);
}
