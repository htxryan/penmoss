/**
 * The adjustable limits (PEN-137, O7, N8, AC27) and the logs a bug report attaches (AC3, AC28):
 * every reader falls back to the default, typed values are checked against the range, and the
 * report takes the newest lines within the hours, lines and size, in a fence no line closes,
 * cut from the oldest so the issue stays inside the Linear intake's 60,000 characters.
 */
import { describe, expect, it } from 'vitest';
import {
  changedLimits,
  DEFAULT_LIMITS,
  EVENT_BYTES,
  eventSpace,
  formatBytes,
  isLimitKey,
  LIMIT_KEYS,
  limitAllowed,
  LIMITS,
  limitSpec,
  logSpace,
  parseLimit,
  rangeLabel,
  rangeMessage,
  readLimits,
  reportHours,
  type Limits,
} from '../src/analytics/limits';
import {
  fitLogLines,
  formatReportSize,
  INTAKE_BODY_LIMIT,
  lineTime,
  logBlock,
  reportLines,
  textBytes,
} from '../src/analytics/log-block';

describe('LIMITS', () => {
  it('has the plan’s defaults and ranges', () => {
    expect(LIMITS.map((spec) => [spec.key, spec.default, spec.min, spec.max, spec.unit])).toEqual([
      ['events.days', 7, 1, 360, 'days'],
      ['events.max', 200_000, 500, 2_000_000, 'events'],
      ['logs.fileKb', 1024, 256, 81_920, 'KB'],
      ['logs.files', 2, 1, 5, 'files'],
      ['logs.days', 7, 1, 360, 'days'],
      ['report.hours', 24, 1, 168, 'hours'],
      ['report.lines', 300, 50, 2000, 'lines'],
      ['report.kb', 16, 4, 40, 'KB'],
    ]);
    expect(LIMITS.map((spec) => spec.key)).toEqual([...LIMIT_KEYS]);
    for (const spec of LIMITS) {
      expect(spec.min).toBeLessThanOrEqual(spec.default);
      expect(spec.default).toBeLessThanOrEqual(spec.max);
    }
  });

  it('knows its keys', () => {
    expect(isLimitKey('events.days')).toBe(true);
    expect(isLimitKey('events')).toBe(false);
    expect(limitSpec('report.kb').group).toBe('report');
  });

  it('keeps logs to 400 MB at most', () => {
    const most = Object.fromEntries(LIMITS.map((spec) => [spec.key, spec.max])) as Limits;
    expect(logSpace(most)).toBe(400 * 1024 * 1024);
  });
});

describe('readLimits', () => {
  it('falls back to the default for each value missing, not whole or out of range', () => {
    expect(readLimits(undefined)).toEqual(DEFAULT_LIMITS);
    expect(readLimits(null)).toEqual(DEFAULT_LIMITS);
    expect(readLimits('7')).toEqual(DEFAULT_LIMITS);
    expect(
      readLimits({
        'events.days': 30,
        'events.max': 499,
        'logs.fileKb': 81_921,
        'logs.files': 2.5,
        'logs.days': '14',
        'report.hours': Number.NaN,
        'report.lines': 2000,
        'report.kb': 4,
      }),
    ).toEqual({ ...DEFAULT_LIMITS, 'events.days': 30, 'report.lines': 2000, 'report.kb': 4 });
  });

  it('keeps only the changed values', () => {
    expect(changedLimits(DEFAULT_LIMITS)).toEqual({});
    expect(changedLimits({ ...DEFAULT_LIMITS, 'logs.files': 5 })).toEqual({ 'logs.files': 5 });
  });

  it('allows a value only within its range', () => {
    expect(limitAllowed('logs.files', 1)).toBe(true);
    expect(limitAllowed('logs.files', 5)).toBe(true);
    expect(limitAllowed('logs.files', 0)).toBe(false);
    expect(limitAllowed('logs.files', 6)).toBe(false);
    expect(limitAllowed('logs.files', '3')).toBe(false);
  });
});

describe('parseLimit', () => {
  it('reads a whole number typed with or without separators', () => {
    expect(parseLimit('events.max', '800,000')).toBe(800_000);
    expect(parseLimit('events.max', '2,000,000')).toBe(2_000_000);
    expect(parseLimit('events.max', '200000')).toBe(200_000);
    expect(parseLimit('events.max', ' 10_000 ')).toBe(10_000);
    expect(parseLimit('events.max', '5 000')).toBe(5000);
    expect(parseLimit('events.days', '360')).toBe(360);
  });

  it('refuses anything else, and anything out of range', () => {
    for (const text of ['', 'seven', '7.5', '-7', '1e3', '0x10', '361', '0', '12345678']) {
      expect(parseLimit('events.days', text), text).toBeNull();
    }
    expect(parseLimit('events.max', '2,000,001')).toBeNull();
    expect(parseLimit('events.max', '499')).toBeNull();
  });
});

