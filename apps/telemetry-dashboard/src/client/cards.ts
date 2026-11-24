/**
 * The dashboard's cards (PEN-137): a chart or a table with its legend, Table toggle and Download
 * CSV, tiles of figures, and the pivots that turn an answer's rows into series.
 */
import { dayOf } from '@penmoss/telemetry/day';
import { formatNumber, stackedColumns, type Series } from './charts';
import { ACTOR_LABELS, fullNumber, type EventName } from './names';
import { type Player } from './replay/player';
import { state } from './state';

export type Row = Record<string, string | number | null>;
/** A link in a table's cell (a session's start). */
interface LinkCell {
  readonly text: string;
  readonly href: string;
}
/** A display name with the id it was recorded by (the id is a muted line under it), or a link. */
export type Cell = string | number | EventName | LinkCell;

/** A named cell: it has an id, even an empty one (Paths' "Session Ended"). */
const named = (value: Cell): value is EventName => typeof value === 'object' && 'id' in value;
const linked = (value: Cell): value is LinkCell => typeof value === 'object' && 'href' in value;

interface TableSpec {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly Cell[])[];
}

interface LegendItem {
  readonly label: string;
  readonly color: string;
}

interface CardSpec {
  readonly id: string;
  readonly title: string;
  /** A count shown beside the title ("Never Used 412"). */
  readonly count?: number;
  /** A body other than a chart (Never Used's chips): shown, with its table behind Table. */
  readonly custom?: HTMLElement;
  readonly note?: string;
  /** Draws the chart at a width; null for a card that is only its table. */
  readonly chart: ((width: number) => SVGSVGElement) | null;
  readonly legend?: readonly LegendItem[];
  /** 'line' keys for line charts, boxes for the rest. */
  readonly legendShape?: 'line' | 'box';
  /** Its table, behind Table and Download CSV; a card with `controls` has none. */
  readonly table?: TableSpec;
  /** The card's own controls in its foot, in place of Table and Download CSV (Playback). */
  readonly controls?: readonly HTMLElement[];
  readonly empty?: boolean;
  /** Across the whole view, not one column. */
  readonly wide?: boolean;
  /** A table-only card whose table shows in full, the page scrolling (Recent Sessions). */
  readonly tall?: boolean;
  /** Placed between the header and the body (a pager, a line under the note). */
  readonly before?: HTMLElement;
  /** A custom body with no padding, its rows edge to edge (the timeline). */
  readonly flush?: boolean;
  /** The CSV's file name, when penmoss-<id>-<days>d.csv would mean nothing. */
  readonly file?: string;
  /** The CSV's rows, header first, when they are not the table's. */
  readonly csv?: () => readonly (readonly (string | number)[])[];
}

/** Person, agent, script: blue, orange, aqua (series 1–3). */
const ACTOR_COLOURS: Record<string, string> = {
  person: 'var(--s1)',
  agent: 'var(--s2)',
  script: 'var(--s3)',
};
export const slot = (i: number) => (i < 8 ? `var(--s${i + 1})` : 'var(--other)');

// ---------------------------------------------------------------------------------------------
// Pivots: rows to series.

