/**
 * The Factory UI's view (F20, #276; redesigned in A1233): the factory's health, what needs
 * Ryan and exactly what to do about it, each card on the lifecycle (Todo → Plan → Build → Gate →
 * Proof → PR + CI → Review → Merge → Done) with its runs, and the slots' runs over the last hours.
 * Built from the board, the run ledger, `status.json`, the planning folders and `claude agents`,
 * all read-only. The page draws two views of it, Inbox and Pipeline, with one card detail.
 *
 * A card counts as the factory's only when the factory handles its status (Todo, Planning) or the
 * ledger holds its claim: an In Progress card nobody gave the factory is counted, not listed.
 */
import type { Running } from '../dispatcher.ts';
import { optedIn } from '../labels.ts';
import { pickNext } from '../pick.ts';
import { issueOf, type LedgerEvent, parseLedger } from '../ledger.ts';
import { STAGES, type CardView, type FactoryView, type ViewInput } from './view.ts';
import { health } from './health.ts';
import { card } from './card.ts';
import { timeline, recent } from './timeline.ts';

export function buildView(input: ViewInput): FactoryView {
  const { config, board, now } = input;
  const s = config.status;
  const all = parseLedger(input.ledger);
  const byIssue = new Map<number, LedgerEvent[]>();
  for (const e of all) {
    const n = issueOf(e);
    if (!Number.isInteger(n)) continue;
    const list = byIssue.get(n) ?? [];
    list.push(e);
    byIssue.set(n, list);
  }
  // A dead daemon runs nothing, whatever its last status.json says.
  const status = input.status && input.alive(input.status.pid) ? input.status : null;
  const running = new Map<number, Running>((status?.running ?? []).map((r) => [r.issue, r]));
  const merging = new Set(status?.merging ?? []);
  const doneSince = now.getTime() - config.ui.doneDays * 86_400_000;
  const picks = pickNext(board.items, config, new Set(running.keys()));
  const position = new Map(picks.queue.map((p, i) => [p.item.number, i + 1]));

  const cards: CardView[] = [];
  const outside: string[] = [];
  for (const item of board.items) {
    if (item.repo !== config.repo) continue;
    const events = byIssue.get(item.number) ?? [];
    const st = item.status ?? '';
    if (st === s.working || st === s.review) {
      // The factory's only if its ledger holds the claim: PEN-30's tasks were never given to it.
      if (!events.some((e) => e.event === 'claimed')) {
        outside.push(item.key);
        continue;
      }
    } else if (st === s.done) {
      // The merge step logs to the daemon's log, not the ledger, so a Done card counts by its
      // last ledger line (its review) when there's no `done` line.
      if (!events.some((e) => e.event === 'claimed')) continue;
      const doneAt = (events.findLast((e) => e.event === 'done') ?? events.at(-1))?.at;
      if (!doneAt || Date.parse(doneAt) < doneSince) continue;
    } else if (st !== s.pick && st !== s.planning) continue;
    // A card waiting in Todo or Planning is the factory's only with the opt-in label (A1296).
    else if (!optedIn(item.labels, config)) continue;
    cards.push(
      card(input, item, events, {
        live: running.get(item.number),
        merging: merging.has(item.number),
        queuePosition: position.get(item.number) ?? null,
      }),
    );
  }

  const order = { needs: 0, working: 1, queue: 2, done: 3 };
  const since = (c: CardView) => (c.since ? Date.parse(c.since) : now.getTime());
  cards.sort(
    (a, b) =>
      order[a.group] - order[b.group] ||
      (a.group === 'needs' ? since(a) - since(b) : 0) ||
      (a.group === 'queue'
        ? (a.queuePosition ?? 99) - (b.queuePosition ?? 99) || (a.priority ?? 3) - (b.priority ?? 3)
        : 0) ||
      (a.group === 'done' ? since(b) - since(a) : 0) ||
      b.stage - a.stage,
  );

  const windowMs = (input.windowHours ?? 12) * 3_600_000;
  const from = new Date(now.getTime() - windowMs);
  return {
    updatedAt: now.toISOString(),
    writable: input.writable ?? false,
    readOnly: input.writable ? null : (input.readOnly ?? 'Read-only'),
    health: health(input),
    stages: STAGES,
    needs: cards.filter((c) => c.group === 'needs'),
    cards,
    slots: config.slots.map((slot) => {
      const r = [...running.values()].find((x) => x.slot === slot.id);
      const it = r ? board.items.find((i) => i.number === r.issue) : undefined;
      return {
        slot: slot.id,
        issue: r?.issue ?? null,
        key: it?.key ?? (r ? `${r.issue}` : null),
        since: r?.startedAt ?? null,
        waitingFor: r?.waitingFor?.reason ?? null,
      };
    }),
    outside,
    timeline: timeline(input, byIssue, from, running),
    ...recent(input, byIssue, from),
  };
}
