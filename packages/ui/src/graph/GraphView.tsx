/**
 * The graph view (T17): the whole vault, or the notes within a few links of
 * one note, with filters (top-level folder, tag, orphans, tags as nodes) and
 * a legend of folder colours. Loaded lazily with d3-force; the app passes the
 * notes and links from its local index, so the graph works offline and costs
 * the Worker nothing.
 */
import { useMemo, useState } from 'react';
import { GraphCanvas } from './GraphCanvas';
import {
  buildGraph,
  DEFAULT_FILTERS,
  tagsOf,
  type GraphFilters,
  type GraphNoteInput,
  type GraphScope,
} from './model';
import { Select } from '../controls/Select';

export interface GraphGroup {
  /** A top-level folder's id; null for notes at the top level. */
  readonly id: string | null;
  readonly name: string;
}

export interface GraphViewProps {
  readonly notes: readonly GraphNoteInput[];
  /** Top-level folders in sidebar order (their colours follow this order). */
  readonly groups: readonly GraphGroup[];
  /** The note a local graph centres on (null: only the global graph). */
  readonly note: string | null;
  /** Whether the local graph is shown. */
  readonly local: boolean;
  readonly onLocalChange: (local: boolean) => void;
  readonly onOpen: (id: string, newTab: boolean) => void;
  /** The note's title, for the local graph's heading. */
  readonly noteTitle?: string | null;
}

const DEPTHS = [1, 2, 3, 4] as const;
const ALL = '*';
const TOP = '';

export function GraphView({
  notes,
  groups,
  note,
  local,
  onLocalChange,
  onOpen,
  noteTitle,
}: GraphViewProps) {
  const [depth, setDepth] = useState(2);
  const [filters, setFilters] = useState<GraphFilters>(DEFAULT_FILTERS);
  const tags = useMemo(() => tagsOf(notes), [notes]);
  const isLocal = local && note !== null;
  const scope: GraphScope = isLocal ? { kind: 'local', id: note, depth } : { kind: 'global' };
  const scopeKey = isLocal ? `local:${note}:${depth}` : 'global';
  const data = useMemo(
    () => buildGraph(notes, scope, filters),
    // `scope` is rebuilt each render; scopeKey says when it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [notes, scopeKey, filters],
  );
  const colourOrder = useMemo(() => groups.map((group) => group.id), [groups]);
  const names = useMemo(() => new Map(groups.map((group) => [group.id, group.name])), [groups]);
  const shownGroups = useMemo(() => {
    const present = new Set(data.nodes.map((node) => node.group));
    return groups.filter((group) => present.has(group.id));
  }, [data, groups]);
  const noteCount = data.nodes.filter((node) => node.kind === 'note').length;
  const linkCount = data.edges.filter((edge) => !edge.tag).length;
  const groupValue =
    filters.groups === null
      ? ALL
      : ([...filters.groups][0] ?? null) === null
        ? TOP
        : [...filters.groups][0]!;

  return (
    <section className="pm-graph" data-testid="graph-view" aria-label="Graph">
      <div className="pm-graph-bar" role="toolbar" aria-label="Graph options">
        <div className="pm-graph-scope" role="group" aria-label="Scope">
          <button
            type="button"
            aria-pressed={!isLocal}
            onClick={() => onLocalChange(false)}
            data-testid="graph-global"
          >
            All Notes
          </button>
          <button
            type="button"
            aria-pressed={isLocal}
            disabled={note === null}
            onClick={() => onLocalChange(true)}
            data-testid="graph-local"
            title={note === null ? 'Open a note to see its local graph' : undefined}
          >
            {noteTitle ? `Around “${noteTitle}”` : 'This Note'}
          </button>
        </div>
        {isLocal && (
          <label className="pm-graph-field">
            Depth
            <Select
              size="small"
              value={depth}
              onChange={(event) => setDepth(Number(event.target.value))}
              data-testid="graph-depth"
            >
              {DEPTHS.map((value) => (
                <option key={value} value={value}>
                  {value === 1 ? '1 Link' : `${value} Links`}
                </option>
              ))}
            </Select>
          </label>
        )}
        <label className="pm-graph-field">
          Folder
          <Select
            size="small"
            value={groupValue}
            data-testid="graph-folder"
            onChange={(event) => {
              const value = event.target.value;
              setFilters({
                ...filters,
                groups: value === ALL ? null : new Set([value === TOP ? null : value]),
              });
            }}
          >
            <option value={ALL}>All Folders</option>
            {groups.map((group) => (
              <option key={group.id ?? TOP} value={group.id ?? TOP}>
                {group.name}
              </option>
            ))}
          </Select>
        </label>
        {tags.length > 0 && (
          <>
            <label className="pm-graph-field">
              Tag
              <Select
                size="small"
                value={filters.tag ?? ALL}
                data-testid="graph-tag"
                onChange={(event) =>
                  setFilters({
                    ...filters,
                    tag: event.target.value === ALL ? null : event.target.value,
                  })
                }
              >
                <option value={ALL}>Any Tag</option>
                {tags.map((tag) => (
                  <option key={tag} value={tag}>
                    #{tag}
                  </option>
                ))}
              </Select>
            </label>
            <label className="pm-graph-check">
              <input
                type="checkbox"
                checked={filters.tagNodes}
                onChange={(event) => setFilters({ ...filters, tagNodes: event.target.checked })}
              />
              Tags as Nodes
            </label>
          </>
        )}
        <label className="pm-graph-check">
          <input
            type="checkbox"
            checked={filters.orphans}
            data-testid="graph-orphans"
            onChange={(event) => setFilters({ ...filters, orphans: event.target.checked })}
          />
          Unlinked Notes
        </label>
        <p className="pm-graph-count" data-testid="graph-count">
          {noteCount === 1 ? '1 note' : `${noteCount} notes`} ·{' '}
          {linkCount === 1 ? '1 link' : `${linkCount} links`}
        </p>
      </div>
      {shownGroups.length > 1 && (
        <ul className="pm-graph-legend" aria-label="Folder colours">
          {shownGroups.map((group) => (
            <li key={group.id ?? TOP}>
              <span
                className="pm-graph-swatch"
                data-group={group.id === null ? 'none' : colourOrder.indexOf(group.id) % 8}
                aria-hidden="true"
              />
              {group.name}
            </li>
          ))}
        </ul>
      )}
      {data.nodes.length === 0 ? (
        <p className="pm-graph-empty" data-testid="graph-empty">
          {notes.length === 0 ? 'No notes yet.' : 'No notes match these filters.'}
        </p>
      ) : (
        <GraphCanvas
          data={data}
          groups={colourOrder}
          centre={isLocal ? note : null}
          groupName={(group) => names.get(group) ?? null}
          onOpen={onOpen}
          label={
            isLocal
              ? `Local graph: ${noteCount} notes within ${depth} links of ${noteTitle ?? 'this note'}`
              : `Graph of ${noteCount} notes and ${linkCount} links`
          }
        />
      )}
    </section>
  );
}
