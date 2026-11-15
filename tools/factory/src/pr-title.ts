/**
 * A run's branch name and its pull request's title (F9: out of run.ts): the card's title, cut at
 * a clause break to fit GitHub's list, and the agent's own title when it wrote one.
 */
import type { BoardItem } from './board.ts';
import type { FactoryConfig } from './config.ts';

export function branchName(config: FactoryConfig, item: BoardItem): string {
  const slug = item.title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '')
    .split('-')
    .slice(0, 6)
    .join('-');
  return `${config.branchPrefix}${item.number}-${slug || 'issue'}`;
}

/** GitHub shows about this much of a title in its lists; git's own advice for a subject. */
export const TITLE_MAX = 72;

/** The longest title the agent may give in `result.json` (A1345). */
export const AGENT_TITLE_MAX = 60;

/**
 * Where a long title can end: before a clause that explains or adds to the change (", so …",
 * "; …", ": …" after the area prefix, a dash), and failing that before a comma.
 */
const CLAUSE_BREAKS = [
  /, so (?:that )?/g,
  /, which /g,
  /, because /g,
  /, but /g,
  /, and /g,
  /; /g,
  /: /g,
  / [—–] /g,
  / - /g,
  / so that /g,
  / because /g,
];
const COMMA_BREAK = /, /g;

/** Words a title shouldn't end on once it is cut. */
const DANGLING =
  /(?:\s+(?:a|an|the|and|or|but|so|to|of|in|on|at|by|for|from|with|without|into|onto|as|that|which|when|while|its|their|his|her|this|these|those|is|are|was|were|be|it))+$/i;

/**
 * `title` cut to `TITLE_MAX` without an ellipsis (A1345): at the last clause break that fits
 * after the area prefix (`Mac: `), else a comma, else at a word, with no dangling article,
 * preposition or conjunction at the end. PEN-121's PR was `Mac: agents' MCP servers run from
 * Penmoss CLI.app, so opening Penmoss…`; it is now `Mac: agents' MCP servers run from Penmoss
 * CLI.app`.
 */
export function shortenTitle(title: string): string {
  if (title.length <= TITLE_MAX) return title;
  const prefix = /^[A-Z][\w ./+-]{0,24}: /.exec(title)?.[0].length ?? 0;
  // A cut leaves at least the prefix and a few words.
  const least = prefix + 16;
  const lastBreak = (patterns: readonly RegExp[]) => {
    let at = -1;
    for (const pattern of patterns)
      for (const m of title.matchAll(pattern))
        if (m.index >= least && m.index <= TITLE_MAX && m.index > at) at = m.index;
    return at;
  };
  const tidy = (text: string) => text.replace(/[\s:;,.–—-]+$/, '').replace(DANGLING, '');
  for (const patterns of [CLAUSE_BREAKS, [COMMA_BREAK]]) {
    const at = lastBreak(patterns);
    if (at > 0) return tidy(title.slice(0, at));
  }
  const words = title.slice(0, TITLE_MAX + 1).split(' ');
  if (words.length > 1) words.pop();
  const cut = tidy(words.join(' '));
  return cut.length >= least ? cut : tidy(title.slice(0, TITLE_MAX));
}

/**
 * The PR's title: the agent's own `title` from `result.json` when it is a usable one (at most
 * `AGENT_TITLE_MAX` characters, naming no card), else the branch's first commit subject (the
 * agent writes it as a change's title), else the first sentence of the agent's summary, either
 * cut to `TITLE_MAX` at a clause or a word (`shortenTitle`). It never names the card: Linear's
 * GitHub integration moves a card named in a PR's title (it closed PEN-75 when #62 merged), and
 * the factory owns the card's status (A1221). The body's "Part of" links it.
 */
export function prTitle(input: {
  readonly title?: string | undefined;
  readonly subject?: string | undefined;
  readonly summary: string;
  readonly key: string;
}): string {
  const team = /^([A-Za-z][A-Za-z0-9]*)-\d+$/.exec(input.key)?.[1];
  const clean = (text: string) => {
    let t = text.split('\n')[0] ?? '';
    if (team) t = t.replaceAll(new RegExp(`[([]?\\b${team}-\\d+\\b[)\\]]?:?`, 'gi'), ' ');
    return t
      .replaceAll(/\(\s*\)|\[\s*\]/g, ' ')
      .replaceAll(/\s+/g, ' ')
      .replaceAll(/^[\s:;,–-]+|[\s:;,–-]+$/g, '');
  };
  const own = input.title?.trim().replace(/\.$/, '') ?? '';
  const usable =
    own !== '' &&
    !own.includes('\n') &&
    own.length <= AGENT_TITLE_MAX &&
    !(team && new RegExp(`\\b${team}-\\d+\\b`, 'i').test(own));
  if (usable) return own;
  const subject =
    input.subject && !input.subject.startsWith('Number the new decisions')
      ? clean(input.subject)
      : '';
  const sentence = clean(input.summary.split(/(?<=[.!?])\s/)[0] ?? '').replace(/\.$/, '');
  return shortenTitle(subject || sentence || 'The factory’s change');
}