describe('range words', () => {
  it('writes a field’s range and what it says out of range', () => {
    expect(rangeLabel('events.days')).toBe('1–360 days');
    expect(rangeLabel('events.max')).toBe('500–2,000,000 events');
    expect(rangeLabel('logs.fileKb')).toBe('256–81,920 KB');
    expect(rangeMessage('events.days')).toBe('Between 1 and 360');
    expect(rangeMessage('events.max')).toBe('Between 500 and 2,000,000');
  });
});

describe('space', () => {
  it('estimates the record’s and the logs’ space', () => {
    // PEN-177: 200,000 events of about 500 bytes each.
    expect(EVENT_BYTES).toBe(500);
    expect(eventSpace(DEFAULT_LIMITS)).toBe(200_000 * 500);
    expect(logSpace(DEFAULT_LIMITS)).toBe(2 * 1024 * 1024);
  });

  it('writes bytes as the Advanced section does', () => {
    expect(formatBytes(0)).toBe('1 KB');
    expect(formatBytes(1)).toBe('1 KB');
    expect(formatBytes(640 * 1024)).toBe('640 KB');
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2 MB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatBytes(12.4 * 1024 * 1024)).toBe('12 MB');
    expect(formatBytes(400 * 1024 * 1024)).toBe('400 MB');
    expect(formatBytes(eventSpace(DEFAULT_LIMITS))).toBe('95 MB');
    expect(formatBytes(eventSpace({ ...DEFAULT_LIMITS, 'events.max': 2_000_000 }))).toBe('954 MB');
  });

  it('moves an install on the old default to the new one, deleting nothing (PEN-177)', () => {
    // The consent file keeps only changed limits, so the old default (5,000) was never stored.
    expect(readLimits({})['events.max']).toBe(200_000);
    // A limit someone set stays theirs, even one the old range allowed at its top.
    expect(readLimits({ 'events.max': 800_000 })['events.max']).toBe(800_000);
    expect(readLimits({ 'events.max': 5000 })['events.max']).toBe(5000);
  });
});

describe('reportHours', () => {
  it('is never more than the logs keep', () => {
    expect(reportHours(DEFAULT_LIMITS)).toBe(24);
    expect(reportHours({ ...DEFAULT_LIMITS, 'report.hours': 168, 'logs.days': 1 })).toBe(24);
    expect(reportHours({ ...DEFAULT_LIMITS, 'report.hours': 168, 'logs.days': 7 })).toBe(168);
  });
});

const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();

describe('lineTime', () => {
  it('reads the time a line starts with', () => {
    expect(lineTime('2026-11-19T11:54:16.525Z info main started')).toBe(
      Date.parse('2026-11-19T11:54:16.525Z'),
    );
    expect(lineTime('2026-11-19T11:54:16Z warn x')).toBe(Date.parse('2026-11-19T11:54:16Z'));
    expect(lineTime('    at run (main.js:1:2)')).toBeNull();
    expect(lineTime('2026-13-45T99:99:99Z bad')).toBeNull();
    expect(lineTime('2026-11-19T11:54:16.525Z')).toBeNull();
  });
});

