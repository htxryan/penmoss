/**
 * One step of a card's Planning phase (F15, F16; #266, #267), taken on each poll: start the
 * session, hand it Ryan's issue comments, post its open points and set Blocked, or record the
 * agreed plan. The step is short (a CLI call or two), so planning takes no slot.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkPlanContract } from './artifact.ts';
import type { BoardItem } from './board.ts';
import type { FactoryConfig } from './config.ts';
import type { Issue } from './issue.ts';
import { formatMarker } from './pick.ts';
import {
  agreedPlanPath,
  readMeta,
  readState,
  writeMeta,
  type PlanFiles,
  type PlanMeta,
} from './planning-host.ts';
import { planningAction, type PlanningAction, type PlanQuestion } from './planning.ts';

export interface PlanDeps {
  comment(issue: number, body: string): Promise<void>;
  setStatus(item: BoardItem, status: string): Promise<void>;
  setBlocked(item: BoardItem): Promise<void>;
  /** Prepares the read-only snapshot of main the session explores. */
  snapshot(): Promise<void>;
  /** Starts the session with a message, or resumes it by ID. */
  launch(message: string, resume?: string): Promise<{ sessionId?: string; chatUrl?: string }>;
  stop(sessionId: string): Promise<void>;
  /** The session as `claude agents` lists it, or nothing once it has stopped. */
  session(): Promise<{ readonly busy: boolean } | undefined>;
  now(): Date;
}

export interface PlanInput {
  readonly config: FactoryConfig;
  readonly item: BoardItem;
  readonly issue: Issue;
  readonly files: PlanFiles;
  /** The filled planning prompt, for a session's first message. */
  readonly prompt: string;
}

const MARKER = 'penmoss-factory';

/** Ryan's comments on the issue after `since`, oldest first; the factory's own are left out. */
export function commentsSince(issue: Issue, owner: string, since: string | undefined) {
  return issue.comments.filter(
    (c) => c.author === owner && !c.body.includes(MARKER) && (!since || c.createdAt > since),
  );
}

