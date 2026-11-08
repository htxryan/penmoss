/**
 * The graph's data (T17): notes as nodes and wikilinks as undirected edges,
 * from the local link index, cut down by scope (the whole vault, or the notes
 * within `depth` links of one note) and filters (top-level folder, tag,
 * orphans), optionally with tags as nodes. Pure and DOM-free.
 */

export interface GraphNoteInput {
  readonly id: string;
  readonly title: string;
  /** The note's top-level folder (its colour), or null at the top level. */
  readonly group: string | null;
  readonly tags: readonly string[];
  /** Ids of the notes it links to or embeds (unknown ids are ignored). */
  readonly links: readonly string[];
}

export type GraphScope =
  | { readonly kind: 'global' }
  | { readonly kind: 'local'; readonly id: string; readonly depth: number };

export interface GraphFilters {
  /** Top-level folders to show (null: all). The top level is `null` in the set. */
  readonly groups: ReadonlySet<string | null> | null;
  /** Only notes with this tag (null: any). */
  readonly tag: string | null;
  /** Show notes with no links. */
  readonly orphans: boolean;
  /** Show tags as nodes, linked to their notes. */
  readonly tagNodes: boolean;
}

export const DEFAULT_FILTERS: GraphFilters = {
  groups: null,
  tag: null,
  orphans: true,
  tagNodes: false,
};

export interface GraphNode {
  readonly id: string;
  readonly label: string;
  readonly kind: 'note' | 'tag';
  readonly group: string | null;
  /** Edges at this node, in the shown graph. */
  degree: number;
}

export interface GraphEdge {
  readonly source: string;
  readonly target: string;
  readonly tag: boolean;
}

export interface GraphData {
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
}

const TAG_PREFIX = 'tag:';

/** Unique undirected edges between known notes, without self-links. */
function noteEdges(notes: ReadonlyMap<string, GraphNoteInput>): GraphEdge[] {
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const note of notes.values()) {
    for (const target of note.links) {
      if (target === note.id || !notes.has(target)) continue;
      const key = note.id < target ? `${note.id} ${target}` : `${target} ${note.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: note.id, target, tag: false });
    }
  }
  return edges;
}

export function buildGraph(
  input: readonly GraphNoteInput[],
  scope: GraphScope,
  filters: GraphFilters = DEFAULT_FILTERS,
): GraphData {
  const all = new Map(input.map((note) => [note.id, note]));
  let edges = noteEdges(all);
  let keep: Set<string>;
  const center = scope.kind === 'local' ? scope.id : null;

  if (scope.kind === 'local') {
    const adjacent = new Map<string, string[]>();
    for (const edge of edges) {
      (adjacent.get(edge.source) ?? adjacent.set(edge.source, []).get(edge.source)!).push(
        edge.target,
      );
      (adjacent.get(edge.target) ?? adjacent.set(edge.target, []).get(edge.target)!).push(
        edge.source,
      );
    }
    keep = new Set(all.has(scope.id) ? [scope.id] : []);
    let frontier = [...keep];
    for (let hop = 0; hop < scope.depth && frontier.length > 0; hop++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const other of adjacent.get(id) ?? []) {
          if (!keep.has(other)) {
            keep.add(other);
            next.push(other);
          }
        }
      }
      frontier = next;
    }
  } else {
    keep = new Set(all.keys());
  }

  // Folder and tag filters (the local graph's centre always stays).
  for (const id of [...keep]) {
    if (id === center) continue;
    const note = all.get(id)!;
    if (filters.groups && !filters.groups.has(note.group)) keep.delete(id);
    else if (filters.tag && !note.tags.includes(filters.tag)) keep.delete(id);
  }
  edges = edges.filter((edge) => keep.has(edge.source) && keep.has(edge.target));

  const degree = new Map<string, number>();
  const bump = (id: string) => degree.set(id, (degree.get(id) ?? 0) + 1);
  for (const edge of edges) {
    bump(edge.source);
    bump(edge.target);
  }
  if (!filters.orphans) {
    for (const id of [...keep]) if (id !== center && !degree.has(id)) keep.delete(id);
  }

  const nodes: GraphNode[] = [...keep].map((id) => {
    const note = all.get(id)!;
    return {
      id,
      label: note.title.trim() || 'Untitled',
      kind: 'note',
      group: note.group,
      degree: 0,
    };
  });
  if (filters.tagNodes) {
    const tags = new Map<string, string[]>();
    for (const id of keep) {
      for (const tag of all.get(id)!.tags) (tags.get(tag) ?? tags.set(tag, []).get(tag)!).push(id);
    }
    for (const [tag, ids] of tags) {
      nodes.push({
        id: `${TAG_PREFIX}${tag}`,
        label: `#${tag}`,
        kind: 'tag',
        group: null,
        degree: 0,
      });
      for (const id of ids) edges.push({ source: id, target: `${TAG_PREFIX}${tag}`, tag: true });
    }
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const edge of edges) {
    byId.get(edge.source)!.degree++;
    byId.get(edge.target)!.degree++;
  }
  return { nodes, edges };
}

/** Every tag on the notes, most used first (for the tag filter). */
export function tagsOf(input: readonly GraphNoteInput[]): string[] {
  const counts = new Map<string, number>();
  for (const note of input)
    for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag]) => tag);
}

/** A synthetic vault of `notes` notes and about `links` links, in clusters (perf tests). */
export function syntheticGraph(notes: number, links: number, seed = 1): GraphNoteInput[] {
  let state = seed;
  const random = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const groups = ['Journal', 'Projects', 'Areas', 'Reading', 'Inbox', null];
  const out = Array.from({ length: notes }, (_, i) => ({
    id: `n${i}`,
    title: `Note ${i}`,
    group: groups[i % groups.length]!,
    tags: i % 7 === 0 ? ['review'] : [],
    links: [] as string[],
  }));
  for (let i = 0; i < links; i++) {
    const from = Math.floor(random() * notes);
    // Mostly near neighbours (clusters), sometimes anywhere.
    const to =
      random() < 0.8
        ? (from + 1 + Math.floor(random() * 20)) % notes
        : Math.floor(random() * notes);
    out[from]!.links.push(`n${to}`);
  }
  return out;
}
