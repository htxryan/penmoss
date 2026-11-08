/**
 * Filing feedback on the device with the person's own GitHub token (T57, A1010–A1012), against the
 * fake GitHub the Worker's tests and the e2e suites use: the issue, its screenshots, one issue per
 * submission however often it is sent, and a plain refusal for a token that cannot open issues.
 */
import { describe, expect, it } from 'vitest';
import { fieldGroup } from '../src/feedback';
import {
  FEEDBACK_REPO,
  FEEDBACK_SETTLE_MS,
  FeedbackGitHub,
  fileFeedback,
  memoryLedger,
  TOKEN_MESSAGES,
  type FeedbackAnswer,
} from '../src/feedback-github';
import { FakeFeedbackGitHub } from './support/fake-github-feedback';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 9]);
const ID = '01JD0000000000000000000000';

function setup(token = 'fake-feedback-token') {
  const fake = new FakeFeedbackGitHub();
  const github = new FeedbackGitHub(
    {
      api: fake.base,
      uploads: fake.base,
      owner: FEEDBACK_REPO.owner,
      repo: FEEDBACK_REPO.repo,
      repoId: FEEDBACK_REPO.repoId,
      token,
    },
    fake.fetch,
  );
  return { fake, github, ledger: memoryLedger() };
}

const payload = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    submissionId: ID,
    type: 'bug',
    priority: 2,
    title: 'It broke',
    description: 'Steps: open it. Token ghp_abcdefghijklmnopqrstuvwxyz0123456789 pasted.',
    version: '0.1.385 (385)',
    context: { groups: [fieldGroup('app', [['Client', 'Mac']])] },
    ...extra,
  });

const shots = () => [
  { type: 'image/png', blob: new Blob([PNG], { type: 'image/png' }) },
  { type: 'image/jpeg', blob: new Blob([JPEG], { type: 'image/jpeg' }) },
];

const issueOf = (answer: FeedbackAnswer) => ('issue' in answer.body ? answer.body.issue : null);
const codeOf = (answer: FeedbackAnswer) => ('error' in answer.body ? answer.body.error.code : null);

