/**
 * One card as the page shows it (A1233): its stage on the lifecycle, what it is doing or why it
 * stopped, what it needs from Ryan, its runs, links and chat.
 */
import type { BoardItem } from '../board.ts';
import type { FactoryConfig } from '../config.ts';
import type { Running } from '../dispatcher.ts';
import { parseIssueSpec } from '../labels.ts';
import { attachCommand, type PlanQuestion } from '../planning.ts';
import { hasBlockedSet } from '../tracker/port.ts';
import type { LedgerEvent } from '../ledger.ts';
import type { Link, Tone, Need, Point, CardView, PlanInfo, ViewInput } from './view.ts';
import { str } from './fields.ts';
import { STAGE_OF, STOPS, runsOf, stopOf, progressOf, roundOf, runView } from './card-runs.ts';
import { need, stopNeed, fixFor } from './needs.ts';
import { pointsOf } from './points.ts';

export function card(
  input: ViewInput,
  item: BoardItem,
  events: readonly LedgerEvent[],
  ctx: { live: Running | undefined; merging: boolean; queuePosition: number | null },
): CardView {
  const { config } = input;
  const s = config.status;
  const st = item.status ?? '';
  const plan = input.plans[item.number];
  // A planning card's live session, which Ryan can chat with.
  const chatting = st === s.planning && !!plan?.meta.sessionId && !plan.meta.agreed;
  const runs = runsOf(events);
  const lastRun = runs.at(-1);
  const views = runs.map((r, i) =>
    runView(r, config, i === runs.length - 1, !!ctx.live || ctx.merging),
  );
  const pr = (events.findLast((e) => str(e['pr']))?.['pr'] as string | undefined) ?? null;
  const spec = parseIssueSpec(item.labels, config);
  const set = hasBlockedSet(item);
  const heldBy = item.blockedBy ?? [];

  const links: Link[] = [{ label: item.key, href: item.url }];
  if (pr)
    links.push(
      { label: `PR #${pr.split('/').at(-1)}`, href: pr },
      { label: 'CI', href: `${pr}/checks` },
    );
  if (plan?.state?.planUrl) links.push({ label: 'Plan', href: plan.state.planUrl });
  if (plan?.state?.designUrl) links.push({ label: 'Design', href: plan.state.designUrl });

  // Where the card is.
  const progress = lastRun?.events.findLast((e) => !STOPS.has(e.event));
  let stage =
    st === s.pick
      ? 0
      : st === s.planning
        ? 1
        : st === s.done
          ? 8
          : st === s.review
            ? progress && (progress.event === 'merged' || progress.event === 'resumed')
              ? 7
              : 6
            : Math.max(2, Math.min(6, STAGE_OF[progress?.event ?? 'claimed'] ?? 2));
  if (ctx.merging) stage = 7;

  const stop = lastRun ? stopOf(lastRun, config) : null;
  const planning = st === s.planning;
  let tone: Tone;
  let step = '';
  let since: string | null = null;
  let needed: Need | null = null;
  let paused = false;
  let open: readonly string[] = [];
  let questions: readonly PlanQuestion[] = [];
  let asked: { points: Point[]; notes: string[] } = { points: [], notes: [] };

  if (planning && set && plan?.meta.askedAt) {
    open = plan.state?.open ?? [];
    questions = plan.state?.questions ?? [];
    asked = pointsOf(open, questions);
    const n = Math.max(open.length, questions.length);
    needed = need(
      'answer',
      n
        ? `Answer ${n} question${n === 1 ? '' : 's'} on the plan`
        : 'Answer the open points on the plan',
      'Pick an answer for each (the planner’s proposal is marked), add anything else below and send, or agree the plan as it stands. The chat and the issue work too.',
    );
    step = 'Open points posted';
    since = plan.meta.askedAt;
  } else if (set && !spec.ok && (st === s.pick || planning)) {
    needed = need('card', `Won't start: ${spec.error}`, 'Fix the labels in Linear, then unblock.');
    step = "Won't start: labels conflict";
  } else if (
    set &&
    stop &&
    !stop.paused &&
    st !== s.pick &&
    (st !== s.planning || runs.length > 0)
  ) {
    needed = stop.machine
      ? stopNeed('machine', stop.text, 'Fix it on the Mac, then retry.')
      : stopNeed('unblock', stop.text, 'Fix it or say how on the issue, then retry.');
    step = stop.text;
    since = stop.at;
  } else if (set && planning) {
    // Planning errors aren't in the ledger: the issue's last comment says whether it was the
    // factory or Ryan.
    needed = need(
      'unblock',
      'Planning is Blocked',
      'The factory stopped it on an error (its comment on the issue says why), or you paused it. Clear Blocked to resume the session.',
    );
    step = 'Planning Blocked';
  } else if (set) {
    paused = true;
    // Only a stop the ledger says Ryan made is his. Otherwise the ledger has no reason (a block
    // set in Linear, or by an older factory that didn't log one): say Blocked, not who (A1377).
    step = stop?.paused ? 'Paused by you' : 'Blocked';
    since = stop?.paused ? stop.at : null;
  } else if (!spec.ok && (st === s.pick || planning)) {
    needed = need('card', `Won't start: ${spec.error}`, 'Fix the labels in Linear.');
    step = "Won't start: labels conflict";
  } else if (heldBy.length) {
    step = `Held: blocked by ${heldBy.join(', ')}`;
  }
  if (heldBy.length && step && !step.startsWith('Held'))
    step = `${step}; also blocked by ${heldBy.join(', ')}`;

  // Not stopped: what it is doing.
  if (!step) {
    if (ctx.live?.waitingFor) {
      step = `Waiting: ${ctx.live.waitingFor.reason}`;
      since = ctx.live.waitingFor.since;
      if (!/busy|another run|queued/i.test(ctx.live.waitingFor.reason))
        needed = need(
          'machine',
          `Waiting: ${ctx.live.waitingFor.reason}`,
          `The run carries on by itself once that's fixed; it stops Blocked after ${config.macProof.waitHours} h.`,
          fixFor(ctx.live.waitingFor.reason),
        );
    } else if (ctx.live || ctx.merging) {
      const last = lastRun?.events.at(-1);
      step = last ? progressOf(last, config) : 'Claimed; starting the agent';
      since = ctx.live?.startedAt ?? last?.at ?? null;
    } else if (planning) {
      step = planningStep(plan, input.busySessions.has(item.number));
      since = plan?.meta.messagedAt ?? null;
    } else if (st === s.review) {
      step = 'Waiting for your review';
      since = progress?.at ?? null;
      if (pr)
        needed = need(
          'review',
          `Review PR #${pr.split('/').at(-1)}`,
          'Approve it on GitHub and the factory merges it and watches main; comment for another round.',
        );
    } else if (st === s.pick) {
      step =
        ctx.queuePosition === 1
          ? 'Next when a slot frees'
          : `In the queue (#${ctx.queuePosition ?? '?'})`;
      if (spec.ok) step += spec.spec.planSkip ? ' · plan:skip' : ' · plans first';
    } else if (st === s.done) {
      step = 'Done';
      since = (events.findLast((e) => e.event === 'done') ?? events.at(-1))?.at ?? null;
    } else {
      // Claimed, not live, not Blocked: an orphan the daemon restarts on its branch (R12).
      step = 'Stopped mid-run; the daemon restarts it on its branch';
      since = lastRun?.events.at(-1)?.at ?? null;
    }
  }

  if (needed) tone = needed.kind === 'unblock' ? 'stop' : needed.kind === 'card' ? 'card' : 'you';
  else if (st === s.done) tone = 'done';
  else if (paused || heldBy.length || st === s.pick) tone = 'idle';
  else tone = 'live';

  const group: CardView['group'] = needed
    ? 'needs'
    : st === s.done
      ? 'done'
      : st === s.pick || paused || (heldBy.length > 0 && !ctx.live)
        ? 'queue'
        : 'working';
  const liveRun = ctx.live && lastRun ? lastRun.id : null;
  const canComplete = planning && !!plan?.state?.planUrl && !plan.meta.agreed;
  return {
    number: item.number,
    key: item.key,
    title: item.title,
    url: item.url,
    status: st,
    stage,
    tone,
    step,
    since,
    need: needed,
    paused,
    blocked: set,
    heldBy,
    group,
    queuePosition: ctx.queuePosition,
    priority: priorityOf(item, config),
    agent: spec.ok ? spec.spec.agent : null,
    model: spec.ok ? spec.spec.modelAlias : null,
    slot: ctx.live?.slot ?? null,
    round: lastRun && st === s.working ? roundOf(lastRun, config) : null,
    pr,
    open,
    questions,
    points: asked.points,
    notes: asked.notes,
    canComplete,
    runs: views,
    runFolder: lastRun && input.runFolder ? input.runFolder(lastRun.id) : null,
    chat: chatting && plan.meta.sessionId ? attachCommand(plan.meta.sessionId) : null,
    chatUrl: chatting
      ? chatLink(plan.meta.chatUrl)
      : liveRun && input.runChat
        ? chatLink(input.runChat(liveRun))
        : null,
    log: liveRun && input.logTail ? input.logTail(liveRun) : [],
    links,
  };
}

function priorityOf(item: BoardItem, config: FactoryConfig): number | null {
  if (item.priority) return item.priority;
  const spec = parseIssueSpec(item.labels, config);
  return spec.ok ? spec.spec.priority : null;
}

function planningStep(plan: PlanInfo | undefined, busy: boolean): string {
  if (!plan?.meta.sessionId) return 'Planning starts on the next poll';
  if (plan.meta.agreed)
    return plan.meta.agreed.trivial
      ? 'No plan needed; next when a slot frees'
      : 'Plan agreed; next when a slot frees';
  if (busy) return 'Planning session working';
  return 'Planning session idle';
}

/** A planning session's claude.ai chat link, or null for anything that isn't one. */
export function chatLink(url: string | undefined): string | null {
  return url && /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]+$/.test(url) ? url : null;
}
