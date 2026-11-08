import { describe, expect, it } from 'vitest';
import { parseAgentResult } from '../src/result.ts';

describe('parseAgentResult', () => {
  it('reads the plan example', () => {
    const r = parseAgentResult(
      JSON.stringify({
        status: 'done',
        summary: 'Comment threads open from the margin on Android (closes #212)',
        questions: [],
        platforms: {
          android: { inScope: true, proofSpecs: ['app.penmoss.comments.MarginThreadTest'] },
        },
        tests: [{ cmd: 'task check', result: 'pass' }],
        decisions: ['A-NEW-1: margin threads open in a bottom sheet on phones'],
        risks: [],
      }),
    );
    expect(r.ok && r.result.platforms.android?.proofSpecs).toEqual([
      'app.penmoss.comments.MarginThreadTest',
    ]);
  });
  it.each([
    ['nope', 'is not JSON'],
    ['{"status":"ok","summary":"x"}', 'status must be'],
    ['{"status":"done","summary":""}', 'summary must be'],
    ['{"status":"needs-info","summary":"x"}', 'needs at least one question'],
    ['{"status":"done","summary":"x","platforms":{"ios":{"inScope":true}}}', 'unknown platform'],
    ['{"status":"done","summary":"x","decisions":[1]}', 'decisions and risks'],
  ])('rejects %s', (text, error) => {
    const r = parseAgentResult(text);
    expect(!r.ok && r.error).toContain(error);
  });
});
