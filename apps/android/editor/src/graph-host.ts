/**
 * The graph page on the phone (T40 P7, LK7, LK8; A478, A479): the web's graph
 * model, force layout and canvas renderer (`@penmoss/ui/graph`, T17) under
 * touch instead of a mouse. Drag pans, two fingers pinch to zoom, a tap on a
 * note shows a chip with its title, and a tap on the chip opens the note. The
 * app sends the notes and links (from Room, so it works offline), what to show
 * and the theme; the page holds nothing else and reaches nothing (A293).
 *
 * Per-frame state lives here, not in the DOM: input only asks for a frame, so
 * one draw per frame however many touch events arrive.
 */
import { createLayout, type Layout, type LayoutNode } from '@penmoss/ui/graph/layout';
import { buildGraph, type GraphData, type GraphScope } from '@penmoss/ui/graph/model';
import {
  drawGraph,
  fitTransform,
  nodeAt,
  type Context2D,
  type ThemeColors,
  type Transform,
} from '@penmoss/ui/graph/renderer';
import { FALLBACK_THEME, readTheme } from '@penmoss/ui/graph/theme';
import { applyThemeTo, builtInTheme, parseTheme } from '@penmoss/ui/theme';
import {
  GRAPH_VERSION,
  parseToGraph,
  type FromGraph,
  type GraphGroupEntry,
  type GraphNote,
  type GraphScopeMessage,
} from './graph-protocol';

export interface GraphElements {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  /** The chip a tap on a note shows; a tap on it opens the note. */
  readonly chip: HTMLButtonElement;
  /** Shown instead of the canvas when there are no notes. */
  readonly empty: HTMLElement;
}

export interface GraphHostOptions {
  /** The canvas's size in CSS pixels (tests; the page measures the root). */
  readonly size?: () => { width: number; height: number };
  readonly requestFrame?: (callback: () => void) => number;
  readonly cancelFrame?: (handle: number) => void;
}

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 6;
/** How far a finger may move and still tap (CSS pixels): wider than a mouse's 4. */
export const TAP_SLOP = 10;
/** How far outside a node's circle a tap still hits it, on screen (a fingertip). */
export const TOUCH_REACH = 14;
/** Graphs this small open settled; larger ones settle a little, then move into place. */
const SMALL = 300;

const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Point {
  x: number;
  y: number;
}

type Gesture =
  | { kind: 'tap'; start: Point; origin: Transform; moved: boolean }
  | { kind: 'pinch'; distance: number; middle: Point; origin: Transform };

export class GraphHost {
  private notes: GraphNote[] = [];
  private colourOrder: (string | null)[] = [];
  private groupNames = new Map<string | null, string>();
  private scope: GraphScopeMessage | null = null;
  private received = false;
  private data: GraphData = { nodes: [], edges: [] };
  private layout: Layout | null = null;
  private transform: Transform = { x: 0, y: 0, k: 1 };
  private autoFit = true;
  private selected: LayoutNode | null = null;
  private colours: ThemeColors = FALLBACK_THEME;
  private frame = 0;
  private readonly pointers = new Map<number, Point>();
  private gesture: Gesture | null = null;
  private readonly ctx: Context2D | null;
  private readonly size: () => { width: number; height: number };
  private readonly requestFrame: (callback: () => void) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly cleanups: Array<() => void> = [];

  constructor(
    private readonly elements: GraphElements,
    private readonly post: (message: FromGraph) => void,
    options: GraphHostOptions = {},
  ) {
    this.ctx = elements.canvas.getContext?.('2d') ?? null;
    this.size =
      options.size ??
      (() => {
        const rect = elements.root.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
    this.requestFrame =
      options.requestFrame ?? ((callback) => requestAnimationFrame(() => callback()));
    this.cancelFrame = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
    const { canvas, chip } = elements;
    const listen = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement,
      type: K,
      handler: (event: HTMLElementEventMap[K]) => void,
    ) => {
      target.addEventListener(type, handler as EventListener);
      this.cleanups.push(() => target.removeEventListener(type, handler as EventListener));
    };
    listen(canvas, 'pointerdown', (event) => this.down(event));
    listen(canvas, 'pointermove', (event) => this.move(event));
    listen(canvas, 'pointerup', (event) => this.up(event));
    listen(canvas, 'pointercancel', (event) => this.cancel(event));
    listen(chip, 'click', () => {
      const node = this.selected;
      if (node) this.post({ v: GRAPH_VERSION, type: 'open', noteId: node.node.id });
    });
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(() => this.resized());
      observer.observe(elements.root);
      this.cleanups.push(() => observer.disconnect());
    }
  }