function links(meta: PlanMeta, planUrl: string | null, designUrl: string | null): string {
  return [
    planUrl && `- Plan: ${planUrl}`,
    designUrl && `- Design: ${designUrl}`,
    meta.chatUrl && `- Chat with the planning session: ${meta.chatUrl}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function advancePlanning(deps: PlanDeps, input: PlanInput): Promise<PlanningAction> {
  const { config, item, issue, files } = input;
  const meta = readMeta(files);
  if (meta.agreed) return { kind: 'wait', why: 'the plan is agreed; implementation is queued' };
  const read = readState(files);
  const state = read?.state ?? null;
  const fresh = !!read && (!meta.messagedAt || read.writtenAt.toISOString() > meta.messagedAt);
  const asked = !!meta.askedAt && (!meta.messagedAt || meta.askedAt >= meta.messagedAt);
  const now = deps.now();
  const comments = commentsSince(issue, config.owner, meta.deliveredAt);
  const session = meta.sessionId ? await deps.session() : undefined;
  const action = planningAction({
    blocked: item.blocked,
    started: !!meta.sessionId,
    busy: session?.busy ?? false,
    state,
    fresh,
    asked,
    sinceMessage: meta.messagedAt
      ? Math.floor((now.getTime() - Date.parse(meta.messagedAt)) / 60_000)
      : 0,
    newComments: comments.map((c) => c.body),
  });
  const delivered = comments.at(-1)?.createdAt ?? meta.deliveredAt;
  const marker = (event: string) => formatMarker({ issue: String(item.number), event });

  switch (action.kind) {
    case 'wait':
      return action;
    case 'start': {
      if (item.status !== config.status.planning)
        await deps.setStatus(item, config.status.planning);
      await deps.snapshot();
      const started = await deps.launch(input.prompt);
      const next: PlanMeta = {
        ...started,
        deliveredAt: issue.comments.at(-1)?.createdAt ?? now.toISOString(),
        messagedAt: now.toISOString(),
      };
      writeMeta(files, next);
      await deps.comment(
        item.number,
        [
          'Planning has started. The plan (and a design, if what users see changes) arrives as artifacts; answer in their comments, in the chat, or here.',
          links(next, null, null),
          marker('plan-start'),
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
      return action;
    }
    case 'resume': {
      const message =
        action.comments.length > 0
          ? `Ryan commented on the issue:\n\n${action.comments.map((c) => `> ${c.replaceAll('\n', '\n> ')}`).join('\n\n')}\n\nAnswer, revise the plan, and update state.json.`
          : 'Ryan cleared Blocked. Read the artifact comments and the chat for his answers, revise the plan, and update state.json.';
      const resumed = await deps.launch(message, meta.sessionId);
      writeMeta(files, {
        ...meta,
        ...resumed,
        deliveredAt: delivered,
        messagedAt: now.toISOString(),
        askedAt: undefined,
      });
      return action;
    }
    case 'ask': {
      await deps.comment(
        item.number,
        [
          'The plan has open points:',
          action.open.map((o) => `- ${o}`).join('\n'),
          questionsText(state?.questions ?? []),
          links(meta, state?.planUrl ?? null, state?.designUrl ?? null),
          'Answer here, in the artifact comments or in the chat, then clear Blocked: the session picks up from there. Say "complete" when the plan is.',
          marker('plan-asked'),
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
      await deps.setBlocked(item);
      if (meta.sessionId) await deps.stop(meta.sessionId);
      writeMeta(files, { ...meta, askedAt: now.toISOString() });
      return action;
    }
    case 'stuck': {
      await deps.comment(
        item.number,
        `Planning stopped: ${action.why}. Clear Blocked to resume it.\n\n${links(meta, state?.planUrl ?? null, state?.designUrl ?? null)}\n\n${marker('plan-stuck')}`,
      );
      await deps.setBlocked(item);
      if (meta.sessionId) await deps.stop(meta.sessionId);
      writeMeta(files, { ...meta, askedAt: now.toISOString() });
      return action;
    }
    case 'trivial':
    case 'agreed': {
      const trivial = action.kind === 'trivial';
      if (trivial && !config.planning.agentMaySkipTrivial) {
        return advanceAsk(deps, input, meta, now, [
          `The planning session thinks no plan is needed: ${action.reason}. Agree with "complete", or say what the plan should cover.`,
        ]);
      }
      const plan = `${files.out}/plan.html`;
      if (!trivial && !existsSync(plan)) {
        return advanceAsk(deps, input, meta, now, [
          `Ryan agreed ("${action.quote}"), but the session saved no plan.html to implement from.`,
        ]);
      }
      // The plan contract (F16): a miss goes back to the session, twice, then to Ryan.
      const problems =
        action.kind === 'trivial' ? [] : checkPlanContract(readFileSync(plan, 'utf8'));
      if (action.kind === 'agreed' && problems.length > 0) {
        const fixes = meta.contractFixes ?? 0;
        if (fixes >= MAX_CONTRACT_FIXES) {
          return advanceAsk(deps, input, meta, now, [
            `Ryan agreed ("${action.quote}"), but the plan still breaks the plan contract: ${problems.join('; ')}.`,
          ]);
        }
        const resumed = await deps.launch(
          `Ryan agreed ("${action.quote}", in the ${action.channel}), but before the factory can build from the plan, fix it: ${problems.join('; ')}. Change nothing else. Republish the same artifact, save plan.html, and write state.json with status "agreed" and the same quote.`,
          meta.sessionId,
        );
        writeMeta(files, {
          ...meta,
          ...resumed,
          deliveredAt: delivered,
          messagedAt: now.toISOString(),
          askedAt: undefined,
          contractFixes: fixes + 1,
        });
        return { kind: 'resume', comments: [] };
      }
      if (!trivial) {
        copyFileSync(plan, agreedPlanPath(files));
        // The mockups as agreed, for validation (F19): later edits in out/ don't change them.
        const mockups = join(files.out, 'mockups');
        if (existsSync(mockups)) {
          const kept = join(files.root, 'agreed-mockups');
          mkdirSync(kept, { recursive: true });
          for (const f of readdirSync(mockups).filter((n) => n.endsWith('.html')))
            copyFileSync(join(mockups, f), join(kept, f));
        }
      }
      const quote = trivial ? action.reason : action.quote;
      const versions = state?.agreed ?? null;
      writeMeta(files, {
        ...meta,
        deliveredAt: delivered,
        agreed: {
          quote,
          channel: trivial ? 'agent' : action.channel,
          at: now.toISOString(),
          trivial,
          planUrl: trivial ? null : (state?.planUrl ?? null),
          designUrl: trivial ? null : (state?.designUrl ?? null),
          planVersion: versions?.planVersion ?? null,
          designVersion: versions?.designVersion ?? null,
        },
      });
      if (meta.sessionId) await deps.stop(meta.sessionId);
      await deps.comment(
        item.number,
        [
          trivial
            ? `No plan needed: ${quote}. Implementation starts when a slot is free.`
            : `The plan is agreed ("${quote}", in the ${action.channel})${versionsText(versions)}. Implementation starts when a slot is free, from this copy of the plan.`,
          links(meta, state?.planUrl ?? null, state?.designUrl ?? null),
          formatMarker({ issue: String(item.number), event: 'plan-approved' }),
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
      return action;
    }
  }
}

/** How many times the session gets to fix a plan that breaks the contract before Ryan hears. */
export const MAX_CONTRACT_FIXES = 2;

function versionsText(v: { planVersion: number; designVersion: number | null } | null): string {
  if (!v) return '';
  return `: plan v${v.planVersion}${v.designVersion === null ? '' : `, design v${v.designVersion}`}`;
}

/** Structured questions for the issue: each with its options, the proposal first. */
export function questionsText(questions: readonly PlanQuestion[]): string {
  if (questions.length === 0) return '';
  return [
    'Pick an answer in the Factory UI, or reply here:',
    ...questions.map(
      (q) => `- **${q.text}**\n${q.options.map((o, i) => `  ${i + 1}. ${o}`).join('\n')}`,
    ),
  ].join('\n');
}

async function advanceAsk(
  deps: PlanDeps,
  input: PlanInput,
  meta: PlanMeta,
  now: Date,
  open: string[],
): Promise<PlanningAction> {
  const { item } = input;
  await deps.comment(
    item.number,
    `${open.join('\n\n')}\n\nClear Blocked to resume planning.\n\n${formatMarker({ issue: String(item.number), event: 'plan-asked' })}`,
  );
  await deps.setBlocked(item);
  if (meta.sessionId) await deps.stop(meta.sessionId);
  writeMeta(input.files, { ...meta, askedAt: now.toISOString() });
  return { kind: 'ask', open };
}
