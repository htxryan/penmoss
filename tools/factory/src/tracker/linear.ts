/**
 * Linear's tracker (LD1): the cards are the Penmoss team's issues, PEN-36 being card 36. Status
 * is the issue's workflow state, Blocked is a label the factory only ever adds (LD3), and an
 * unfinished "blocked by" issue keeps a card Blocked too (LD8). Pickup order is Linear's own
 * priority, then the team's manual order (LD11). The factory acts as its OAuth app (LD4).
 */
import type { FactoryConfig } from '../config.ts';
import type { Issue } from '../issue.ts';
import type { Priority } from '../labels.ts';
import type { LinearClient } from './linear-client.ts';
import type { Board, BoardItem, Tracker } from './port.ts';

interface RawLabel {
  readonly name: string;
  readonly parent?: { readonly name: string } | null;
}

interface RawRelation {
  readonly type: string;
  readonly issue: { readonly identifier: string; readonly state: { readonly type: string } } | null;
}

interface RawCard {
  readonly id: string;
  readonly identifier: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly priority: number;
  readonly sortOrder: number;
  readonly state: { readonly name: string; readonly type: string };
  readonly creator: { readonly id: string } | null;
  readonly labels: { readonly nodes: readonly RawLabel[] };
  readonly inverseRelations: { readonly nodes: readonly RawRelation[] };
}

const CARD = `
  id identifier number title url priority sortOrder
  state { name type }
  creator { id }
  labels(first: 25) { nodes { name parent { name } } }
  inverseRelations(first: 10) { nodes { type issue { identifier state { type } } } }`;

const BOARD = (doneDays: number) => `
query Board($team: String!, $states: [String!], $after: String) {
  issues(first: 50, after: $after, filter: {
    team: { key: { eq: $team } },
    or: [{ state: { name: { in: $states } } }, { completedAt: { gt: "-P${doneDays}D" } }]
  }) {
    pageInfo { hasNextPage endCursor }
    nodes { ${CARD} }
  }
}`;

const ONE = `query Card($id: String!) { issue(id: $id) { ${CARD} } }`;

const ISSUE = `
query Issue($id: String!) {
  issue(id: $id) {
    id identifier number title description url
    creator { id displayName }
    attachments(first: 25) { nodes { url } }
    comments(first: 100) { nodes { body createdAt user { id displayName } } }
  }
}`;

const TEAM = `
query Team($team: String!, $label: String!) {
  teams(first: 1, filter: { key: { eq: $team } }) {
    nodes { id key states(first: 50) { nodes { id name type } } }
  }
  issueLabels(first: 25, filter: { name: { eq: $label } }) { nodes { id team { key } } }
}`;

const SET_STATE = `
mutation($id: String!, $state: String!) {
  issueUpdate(id: $id, input: { stateId: $state }) { success }
}`;
const ADD_LABEL = `
mutation($id: String!, $label: String!) { issueAddLabel(id: $id, labelId: $label) { success } }`;
const COMMENT = `
mutation($issue: String!, $body: String!) {
  commentCreate(input: { issueId: $issue, body: $body }) { success }
}`;

export interface LinearTeam {
  readonly id: string;
  /** State name → ID. */
  readonly states: Readonly<Record<string, string>>;
  readonly blockedLabel: string | undefined;
}

/** Linear's priority (0 none, 1 Urgent … 4 Low) as pickup priority; none counts as Medium (P3). */
export function priorityOf(linear: number): Priority {
  return linear === 1 || linear === 2 || linear === 4 ? linear : 3;
}

/** A label as the factory's label rules read it: group `Agent`, label `claude` → `agent:claude`. */
export function labelName(label: RawLabel): string {
  return label.parent ? `${label.parent.name.toLowerCase()}:${label.name}` : label.name;
}

const FINISHED = new Set(['completed', 'canceled']);

/** The issues that block this one and aren't finished (LD8). */
function blockers(card: RawCard): string[] {
  return card.inverseRelations.nodes
    .filter((r) => r.type === 'blocks' && r.issue && !FINISHED.has(r.issue.state.type))
    .map((r) => r.issue!.identifier);
}

export function toItem(card: RawCard, config: FactoryConfig, position: number): BoardItem {
  const blockedBy = blockers(card);
  const set = card.labels.nodes.some((l) => l.name === config.linear.blockedLabel);
  return {
    itemId: card.id,
    number: card.number,
    key: card.identifier,
    title: card.title,
    url: card.url,
    repo: config.repo,
    state: FINISHED.has(card.state.type) ? 'CLOSED' : 'OPEN',
    author: card.creator?.id ?? '',
    labels: card.labels.nodes.map(labelName),
    status: card.state.name,
    blocked: set || blockedBy.length > 0,
    ...(blockedBy.length ? { blockedBy, blockedSet: set } : {}),
    priority: priorityOf(card.priority),
    position,
  };
}

/**
 * The factory's hidden markers (`<!-- penmoss-factory … -->`) as a visible code line: Linear
 * keeps comments as Markdown, which an HTML comment may not survive (LD5).
 */
export function linearBody(body: string): string {
  return body.replaceAll(/<!--\s*(penmoss-factory\s[^>]*?)\s*-->/g, '`$1`');
}

/** Whether the description came from outside: the GitHub intake files it as Ryan (D66). */
function external(description: string, attachments: readonly { url: string }[]): boolean {
  return (
    description.startsWith('From GitHub: [') ||
    attachments.some((a) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+/.test(a.url))
  );
}

