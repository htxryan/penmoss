/**
 * The graph page (T40 P7, LK7, LK8; A478, A479): the web's graph model and
 * layout under touch, fed by the app. Checks the bridge against
 * apps/android/contract/graph-v1.json (the Kotlin GraphProtocolTest reads the
 * same file), the layout of a fixture, the local graph's depths, and that a tap
 * on a note shows its chip and a tap on the chip asks the app to open it.
 */
import { buildGraph } from '@penmoss/ui/graph/model';
import { afterEach, describe, expect, it } from 'vitest';
import contractJson from '../../contract/graph-v1.json';
import { GraphHost } from '../src/graph-host';
import {
  encodeFromGraph,
  GRAPH_DEPTHS,
  parseToGraph,
  type FromGraph,
  type GraphNote,
} from '../src/graph-protocol';

const contract = contractJson as unknown as {
  depths: number[];
  toGraph: unknown[];
  fromGraph: FromGraph[];
  invalidToGraph: string[];
  invalidFromGraph: string[];
};

const WIDTH = 360;
const HEIGHT = 640;

// A–B–C–D in a line, E on its own, F in a folder linked to A.
const NOTES: GraphNote[] = [
  { id: 'a', title: 'Garden', group: null, links: ['b', 'f'] },
  { id: 'b', title: 'Beds', group: null, links: ['c'] },
  { id: 'c', title: 'Compost', group: null, links: ['d', 'missing'] },
  { id: 'd', title: 'Dahlias', group: null, links: [] },
  { id: 'e', title: 'Errands', group: null, links: [] },
  { id: 'f', title: 'Fences', group: 'projects', links: ['a'] },
];
const GROUPS = [
  { id: 'projects', name: 'Projects' },
  { id: null, name: 'Top level' },
];

interface Harness {
  host: GraphHost;
  posted: FromGraph[];
  canvas: HTMLCanvasElement;
  chip: HTMLButtonElement;
  empty: HTMLElement;
  send(message: unknown): void;
  /** Runs the frames asked for so far. */
  frames(): void;
}

const hosts: GraphHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.close();
  document.body.replaceChildren();
});

function harness(): Harness {
  const root = document.createElement('main');
  const canvas = document.createElement('canvas');
  const chip = document.createElement('button');
  const empty = document.createElement('p');
  chip.hidden = true;
  empty.hidden = true;
  root.append(canvas, empty, chip);
  document.body.append(root);
  const posted: FromGraph[] = [];
  let queued: Array<() => void> = [];
  const host = new GraphHost({ root, canvas, chip, empty }, (message) => posted.push(message), {
    size: () => ({ width: WIDTH, height: HEIGHT }),
    requestFrame: (callback) => {
      queued.push(callback);
      return queued.length;
    },
    cancelFrame: () => {},
  });
  hosts.push(host);
  host.start();
  return {
    host,
    posted,
    canvas,
    chip,
    empty,
    send: (message) => host.receive(JSON.stringify(message)),
    frames: () => {
      const run = queued;
      queued = [];
      for (const callback of run) callback();
    },
  };
}

function pointer(target: Element, type: string, id: number, x: number, y: number) {
  target.dispatchEvent(
    new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true }),
  );
}

function tap(target: Element, at: { x: number; y: number }) {
  pointer(target, 'pointerdown', 1, at.x, at.y);
  pointer(target, 'pointerup', 1, at.x, at.y);
}

function shown(h: Harness) {
  return h.posted.filter((message) => message.type === 'shown');
}

function showAll(h: Harness) {
  h.send({ v: 1, type: 'graph', notes: NOTES, groups: GROUPS });
  h.send({ v: 1, type: 'scope', scope: { kind: 'global' } });
}

