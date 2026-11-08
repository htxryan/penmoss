/**
 * `task factory:linear:check` (L2): is Linear's Penmoss team set up the factory's way? It names
 * each missing state, label and label group, and exits non-zero while any is missing. With
 * `--fix` it creates them as Ryan, with his own key; `--me` prints his Linear user ID for
 * `config.linear.owner`.
 */
import type { FactoryConfig } from '../config.ts';
import type { LinearClient } from './linear-client.ts';

export interface Snapshot {
  readonly team: { readonly id: string } | null;
  readonly states: readonly { readonly name: string; readonly type: string }[];
  /** The team's labels and the workspace's, each with its group's name. */
  readonly labels: readonly {
    readonly id: string;
    readonly name: string;
    readonly isGroup: boolean;
    readonly group: string | null;
  }[];
  readonly owner: { readonly displayName: string; readonly active: boolean } | null;
}

export type Need =
  | { readonly kind: 'team' | 'owner'; readonly text: string }
  | { readonly kind: 'state'; readonly text: string; readonly name: string; readonly type: string }
  | { readonly kind: 'group'; readonly text: string; readonly name: string }
  | {
      readonly kind: 'label';
      readonly text: string;
      readonly name: string;
      readonly group: string | null;
    };

/** What the factory needs of the team, and what's missing. */
export function teamNeeds(s: Snapshot, config: FactoryConfig): Need[] {
  const team = config.linear.team;
  if (!s.team) return [{ kind: 'team', text: `Linear has no team ${team} that this key can see` }];
  const needs: Need[] = [];
  const st = config.linear.status;
  const states: [string, string][] = [
    [st.pick, 'unstarted'],
    [st.planning, 'started'],
    [st.working, 'started'],
    [st.review, 'started'],
    [st.done, 'completed'],
  ];
  for (const [name, type] of states) {
    const found = s.states.find((x) => x.name === name);
    if (!found) needs.push({ kind: 'state', name, type, text: `state "${name}" (${type})` });
    else if (found.type !== type)
      needs.push({
        kind: 'owner',
        text: `state "${name}" is ${found.type}, not ${type}: change its type in Linear's team settings`,
      });
  }
  const has = (name: string, group: string | null) =>
    s.labels.some(
      (l) => !l.isGroup && l.name === name && (l.group?.toLowerCase() ?? null) === group,
    );
  for (const name of [
    config.linear.blockedLabel,
    config.planning.skipLabel,
    'platform:web',
    'platform:mac',
    'platform:android',
  ])
    if (!has(name, null)) needs.push({ kind: 'label', name, group: null, text: `label "${name}"` });
  // One label per group on an issue: Linear itself refuses two agents or two models (F12).
  const groups: [string, readonly string[]][] = [
    ['Agent', ['claude', 'opencode']],
    ['Model', Object.keys(config.models)],
  ];
  for (const [group, children] of groups) {
    if (!s.labels.some((l) => l.isGroup && l.name.toLowerCase() === group.toLowerCase()))
      needs.push({ kind: 'group', name: group, text: `label group "${group}"` });
    for (const name of children)
      if (!has(name, group.toLowerCase()))
        needs.push({ kind: 'label', name, group, text: `label "${name}" in the group "${group}"` });
  }
  if (!config.linear.owner)
    needs.push({
      kind: 'owner',
      text: "config.linear.owner is empty: run with --me to print Ryan's Linear user ID",
    });
  else if (!s.owner?.active)
    needs.push({
      kind: 'owner',
      text: `config.linear.owner (${config.linear.owner}) isn't an active user`,
    });
  return needs;
}

const SNAPSHOT = `
query Check($team: String!) {
  teams(filter: { key: { eq: $team } }) {
    nodes {
      id
      states(first: 50) { nodes { name type } }
      labels(first: 250) { nodes { id name isGroup parent { name } } }
    }
  }
  organization { labels(first: 250) { nodes { id name isGroup parent { name } team { id } } } }
}`;

const OWNER = `query Owner($id: String!) { user(id: $id) { displayName active } }`;

interface RawLabel {
  readonly id: string;
  readonly name: string;
  readonly isGroup: boolean;
  readonly parent: { readonly name: string } | null;
  readonly team?: { readonly id: string } | null;
}

export async function snapshot(client: LinearClient, config: FactoryConfig): Promise<Snapshot> {
  const raw = await client.request<{
    teams: {
      nodes: readonly {
        id: string;
        states: { nodes: readonly { name: string; type: string }[] };
        labels: { nodes: readonly RawLabel[] };
      }[];
    };
    organization: { labels: { nodes: readonly RawLabel[] } };
  }>(SNAPSHOT, { team: config.linear.team });
  const team = raw.teams.nodes[0] ?? null;
  const owner = config.linear.owner
    ? await client
        .request<{ user: { displayName: string; active: boolean } | null }>(OWNER, {
          id: config.linear.owner,
        })
        .then((r) => r.user)
        .catch(() => null)
    : null;
  const label = (l: RawLabel) => ({
    id: l.id,
    name: l.name,
    isGroup: l.isGroup,
    group: l.parent?.name ?? null,
  });
  return {
    team: team && { id: team.id },
    states: team?.states.nodes ?? [],
    labels: [
      ...(team?.labels.nodes ?? []).map(label),
      ...raw.organization.labels.nodes.filter((l) => !l.team).map(label),
    ],
    owner,
  };
}

const CREATE_STATE = `
mutation($team: String!, $name: String!, $type: String!) {
  workflowStateCreate(input: { teamId: $team, name: $name, type: $type, color: "#5e6ad2" }) { success }
}`;
const CREATE_LABEL = `
mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id } } }`;

/** Creates what's missing, as Ryan: states, then groups, then the labels in them. */
export async function fix(
  client: LinearClient,
  config: FactoryConfig,
  log: (line: string) => void,
): Promise<void> {
  let s = await snapshot(client, config);
  if (!s.team) throw new Error(`no team ${config.linear.team}`);
  const teamId = s.team.id;
  const needs = teamNeeds(s, config);
  for (const n of needs.filter((x) => x.kind === 'state')) {
    await client.request(CREATE_STATE, { team: teamId, name: n.name, type: n.type });
    log(`created ${n.text}`);
  }
  for (const n of needs.filter((x) => x.kind === 'group')) {
    await client.request(CREATE_LABEL, { input: { teamId, name: n.name, isGroup: true } });
    log(`created ${n.text}`);
  }
  s = await snapshot(client, config);
  for (const n of needs) {
    if (n.kind !== 'label') continue;
    const parent = n.group
      ? s.labels.find((l) => l.isGroup && l.name.toLowerCase() === n.group!.toLowerCase())?.id
      : undefined;
    await client.request(CREATE_LABEL, {
      input: { teamId, name: n.name, ...(parent ? { parentId: parent } : {}) },
    });
    log(`created ${n.text}`);
  }
}