/** Every day of the period, oldest first, ending `today`. */
export function daysOf(today: string, days: number): string[] {
  const end = Date.parse(`${today}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) => dayOf(end - (days - 1 - i) * 86_400_000));
}

/** Rows of (day, key, value) as one series per key over `days`. */
export function pivot(
  rows: readonly Row[],
  days: readonly string[],
  keyOf: (row: Row) => string,
  value: string,
  keys: readonly string[],
  label: (key: string) => string,
  colour: (key: string, index: number) => string,
): Series[] {
  const index = new Map(days.map((day, i) => [day, i]));
  return keys.map((key, k) => {
    const values = days.map(() => 0);
    for (const row of rows) {
      const i = index.get(String(row['day']));
      if (i !== undefined && keyOf(row) === key)
        values[i] = (values[i] ?? 0) + Number(row[value] ?? 0);
    }
    return { key, label: label(key), color: colour(key, k), values };
  });
}

/** Days grouped into weeks (for a year's columns): the week's first day, and its sums. */
function weekly(
  days: readonly string[],
  series: readonly Series[],
): { days: string[]; series: Series[] } {
  const starts = days.filter((_, i) => i % 7 === 0);
  return {
    days: starts,
    series: series.map((s) => ({
      ...s,
      values: starts.map((_, w) => s.values.slice(w * 7, w * 7 + 7).reduce((a, b) => a + b, 0)),
    })),
  };
}

export const distinct = (rows: readonly Row[], key: string) => [
  ...new Set(rows.map((row) => String(row[key] ?? ''))),
];

// ---------------------------------------------------------------------------------------------
// Cards.

const resizers = new Set<() => void>();
new ResizeObserver(() => resizers.forEach((draw) => draw())).observe(document.documentElement);

/** A session page's Playback (PEN-178), stopped when the view is drawn again. */
let player: Player | null = null;
/** Keeps the session page's player, to stop it when the view is drawn again. */
export function setPlayer(next: Player): void {
  player = next;
}
/** Clears what the last view left running: its charts' redraws and its player. */
export function clearView(): void {
  resizers.clear();
  player?.dispose();
  player = null;
}

/** Rows as CSV text. */
function csvText(rows: readonly (readonly (string | number)[])[]): string {
  const cell = (value: string | number) => {
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return rows.map((row) => row.map(cell).join(',')).join('\n') + '\n';
}

/** The table as CSV: a named column is followed by its ids ("Command", "Command ID"). */
function csvOf(table: TableSpec): string {
  const withIds = table.columns.map((_, i) => table.rows.some((row) => named(row[i]!)));
  const head = table.columns.flatMap((column, i) =>
    withIds[i] ? [column, `${column} ID`] : [column],
  );
  const body = table.rows.map((row) =>
    row.flatMap((value, i): (string | number)[] =>
      named(value)
        ? [value.title, value.id]
        : linked(value)
          ? [value.text]
          : withIds[i]
            ? [value, '']
            : [value],
    ),
  );
  return csvText([head, ...body]);
}

function tableElement(spec: TableSpec, caption: string): HTMLTableElement {
  const table = document.createElement('table');
  const cap = document.createElement('caption');
  cap.textContent = caption;
  table.append(cap);
  const head = table.createTHead().insertRow();
  spec.columns.forEach((column, i) => {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = column;
    // A column of figures has its heading over them, at the right.
    if (spec.rows.length > 0 && spec.rows.every((row) => typeof row[i] === 'number')) {
      th.className = 'num';
    }
    head.append(th);
  });
  const body = table.createTBody();
  for (const row of spec.rows) {
    const tr = body.insertRow();
    for (const value of row) {
      const td = tr.insertCell();
      if (named(value)) {
        // The display name, and the id it was recorded by muted under it.
        const id = document.createElement('span');
        id.className = 'cell-id';
        id.textContent = value.id;
        td.append(value.title, ...(value.id ? [id] : []));
      } else if (linked(value)) {
        const link = document.createElement('a');
        link.href = value.href;
        link.textContent = value.text;
        td.append(link);
      } else {
        td.textContent = typeof value === 'number' ? fullNumber(value) : value;
        if (typeof value === 'number') td.className = 'num';
      }
    }
  }
  return table;
}

export function button(label: string, onClick: () => void, name = label): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  node.setAttribute('aria-label', name);
  node.addEventListener('click', onClick);
  return node;
}

export function card(spec: CardSpec): HTMLElement {
  const section = document.createElement('section');
  section.className = spec.wide ? 'card wide' : 'card';
  section.dataset['card'] = spec.id;
  const head = document.createElement('header');
  const title = document.createElement('h2');
  title.textContent = spec.title;
  title.id = `card-${spec.id}`;
  if (spec.count !== undefined) {
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = fullNumber(spec.count);
    title.append(' ', count);
  }
  section.setAttribute('aria-labelledby', title.id);
  head.append(title);
  if (spec.note) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = spec.note;
    head.append(note);
  }
  section.append(head);
  if (spec.before) section.append(spec.before);
  if (spec.legend && spec.legend.length >= 2) {
    const legend = document.createElement('ul');
    legend.className = 'legend';
    legend.setAttribute('aria-label', `${spec.title} Legend`);
    for (const item of spec.legend) {
      const li = document.createElement('li');
      const key = document.createElement('span');
      key.className = spec.legendShape === 'line' ? 'key line' : 'key';
      key.style.background = item.color;
      li.append(key, document.createTextNode(item.label));
      legend.append(li);
    }
    section.append(legend);
  }
  const body = document.createElement('div');
  body.className = spec.flush ? 'chart-body flush' : 'chart-body';
  const drawn = spec.chart !== null || spec.custom !== undefined;
  body.hidden = !drawn && !spec.empty;
  section.append(body);
  if (spec.empty) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Nothing in this period.';
    body.append(empty);
  } else if (spec.custom) {
    body.append(spec.custom);
  } else if (spec.chart) {
    const draw = spec.chart;
    let drawnAt = 0;
    const redraw = () => {
      const style = getComputedStyle(body);
      const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const width = Math.floor(body.clientWidth - padding);
      if (width <= 0 || width === drawnAt) return;
      drawnAt = width;
      body.replaceChildren(draw(width));
    };
    resizers.add(redraw);
    requestAnimationFrame(redraw);
  }
  const tools = document.createElement('footer');
  tools.className = 'tools';
  if (spec.controls) {
    tools.append(...spec.controls);
    section.append(tools);
    return section;
  }
  // Table and Download CSV fill the foot, equal, as a bar's controls do (PEN-182).
  tools.classList.add('table-tools');
  const table = spec.table ?? { columns: [], rows: [] };
  const tableHolder = document.createElement('div');
  tableHolder.className = spec.tall ? 'table-holder tall' : 'table-holder';
  tableHolder.hidden = drawn;
  tableHolder.append(tableElement(table, spec.title));
  if (drawn) {
    const toggle = button(
      'Table',
      () => {
        const open = tableHolder.hidden;
        tableHolder.hidden = !open;
        toggle.setAttribute('aria-pressed', String(open));
      },
      `Table: ${spec.title}`,
    );
    toggle.setAttribute('aria-pressed', 'false');
    tools.append(toggle);
  }
  tools.append(
    button(
      'Download CSV',
      () => {
        const text = spec.csv ? csvText(spec.csv()) : csvOf(table);
        const blob = new Blob([text], { type: 'text/csv' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = spec.file ?? `penmoss-${spec.id}-${state.days}d.csv`;
        document.body.append(link);
        link.click();
        link.remove();
        // Kept a minute: the browser reads it after the click returns.
        setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
      },
      `Download CSV: ${spec.title}`,
    ),
  );
  section.append(tableHolder, tools);
  return section;
}

/** Figures in a row of tiles, every number the same size; a word ("Mac") the same size too. */
export function tiles(items: readonly { label: string; value: number | string }[]): HTMLElement {
  const list = document.createElement('dl');
  list.className = 'tiles';
  for (const item of items) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    const label = document.createElement('dt');
    label.textContent = item.label;
    const value = document.createElement('dd');
    value.textContent = typeof item.value === 'number' ? formatNumber(item.value) : item.value;
    tile.append(label, value);
    list.append(tile);
  }
  return list;
}

export interface Answer {
  readonly today: string;
  readonly filters: { days: number };
  /** When the answer was made (ms), the newest event received (ms), the rollup's last day. */
  readonly asOf?: number;
  readonly receivedAt?: number | null;
  readonly rolledUpThrough?: string | null;
  readonly [key: string]: unknown;
}

export const rowsOf = (answer: Answer, key: string) => (answer[key] as Row[] | undefined) ?? [];

/** Events by actor, a column a day (a week for a year), person/agent/script. */
export function actorCard(answer: Answer, id: string): HTMLElement {
  const rows = rowsOf(answer, 'actors');
  let days = daysOf(answer.today, answer.filters.days);
  let series = pivot(
    rows,
    days,
    (row) => String(row['actor']),
    'events',
    ['person', 'agent', 'script'],
    (k) => ACTOR_LABELS[k] ?? k,
    (k) => ACTOR_COLOURS[k] ?? 'var(--other)',
  );
  const byWeek = answer.filters.days > 90;
  if (byWeek) ({ days, series } = weekly(days, series));
  return card({
    id,
    title: 'Events by Actor',
    note: byWeek ? 'A column a week.' : 'A column a day.',
    chart: (width) => stackedColumns({ categories: days, series, label: 'Events by actor' }, width),
    legend: series,
    table: {
      columns: [byWeek ? 'Week Starting' : 'Day', ...series.map((s) => s.label)],
      rows: days.map((day, i) => [day, ...series.map((s) => s.values[i] ?? 0)]),
    },
    empty: rows.length === 0,
  });
}

/** What a view's renderer gives render() besides its body: its own header, range and title. */
export interface Rendered {
  /** In place of the view's h1 (a session's header row). */
  readonly head?: readonly HTMLElement[];
  readonly body: readonly HTMLElement[];
  /** The days the range line spans, when not the period (Sessions reads at most 90). */
  readonly rangeDays?: number;
  /** The tab's title, before " · Penmoss Usage". */
  readonly title?: string;
  /** Runs once the page is in place. */
  readonly after?: () => void;
}

/** "19 Nov, 17:58 UTC" from ms. */
export function stamp(ms: number): string {
  return `${new Date(ms).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  })} UTC`;
}
