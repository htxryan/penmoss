import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readDoctorSummaries, writeDoctorSummary } from '../src/doctor-summary.ts';
import { testConfig } from './helpers.ts';

describe("the doctor's summary (A1233)", () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-doctor-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const config = { ...testConfig(), stateDir: dir };
  mkdirSync(join(dir, 'doctor'));

  it('keeps the last full result per slot', () => {
    writeDoctorSummary(config, { slot: 1, at: '2026-11-09T01:00:00.000Z', failed: [] });
    writeDoctorSummary(config, { slot: 2, at: '2026-11-09T01:05:00.000Z', failed: ['jdk'] });
    expect(readDoctorSummaries(config)).toEqual([
      { slot: 1, at: '2026-11-09T01:00:00.000Z', failed: [] },
      { slot: 2, at: '2026-11-09T01:05:00.000Z', failed: ['jdk'] },
    ]);
  });

  it('skips a torn summary and a slot that has none', () => {
    writeFileSync(join(dir, 'doctor', 'summary-slot2.json'), '{"at":');
    expect(readDoctorSummaries(config).map((d) => d.slot)).toEqual([1]);
    rmSync(join(dir, 'doctor', 'summary-slot1.json'));
    expect(readDoctorSummaries(config)).toEqual([]);
  });
});
