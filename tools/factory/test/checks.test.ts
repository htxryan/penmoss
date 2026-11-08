import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runIdOf, summarizeChecks, type CheckRun } from '../src/checks.ts';
import { assignDecisionNumbers, maxDecision, reserveDecisionNumbers } from '../src/decisions.ts';

// Recorded from `gh pr checks 283 --json name,state,bucket,link,startedAt` (trimmed).
const pass: CheckRun = {
  name: 'Check',
  state: 'SUCCESS',
  bucket: 'pass',
  link: 'https://github.com/htxryan/penmoss/actions/runs/42411975662/job/128523047100',
  startedAt: '2026-11-07T20:50:49Z',
};
const skip: CheckRun = {
  name: 'Mac app (Electron under xvfb)',
  state: 'SKIPPED',
  bucket: 'skipping',
  link: 'x',
  startedAt: '2026-11-07T20:37:49Z',
};
const fail: CheckRun = { ...pass, name: 'E2E smoke', state: 'FAILURE', bucket: 'fail' };
const running: CheckRun = { ...pass, name: 'Android app', state: 'IN_PROGRESS', bucket: 'pending' };
const queued: CheckRun = {
  name: 'Android app',
  state: 'QUEUED',
  bucket: 'pending',
  link: 'x',
  startedAt: '0001-01-01T00:00:00Z',
};

const opened = new Date('2026-11-07T20:30:00Z');
const at = (minutes: number) => new Date(opened.getTime() + minutes * 60_000);

describe('summarizeChecks', () => {
  it('is green when everything passed or skipped', () => {
    expect(summarizeChecks([pass, skip], at(10), 60, opened)).toEqual({ kind: 'green' });
  });
  it('is red as soon as one fails, naming it', () => {
    expect(summarizeChecks([pass, fail, running], at(10), 60, opened)).toEqual({
      kind: 'red',
      failed: [fail],
    });
  });
  it('waits while jobs run, however long', () => {
    expect(summarizeChecks([pass, running], at(500), 60, opened).kind).toBe('pending');
  });
  it('pauses (not fails) when jobs sat queued past ciMinutes: no runner online', () => {
    expect(summarizeChecks([pass, queued], at(30), 60, opened).kind).toBe('pending');
    expect(summarizeChecks([pass, queued], at(61), 60, opened)).toEqual({
      kind: 'stalled',
      queued: [queued],
    });
  });
  it('waits when GitHub has queued nothing yet', () => {
    expect(summarizeChecks([], at(1), 60, opened).kind).toBe('pending');
  });
  it('finds the run ID for the failed log', () => {
    expect(runIdOf(fail)).toBe('42411975662');
  });
});

describe('decision numbers', () => {
  it('finds the highest A-number', () => {
    expect(maxDecision('| A1172 | x |\n| A1173 | y | see A99')).toBe(1173);
  });
  it('numbers A-NEW-k after it, the same in every file', () => {
    const { texts, assigned } = assignDecisionNumbers(
      ['| A-NEW-1 | sheets |\n| A-NEW-2 | colours |', 'per A-NEW-2 and A-NEW-1'],
      1173,
    );
    expect(assigned).toEqual({ 'A-NEW-1': 'A1174', 'A-NEW-2': 'A1175' });
    expect(texts).toEqual(['| A1174 | sheets |\n| A1175 | colours |', 'per A1175 and A1174']);
  });
  it('gives two runs different numbers once the first has merged', () => {
    const first = assignDecisionNumbers(['| A-NEW-1 | one |'], 1173).texts[0]!;
    const second = assignDecisionNumbers(['| A-NEW-1 | two |'], maxDecision(first)).texts[0]!;
    expect([first, second]).toEqual(['| A1174 | one |', '| A1175 | two |']);
  });
  it('gives two slots different numbers while both PRs are open on the same main', () => {
    const reserved = join(mkdtempSync(join(tmpdir(), 'factory-decisions-')), 'decision-numbers');
    const main = '| A1172 | x |\n| A1173 | y |';
    const one = reserveDecisionNumbers(['| A-NEW-1 | one |\n| A-NEW-2 | more |'], main, reserved);
    const two = reserveDecisionNumbers(['| A-NEW-1 | two |'], main, reserved);
    expect(one.texts).toEqual(['| A1174 | one |\n| A1175 | more |']);
    expect(two.texts).toEqual(['| A1176 | two |']);
    // Once main has gone past what was given out, main's own numbers lead again.
    const three = reserveDecisionNumbers(['| A-NEW-1 | three |'], '| A1180 | z |', reserved);
    expect(three.assigned).toEqual({ 'A-NEW-1': 'A1181' });
  });
});
