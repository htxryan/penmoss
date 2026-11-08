/**
 * The Factory UI's writes (F21, #277), made as Ryan, never as the bot or the factory's app: a
 * reply on the issue (optionally clearing Blocked), a picked answer to a planning question,
 * "Complete", and Blocked on or off. Only the UI imports this module: the dispatcher can set
 * Blocked but never clear it (R23), and a test holds that boundary.
 */
import type { FactoryConfig } from '../config.ts';
import { answerText } from '../planning.ts';
import { issueKey, type OwnerTracker } from '../tracker/port.ts';

export type UiAction =
  | {
      readonly kind: 'reply';
      readonly issue: number;
      readonly text: string;
      readonly unblock: boolean;
    }
  | {
      readonly kind: 'answer';
      readonly issue: number;
      readonly question: string;
      readonly option: string;
    }
  | { readonly kind: 'complete'; readonly issue: number }
  | { readonly kind: 'block'; readonly issue: number; readonly on: boolean };

const MAX_TEXT = 10_000;

/** A request body as an action, or why it isn't one. */
export function parseAction(
  raw: unknown,
): { ok: true; action: UiAction } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'not an object' };
  const r = raw as Record<string, unknown>;
  const issue = r['issue'];
  if (typeof issue !== 'number' || !Number.isInteger(issue) || issue < 1)
    return { ok: false, error: 'issue must be a positive whole number' };
  const text = (key: string) => {
    const v = r[key];
    return typeof v === 'string' && v.trim() !== '' && v.length <= MAX_TEXT ? v : null;
  };
  switch (r['kind']) {
    case 'reply': {
      const t = text('text');
      if (!t) return { ok: false, error: `text must be 1–${MAX_TEXT} characters` };
      return {
        ok: true,
        action: { kind: 'reply', issue, text: t, unblock: r['unblock'] === true },
      };
    }
    case 'answer': {
      const question = text('question');
      const option = text('option');
      if (!question || !option) return { ok: false, error: 'question and option are required' };
      return { ok: true, action: { kind: 'answer', issue, question, option } };
    }
    case 'complete':
      return { ok: true, action: { kind: 'complete', issue } };
    case 'block':
      if (typeof r['on'] !== 'boolean') return { ok: false, error: 'on must be true or false' };
      return { ok: true, action: { kind: 'block', issue, on: r['on'] } };
    default:
      return { ok: false, error: 'unknown kind' };
  }
}

export interface Writer {
  perform(action: UiAction): Promise<string>;
}

/** `tracker` must act as Ryan (his gh, his Linear key); `runUi` checks it before serving. */
export function createWriter(config: FactoryConfig, tracker: OwnerTracker): Writer {
  const comment = (issue: number, body: string) => tracker.comment(issue, body);
  return {
    async perform(action) {
      const board = await tracker.readBoard();
      const item = board.items.find((i) => i.number === action.issue && i.repo === config.repo);
      if (!item) throw new Error(`${issueKey(config, action.issue)} isn't on the board`);
      // Comment first, then clear Blocked: the daemon must see the words when it resumes.
      const reply = async (body: string, unblock: boolean) => {
        await comment(item.number, body);
        if (unblock && item.blocked) await tracker.clearBlocked(item);
        return unblock && item.blocked ? 'Posted, and Blocked cleared' : 'Posted';
      };
      switch (action.kind) {
        case 'reply':
          return reply(action.text, action.unblock);
        case 'answer':
          return reply(answerText(action.question, action.option), true);
        case 'complete':
          // The normal agreement path: an explicit yes on the issue (R17).
          return reply('Complete', true);
        case 'block':
          if (action.on === item.blocked) return action.on ? 'Already Blocked' : 'Not Blocked';
          if (action.on) await tracker.setBlocked(item);
          else await tracker.clearBlocked(item);
          return action.on ? 'Blocked' : 'Blocked cleared';
      }
    },
  };
}