export function createLinearTracker(
  config: FactoryConfig,
  client: LinearClient,
): Tracker & {
  team(): Promise<LinearTeam>;
} {
  const key = (n: number) => `${config.linear.team}-${n}`;
  const ids = new Map<number, string>();
  let team: LinearTeam | undefined;

  const loadTeam = async (): Promise<LinearTeam> => {
    if (team) return team;
    const raw = await client.request<{
      teams: {
        nodes: readonly {
          id: string;
          states: { nodes: readonly { id: string; name: string; type: string }[] };
        }[];
      };
      issueLabels: { nodes: readonly { id: string; team: { key: string } | null }[] };
    }>(TEAM, { team: config.linear.team, label: config.linear.blockedLabel });
    const found = raw.teams.nodes[0];
    if (!found)
      throw new Error(`Linear has no team ${config.linear.team} that the factory can see`);
    const labels = raw.issueLabels.nodes;
    const blocked =
      labels.find((l) => l.team?.key === config.linear.team) ?? labels.find((l) => !l.team);
    team = {
      id: found.id,
      states: Object.fromEntries(found.states.nodes.map((s) => [s.name, s.id])),
      blockedLabel: blocked?.id,
    };
    return team;
  };

  const idOf = async (n: number): Promise<string> => {
    const known = ids.get(n);
    if (known) return known;
    const raw = await client.request<{ issue: RawCard | null }>(ONE, { id: key(n) });
    if (!raw.issue) throw new Error(`${key(n)} doesn't exist or the factory can't see it`);
    ids.set(n, raw.issue.id);
    return raw.issue.id;
  };

  const ok = (what: string, result: { success: boolean } | undefined) => {
    if (!result?.success) throw new Error(`Linear didn't ${what}`);
  };

  const comment = async (n: number, body: string): Promise<void> => {
    const r = await client.request<{ commentCreate: { success: boolean } }>(COMMENT, {
      issue: await idOf(n),
      body: linearBody(body),
    });
    ok(`post the comment on ${key(n)}`, r.commentCreate);
  };

  return {
    name: 'linear',
    owner: config.linear.owner,
    team: loadTeam,
    async readBoard(): Promise<Board> {
      const s = config.status;
      const cards: RawCard[] = [];
      let after: string | undefined;
      for (;;) {
        const page = await client.request<{
          issues: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: readonly RawCard[];
          };
        }>(BOARD(config.ui.doneDays), {
          team: config.linear.team,
          states: [s.pick, s.planning, s.working, s.review],
          ...(after ? { after } : {}),
        });
        cards.push(...page.issues.nodes);
        if (!page.issues.pageInfo.hasNextPage || !page.issues.pageInfo.endCursor) break;
        after = page.issues.pageInfo.endCursor;
      }
      // The team's manual order; Linear sorts lower sortOrder first.
      cards.sort((a, b) => a.sortOrder - b.sortOrder);
      for (const c of cards) ids.set(c.number, c.id);
      return { items: cards.map((c, i) => toItem(c, config, i)) };
    },
    async readIssue(n) {
      const raw = await client.request<{
        issue: {
          id: string;
          identifier: string;
          number: number;
          title: string;
          description: string | null;
          url: string;
          creator: { id: string; displayName: string } | null;
          attachments: { nodes: readonly { url: string }[] };
          comments: {
            nodes: readonly {
              body: string;
              createdAt: string;
              user: { id: string; displayName: string } | null;
            }[];
          };
        } | null;
      }>(ISSUE, { id: key(n) });
      const i = raw.issue;
      if (!i) throw new Error(`${key(n)} doesn't exist or the factory can't see it`);
      ids.set(n, i.id);
      const description = i.description ?? '';
      const result: Issue = {
        number: i.number,
        key: i.identifier,
        title: i.title,
        body: description,
        author: i.creator?.id ?? '',
        authorName: i.creator?.displayName ?? 'unknown',
        external: external(description, i.attachments.nodes),
        url: i.url,
        labels: [],
        comments: [...i.comments.nodes]
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map((c) => ({
            author: c.user?.id ?? '',
            authorName: c.user?.displayName ?? 'an integration',
            body: c.body,
            createdAt: c.createdAt,
          })),
      };
      return result;
    },
    async isBlocked(n) {
      const raw = await client.request<{ issue: RawCard | null }>(ONE, { id: key(n) });
      // A card that has gone (deleted, moved to another team) is treated as Blocked: hands off.
      return raw.issue ? toItem(raw.issue, config, 0).blocked : true;
    },
    comment,
    async setStatus(item, status) {
      const state = (await loadTeam()).states[status];
      if (!state)
        throw new Error(
          `Linear's ${config.linear.team} team has no state "${status}" (task factory:linear:check)`,
        );
      const r = await client.request<{ issueUpdate: { success: boolean } }>(SET_STATE, {
        id: item.itemId,
        state,
      });
      ok(`move ${item.key} to ${status}`, r.issueUpdate);
    },
    async setBlocked(item) {
      const label = (await loadTeam()).blockedLabel;
      if (!label)
        throw new Error(
          `Linear has no "${config.linear.blockedLabel}" label for ${config.linear.team} (task factory:linear:check)`,
        );
      const r = await client.request<{ issueAddLabel: { success: boolean } }>(ADD_LABEL, {
        id: item.itemId,
        label,
      });
      ok(`set ${config.linear.blockedLabel} on ${item.key}`, r.issueAddLabel);
    },
    async closeIssue(n, body) {
      // The move to Done is the caller's setStatus; on Linear, closing is only the comment.
      await comment(n, body);
    },
  };
}
