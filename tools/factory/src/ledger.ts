/**
 * The run ledger, runs.jsonl (F3, F9: out of ui/model.ts): one event per line, and the card a
 * run belongs to. The UI, the report and CI's failure handling all read it from here.
 */

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