describe('graph contract v1 (T40 P7, A478)', () => {
  it('offers the depths the app offers', () => {
    expect([...GRAPH_DEPTHS]).toEqual(contract.depths);
  });

  it('reads every message the app may send', () => {
    for (const message of contract.toGraph) {
      expect(parseToGraph(JSON.stringify(message))).toEqual(message);
    }
  });

  it('refuses malformed messages and other versions', () => {
    for (const raw of contract.invalidToGraph) expect(parseToGraph(raw)).toBeNull();
  });

  it('writes messages in the shapes the app reads', () => {
    for (const message of contract.fromGraph) {
      expect(JSON.parse(encodeFromGraph(message))).toEqual(message);
    }
  });

  it('answers the example messages with messages of the contract types only', () => {
    const h = harness();
    for (const message of contract.toGraph) h.send(message);
    const types = new Set(contract.fromGraph.map((message) => message.type));
    for (const message of h.posted) expect(types.has(message.type)).toBe(true);
  });
});

describe('the graph page (T40 P7, LK7, LK8)', () => {
  it('says ready, and draws nothing until it has the notes and what to show', () => {
    const h = harness();
    expect(h.posted).toEqual([{ v: 1, type: 'ready' }]);
    h.send({ v: 1, type: 'graph', notes: NOTES, groups: GROUPS });
    expect(shown(h)).toEqual([]);
    h.send({ v: 1, type: 'scope', scope: { kind: 'global' } });
    expect(shown(h)).toEqual([{ v: 1, type: 'shown', notes: 6, links: 4 }]);
  });

  it('lays out every note as the web’s model builds it, inside the screen', () => {
    const h = harness();
    showAll(h);
    h.frames();
    const web = buildGraph(
      NOTES.map((note) => ({ ...note, tags: [] })),
      { kind: 'global' },
    );
    expect(h.host.shownIds).toEqual(web.nodes.map((node) => node.id));
    const points = h.host.shownIds.map((id) => h.host.positionOf(id)!);
    for (const point of points) {
      expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(WIDTH);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(HEIGHT);
    }
    // No two notes on top of each other.
    const keys = new Set(points.map((point) => `${Math.round(point.x)},${Math.round(point.y)}`));
    expect(keys.size).toBe(points.length);
    expect(h.canvas.getAttribute('aria-label')).toBe('Graph of 6 notes and 4 links');
  });

  it('shows the notes within the chosen depth of one note, it in the middle', () => {
    const h = harness();
    h.send({ v: 1, type: 'graph', notes: NOTES, groups: GROUPS });
    h.send({ v: 1, type: 'scope', scope: { kind: 'local', noteId: 'b', depth: 1 } });
    expect([...h.host.shownIds].sort()).toEqual(['a', 'b', 'c']);
    const centre = h.host.positionOf('b')!;
    expect(Math.abs(centre.x - WIDTH / 2)).toBeLessThan(WIDTH / 3);
    h.send({ v: 1, type: 'scope', scope: { kind: 'local', noteId: 'b', depth: 3 } });
    expect([...h.host.shownIds].sort()).toEqual(['a', 'b', 'c', 'd', 'f']);
    expect(shown(h).at(-1)).toEqual({ v: 1, type: 'shown', notes: 5, links: 4 });
    expect(h.canvas.getAttribute('aria-label')).toBe('Local graph: 5 notes within 3 links of Beds');
  });

  it('shows a note’s chip on a tap, and the chip opens it', () => {
    const h = harness();
    showAll(h);
    const garden = h.host.positionOf('a')!;
    tap(h.canvas, garden);
    expect(h.host.selectedId).toBe('a');
    expect(h.chip.hidden).toBe(false);
    expect(h.chip.textContent).toBe('Garden');
    expect(h.chip.getAttribute('aria-label')).toBe('Open Garden, 2 links, Top level');
    // The tap itself opens nothing: the chip does.
    expect(h.posted.some((message) => message.type === 'open')).toBe(false);
    h.chip.click();
    expect(h.posted.at(-1)).toEqual({ v: 1, type: 'open', noteId: 'a' });
    // A tap on empty space puts the chip away.
    tap(h.canvas, { x: 2, y: 2 });
    expect(h.chip.hidden).toBe(true);
  });

  it('names the folder of a note in a folder', () => {
    const h = harness();
    showAll(h);
    tap(h.canvas, h.host.positionOf('f')!);
    expect(h.chip.getAttribute('aria-label')).toBe('Open Fences, 1 link, Projects');
  });

  it('a fingertip near a small node still hits it', () => {
    const h = harness();
    showAll(h);
    const errands = h.host.positionOf('e')!;
    tap(h.canvas, { x: errands.x + 10, y: errands.y });
    expect(h.host.selectedId).toBe('e');
  });

  it('pans with one finger, never tapping', () => {
    const h = harness();
    showAll(h);
    const before = h.host.positionOf('a')!;
    pointer(h.canvas, 'pointerdown', 1, before.x, before.y);
    pointer(h.canvas, 'pointermove', 1, before.x + 40, before.y + 25);
    pointer(h.canvas, 'pointerup', 1, before.x + 40, before.y + 25);
    const after = h.host.positionOf('a')!;
    expect(after.x - before.x).toBeCloseTo(40, 5);
    expect(after.y - before.y).toBeCloseTo(25, 5);
    expect(h.host.selectedId).toBeNull();
  });

  it('pinches to zoom about the fingers, never tapping', () => {
    const h = harness();
    showAll(h);
    const zoom = h.host.zoom;
    const garden = h.host.positionOf('a')!;
    pointer(h.canvas, 'pointerdown', 1, garden.x - 20, garden.y);
    pointer(h.canvas, 'pointerdown', 2, garden.x + 20, garden.y);
    pointer(h.canvas, 'pointermove', 1, garden.x - 40, garden.y);
    pointer(h.canvas, 'pointermove', 2, garden.x + 40, garden.y);
    expect(h.host.zoom).toBeCloseTo(zoom * 2, 5);
    // The note between the fingers stays between them.
    const after = h.host.positionOf('a')!;
    expect(after.x).toBeCloseTo(garden.x, 5);
    expect(after.y).toBeCloseTo(garden.y, 5);
    pointer(h.canvas, 'pointerup', 2, garden.x + 40, garden.y);
    pointer(h.canvas, 'pointerup', 1, garden.x - 40, garden.y);
    expect(h.host.selectedId).toBeNull();
  });

  it('brings a note picked in the search field to the middle with its chip', () => {
    const h = harness();
    showAll(h);
    h.send({ v: 1, type: 'focus', noteId: 'd' });
    const dahlias = h.host.positionOf('d')!;
    expect(dahlias.x).toBeCloseTo(WIDTH / 2, 5);
    expect(dahlias.y).toBeCloseTo(HEIGHT / 2, 5);
    expect(h.chip.textContent).toBe('Dahlias');
    // A note not shown is not focused.
    h.send({ v: 1, type: 'scope', scope: { kind: 'local', noteId: 'e', depth: 1 } });
    h.send({ v: 1, type: 'focus', noteId: 'a' });
    expect(h.host.selectedId).toBeNull();
  });

  it('keeps a title as text, never markup', () => {
    const h = harness();
    h.send({
      v: 1,
      type: 'graph',
      notes: [{ id: 'x', title: '<img src=x onerror=alert(1)>', group: null, links: [] }],
      groups: GROUPS,
    });
    h.send({ v: 1, type: 'scope', scope: { kind: 'global' } });
    tap(h.canvas, h.host.positionOf('x')!);
    expect(h.chip.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(h.chip.children).toHaveLength(0);
  });

  it('says there are no notes yet', () => {
    const h = harness();
    h.send({ v: 1, type: 'graph', notes: [], groups: GROUPS });
    h.send({ v: 1, type: 'scope', scope: { kind: 'global' } });
    expect(h.empty.hidden).toBe(false);
    expect(h.canvas.hidden).toBe(true);
    expect(shown(h).at(-1)).toEqual({ v: 1, type: 'shown', notes: 0, links: 0 });
  });

  it('keeps where the notes were when the notes change', () => {
    const h = harness();
    showAll(h);
    h.frames();
    const before = h.host.positionOf('d')!;
    h.send({
      v: 1,
      type: 'graph',
      notes: NOTES.map((note) => (note.id === 'e' ? { ...note, links: ['d'] } : note)),
      groups: GROUPS,
    });
    const after = h.host.positionOf('d')!;
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(WIDTH / 4);
  });
});
