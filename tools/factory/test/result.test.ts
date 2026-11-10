import { describe, expect, it } from 'vitest';
import { parseAgentResult } from '../src/result.ts';

describe('parseAgentResult', () => {
  it('reads questions written as { question, proposed } objects (A1267)', () => {
    // PEN-80's agent wrote its question this way, and the run Blocked on the format instead.
    const r = parseAgentResult(
      JSON.stringify({
        status: 'needs-info',
        summary: 'A skip needs a decision',
        questions: [
          { question: 'Skip the test?', proposed: 'No: open a flake issue instead.' },
          'Plain question?',
        ],
      }),
    );
    expect(r.ok && r.result.questions).toEqual([
      'Skip the test? Proposed: No: open a flake issue instead.',
      'Plain question?',
    ]);
    const bad = parseAgentResult(
      JSON.stringify({ status: 'needs-info', summary: 's', questions: [{ proposed: 'x' }] }),
    );
    expect(bad.ok).toBe(false);
  });
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
  it('takes spec paths, a line number and a class#method', () => {
    const specs = {
      web: ['apps/web/test/e2e/comments.spec.ts', 'apps/web/test/e2e/a-b_c.spec.ts:12'],
      mac: ['test/e2e/app.spec.ts'],
      android: ['app.penmoss.editor.TypingInstrumentedTest#keyEventsWriteTheParagraphExactly'],
    };
    const r = parseAgentResult(
      JSON.stringify({
        status: 'done',
        summary: 'x',
        platforms: Object.fromEntries(
          Object.entries(specs).map(([k, proofSpecs]) => [k, { inScope: true, proofSpecs }]),
        ),
      }),
    );
    expect(r.ok && r.result.platforms.mac?.proofSpecs).toEqual(specs.mac);
    expect(r.ok && r.result.platforms.web?.proofSpecs).toEqual(specs.web);
  });
  it.each([
    ['nope', 'is not JSON'],
    ['{"status":"ok","summary":"x"}', 'status must be'],
    ['{"status":"done","summary":""}', 'summary must be'],
    ['{"status":"needs-info","summary":"x"}', 'needs at least one question'],
    ['{"status":"done","summary":"x","platforms":{"ios":{"inScope":true}}}', 'unknown platform'],
    ['{"status":"done","summary":"x","decisions":[1]}', 'decisions and risks'],
    // The Mac's specs go into the shell command the test VM runs.
    ...['x.spec.ts; curl evil', '$(id)', '--config=x.ts', 'a b', "a'b", 'x\n.spec.ts'].map(
      (spec): [string, string] => [
        JSON.stringify({
          status: 'done',
          summary: 'x',
          platforms: { mac: { inScope: true, proofSpecs: ['test/e2e/app.spec.ts', spec] } },
        }),
        'is not a plain spec path or test class',
      ],
    ),
  ])('rejects %s', (text, error) => {
    const r = parseAgentResult(text);
    expect(!r.ok && r.error).toContain(error);
  });
});