  start(): void {
    this.post({ v: GRAPH_VERSION, type: 'ready' });
  }

  receive(raw: string): void {
    const message = parseToGraph(raw);
    if (!message) return;
    switch (message.type) {
      case 'graph':
        this.notes = [...message.notes];
        this.setGroups(message.groups);
        this.received = true;
        this.rebuild();
        break;
      case 'scope':
        this.scope = message.scope;
        this.rebuild();
        break;
      case 'focus':
        this.focus(message.noteId);
        break;
      case 'theme': {
        const theme = builtInTheme(message.theme['id']) ?? parseTheme(message.theme)?.theme ?? null;
        if (!theme) return;
        applyThemeTo(this.elements.root.ownerDocument.documentElement, theme, message.variant);
        this.colours = readTheme(this.elements.canvas);
        this.schedule();
        break;
      }
    }
  }

  close(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    if (this.frame) this.cancelFrame(this.frame);
    this.frame = 0;
    this.layout?.stop();
  }

  // --- what tests read ---

  /** A node's centre in CSS pixels from the canvas's top left, or null when not shown. */
  positionOf(id: string): Point | null {
    const node = this.layout?.nodes.find((candidate) => candidate.node.id === id);
    if (!node) return null;
    const { x, y, k } = this.transform;
    return { x: node.x * k + x, y: node.y * k + y };
  }

  get zoom(): number {
    return this.transform.k;
  }

  get selectedId(): string | null {
    return this.selected?.node.id ?? null;
  }

  /** The ids shown now, in layout order. */
  get shownIds(): string[] {
    return this.data.nodes.map((node) => node.id);
  }

  // --- the graph ---

  private setGroups(groups: readonly GraphGroupEntry[]): void {
    this.colourOrder = groups.map((group) => group.id);
    this.groupNames = new Map(groups.map((group) => [group.id, group.name]));
  }

  private graphScope(): GraphScope {
    const scope = this.scope;
    if (scope?.kind === 'local') return { kind: 'local', id: scope.noteId, depth: scope.depth };
    return { kind: 'global' };
  }

  private rebuild(): void {
    if (!this.received || !this.scope) return;
    const scope = this.graphScope();
    const centre = scope.kind === 'local' ? scope.id : null;
    this.data = buildGraph(
      this.notes.map((note) => ({ ...note, tags: [] })),
      scope,
    );
    const previous = new Map(
      (this.layout?.nodes ?? []).map((node) => [node.node.id, { x: node.x, y: node.y }]),
    );
    this.layout?.stop();
    const layout = createLayout(this.data, centre, previous);
    this.layout = layout;
    const kept = this.selected?.node.id;
    this.selected = kept ? (layout.nodes.find((node) => node.node.id === kept) ?? null) : null;
    layout.settle(layout.nodes.length <= SMALL || reducedMotion() ? 300 : 40);
    if (previous.size === 0) this.autoFit = true;
    if (this.autoFit) this.fit();
    this.showChip();
    const notes = this.data.nodes.filter((node) => node.kind === 'note').length;
    const links = this.data.edges.filter((edge) => !edge.tag).length;
    this.elements.empty.hidden = this.notes.length > 0;
    this.elements.canvas.hidden = this.notes.length === 0;
    this.elements.canvas.setAttribute('aria-label', this.label(notes, links));
    this.post({ v: GRAPH_VERSION, type: 'shown', notes, links });
    this.schedule();
  }

  /** The canvas's name for TalkBack, in the web's words. */
  private label(notes: number, links: number): string {
    const scope = this.scope;
    if (scope?.kind === 'local') {
      const title =
        this.notes.find((note) => note.id === scope.noteId)?.title.trim() || 'this note';
      const depth = scope.depth === 1 ? '1 link' : `${scope.depth} links`;
      return `Local graph: ${notes === 1 ? '1 note' : `${notes} notes`} within ${depth} of ${title}`;
    }
    return `Graph of ${notes === 1 ? '1 note' : `${notes} notes`} and ${links === 1 ? '1 link' : `${links} links`}`;
  }

  private fit(): void {
    const { width, height } = this.size();
    this.transform = fitTransform(this.layout?.nodes ?? [], width, height);
  }

  private resized(): void {
    if (this.autoFit) this.fit();
    this.schedule();
  }

  private focus(id: string): void {
    const node = this.layout?.nodes.find((candidate) => candidate.node.id === id);
    if (!node) return;
    const { width, height } = this.size();
    const k = Math.max(this.transform.k, 1);
    this.autoFit = false;
    this.transform = { k, x: width / 2 - node.x * k, y: height / 2 - node.y * k };
    this.select(node);
  }

