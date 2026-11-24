/**
 * The dashboard's charts (PEN-137): inline SVG, drawn at the card's own width, with one hover
 * tooltip. Line, stacked bars (columns), bars (rows, stacked or not), funnel, stacked area and a
 * paths tree. Thin marks, 2px lines, 4px rounded data ends, a 2px surface gap between touching
 * fills, hairline grid; text in text colours, never a series colour. Every value a tooltip shows
 * is also in the card's table.
 */
import { eventName, fullNumber } from './names';

const SVG = 'http://www.w3.org/2000/svg';

type Attrs = Record<string, string | number>;

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (SVGElement | string)[] = [],
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export const formatNumber = (value: number) =>
  Math.abs(value) >= 10_000
    ? new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 }).format(
        value,
      )
    : fullNumber(value);

/** "19 Nov" from YYYY-MM-DD. */
export function shortDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? day
    : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** A series: its label, its colour (a CSS variable), and a value per category. */
export interface Series {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly values: readonly number[];
}

/** A tooltip's heading: its text, or a display name with its id in a muted line under it. */
type TipHead = string | { readonly title: string; readonly id: string };

interface TipLine {
  readonly value: string;
  readonly label: string;
  readonly color?: string;
}

// ---------------------------------------------------------------------------------------------
// The tooltip: one for the page.

let tip: HTMLDivElement | null = null;

function tipElement(): HTMLDivElement {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.append(tip);
  }
  return tip;
}

/**
 * Where a tooltip goes, so it never covers what it describes or the axis labels:
 * - `beside`: a day's mark between viewport x `beside[0]` and `beside[1]` (a crosshair, or a
 *   column's sides), inside `plot` (the plot area, without the axes); the tooltip sits to its
 *   right, or its left, kept within the plot so the axes' labels stay clear.
 * - `avoid`: a row or a node; the tooltip sits above it (below when there's no room), and no
 *   further left than `left` (a bar chart's labels end there).
 */
export type Placement =
  | { readonly beside: readonly [number, number]; readonly plot: DOMRect }
  | { readonly avoid: DOMRect; readonly left?: number };

const GAP = 10;
const EDGE = 8;

const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(value, Math.max(low, high)));

/** Where the tooltip's top left corner goes for a pointer at (x, y). */
function tipPosition(
  x: number,
  y: number,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  place?: Placement,
): { left: number; top: number } {
  const { width, height } = size;
  const right = viewport.width - EDGE - width;
  const bottom = viewport.height - EDGE - height;
  if (place && 'beside' in place) {
    const { plot } = place;
    const after = place.beside[1] + GAP;
    const before = place.beside[0] - GAP - width;
    const left =
      after + width <= Math.min(plot.right, viewport.width - EDGE)
        ? after
        : before >= Math.max(plot.left, EDGE)
          ? before
          : clamp(after, EDGE, right);
    const top = clamp(y - height / 2, plot.top, plot.bottom - height);
    return { left, top: clamp(top, EDGE, bottom) };
  }
  if (place) {
    const { avoid } = place;
    const above = avoid.top - GAP - height;
    const top = above >= EDGE ? above : avoid.bottom + GAP;
    const left = clamp(x - width / 2, Math.max(EDGE, place.left ?? EDGE), right);
    return { left, top: clamp(top, EDGE, bottom) };
  }
  const left = clamp(x + 14, EDGE, right);
  const top = y + 14 + height > viewport.height - EDGE ? y - height - 14 : y + 14;
  return { left, top: Math.max(EDGE, top) };
}

/** Shows the tooltip for (x, y) in the viewport: a title, then each value before its label. */
function showTip(
  x: number,
  y: number,
  title: TipHead,
  lines: readonly TipLine[],
  place?: Placement,
): void {
  const node = tipElement();
  node.replaceChildren();
  const head = document.createElement('div');
  head.className = 'tip-title';
  head.textContent = typeof title === 'string' ? title : title.title;
  node.append(head);
  if (typeof title !== 'string' && title.id) {
    const id = document.createElement('div');
    id.className = 'tip-id';
    id.textContent = title.id;
    node.append(id);
  }
  for (const line of lines) {
    const row = document.createElement('div');
    row.className = 'tip-row';
    if (line.color) {
      const key = document.createElement('span');
      key.className = 'tip-key';
      key.style.background = line.color;
      row.append(key);
    }
    const value = document.createElement('strong');
    value.textContent = line.value;
    const label = document.createElement('span');
    label.textContent = line.label;
    row.append(value, label);
    node.append(row);
  }
  node.hidden = false;
  const box = node.getBoundingClientRect();
  const { left, top } = tipPosition(
    x,
    y,
    { width: box.width, height: box.height },
    { width: window.innerWidth, height: window.innerHeight },
    place,
  );
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
}

