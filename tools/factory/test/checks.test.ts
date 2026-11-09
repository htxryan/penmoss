import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runIdOf, summarizeChecks, type CheckRun } from '../src/checks.ts';
import {
  definedPlaceholders,
  maxDecision,
  numberLines,
  reserveDecisionNumbers,
} from '../src/decisions.ts';

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
  const reservedFile = () =>
    join(mkdtempSync(join(tmpdir(), 'factory-decisions-')), 'decision-numbers');
  const all = (text: string) => new Set(text.split('\n').map((_, i) => i + 1));

  it('numbers A-NEW-k after it, the same in every file', () => {
    const rows = '| A-NEW-1 | sheets |\n| A-NEW-2 | colours |';
    const reference = 'per A-NEW-2 and A-NEW-1';
    const assigned = reserveDecisionNumbers(
      definedPlaceholders(rows, all(rows)),
      '| A1173 | y |',
      reservedFile(),
    );
    expect(assigned).toEqual({ 'A-NEW-1': 'A1174', 'A-NEW-2': 'A1175' });
    expect([rows, reference].map((t) => numberLines(t, all(t), assigned))).toEqual([
      '| A1174 | sheets |\n| A1175 | colours |',
      'per A1175 and A1174',
    ]);
  });
  it('gives two runs different numbers once the first has merged', () => {
    const one = '| A-NEW-1 | one |';
    const first = numberLines(
      one,
      all(one),
      reserveDecisionNumbers(['A-NEW-1'], '| A1173 | y |', reservedFile()),
    );
    const second = numberLines(
      '| A-NEW-1 | two |',
      new Set([1]),
      reserveDecisionNumbers(['A-NEW-1'], first, reservedFile()),
    );
    expect([first, second]).toEqual(['| A1174 | one |', '| A1175 | two |']);
  });
  it('gives two slots different numbers while both PRs are open on the same main', () => {
    const reserved = reservedFile();
    const main = '| A1172 | x |\n| A1173 | y |';
    const one = reserveDecisionNumbers(['A-NEW-1', 'A-NEW-2'], main, reserved);
    const two = reserveDecisionNumbers(['A-NEW-1'], main, reserved);
    expect(one).toEqual({ 'A-NEW-1': 'A1174', 'A-NEW-2': 'A1175' });
    expect(two).toEqual({ 'A-NEW-1': 'A1176' });
    // Once main has gone past what was given out, main's own numbers lead again.
    const three = reserveDecisionNumbers(['A-NEW-1'], '| A1180 | z |', reserved);
    expect(three).toEqual({ 'A-NEW-1': 'A1181' });
  });
  it('defines a placeholder only by a decision row the branch added', () => {
    const decisions = [
      '| A1173 | y |',
      '| A-NEW-1 | added by the branch |',
      '| A-NEW-2 | already there |',
      'Number new decisions A-NEW-3.',
      '| A-NEW-1 | the same key again |',
    ].join('\n');
    expect(definedPlaceholders(decisions, new Set([2, 4, 5]))).toEqual(['A-NEW-1']);
  });
  it('numbers only the given lines, and only placeholders that were assigned', () => {
    const text = 'Number new decisions `A-NEW-1`.\nper A-NEW-1, not A-NEW-2\n';
    expect(numberLines(text, new Set([2]), { 'A-NEW-1': 'A1232' })).toBe(
      'Number new decisions `A-NEW-1`.\nper A1232, not A-NEW-2\n',
    );
  });
  it('reserves nothing when there is nothing to number', () => {
    const reserved = reservedFile();
    expect(reserveDecisionNumbers([], '| A1173 | y |', reserved)).toEqual({});
    expect(existsSync(reserved)).toBe(false);
  });
});