  private select(node: LayoutNode | null): void {
    this.selected = node && node.node.kind === 'note' ? node : null;
    this.showChip();
    this.schedule();
  }

  private showChip(): void {
    const { chip } = this.elements;
    const node = this.selected;
    chip.hidden = node === null;
    if (!node) return;
    const group = this.groupNames.get(node.node.group) ?? null;
    const links = node.node.degree === 1 ? '1 link' : `${node.node.degree} links`;
    chip.textContent = node.node.label;
    chip.setAttribute(
      'aria-label',
      `Open ${node.node.label}, ${links}${group ? `, ${group}` : ''}`,
    );
  }

  // --- drawing ---

  private schedule(): void {
    this.frame ||= this.requestFrame(() => this.draw());
  }

  private draw(): void {
    this.frame = 0;
    const layout = this.layout;
    if (!layout) return;
    const moving = layout.tick();
    if (moving && this.autoFit) this.fit();
    const { width, height } = this.size();
    const canvas = this.elements.canvas;
    const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
    if (this.ctx && width > 0) {
      const w = Math.max(1, Math.round(width * ratio));
      const h = Math.max(1, Math.round(height * ratio));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const selected = this.selected;
      drawGraph(
        this.ctx,
        { width, height, ratio },
        layout.nodes,
        layout.links,
        this.colourOrder,
        this.colours,
        {
          transform: this.transform,
          hovered: null,
          focused: selected,
          centre: this.scope?.kind === 'local' ? this.scope.noteId : null,
          neighbours: selected ? this.neighbours(selected) : null,
        },
      );
    }
    if (moving) this.schedule();
  }

  private neighbours(active: LayoutNode): Set<string> {
    const ids = new Set([active.node.id]);
    for (const link of this.layout?.links ?? []) {
      if (link.source === active) ids.add(link.target.node.id);
      else if (link.target === active) ids.add(link.source.node.id);
    }
    return ids;
  }

  // --- touch ---

  private point(event: PointerEvent): Point {
    const rect = this.elements.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private down(event: PointerEvent): void {
    this.pointers.set(event.pointerId, this.point(event));
    try {
      this.elements.canvas.setPointerCapture?.(event.pointerId);
    } catch {
      // A pointer the WebView no longer knows: the gesture still works without capture.
    }
    const [first, second] = [...this.pointers.values()];
    if (first && second) {
      this.gesture = {
        kind: 'pinch',
        distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
        middle: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
        origin: this.transform,
      };
    } else if (first) {
      this.gesture = { kind: 'tap', start: first, origin: this.transform, moved: false };
    }
  }

  private move(event: PointerEvent): void {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, this.point(event));
    const gesture = this.gesture;
    if (!gesture) return;
    if (gesture.kind === 'pinch') {
      const [first, second] = [...this.pointers.values()];
      if (!first || !second) return;
      const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
      const middle = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      const { origin } = gesture;
      const k = clampZoom(origin.k * (distance / gesture.distance));
      // The graph point under the fingers' first middle stays under their middle now.
      const gx = (gesture.middle.x - origin.x) / origin.k;
      const gy = (gesture.middle.y - origin.y) / origin.k;
      this.autoFit = false;
      this.transform = { k, x: middle.x - gx * k, y: middle.y - gy * k };
      this.schedule();
      return;
    }
    const at = this.pointers.get(event.pointerId)!;
    const dx = at.x - gesture.start.x;
    const dy = at.y - gesture.start.y;
    if (!gesture.moved && Math.hypot(dx, dy) < TAP_SLOP) return;
    gesture.moved = true;
    this.autoFit = false;
    this.transform = { ...gesture.origin, x: gesture.origin.x + dx, y: gesture.origin.y + dy };
    this.schedule();
  }

  private up(event: PointerEvent): void {
    if (!this.pointers.has(event.pointerId)) return;
    const at = this.point(event);
    this.pointers.delete(event.pointerId);
    const gesture = this.gesture;
    if (gesture?.kind === 'pinch') {
      // The finger left behind pans from here, never taps.
      const [rest] = [...this.pointers.values()];
      this.gesture = rest
        ? { kind: 'tap', start: rest, origin: this.transform, moved: true }
        : null;
      return;
    }
    this.gesture = null;
    if (!gesture || gesture.moved || !this.layout) return;
    const { x, y, k } = this.transform;
    const node = nodeAt(
      this.layout.nodes,
      { x: (at.x - x) / k, y: (at.y - y) / k },
      TOUCH_REACH / k,
    );
    this.select(node);
  }

  private cancel(event: PointerEvent): void {
    this.pointers.delete(event.pointerId);
    if (this.pointers.size === 0) this.gesture = null;
  }
}
