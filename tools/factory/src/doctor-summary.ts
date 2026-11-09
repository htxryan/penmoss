/**
 * `factory:doctor`'s last full result per slot, `doctor/summary-slot<n>.json` in the state folder:
 * the doctor writes it, and the Factory UI's health bar reads it (A1233).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome, type FactoryConfig } from './config.ts';

export interface DoctorSummary {
  readonly slot: number;
  readonly at: string;
  /** The names of the checks that failed; empty when all passed. */
  readonly failed: readonly string[];
}

const summaryPath = (config: FactoryConfig, slot: number) =>
  join(expandHome(config.stateDir), 'doctor', `summary-slot${slot}.json`);

/** Records a full run's result (a run with `--only` is partial, so it records nothing). */
export function writeDoctorSummary(config: FactoryConfig, summary: DoctorSummary): void {
  writeFileSync(
    summaryPath(config, summary.slot),
    `${JSON.stringify({ at: summary.at, failed: summary.failed })}\n`,
  );
}

/** The last result of each configured slot that has one. */
export function readDoctorSummaries(config: FactoryConfig): DoctorSummary[] {
  const results: DoctorSummary[] = [];
  for (const slot of config.slots) {
    try {
      const r = JSON.parse(
        readFileSync(summaryPath(config, slot.id), 'utf8'),
      ) as Partial<DoctorSummary>;
      if (typeof r.at === 'string' && Array.isArray(r.failed))
        results.push({
          slot: slot.id,
          at: r.at,
          failed: r.failed.filter((f) => typeof f === 'string'),
        });
    } catch {
      // Not run since the summary was added, or a torn write.
    }
  }
  return results;
}