export function hideTip(): void {
  if (tip) tip.hidden = true;
}

/** Hover and keyboard focus on `target` both show the same tooltip, placed by `place`. */
/** A heading as one line of text: "New Note (note.new)". */
function headText(title: TipHead): string {
  return typeof title === 'string'
    ? title
    : title.id
      ? `${title.title} (${title.id})`
      : title.title;
}

function hoverable(
  target: SVGElement,
  title: TipHead,
  lines: () => readonly TipLine[],
  place: () => Placement = () => ({ avoid: target.getBoundingClientRect() }),
): void {
  target.setAttribute('tabindex', '0');
  target.setAttribute(
    'aria-label',
    [headText(title), ...lines().map((l) => `${l.label} ${l.value}`)].join(', '),
  );
  target.classList.add('hit');
  target.addEventListener('pointermove', (event) =>
    showTip(event.clientX, event.clientY, title, lines(), place()),
  );
  target.addEventListener('pointerleave', hideTip);
  target.addEventListener('focus', () => {
    const box = target.getBoundingClientRect();
    showTip(box.left + box.width / 2, box.top + box.height / 2, title, lines(), place());
  });
  target.addEventListener('blur', hideTip);
}

/** The plot area of `chart` (inside its axes) in the viewport. */
function plotRect(chart: SVGSVGElement, frame: Frame): DOMRect {
  const box = chart.getBoundingClientRect();
  return new DOMRect(
    box.left + frame.left,
    box.top + frame.top,
    plotWidth(frame),
    plotHeight(frame),
  );
}

/** A tooltip beside the mark between chart x `from` and `to`, within the plot. */
function besideAt(chart: SVGSVGElement, frame: Frame, from: number, to = from): () => Placement {
  return () => {
    const left = chart.getBoundingClientRect().left;
    return { beside: [left + from, left + to], plot: plotRect(chart, frame) };
  };
}

/** A tooltip above (or below) `target`, starting no further left than chart x `from`. */
function aboveFrom(chart: SVGSVGElement, target: SVGElement, from: number): () => Placement {
  return () => ({
    avoid: target.getBoundingClientRect(),
    left: chart.getBoundingClientRect().left + from,
  });
}

// ---------------------------------------------------------------------------------------------
// Scales and axes.

/** A round maximum for an axis and its ticks. */
function niceScale(max: number, ticks = 4): { max: number; step: number } {
  if (max <= 0) return { max: ticks, step: 1 };
  const raw = max / ticks;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw;
  return { max: step * Math.ceil(max / step), step };
}

