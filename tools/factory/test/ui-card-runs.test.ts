import { describe, expect, it } from 'vitest';
import { buildView } from '../src/ui/model.ts';
import { cleanError } from '../src/ui/card-runs.ts';
import { line, pen, input, view, card, minutesAgo } from './ui-fixture.ts';

describe('a run that failed before the agent started (A1233)', () => {
  it('shows the failure, not "Paused: Agent working (round 0)"', () => {
    const c = card(view, 'PEN-75');
    expect(c.step).toBe('Failed before the agent started: claude: command not found (exit 127)');
    expect(c.step).not.toMatch(/Paused|round 0/);
    expect(c.need?.label).toBe('Fix the Mac');
    expect(c.need?.command).toBe('task factory:install');
    expect(c.runs.map((r) => [r.outcome, r.summary])).toEqual([
      ['failed', 'Failed before the agent started: claude: command not found (exit 127)'],
    ]);
  });

  it('says so when the run failed before the agent was even launched', () => {
    const v = buildView(
      input({
        board: {
          items: [
            pen(21, {
              status: 'In Progress',
              labels: ['Blocked'],
              blocked: true,
              blockedSet: true,
            }),
          ],
        },
        ledger: [
          line('21-a', 'claimed', minutesAgo(5), { issue: 21 }),
          line('21-a', 'failed', minutesAgo(4), { error: 'git worktree add failed: disk full' }),
        ].join('\n'),
      }),
    );
    expect(card(v, 'PEN-21').step).toBe(
      'Failed before the agent started: git worktree add failed: disk full',
    );
    expect(card(v, 'PEN-21').need?.kind).toBe('unblock');
  });

  it('counts agent rounds from 1, as people do', () => {
    expect(card(view, 'PEN-79').step).toBe('Agent round 1 of 3');
    expect(card(view, 'PEN-79').round).toBe('Agent round 1 of 3');
  });

  it("cleans an agent CLI's error into one line", () => {
    expect(
      cleanError('claude-code exited with code 127:\n/bin/sh: claude: command not found\n'),
    ).toBe('claude: command not found (exit 127)');
    expect(cleanError('spawn terminal-notifier ENOENT')).toBe('spawn terminal-notifier ENOENT');
  });
});
