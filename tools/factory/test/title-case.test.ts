import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const { titleCaseProblem, isTitleLike } = createRequire(import.meta.url)(
  '../sandbox/title-case.cjs',
) as {
  titleCaseProblem: (t: string) => { text: string; words: string[]; suggestion: string } | null;
  isTitleLike: (t: string) => boolean;
};

describe("the app's Title Case (A938, A1649)", () => {
  it.each([
    'Share How You Use Penmoss?',
    "Don't Share",
    'Move to Folder',
    'Keep at Most',
    'Attach Logs from the Last',
    'Sign In with GitHub',
    'Sign In Again',
    'Back Up Now',
    'Delete 27 Events?',
    'Delete #tag?',
    'Reset My Analytics ID',
    'Move to…',
    'The penmoss Command',
    'Waiting to Send',
  ])('passes %s', (label) => {
    expect(titleCaseProblem(label)).toBeNull();
  });

  it.each([
    ['Share usage data', 'Share Usage Data'],
    ['Delete your shared data?', 'Delete Your Shared Data?'],
    ['Analytics Id', 'Analytics ID'],
    ['Captured context', 'Captured Context'],
    ['Consent answered', 'Consent Answered'],
    ['What is recorded', 'What Is Recorded'],
    ['Open in new window', 'Open in New Window'],
    ['What to look for', 'What to Look For'],
    ['Waiting to send', 'Waiting to Send'],
    ['Top 25 commands', 'Top 25 Commands'],
  ])('finds %s, which should read %s', (label, fixed) => {
    expect(titleCaseProblem(label)?.suggestion).toBe(fixed);
  });

  it('leaves sentences, hints and long labels to sentence case', () => {
    expect(isTitleLike('Penmoss keeps this on your Mac.')).toBe(false);
    expect(isTitleLike('Keeps it here. Sends nothing')).toBe(false);
    expect(
      isTitleLike('How long and how much Penmoss keeps on this Mac, and when it goes away'),
    ).toBe(false);
    expect(titleCaseProblem('Sent only with your consent.')).toBeNull();
  });
});
