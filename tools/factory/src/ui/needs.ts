/** What Ryan must do to move a card on (the brief's five gates), and what fixes the Mac. */
import type { NeedKind, Need } from './view.ts';

const NEED_LABEL: Readonly<Record<NeedKind, string>> = {
  answer: 'Answer the plan',
  review: 'Review the PR',
  unblock: 'Unblock',
  machine: 'Fix the Mac',
  card: 'Fix the card',
};

export function need(
  kind: NeedKind,
  brief: string,
  what: string,
  command: string | null = null,
): Need {
  return { kind, label: NEED_LABEL[kind], brief, what, command };
}

/** A stop's first clause is the brief; the rest, if any, leads into what to do. */
export function stopNeed(kind: 'unblock' | 'machine', text: string, then: string): Need {
  const [brief = text, ...rest] = text.split(/;\s*/);
  const more = rest.join('; ');
  const lead = more ? `${more[0]!.toUpperCase()}${more.slice(1)}. ` : '';
  return need(kind, brief, `${lead}${then}`, kind === 'machine' ? fixFor(text) : null);
}

/** A command that fixes a machine problem the factory names, when there is one. */
export function fixFor(text: string): string | null {
  if (/command not found|exit 127/i.test(text)) return 'task factory:install';
  if (/isn.t made|not made/i.test(text)) return 'task desktop:test:vm';
  if (/tart.*(missing|not found|isn.t installed)/i.test(text))
    return 'brew install cirruslabs/cli/tart';
  return null;
}
