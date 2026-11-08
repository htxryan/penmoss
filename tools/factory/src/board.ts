/**
 * Project 8 as the factory sees it: every issue card with its Status, its
 * Blocked field and its labels, in board order. Writes are limited to moving a
 * card and setting Blocked. There is deliberately no way to clear Blocked here:
 * only Ryan clears it (R23), and the Factory UI does that as him (F21).
 */
import type { FactoryConfig } from './config.ts';
import type { Gh } from './github.ts';

export interface BoardItem {
  /** The project item's node ID, used for field updates. */
  readonly itemId: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly repo: string;
  readonly state: 'OPEN' | 'CLOSED';
  readonly author: string;
  readonly labels: readonly string[];
  readonly status: string | null;
  readonly blocked: boolean;
  /** Position on the board, 0 first. */
  readonly position: number;
}

export interface SingleSelectField {
  readonly id: string;
  readonly options: Readonly<Record<string, string>>;
}

export interface Board {
  readonly projectId: string;
  readonly status: SingleSelectField;
  readonly blocked: SingleSelectField;
  readonly items: readonly BoardItem[];
}

const FIELDS_AND_ITEMS = `
query($owner: String!, $number: Int!, $cursor: String) {
  user(login: $owner) {
    projectV2(number: $number) {
      id
      fields(first: 50) {
        nodes { ... on ProjectV2SingleSelectField { id name options { id name } } }
      }
      items(first: 100, after: $cursor, orderBy: { field: POSITION, direction: ASC }) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          content {
            ... on Issue {
              number title url state
              repository { nameWithOwner }
              author { login }
              labels(first: 30) { nodes { name } }
            }
          }
          fieldValues(first: 30) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2SingleSelectField { name } }
              }
            }
          }
        }
      }
    }
  }
}`;

interface RawField {
  readonly id?: string;
  readonly name?: string;
  readonly options?: readonly { readonly id: string; readonly name: string }[];
}

interface RawItem {
  readonly id: string;
  readonly content: {
    readonly number?: number;
    readonly title?: string;
    readonly url?: string;
    readonly state?: 'OPEN' | 'CLOSED';
    readonly repository?: { readonly nameWithOwner: string };
    readonly author?: { readonly login: string } | null;
    readonly labels?: { readonly nodes: readonly { readonly name: string }[] };
  } | null;
  readonly fieldValues: {
    readonly nodes: readonly {
      readonly name?: string;
      readonly field?: { readonly name?: string };
    }[];
  };
}

interface RawPage {
  readonly user: {
    readonly projectV2: {
      readonly id: string;
      readonly fields: { readonly nodes: readonly RawField[] };
      readonly items: {
        readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
        readonly nodes: readonly RawItem[];
      };
    } | null;
  } | null;
}

function selectField(fields: readonly RawField[], name: string): SingleSelectField {
  const field = fields.find((f) => f.name === name && f.id && f.options);
  if (!field?.id || !field.options)
    throw new Error(`Project has no single-select field named "${name}"`);
  return { id: field.id, options: Object.fromEntries(field.options.map((o) => [o.name, o.id])) };
}

/** Reads the whole board (issues only; draft items and pull requests are skipped). */
export async function readBoard(gh: Gh, config: FactoryConfig): Promise<Board> {
  const items: BoardItem[] = [];
  let cursor: string | undefined;
  let projectId: string | undefined;
  let status: SingleSelectField | undefined;
  let blocked: SingleSelectField | undefined;
  let position = 0;
  for (;;) {
    const page = await gh.graphql<RawPage>(FIELDS_AND_ITEMS, {
      owner: config.project.owner,
      number: config.project.number,
      cursor,
    });
    const project = page.user?.projectV2;
    if (!project)
      throw new Error(`Project ${config.project.owner}/${config.project.number} not found`);
    projectId = project.id;
    status ??= selectField(project.fields.nodes, 'Status');
    blocked ??= selectField(project.fields.nodes, config.blockedField);
    for (const node of project.items.nodes) {
      const c = node.content;
      if (!c?.number || !c.repository || !c.title || !c.url || !c.state) continue;
      const value = (field: string): string | null =>
        node.fieldValues.nodes.find((v) => v.field?.name === field)?.name ?? null;
      items.push({
        itemId: node.id,
        number: c.number,
        title: c.title,
        url: c.url,
        repo: c.repository.nameWithOwner,
        state: c.state,
        author: c.author?.login ?? '',
        labels: c.labels?.nodes.map((l) => l.name) ?? [],
        status: value('Status'),
        blocked: value(config.blockedField) !== null,
        position: position++,
      });
    }
    if (!project.items.pageInfo.hasNextPage || !project.items.pageInfo.endCursor) break;
    cursor = project.items.pageInfo.endCursor;
  }
  if (!projectId || !status || !blocked) throw new Error('Project fields missing');
  return { projectId, status, blocked, items };
}

const SET_SINGLE_SELECT = `
mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option }
  }) { projectV2Item { id } }
}`;

/** Moves a card to another status, by the status's name. */
export async function setStatus(
  gh: Gh,
  board: Board,
  item: BoardItem,
  statusName: string,
): Promise<void> {
  const option = board.status.options[statusName];
  if (!option) throw new Error(`Status "${statusName}" doesn't exist on the board`);
  await gh.graphql(SET_SINGLE_SELECT, {
    project: board.projectId,
    item: item.itemId,
    field: board.status.id,
    option,
  });
}

/** Sets the Blocked field. The factory can only set it, never clear it (R23). */
export async function setBlocked(gh: Gh, board: Board, item: BoardItem): Promise<void> {
  const option = Object.values(board.blocked.options)[0];
  if (!option) throw new Error('The Blocked field has no option to set');
  await gh.graphql(SET_SINGLE_SELECT, {
    project: board.projectId,
    item: item.itemId,
    field: board.blocked.id,
    option,
  });
}
