/**
 * The run ledger, runs.jsonl (F3, F9: out of ui/model.ts): one event per line, and the card a
 * run belongs to. The UI, the report and CI's failure handling all read it from here, and the
 * host appends to it (`appendLedger`).
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome, type FactoryConfig } from './config.ts';

export interface LedgerEvent {
  readonly at: string;
  readonly run: string;
  readonly event: string;
  readonly [detail: string]: unknown;
}

export function parseLedger(text: string): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Partial<LedgerEvent>;
      if (typeof e.at === 'string' && typeof e.run === 'string' && typeof e.event === 'string')
        events.push(e as LedgerEvent);
    } catch {
      // A torn line from a crash.
    }
  }
  return events;
}

export const issueOf = (e: LedgerEvent) => Number(e.run.split('-')[0]);

/**
 * Appends one event to the run ledger (`runs.jsonl`), which `factory:report`, the daemon's
 * recovery (`unfinishedClaims`) and the UI read: `{ at, run, event, ...detail }`.
 */
export function appendLedger(
  config: FactoryConfig,
  entry: { readonly run: string; readonly event: string; readonly [key: string]: unknown },
): void {
  appendFileSync(
    join(expandHome(config.stateDir), 'runs.jsonl'),
    `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
  );
}
