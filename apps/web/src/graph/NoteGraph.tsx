/**
 * The note side panel's Local Graph tab (T51 item 6, A936): the open note's
 * neighbourhood, the notes within one to three links of it, drawn as the
 * graph page draws it, with Open Full Graph a click away. Loaded lazily with
 * d3-force and the graph's styles (NoteView), so a note that never shows the
 * tab never pays for them. A click on a note opens it.
 */
import { GraphCanvas } from '@penmoss/ui/graph/GraphCanvas';
import { buildGraph } from '@penmoss/ui/graph/model';
import { Select } from '@penmoss/ui/controls/Select';
import { Icon } from '@penmoss/ui/icons';
import { useId, useMemo, useState } from 'react';
import { useNoteList, useNotes } from '../notes/hooks';
import { displayTitle } from '../notes/list';
import { navigate, notePath } from '../router';
import { useClosedNotebooks } from '../workspace/notebooks';
import { useWorkspaceState } from '../workspace/hooks';
import { GraphInputCache } from './data';
import { graphPath } from './path';
import './graph.css';

const DEPTHS = [1, 2, 3] as const;
const DEPTH_KEY = 'penmoss.noteGraphDepth';

/** The depth last chosen on this device (2 until one is). */
function readDepth(): number {
  try {
    const value = Number(localStorage.getItem(DEPTH_KEY));
    return (DEPTHS as readonly number[]).includes(value) ? value : 2;
  } catch {
    return 2;
  }
}

function writeDepth(depth: number): void {
  try {
    localStorage.setItem(DEPTH_KEY, String(depth));
  } catch {
    // Private mode: the choice lasts for this page only.
  }
}

export function NoteGraph({ noteId }: { readonly noteId: string }) {
  const notes = useNotes();
  // The list changes whenever a note's title or content does; links are read with it.
  const list = useNoteList();
  const { snapshot } = useWorkspaceState();
  const closed = useClosedNotebooks();
  const [cache] = useState(() => new GraphInputCache());
  const [depth, setDepth] = useState(readDepth);
  const depthId = useId();
  const input = useMemo(
    () =>
      cache.get(notes.localLinks(), {
        folders: snapshot.folders,
        registry: snapshot.notes,
        rootSortMode: snapshot.rootSortMode,
        closed,
      }),
    // As GraphPage: `list` stands for the note store's state, which localLinks reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [notes, list, snapshot, cache, closed],
  );
  const data = useMemo(
    () => buildGraph(input.notes, { kind: 'local', id: noteId, depth }),
    [input, noteId, depth],
  );
  const colourOrder = useMemo(() => input.groups.map((group) => group.id), [input]);
  const names = useMemo(
    () => new Map(input.groups.map((group) => [group.id, group.name])),
    [input],
  );
  const known = data.nodes.some((node) => node.id === noteId);
  const title = displayTitle(list.find((entry) => entry.id === noteId)?.title ?? '');
  const others = data.nodes.length - (known ? 1 : 0);
  const links = data.edges.length;

  return (
    <section className="note-graph" aria-labelledby={`${depthId}-h`} data-testid="note-graph">
      <h2 id={`${depthId}-h`} className="info-heading">
        Local Graph
      </h2>
      <div className="note-graph-bar">
        <label className="note-graph-depth" htmlFor={depthId}>
          Depth
        </label>
        <Select
          id={depthId}
          size="small"
          value={depth}
          data-testid="note-graph-depth"
          onChange={(event) => {
            const next = Number(event.target.value);
            setDepth(next);
            writeDepth(next);
          }}
        >
          {DEPTHS.map((value) => (
            <option key={value} value={value}>
              {value === 1 ? '1 link' : `${value} links`}
            </option>
          ))}
        </Select>
        <span className="note-graph-count muted" data-testid="note-graph-count">
          {others === 1 ? '1 note' : `${others} notes`} ·{' '}
          {links === 1 ? '1 link' : `${links} links`}
        </span>
      </div>
      {known && others > 0 ? (
        <div className="note-graph-canvas">
          <GraphCanvas
            data={data}
            groups={colourOrder}
            centre={noteId}
            groupName={(group) => names.get(group) ?? null}
            onOpen={(id, newTab) => {
              if (newTab) window.open(notePath(id), '_blank', 'noopener');
              else navigate(notePath(id));
            }}
            label={`Local graph: ${others} ${others === 1 ? 'note' : 'notes'} within ${depth} ${
              depth === 1 ? 'link' : 'links'
            } of ${title}`}
          />
        </div>
      ) : (
        <p className="note-graph-empty muted" data-testid="note-graph-empty">
          {known
            ? 'No links yet. Link to another note with [[ and it shows here.'
            : 'This note is not in the graph yet.'}
        </p>
      )}
      <button
        type="button"
        className="btn quiet note-graph-open"
        data-ui="item"
        data-testid="open-full-graph"
        onClick={() => navigate(graphPath(noteId, true))}
      >
        <Icon name="graph" size={16} />
        Open Full Graph
      </button>
    </section>
  );
}