describe('fileFeedback (the device files with its own token, A1010)', () => {
  it('files the issue with its screenshots, labels and the Mac footer, no token in it', async () => {
    const { fake, github, ledger } = setup();
    const answer = await fileFeedback({
      github,
      ledger,
      payload: payload(),
      screenshots: shots(),
      client: 'mac',
    });
    expect(answer.status).toBe(201);
    expect(issueOf(answer)).toEqual({ number: 101, url: fake.issues[0]!.url });
    expect(fake.uploads.map((u) => [u.name, u.contentType, u.repositoryId])).toEqual([
      ['screenshot-1.png', 'image/png', '1450019106'],
      ['screenshot-2.jpg', 'image/jpeg', '1450019106'],
    ]);
    const issue = fake.issues[0]!;
    expect(issue.labels).toEqual(['in-app feedback', 'bug', 'P2']);
    expect(issue.body).toContain(`![screenshot-1.png](${fake.uploads[0]!.url})`);
    expect(issue.body).toContain(`![screenshot-2.jpg](${fake.uploads[1]!.url})`);
    expect(issue.body).toContain('<details>');
    expect(issue.body.trimEnd()).toMatch(
      new RegExp(`Sent from Penmoss Mac 0\\.1\\.385 \\(385\\) · submission ${ID}$`),
    );
    expect(issue.body).not.toContain('ghp_');
    expect(issue.body).toContain('[token removed]');
    expect(ledger.rows.get(ID)?.status).toBe('sent');
  });

  it('answers a repeat with the issue already filed, and calls GitHub no more', async () => {
    const { fake, github, ledger } = setup();
    const input = {
      github,
      ledger,
      payload: payload(),
      screenshots: shots(),
      client: 'mac' as const,
    };
    const first = await fileFeedback(input);
    const calls = fake.calls.length;
    const again = await fileFeedback(input);
    expect(again.status).toBe(200);
    expect(issueOf(again)).toEqual(issueOf(first));
    expect('duplicate' in again.body && again.body.duplicate).toBe(true);
    expect(fake.calls.length).toBe(calls);
    expect(fake.issues).toHaveLength(1);
  });

  it('adopts the issue a lost answer filed: a retry looks it up by its footer first', async () => {
    const { fake, github, ledger } = setup();
    let now = 1_000_000;
    // GitHub files it, but the answer never arrives.
    fake.fail(
      `/repos/htxryan/penmoss/issues`,
      502,
      1,
      { message: 'Bad gateway' },
      {},
      {
        method: 'POST',
        after: true,
      },
    );
    const input = {
      github,
      ledger,
      payload: payload(),
      screenshots: [],
      client: 'android' as const,
      now: () => now,
    };
    const lost = await fileFeedback(input);
    expect(lost.status).toBe(503);
    expect(fake.issues).toHaveLength(1);
    // Too soon: GitHub may still be writing it.
    const soon = await fileFeedback(input);
    expect(soon.status).toBe(409);
    expect(codeOf(soon)).toBe('in_progress');
    expect(soon.retryAfter).toBe(FEEDBACK_SETTLE_MS / 1000);
    now += FEEDBACK_SETTLE_MS;
    const retry = await fileFeedback(input);
    expect(retry.status).toBe(200);
    expect(issueOf(retry)?.number).toBe(fake.issues[0]!.number);
    expect(fake.issues).toHaveLength(1);
  });

  it('files from an account outside the project on the public repository, labels dropped', async () => {
    const { fake, github, ledger } = setup();
    fake.outsider();
    expect(await github.checkToken()).toEqual({ ok: true, login: 'htxryan' });
    const answer = await fileFeedback({
      github,
      ledger,
      payload: payload(),
      screenshots: [],
      client: 'mac',
    });
    expect(answer.status).toBe(201);
    expect(fake.issues).toHaveLength(1);
    expect(fake.issues[0]!.labels).toEqual([]);
  });

  it("adopts a lost answer's issue whose labels GitHub dropped", async () => {
    const { fake, github, ledger } = setup();
    fake.outsider();
    let now = 1_000_000;
    fake.fail(
      '/repos/htxryan/penmoss/issues',
      502,
      1,
      { message: 'Bad gateway' },
      {},
      {
        method: 'POST',
        after: true,
      },
    );
    const input = {
      github,
      ledger,
      payload: payload(),
      screenshots: [],
      client: 'mac' as const,
      now: () => now,
    };
    expect((await fileFeedback(input)).status).toBe(503);
    now += FEEDBACK_SETTLE_MS;
    const retry = await fileFeedback(input);
    expect(retry.status).toBe(200);
    expect(issueOf(retry)?.number).toBe(fake.issues[0]!.number);
    expect(fake.issues).toHaveLength(1);
  });

  it('says plainly when the token cannot open issues, and never retries it', async () => {
    const { fake, github, ledger } = setup();
    fake.fail('/repos/htxryan/penmoss/issues', 403, 1, {
      message: 'Resource not accessible by personal access token',
    });
    const answer = await fileFeedback({
      github,
      ledger,
      payload: payload(),
      screenshots: [],
      client: 'mac',
    });
    expect(answer.status).toBe(424);
    expect(answer.body).toEqual({
      error: { code: 'token_cannot_file', message: TOKEN_MESSAGES.cannotFile },
    });
    expect(TOKEN_MESSAGES.cannotFile).toMatch(/cannot open issues in htxryan\/penmoss/);
  });

  it('says so when the screenshot upload is refused (no Contents write)', async () => {
    const { fake, github, ledger } = setup();
    fake.fail('/user-attachments/assets', 404);
    const answer = await fileFeedback({
      github,
      ledger,
      payload: payload(),
      screenshots: shots(),
      client: 'mac',
    });
    expect(answer.status).toBe(424);
    expect(codeOf(answer)).toBe('token_cannot_file');
    expect(fake.issues).toHaveLength(0);
  });

  it('a token GitHub does not accept is named as such', async () => {
    const { github, ledger } = setup('wrong-token');
    const answer = await fileFeedback({
      github,
      ledger,
      payload: payload(),
      screenshots: [],
      client: 'mac',
    });
    expect(answer.body).toEqual({
      error: { code: 'token_cannot_file', message: TOKEN_MESSAGES.invalid },
    });
  });

  it('a rate limit or a 5xx may pass, with GitHub’s Retry-After', async () => {
    const { fake, github, ledger } = setup();
    fake.fail(
      '/user-attachments/assets',
      403,
      1,
      { message: 'secondary rate limit' },
      {
        'retry-after': '120',
      },
    );
    const answer = await fileFeedback({
      github,
      ledger,
      payload: payload(),
      screenshots: shots(),
      client: 'mac',
    });
    expect(answer.status).toBe(503);
    expect(codeOf(answer)).toBe('github_failed');
    expect(answer.retryAfter).toBe(120);
  });

  it('refuses what the Worker refused: a bad payload, a screenshot that is not its type', async () => {
    const { fake, github, ledger } = setup();
    const bad = await fileFeedback({
      github,
      ledger,
      payload: payload({ priority: 9 }),
      screenshots: [],
      client: 'mac',
    });
    expect(bad.status).toBe(400);
    const fakePng = await fileFeedback({
      github,
      ledger,
      payload: payload(),
      screenshots: [{ type: 'image/png', blob: new Blob([JPEG]) }],
      client: 'mac',
    });
    expect(fakePng.status).toBe(400);
    expect(codeOf(fakePng)).toBe('invalid_request');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('checkToken (said when the token is saved, A1012)', () => {
  it('names the account when the token can reach the repository', async () => {
    const { github } = setup();
    expect(await github.checkToken()).toEqual({ ok: true, login: 'htxryan' });
  });

  it('a token GitHub does not accept', async () => {
    const { github } = setup('nope');
    expect(await github.checkToken()).toMatchObject({ ok: false, problem: 'invalid' });
  });

  it('a token that cannot see the repository, or an account that cannot write to it', async () => {
    const { fake, github } = setup();
    fake.fail('/repos/htxryan/penmoss', 404, 1, { message: 'Not Found' }, {}, { method: 'GET' });
    expect(await github.checkToken()).toEqual({
      ok: false,
      login: 'htxryan',
      problem: 'cannot_file',
      message: TOKEN_MESSAGES.cannotFile,
    });
    fake.permissions = { admin: false, maintain: false, push: false, triage: false, pull: true };
    expect(await github.checkToken()).toMatchObject({ ok: false, problem: 'cannot_file' });
  });
});
