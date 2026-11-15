/** The slots' runs over the last hours, and what happened in them (A1233). */
import type { Running } from '../dispatcher.ts';
import type { LedgerEvent } from '../ledger.ts';
import type { Tone, TimelineBar, Outcome, FactoryView, ViewInput } from './view.ts';
import { str, num } from './fields.ts';
import { runsOf, stopOf, runView } from './card-runs.ts';

export function keyOf(input: ViewInput, issue: number): string {
  return (
    input.board.items.find((i) => i.number === issue)?.key ??
    (input.config.tracker === 'linear' ? `${input.config.linear.team}-${issue}` : `#${issue}`)
  );
}

export function timeline(
  input: ViewInput,
  byIssue: ReadonlyMap<number, LedgerEvent[]>,
  from: Date,
  running: ReadonlyMap<number, Running>,
): FactoryView['timeline'] {
  const { config, now } = input;
  const lanes = config.slots.map((slot) => ({ slot: slot.id, bars: [] as TimelineBar[] }));
  for (const [issue, events] of byIssue) {
    const runs = runsOf(events);
    runs.forEach((run, i) => {
      const slot = num(run.events[0]?.['slot']);
      const lane = lanes.find((l) => l.slot === slot);
      if (!lane) return;
      const live = i === runs.length - 1 && running.get(issue)?.slot === slot;
      const v = runView(run, config, i === runs.length - 1, live);
      const end = v.endedAt ?? now.toISOString();
      if (Date.parse(end) < from.getTime()) return;
      const tone: Tone =
        v.outcome === 'running'
          ? running.get(issue)?.waitingFor
            ? 'you'
            : 'live'
          : v.outcome === 'in-review' || v.outcome === 'merged' || v.outcome === 'done'
            ? 'done'
            : v.outcome === 'interrupted' || v.outcome === 'paused'
              ? 'idle'
              : 'stop';
      lane.bars.push({
        issue,
        key: keyOf(input, issue),
        run: run.id,
        start: v.startedAt,
        end,
        tone,
        label: v.summary,
      });
    });
  }
  for (const lane of lanes) lane.bars.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return { from: from.toISOString(), to: now.toISOString(), lanes };
}

export function recent(
  input: ViewInput,
  byIssue: ReadonlyMap<number, LedgerEvent[]>,
  from: Date,
): Pick<FactoryView, 'outcomes' | 'totals'> {
  const { config } = input;
  const outcomes: Outcome[] = [];
  const totals = { started: 0, inReview: 0, merged: 0, blocked: 0 };
  for (const [issue, events] of byIssue) {
    const key = keyOf(input, issue);
    const runs = runsOf(events);
    runs.forEach((run, i) => {
      for (const e of run.events) {
        if (Date.parse(e.at) < from.getTime()) continue;
        const push = (what: string, detail: string, tone: Tone) =>
          outcomes.push({ at: e.at, issue, key, what, detail, tone });
        if (e.event === 'claimed' && !str(e['phase'])) {
          totals.started++;
          if (i > 0) push('Restarted', `run ${i + 1} on slot ${num(e['slot']) ?? '?'}`, 'live');
        } else if (e.event === 'in-review') {
          totals.inReview++;
          const pr = str(e['pr']);
          push('Reached review', pr ? `PR #${pr.split('/').at(-1)}` : '', 'done');
        } else if (e.event === 'merged') {
          totals.merged++;
          push('Merged', str(e['pr']) ? `PR #${String(e['pr']).split('/').at(-1)}` : '', 'done');
        } else if (e.event === 'done') push('Done', 'main verified', 'done');
      }
      const stop = stopOf(run, config);
      const at = run.events.at(-1)!.at;
      if (stop && !stop.paused && Date.parse(at) >= from.getTime()) {
        totals.blocked++;
        outcomes.push({
          at,
          issue,
          key,
          what: run.events.at(-1)!.event === 'failed' ? 'Failed' : 'Blocked',
          detail: stop.text,
          tone: 'stop',
        });
      }
    });
  }
  outcomes.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { outcomes: outcomes.slice(0, 40), totals };
}