describe('reportLines', () => {
  it('takes only the lines from the last hours the limits allow', () => {
    const lines = [30, 25, 23, 1, 0].map((hours) => `${at(hours)} info line ${hours}`);
    expect(reportLines(lines, DEFAULT_LIMITS, NOW)).toEqual(lines.slice(2));
    const hours = { ...DEFAULT_LIMITS, 'report.hours': 2 };
    expect(reportLines(lines, hours, NOW)).toEqual(lines.slice(3));
    // A shorter log age wins: report.hours 168 but logs kept 1 day.
    const kept = { ...DEFAULT_LIMITS, 'report.hours': 168, 'logs.days': 1 };
    expect(reportLines(lines, kept, NOW)).toEqual(lines.slice(2));
  });

  it('takes at most report.lines lines, the newest', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `${at(1)} info ${i}`);
    const limits = { ...DEFAULT_LIMITS, 'report.lines': 50, 'report.kb': 40 };
    const kept = reportLines(lines, limits, NOW);
    expect(kept).toHaveLength(50);
    expect(kept.at(-1)).toBe(lines.at(-1));
    expect(kept[0]).toBe(lines[350]);
  });

  it('takes at most report.kb KB, counting a newline per line', () => {
    const line = `${at(1)} info ${'x'.repeat(100)}`;
    const lines = Array.from({ length: 2000 }, () => line);
    const limits = { ...DEFAULT_LIMITS, 'report.lines': 2000, 'report.kb': 4 };
    const kept = reportLines(lines, limits, NOW);
    expect(kept).toHaveLength(Math.floor(4096 / (line.length + 1)));
    expect(textBytes(kept)).toBeLessThanOrEqual(4096);
  });

  it('counts bytes, not characters', () => {
    const line = `${at(1)} info ${'é'.repeat(500)}`;
    const limits = { ...DEFAULT_LIMITS, 'report.kb': 4 };
    const kept = reportLines(
      Array.from({ length: 10 }, () => line),
      limits,
      NOW,
    );
    expect(kept).toHaveLength(Math.floor(4096 / (new TextEncoder().encode(line).length + 1)));
  });

  it('keeps a continuation line with the lines around it and skips blank lines', () => {
    const lines = [
      `${at(30)} error old`,
      '    at old (x.js:1:1)',
      `${at(2)} error failed`,
      '    at run (main.js:1:2)',
      '',
      '    at main (main.js:3:4)',
      `${at(1)} info done`,
    ];
    expect(reportLines(lines, DEFAULT_LIMITS, NOW)).toEqual([
      lines[2],
      lines[3],
      lines[5],
      lines[6],
    ]);
  });

  it('leaves out the continuation of a line it cut for a limit', () => {
    const lines = [
      `${at(2)} error a`,
      '    at a (x.js:1:1)',
      `${at(1)} error b`,
      '    at b (x.js:1:1)',
    ];
    const two = { ...DEFAULT_LIMITS, 'report.lines': 50 };
    expect(reportLines(lines, two, NOW)).toEqual(lines);
    const many = Array.from({ length: 47 }, () => `${at(1)} info x`);
    expect(reportLines([...lines, ...many], two, NOW)).toEqual([lines[2], lines[3], ...many]);
  });

  it('keeps a log without times whole, within the limits', () => {
    expect(reportLines(['a', 'b'], DEFAULT_LIMITS, NOW)).toEqual(['a', 'b']);
  });

  it('returns nothing for no lines', () => {
    expect(reportLines([], DEFAULT_LIMITS, NOW)).toEqual([]);
  });
});

describe('formatReportSize', () => {
  it('writes the size the form shows', () => {
    expect(formatReportSize(0)).toBe('0 B');
    expect(formatReportSize(1023)).toBe('1023 B');
    expect(formatReportSize(1024)).toBe('1.0 KB');
    expect(formatReportSize(9830)).toBe('9.6 KB');
    expect(formatReportSize(16 * 1024)).toBe('16 KB');
  });
});

describe('logBlock', () => {
  it('writes a collapsed Anonymised Logs block', () => {
    expect(logBlock(['a', 'b'])).toBe(
      [
        '<details>',
        '<summary>Anonymised Logs (2 lines)</summary>',
        '',
        '```text',
        'a',
        'b',
        '```',
        '',
        '</details>',
      ].join('\n'),
    );
    expect(logBlock(['a'])).toContain('<summary>Anonymised Logs (1 line)</summary>');
    expect(logBlock([])).toBe('');
  });

  it('fences longer than any run of backticks in a line', () => {
    const lines = ['before', '```', 'x ````` y', '```text', '</details>'];
    const block = logBlock(lines);
    expect(block).toContain('``````text\n');
    expect(block.endsWith('\n``````\n\n</details>')).toBe(true);
    // Only the opening and closing fences are runs of six; no line can close the block early.
    const body = block.split('\n').slice(4, -3);
    expect(body).toEqual(lines);
    expect(body.every((line) => !/^`{6,}\s*$/.test(line))).toBe(true);
  });
});

describe('fitLogLines', () => {
  const line = (i: number) => `${at(1)} info line ${i} ${'x'.repeat(300)}`;

  it('keeps every line when the body has room', () => {
    const lines = Array.from({ length: 10 }, (_, i) => line(i));
    expect(fitLogLines(lines, 1000)).toEqual(lines);
  });

  it('cuts the oldest lines first so the body stays under 60,000 characters', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => line(i));
    const others = 20_000;
    const kept = fitLogLines(lines, others);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(lines.length);
    expect(kept.at(-1)).toBe(lines.at(-1));
    expect(kept).toEqual(lines.slice(lines.length - kept.length));
    expect(others + logBlock(kept).length + 2).toBeLessThan(INTAKE_BODY_LIMIT);
    // One more line would not have fitted.
    const more = lines.slice(lines.length - kept.length - 1);
    expect(others + logBlock(more).length + 2).toBeGreaterThan(INTAKE_BODY_LIMIT - 400);
  });

  it('keeps nothing when the rest of the body already fills it', () => {
    expect(fitLogLines([line(1)], INTAKE_BODY_LIMIT)).toEqual([]);
  });

  it('takes a smaller limit', () => {
    const lines = Array.from({ length: 50 }, (_, i) => line(i));
    const kept = fitLogLines(lines, 0, 5000);
    expect(logBlock(kept).length + 2).toBeLessThanOrEqual(5000 - 400);
  });
});
