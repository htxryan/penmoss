// A filed bug report with anonymised logs (PEN-137) through the GitHub → Linear intake (D66):
// `task workflows:test`. The body is core's `feedbackIssueBody` for 2,000 log lines, written to
// fixtures/feedback-logs-body.txt by packages/core/test/feedback.test.ts (which fails if the two
// drift apart): core cuts the oldest lines so the intake never has to cut the body.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { issueInput } from './linear-intake.mjs';

const body = readFileSync(new URL('./fixtures/feedback-logs-body.txt', import.meta.url), 'utf8');

describe('a bug report with anonymised logs', () => {
  const input = issueInput(
    {
      number: 412,
      title: 'Sync stopped',
      body,
      html_url: 'https://github.com/htxryan/penmoss/issues/412',
      user: { login: 'penmoss-feedback' },
      labels: [{ name: 'in-app feedback' }, { name: 'bug' }, { name: 'P2' }],
    },
    'htxryan/penmoss',
  );

  it('reaches Linear whole: nothing cut, the footer last', () => {
    assert.ok(body.length <= 60_000, `body is ${body.length} characters`);
    assert.doesNotMatch(input.description, /\(cut; the rest is on GitHub\)/);
    assert.ok(input.description.endsWith(body.trim()));
    assert.match(input.description, /Sent from Penmoss Mac 0\.40 \(400\) · submission \w+$/);
  });

  it('keeps the logs collapsed, after the captured context and before the footer', () => {
    const text = input.description;
    const context = text.indexOf('<details><summary>Captured Context</summary>');
    const logs = text.search(/<details>\n<summary>Anonymised Logs \(\d+ lines\)<\/summary>/);
    const fence = text.indexOf('```text\n', logs);
    const closed = text.indexOf('\n```\n\n</details>', fence);
    const footer = text.lastIndexOf('Sent from Penmoss');
    assert.ok(context > 0 && logs > context, 'the block follows the context');
    assert.ok(fence > logs && closed > fence, 'the fence opens and closes');
    assert.ok(footer > closed, 'the footer follows the block');
  });
});
