// GitHub intake into Linear (D66) against a fake Linear API: `task workflows:test`.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PEN, intake, issueInput } from './linear-intake.mjs';

const REPO = 'htxryan/penmoss';

/** @param {Partial<import('./linear-intake.mjs').GitHubIssue>} [over] */
const issue = (over = {}) => ({
  number: 7,
  title: 'Crash when opening a notebook',
  body: 'Steps…',
  html_url: 'https://github.com/htxryan/penmoss/issues/7',
  user: { login: 'someone' },
  labels: [],
  ...over,
});

describe('issueInput', () => {
  it('files in PEN Triage with a link back and the body after it', () => {
    const input = issueInput(issue(), REPO);
    assert.equal(input.teamId, PEN.teamId);
    assert.equal(input.stateId, PEN.triageStateId);
    assert.equal(input.title, 'Crash when opening a notebook');
    assert.match(
      input.description,
      /^From GitHub: \[htxryan\/penmoss#7\]\(https:\/\/github\.com\/htxryan\/penmoss\/issues\/7\) by `someone`\./,
    );
    assert.match(input.description, /\n\n---\n\nSteps…$/);
    assert.deepEqual(input.labelIds, []);
    assert.equal('priority' in input, false);
  });

  it("maps Send feedback's labels and priority", () => {
    const input = issueInput(
      issue({ labels: [{ name: 'in-app feedback' }, { name: 'Bug' }, { name: 'P2' }, 'P4'] }),
      REPO,
    );
    assert.deepEqual(input.labelIds, [PEN.labels['in-app feedback'], PEN.labels.bug]);
    assert.equal(input.priority, 2);
  });

  it('treats feature request and Feature as one label, and ignores unknown ones', () => {
    const input = issueInput(
      issue({ labels: [{ name: 'feature request' }, { name: 'Feature' }, { name: 'wontfix' }] }),
      REPO,
    );
    assert.deepEqual(input.labelIds, [PEN.labels.feature]);
  });

  it('keeps an empty body to the link, and an empty title to the number', () => {
    const input = issueInput(issue({ title: '  ', body: null }), REPO);
    assert.equal(input.title, 'GitHub issue #7');
    assert.doesNotMatch(input.description, /---/);
  });

  it('cuts a very long title and body', () => {
    const input = issueInput(issue({ title: 'x'.repeat(400), body: 'y'.repeat(70_000) }), REPO);
    assert.equal(input.title.length, 250);
    assert.ok(input.description.length < 61_000);
    assert.match(input.description, /the rest is on GitHub\)$/);
  });
});

/**
 * A fake Linear API that records each call and answers by operation name.
 * @param {Record<string, unknown>} answers
 */
function fakeLinear(answers) {
  /** @type {{ query: string; variables: any; auth: string | null }[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetcher = async (_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    const headers = /** @type {Record<string, string>} */ (init?.headers);
    calls.push({ query, variables, auth: headers.Authorization ?? null });
    const op = /** @type {string} */ (/(?:query|mutation) (\w+)/.exec(query)?.[1]);
    const answer = answers[op];
    if (answer instanceof Error) {
      return new Response(JSON.stringify({ errors: [{ message: answer.message }] }), {
        status: 400,
      });
    }
    return new Response(JSON.stringify({ data: answer }), { status: 200 });
  };
  return { calls, fetcher };
}

describe('intake', () => {
  it('creates the issue, then links the GitHub issue to it', async () => {
    const { calls, fetcher } = fakeLinear({
      Find: { attachmentsForURL: { nodes: [] } },
      Create: {
        issueCreate: { success: true, issue: { id: 'i1', identifier: 'PEN-99', url: 'u' } },
      },
      Link: { attachmentCreate: { success: true } },
    });
    const result = await intake({ issue: issue(), repo: REPO, key: 'lin_test', fetcher });
    assert.deepEqual(result, { identifier: 'PEN-99', created: true });
    assert.deepEqual(
      calls.map((c) => /(?:query|mutation) (\w+)/.exec(c.query)?.[1]),
      ['Find', 'Create', 'Link'],
    );
    assert.ok(calls.every((c) => c.auth === 'lin_test'));
    assert.equal(calls[1]?.variables.input.title, 'Crash when opening a notebook');
    assert.deepEqual(calls[2]?.variables.input, {
      issueId: 'i1',
      url: 'https://github.com/htxryan/penmoss/issues/7',
      title: 'GitHub htxryan/penmoss#7',
    });
  });

  it('passes the untrusted title and body only as variables, never in the query', async () => {
    const hostile = issue({ title: '") { evil }', body: '`$(rm -rf ~)`' });
    const { calls, fetcher } = fakeLinear({
      Find: { attachmentsForURL: { nodes: [] } },
      Create: { issueCreate: { success: true, issue: { id: 'i', identifier: 'PEN-1', url: '' } } },
      Link: { attachmentCreate: { success: true } },
    });
    await intake({ issue: hostile, repo: REPO, key: 'k', fetcher });
    assert.ok(calls.every((c) => !c.query.includes('evil') && !c.query.includes('rm -rf')));
  });

  it('files nothing when a PEN issue already links to it (a re-run)', async () => {
    const { calls, fetcher } = fakeLinear({
      Find: { attachmentsForURL: { nodes: [{ issue: { identifier: 'PEN-42' } }] } },
    });
    const result = await intake({ issue: issue(), repo: REPO, key: 'k', fetcher });
    assert.deepEqual(result, { identifier: 'PEN-42', created: false });
    assert.equal(calls.length, 1);
  });

  it("fails with Linear's message when the API refuses", async () => {
    const { fetcher } = fakeLinear({
      Find: { attachmentsForURL: { nodes: [] } },
      Create: new Error('Authentication required'),
    });
    await assert.rejects(intake({ issue: issue(), repo: REPO, key: 'k', fetcher }), {
      message: 'Linear API: Authentication required',
    });
  });
});