interface Frame {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

const plotWidth = (frame: Frame) => frame.width - frame.left - frame.right;
const plotHeight = (frame: Frame) => frame.height - frame.top - frame.bottom;

function root(frame: Frame, label: string): SVGSVGElement {
  return svg('svg', {
    width: frame.width,
    height: frame.height,
    viewBox: `0 0 ${frame.width} ${frame.height}`,
    role: 'img',
    'aria-label': label,
    class: 'chart',
  });
}

/** Hairline gridlines with their values, and the baseline. */
function yAxis(chart: SVGSVGElement, frame: Frame, max: number, step: number, unit = ''): void {
  for (let value = 0; value <= max + step / 2; value += step) {
    const y = frame.top + plotHeight(frame) * (1 - value / max);
    chart.append(
      svg('line', {
        x1: frame.left,
        x2: frame.width - frame.right,
        y1: y,
        y2: y,
        class: value === 0 ? 'baseline' : 'grid',
      }),
      svg('text', { x: frame.left - 6, y: y + 4, class: 'tick', 'text-anchor': 'end' }, [
        `${formatNumber(value)}${unit}`,
      ]),
    );
  }
}

/** Day labels under the plot: the first, the last and a few between that fit. */
function xLabels(
  chart: SVGSVGElement,
  frame: Frame,
  categories: readonly string[],
  x: (i: number) => number,
) {
  const n = categories.length;
  if (n === 0) return;
  const fits = Math.max(2, Math.floor(plotWidth(frame) / 64));
  const every = Math.max(1, Math.ceil((n - 1) / (fits - 1)));
  const shown = new Set<number>();
  for (let i = 0; i < n; i += every) shown.add(i);
  if (n > 1) {
    // The last label always; the one before it goes when they would touch.
    const last = n - 1;
    for (const i of shown) if (i !== last && x(last) - x(i) < 56) shown.delete(i);
    shown.add(last);
  }
  for (const i of shown) {
    const anchor = n === 1 ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
    chart.append(
      svg('text', { x: x(i), y: frame.height - 6, class: 'tick', 'text-anchor': anchor }, [
        shortDay(categories[i] ?? ''),
      ]),
    );
  }
}

/** A bar with a 4px rounded end away from its square baseline end. */
function barPath(
  x: number,
  y: number,
  w: number,
  h: number,
  round: 'top' | 'right' | 'none',
): string {
  const r = Math.min(4, w / 2, h / 2);
  if (round === 'none' || r <= 0) return `M${x},${y}h${w}v${h}h${-w}Z`;
  if (round === 'top') {
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

// ---------------------------------------------------------------------------------------------
// The charts.

interface TimeChart {
  readonly categories: readonly string[];
  readonly series: readonly Series[];
  readonly label: string;
}

/** Lines over days, with a crosshair that lists every series at the day under the pointer. */
export function lineChart(spec: TimeChart, width: number): SVGSVGElement {
  const frame: Frame = { width, height: 240, left: 44, right: 12, top: 12, bottom: 26 };
  const chart = root(frame, spec.label);
  const n = spec.categories.length;
  const peak = Math.max(0, ...spec.series.flatMap((s) => s.values));
  const { max, step } = niceScale(peak);
  yAxis(chart, frame, max, step);
  const x = (i: number) =>
    frame.left + (n <= 1 ? plotWidth(frame) / 2 : (plotWidth(frame) * i) / (n - 1));
  const y = (v: number) => frame.top + plotHeight(frame) * (1 - v / max);
  xLabels(chart, frame, spec.categories, x);
  spec.series.forEach((series, index) => {
    const d = series.values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(v)}`).join('');
    // Earlier series are wider, so a later one drawn over the same values leaves an edge of
    // each showing (PEN-170).
    const width = 2 + 3 * (spec.series.length - 1 - index);
    chart.append(svg('path', { d, class: 'line', stroke: series.color, 'stroke-width': width }));
    if (n === 1)
      chart.append(
        svg('circle', {
          cx: x(0),
          cy: y(series.values[0] ?? 0),
          r: 4,
          fill: series.color,
          class: 'dot',
        }),
      );
  });
  crosshair(chart, frame, spec, x, (i) =>
    spec.series.map((s) =>
      svg('circle', { cx: x(i), cy: y(s.values[i] ?? 0), r: 4, fill: s.color, class: 'dot' }),
    ),
  );
  return chart;
}

/** The crosshair layer: a hit area per day, a hairline and markers, the tooltip. */
function crosshair(
  chart: SVGSVGElement,
  frame: Frame,
  spec: TimeChart,
  x: (i: number) => number,
  markers: (i: number) => SVGElement[],
): void {
  const n = spec.categories.length;
  const layer = svg('g', { class: 'cross', 'pointer-events': 'none' });
  chart.append(layer);
  const band = n <= 1 ? plotWidth(frame) : plotWidth(frame) / (n - 1);
  spec.categories.forEach((day, i) => {
    const hit = svg('rect', {
      x: Math.max(frame.left, x(i) - band / 2),
      y: frame.top,
      width: Math.min(band, plotWidth(frame)),
      height: plotHeight(frame),
      class: 'hit-area',
    });
    const lines = () =>
      spec.series.map((s) => ({
        value: fullNumber(s.values[i] ?? 0),
        label: s.label,
        color: s.color,
      }));
    hoverable(hit, shortDay(day), lines, besideAt(chart, frame, x(i)));
    const show = () =>
      layer.replaceChildren(
        svg('line', {
          x1: x(i),
          x2: x(i),
          y1: frame.top,
          y2: frame.top + plotHeight(frame),
          class: 'cross-line',
        }),
        ...markers(i),
      );
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('focus', show);
    hit.addEventListener('pointerleave', () => layer.replaceChildren());
    hit.addEventListener('blur', () => layer.replaceChildren());
    chart.append(hit);
  });
}

/** Columns over days, each split into its series, a 2px gap between parts. */
export function stackedColumns(spec: TimeChart, width: number): SVGSVGElement {
  const frame: Frame = { width, height: 240, left: 44, right: 12, top: 12, bottom: 26 };
  const chart = root(frame, spec.label);
  const n = spec.categories.length;
  const totals = spec.categories.map((_, i) =>
    spec.series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0),
  );
  const { max, step } = niceScale(Math.max(0, ...totals));
  yAxis(chart, frame, max, step);
  const band = plotWidth(frame) / Math.max(1, n);
  const barWidth = Math.max(2, Math.min(24, band - 2));
  const x = (i: number) => frame.left + band * i + band / 2;
  xLabels(chart, frame, spec.categories, x);
  const scale = plotHeight(frame) / max;
  spec.categories.forEach((day, i) => {
    let base = frame.top + plotHeight(frame);
    const parts = spec.series.filter((s) => (s.values[i] ?? 0) > 0);
    parts.forEach((series, index) => {
      const h = (series.values[i] ?? 0) * scale;
      const gap = index === 0 ? 0 : 2;
      const top = base - h;
      chart.append(
        svg('path', {
          d: barPath(
            x(i) - barWidth / 2,
            top,
            barWidth,
            Math.max(0, h - gap),
            index === parts.length - 1 ? 'top' : 'none',
          ),
          fill: series.color,
          class: 'mark',
        }),
      );
      base = top;
    });
    const hit = svg('rect', {
      x: frame.left + band * i,
      y: frame.top,
      width: band,
      height: plotHeight(frame),
      class: 'hit-area',
    });
    hoverable(
      hit,
      shortDay(day),
      () => [
        ...spec.series.map((s) => ({
          value: fullNumber(s.values[i] ?? 0),
          label: s.label,
          color: s.color,
        })),
        { value: fullNumber(totals[i] ?? 0), label: 'Total' },
      ],
      // Beside the column, clear of its bar.
      besideAt(chart, frame, x(i) - barWidth / 2, x(i) + barWidth / 2),
    );
    chart.append(hit);
  });
  return chart;
}

/** Days, each a stack of its series' shares filled up to the total: a stacked area. */
export function stackedArea(spec: TimeChart, width: number): SVGSVGElement {
  const frame: Frame = { width, height: 240, left: 44, right: 12, top: 12, bottom: 26 };
  const chart = root(frame, spec.label);
  const n = spec.categories.length;
  const totals = spec.categories.map((_, i) =>
    spec.series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0),
  );
  const { max, step } = niceScale(Math.max(0, ...totals));
  yAxis(chart, frame, max, step);
  const x = (i: number) =>
    frame.left + (n <= 1 ? plotWidth(frame) / 2 : (plotWidth(frame) * i) / (n - 1));
  const y = (v: number) => frame.top + plotHeight(frame) * (1 - v / max);
  xLabels(chart, frame, spec.categories, x);
  const below = spec.categories.map(() => 0);
  for (const series of spec.series) {
    const lower = [...below];
    series.values.forEach((v, i) => (below[i] = (below[i] ?? 0) + v));
    const upper = [...below];
    const top = upper.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(v)}`).join('');
    const back = lower
      .map((_, i) => n - 1 - i)
      .map((i) => `L${x(i)},${y(lower[i] ?? 0)}`)
      .join('');
    chart.append(svg('path', { d: `${top}${back}Z`, fill: series.color, class: 'area' }));
  }
  crosshair(chart, frame, spec, x, () => []);
  return chart;
}

export interface BarRow {
  /** Its display name ("New Note"). */
  readonly label: string;
  /** The id it was recorded by ("note.new"), muted in its tooltip. */
  readonly id?: string;
  /** One part per series, in the series' order. */
  readonly parts: readonly number[];
  /** Said after the total in the tooltip ("12 installs"). */
  readonly note?: string;
}

export interface BarColumn {
  /** Its heading, over the column. */
  readonly label: string;
  /** One value per row, as shown. */
  readonly values: readonly string[];
  /** How wide it is, in px (72 by default). */
  readonly width?: number;
}

interface BarsSpec {
  readonly label: string;
  readonly series: readonly Pick<Series, 'key' | 'label' | 'color'>[];
  readonly rows: readonly BarRow[];
  /** What the numbers count, for the tooltip ("runs"). */
  readonly unit: string;
  /** "%" when the values are shares. */
  readonly suffix?: string;
  /** Columns of figures at the right, after the bars (left out on a narrow card). */
  readonly columns?: readonly BarColumn[];
  /** The heading over the bars' totals, when there are columns ("Runs"). */
  readonly totalLabel?: string;
  /** False to leave the total off the bar's tip (shares that always add up to 100%). */
  readonly showTotal?: boolean;
}

/** Below this width a bar chart leaves its extra columns to the table. */
const COLUMNS_FROM = 520;

/** A bar's tooltip heading: its name, and its id muted under it when it has one. */
const barHead = (row: BarRow): TipHead => (row.id ? { title: row.label, id: row.id } : row.label);

/** Rows of horizontal bars, each split into its series, the total at the tip. */
export function bars(spec: BarsSpec, width: number): SVGSVGElement {
  const rowHeight = 28;
  const labelWidth = Math.min(200, Math.max(96, Math.round(width * 0.36)));
  const columns = width >= COLUMNS_FROM ? (spec.columns ?? []) : [];
  const columnsWidth = columns.reduce((sum, column) => sum + (column.width ?? 72), 0);
  const head = columns.length > 0 ? 22 : 0;
  const frame: Frame = {
    width,
    height: spec.rows.length * rowHeight + 8 + head,
    left: labelWidth + 8,
    right: 56 + columnsWidth,
    top: 4 + head,
    bottom: 4,
  };
  const chart = root(frame, spec.label);
  const totals = spec.rows.map((row) => row.parts.reduce((sum, v) => sum + v, 0));
  const max = Math.max(1, ...totals);
  const scale = plotWidth(frame) / max;
  const thickness = 16;
  chart.append(
    svg('line', {
      x1: frame.left,
      x2: frame.left,
      y1: frame.top,
      y2: frame.height - frame.bottom,
      class: 'baseline',
    }),
  );
  // The columns' right edges, and their headings.
  const edges: number[] = [];
  let edge = width - columnsWidth;
  for (const column of columns) {
    edge += column.width ?? 72;
    edges.push(edge);
    chart.append(
      svg('text', { x: edge - 4, y: 14, class: 'col-head', 'text-anchor': 'end' }, [column.label]),
    );
  }
  if (columns.length > 0 && spec.totalLabel) {
    chart.append(svg('text', { x: frame.left + 6, y: 14, class: 'col-head' }, [spec.totalLabel]));
  }
  spec.rows.forEach((row, r) => {
    const yMid = frame.top + r * rowHeight + rowHeight / 2;
    const label = svg(
      'text',
      { x: frame.left - 8, y: yMid + 4, class: 'label', 'text-anchor': 'end' },
      [truncate(row.label, labelWidth)],
    );
    label.append(svg('title', {}, [headText(barHead(row))]));
    chart.append(label);
    let left = frame.left;
    const shown = row.parts.map((value, i) => ({ value, i })).filter((p) => p.value > 0);
    shown.forEach(({ value, i }, index) => {
      const w = value * scale;
      const gap = index === shown.length - 1 ? 0 : 2;
      chart.append(
        svg('path', {
          d: barPath(
            left,
            yMid - thickness / 2,
            Math.max(1, w - gap),
            thickness,
            index === shown.length - 1 ? 'right' : 'none',
          ),
          fill: spec.series[i]?.color ?? 'var(--s1)',
          class: 'mark',
        }),
      );
      left += w;
    });
    if (spec.showTotal !== false) {
      chart.append(
        svg('text', { x: left + 6, y: yMid + 4, class: 'value' }, [
          `${formatNumber(Math.round((totals[r] ?? 0) * 10) / 10)}${spec.suffix ?? ''}`,
        ]),
      );
    }
    columns.forEach((column, c) => {
      chart.append(
        svg(
          'text',
          { x: (edges[c] ?? width) - 4, y: yMid + 4, class: 'value', 'text-anchor': 'end' },
          [column.values[r] ?? ''],
        ),
      );
    });
    const hit = svg('rect', {
      x: 0,
      y: frame.top + r * rowHeight,
      width,
      height: rowHeight,
      class: 'hit-area',
    });
    hoverable(
      hit,
      barHead(row),
      () => [
        ...(spec.series.length > 1
          ? spec.series.map((s, i) => ({
              value: `${fullNumber(row.parts[i] ?? 0)}${spec.suffix ?? ''}`,
              label: s.label,
              color: s.color,
            }))
          : []),
        ...(spec.showTotal !== false
          ? [{ value: `${fullNumber(totals[r] ?? 0)}${spec.suffix ?? ''}`, label: spec.unit }]
          : []),
        ...(spec.columns ?? []).map((column) => ({
          value: column.values[r] ?? '',
          label: column.label,
        })),
        ...(row.note ? [{ value: '', label: row.note }] : []),
      ],
      aboveFrom(chart, hit, frame.left),
    );
    chart.append(hit);
  });
  return chart;
}

interface FunnelStep {
  readonly label: string;
  readonly value: number;
}

/** The first run's steps as bars that narrow, in one blue ramp, step by step. */
export function funnel(
  spec: { label: string; steps: readonly FunnelStep[] },
  width: number,
): SVGSVGElement {
  const rowHeight = 30;
  const labelWidth = Math.min(180, Math.max(110, Math.round(width * 0.34)));
  const frame: Frame = {
    width,
    height: spec.steps.length * rowHeight + 8,
    left: labelWidth + 8,
    right: 96,
    top: 4,
    bottom: 4,
  };
  const chart = root(frame, spec.label);
  const first = spec.steps[0]?.value ?? 0;
  const max = Math.max(1, ...spec.steps.map((s) => s.value));
  const scale = plotWidth(frame) / max;
  // Five steps of one blue, the first step darkest (lightest on a dark surface).
  const ramp = 5;
  spec.steps.forEach((step, i) => {
    const y = frame.top + i * rowHeight + 5;
    const w = Math.max(1, step.value * scale);
    const previous = spec.steps[i - 1]?.value;
    const drop = previous ? Math.round((100 * (previous - step.value)) / previous) : 0;
    const shade = Math.min(ramp, 1 + Math.floor((i * ramp) / Math.max(1, spec.steps.length)));
    chart.append(
      svg('text', { x: frame.left - 8, y: y + 15, class: 'label', 'text-anchor': 'end' }, [
        truncate(step.label, labelWidth),
      ]),
      svg('path', {
        d: barPath(frame.left, y, w, rowHeight - 10, 'right'),
        fill: `var(--ramp-${shade})`,
        class: 'mark',
      }),
      svg('text', { x: frame.left + w + 6, y: y + 15, class: 'value' }, [
        `${fullNumber(step.value)}${i > 0 && drop > 0 ? `  −${drop}%` : ''}`,
      ]),
    );
    const hit = svg('rect', { x: 0, y: y - 5, width, height: rowHeight, class: 'hit-area' });
    hoverable(
      hit,
      step.label,
      () => [
        { value: fullNumber(step.value), label: 'installs reached it' },
        {
          value: first ? `${Math.round((100 * step.value) / first)}%` : '–',
          label: 'of those who started',
        },
        ...(i > 0 ? [{ value: `${drop}%`, label: 'dropped since the step before' }] : []),
      ],
      aboveFrom(chart, hit, frame.left),
    );
    chart.append(hit);
  });
  return chart;
}

export interface TreeNode {
  readonly event: string;
  readonly sessions: number;
  readonly share: number;
  readonly children: readonly TreeNode[];
}

/**
 * Paths from a start event, each node's share of the one before: a column per step, or on a
 * narrow card an outline, a row per node indented by its step.
 */
export function tree(spec: { label: string; root: TreeNode }, width: number): SVGSVGElement {
  const leaves = (node: TreeNode): number =>
    node.children.length === 0 ? 1 : node.children.reduce((sum, child) => sum + leaves(child), 0);
  const count = (node: TreeNode): number =>
    1 + node.children.reduce((sum, child) => sum + count(child), 0);
  const outline = width < 560;
  // Each node is a box with 10px of padding round 13px label and 12px value lines.
  const boxHeight = outline ? 34 : 44;
  const rowHeight = boxHeight + (outline ? 8 : 10);
  const pad = 10;
  const columnWidth = (width - 8) / 4;
  const indent = 18;
  const nodeWidth = outline ? 0 : Math.max(60, columnWidth - 20);
  const rows = outline ? count(spec.root) : leaves(spec.root);
  const frame: Frame = {
    width,
    height: Math.max(1, rows) * rowHeight + 8,
    left: 4,
    right: 4,
    top: 4,
    bottom: 4,
  };
  const chart = root(frame, spec.label);
  const linkLayer = svg('g');
  chart.append(linkLayer);
  let nextRow = 0;
  const place = (
    node: TreeNode,
    level: number,
    top: number,
    parent: { x: number; y: number } | null,
    path: string[],
  ) => {
    const x = outline ? frame.left + level * indent : frame.left + level * columnWidth;
    const y = outline
      ? frame.top + nextRow++ * rowHeight + rowHeight / 2
      : top + (leaves(node) * rowHeight) / 2;
    const boxWidth = outline ? width - x - frame.right : nodeWidth;
    const weight = Math.max(1, Math.round(node.share / 12.5));
    if (parent) {
      const midX = (parent.x + x) / 2;
      linkLayer.append(
        svg('path', {
          d: outline
            ? `M${parent.x},${parent.y}V${y}H${x}`
            : `M${parent.x},${parent.y}C${midX},${parent.y} ${midX},${y} ${x},${y}`,
          class: 'link',
          'stroke-width': outline ? 1.5 : weight,
        }),
      );
    }
    const name = eventName(node.event);
    const box = svg('g', { class: 'node' });
    const value =
      level === 0
        ? `${fullNumber(node.sessions)} sessions`
        : `${node.share}% · ${fullNumber(node.sessions)}`;
    box.append(
      svg('rect', {
        x,
        y: y - boxHeight / 2,
        width: boxWidth,
        height: boxHeight,
        rx: 6,
        class: node.event === 'end' ? 'node-box end' : 'node-box',
      }),
    );
    if (outline) {
      // One line: the event, then its share at the right end.
      box.append(
        svg('text', { x: x + pad, y: y + 5, class: 'node-label' }, [
          truncate(name.title, boxWidth - 2 * pad - 110, LABEL_CHAR),
        ]),
        svg(
          'text',
          { x: x + boxWidth - pad, y: y + 4, class: 'node-value', 'text-anchor': 'end' },
          [value],
        ),
      );
    } else {
      box.append(
        svg('text', { x: x + pad, y: y - 3, class: 'node-label' }, [
          truncate(name.title, nodeWidth - 2 * pad, LABEL_CHAR),
        ]),
        svg('text', { x: x + pad, y: y + 14, class: 'node-value' }, [value]),
      );
    }
    const trail = [...path, name.title];
    hoverable(box, { title: trail.join(' → '), id: name.id }, () => [
      { value: fullNumber(node.sessions), label: 'sessions' },
      ...(level > 0
        ? [{ value: `${node.share}%`, label: 'of the sessions at the step before' }]
        : []),
    ]);
    chart.append(box);
    let childTop = top;
    for (const child of node.children) {
      const from = outline ? { x: x + indent / 2, y: y + boxHeight / 2 } : { x: x + nodeWidth, y };
      place(child, level + 1, childTop, from, trail);
      childTop += leaves(child) * rowHeight;
    }
  };
  place(spec.root, 0, frame.top, null, []);
  return chart;
}

/** About how wide a character of a node's 13px label is, in px. */
const LABEL_CHAR = 7.2;

/** `text` cut to about `width` pixels of 12px type (or `char` px a character), with an ellipsis. */
function truncate(text: string, width: number, char = 6.6): string {
  const fits = Math.max(4, Math.floor(width / char));
  return text.length <= fits ? text : `${text.slice(0, fits - 1)}…`;
}
