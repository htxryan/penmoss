/**
 * The Planning phase (F15, F16; #266, #267). Each issue in Planning has one background Claude
 * session (`claude --bg --remote-control`, F0.5) that drafts the plan and design as artifacts and
 * talks with Ryan in artifact comments and a direct chat; issue comments reach it by stop and
 * resume. The session reports through `state.json`. While it waits on Ryan, the card is Blocked
 * and the session is stopped (R23); clearing Blocked resumes it with what he said.
 */
export interface PlanState {
  readonly status: 'drafting' | 'waiting' | 'agreed' | 'trivial';
  readonly planUrl: string | null;
  readonly designUrl: string | null;
  readonly open: readonly string[];
  /** Open points with proposed answers Ryan can pick with one click (F21). */
  readonly questions: readonly PlanQuestion[];
  readonly agreed: {
    readonly quote: string;
    readonly channel: 'chat' | 'artifact' | 'issue';
    readonly planVersion: number;
    readonly designVersion: number | null;
  } | null;
}

export interface PlanQuestion {
  readonly text: string;
  readonly options: readonly string[];
}

function parseQuestions(raw: unknown): PlanQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((q: unknown) => {
    if (typeof q !== 'object' || q === null) return [];
    const { text, options } = q as { text?: unknown; options?: unknown };
    if (typeof text !== 'string' || !text.trim() || !Array.isArray(options)) return [];
    const opts = options.filter((o): o is string => typeof o === 'string' && o.trim() !== '');
    return opts.length >= 2 ? [{ text, options: opts.slice(0, 6) }] : [];
  });
}

/** The answer comment for a picked option: the session reads it as Ryan's answer. */
export function answerText(question: string, option: string): string {
  return `On "${question}": ${option}`;
}

export function parsePlanState(text: string): PlanState | null {
  try {
    const r = JSON.parse(text) as Partial<PlanState>;
    if (
      r.status !== 'waiting' &&
      r.status !== 'agreed' &&
      r.status !== 'trivial' &&
      r.status !== 'drafting'
    )
      return null;
    const url = (u: unknown) =>
      typeof u === 'string' && /^https:\/\/claude\.ai\/(code\/)?artifact\//.test(u) ? u : null;
    const open = Array.isArray(r.open)
      ? r.open.filter((o): o is string => typeof o === 'string')
      : [];
    const a = r.agreed;
    const agreed =
      a &&
      typeof a.quote === 'string' &&
      ['chat', 'artifact', 'issue'].includes(a.channel) &&
      Number.isInteger(a.planVersion)
        ? {
            quote: a.quote,
            channel: a.channel,
            planVersion: a.planVersion,
            designVersion: Number.isInteger(a.designVersion) ? a.designVersion : null,
          }
        : null;
    if (r.status === 'agreed' && !agreed) return null;
    return {
      status: r.status,
      planUrl: url(r.planUrl),
      designUrl: url(r.designUrl),
      open,
      questions: parseQuestions(r.questions),
      agreed,
    };
  } catch {
    return null;
  }
}

/**
 * Whether Ryan's words agree the plan is complete. Only an explicit yes counts: any "but",
 * question or request is feedback (R17).
 */
export function isAgreement(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t || t.length > 120 || t.includes('?')) return false;
  const words = t
    .replaceAll(/[^a-z' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  // Every word must belong to a plain yes; at least one must be the yes itself.
  const filler = new Set([
    'yes',
    'yep',
    'the',
    'plan',
    'is',
    "it's",
    'its',
    'it',
    'ahead',
    'thanks',
    'thank',
    'you',
    'ok',
    'okay',
    'fully',
    'now',
    'please',
  ]);
  const yes = new Set(['complete', 'agreed', 'agree', 'go', 'lgtm', 'approved', 'ship']);
  // A question without its mark ("is it complete") is still a question.
  if (
    ['is', 'are', 'should', 'can', 'could', 'would', 'do', 'does', 'will'].includes(words[0] ?? '')
  )
    return false;
  return (
    words.length > 0 &&
    words.some((w) => yes.has(w)) &&
    words.every((w) => yes.has(w) || filler.has(w))
  );
}

export interface PlanningView {
  readonly blocked: boolean;
  /** Whether the factory has launched a session for this card before. */
  readonly started: boolean;
  /** Whether the background session is running a turn right now. */
  readonly busy: boolean;
  /** The session's state file, if it has written one. */
  readonly state: PlanState | null;
  /** Whether the state file was written since the factory last messaged the session. */
  readonly fresh: boolean;
  /** Whether the factory already posted this state's open points and set Blocked. */
  readonly asked: boolean;
  /** Minutes since the factory last messaged the session. */
  readonly sinceMessage: number;
  /** Ryan's issue comments since the session last heard from the issue. */
  readonly newComments: readonly string[];
}

export type PlanningAction =
  | { readonly kind: 'wait'; readonly why: string }
  | { readonly kind: 'start' }
  | { readonly kind: 'ask'; readonly open: readonly string[] }
  | { readonly kind: 'resume'; readonly comments: readonly string[] }
  | {
      readonly kind: 'agreed';
      readonly quote: string;
      readonly channel: string;
      readonly via: 'session' | 'issue';
    }
  | { readonly kind: 'trivial'; readonly reason: string }
  | { readonly kind: 'stuck'; readonly why: string };

/** How long an idle session may go without writing its state before the factory asks Ryan. */
export const STUCK_MINUTES = 10;

/** The dispatcher's next step for a card in Planning. */
export function planningAction(v: PlanningView): PlanningAction {
  // Blocked comes first, always: the factory never acts on a Blocked card (R23).
  if (v.blocked) return { kind: 'wait', why: 'Blocked: waiting for Ryan to answer and clear it' };
  if (!v.started) return { kind: 'start' };
  // Ryan's own yes on the issue ends planning whatever the session last wrote.
  const yes = v.newComments.find(isAgreement);
  if (yes && v.state?.planUrl)
    return { kind: 'agreed', quote: yes, channel: 'issue', via: 'issue' };
  if (v.busy) return { kind: 'wait', why: 'the planning session is working' };
  if (v.fresh && v.state?.status === 'agreed' && v.state.agreed)
    return {
      kind: 'agreed',
      quote: v.state.agreed.quote,
      channel: v.state.agreed.channel,
      via: 'session',
    };
  if (v.fresh && v.state?.status === 'trivial')
    return { kind: 'trivial', reason: v.state.open[0] ?? 'the agent judged it trivial' };
  if (v.newComments.length > 0) return { kind: 'resume', comments: v.newComments };
  // Ryan cleared Blocked: he may have answered in the artifact or the chat, so the session looks.
  if (v.asked) return { kind: 'resume', comments: [] };
  if (v.fresh && v.state?.status === 'waiting') return { kind: 'ask', open: v.state.open };
  if (v.sinceMessage >= STUCK_MINUTES)
    return {
      kind: 'stuck',
      why: `the planning session has been idle for ${v.sinceMessage} minutes without writing its state`,
    };
  return { kind: 'wait', why: 'the planning session has not replied yet' };
}
