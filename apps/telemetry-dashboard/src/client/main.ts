/**
 * The dashboard's page (PEN-137): a filter bar, eight views, and for each chart a legend (two
 * series or more), a Table toggle and Download CSV. Everything comes from /api/<view>. Nothing is
 * per install outside Sessions (PEN-173, A1661), which lists sessions and shows one session's
 * events and its install's sessions, the install shown only by its first 8 hex characters.
 */
import {
  bars,
  formatNumber,
  funnel,
  hideTip,
  lineChart,
  shortDay,
  stackedArea,
  stackedColumns,
  tree,
  type BarRow,
  type BarColumn,
  type Series,
  type TreeNode,
} from './charts';
import {
  ACTOR_LABELS,
  CLIENT_LABELS,
  FIRSTRUN_LABELS,
  RESULTS,
  SOURCE_LABELS,
  STEP_RESULT_LABELS,
  SYNC_LABELS,
  agentLabel,
  commandName,
  cutLine,
  displayName,
  eventName,
  kindName,
  osName,
  propsInWords,
  sessionLength,
  shortInstall,
  stretches,
  titled,
  windowName,
  type EventName,
} from './names';
import { createTimeline, timesOf, type TimelineEvent } from './timeline';

type Row = Record<string, string | number | null>;
/** A link in a table's cell (a session's start). */
interface LinkCell {
  readonly text: string;
  readonly href: string;
}
/** A display name with the id it was recorded by (the id is a muted line under it), or a link. */
type Cell = string | number | EventName | LinkCell;

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
  readonly table: TableSpec;
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

const VIEW_NAMES = {
  overview: 'Overview',
  commands: 'Commands & Shortcuts',
  firstrun: 'First Run',
  paths: 'Paths',
  sessions: 'Sessions',
  platforms: 'Platforms',
  agents: 'Agents',
  health: 'Health',
} as const;
type ViewName = keyof typeof VIEW_NAMES;

/** Person, agent, script: blue, orange, aqua (series 1–3). */
const ACTOR_COLOURS: Record<string, string> = {
  person: 'var(--s1)',
  agent: 'var(--s2)',
  script: 'var(--s3)',
};
const slot = (i: number) => (i < 8 ? `var(--s${i + 1})` : 'var(--other)');

// ---------------------------------------------------------------------------------------------
// State: the filters and the view, in the address so a reload keeps them; on Sessions, the
// list's page and an open session's install and id too (PEN-173).

interface State {
  view: ViewName;
  days: string;
  client: string;
  actor: string;
  channel: string;
  version: string;
  start: string;
  /** Sessions' page, from 1. */
  page: number;
  /** An open session's install and id, as the address has them (checked before use). */
  install: string;
  session: string;
}

const FILTER_KEYS = ['client', 'actor', 'channel', 'version'] as const;

const DEFAULTS: State = {
  view: 'overview',
  days: '30',
  client: '',
  actor: '',
  channel: '',
  version: '',
  start: 'command:app.palette',
  page: 1,
  install: '',
  session: '',
};

const INSTALL_ID = /^[0-9a-f]{32}$/;
const SESSION_ID = /^[0-9a-f]{16}$/;

/**
 * The state an address (`#view?…`) stands for, from `current`. A bare `#view` keeps the current
 * filters and Start From and opens the view's first page. A hash with any parameter is the whole
 * filter bar: a filter it leaves out is All, a missing page is 1; only Paths' start, which only
 * Paths writes, keeps the current one when it is missing.
 */
function stateOf(hash: string, current: State): State {
  const text = hash.replace(/^#/, '');
  const at = text.indexOf('?');
  const name = at < 0 ? text : text.slice(0, at);
  const view = (name in VIEW_NAMES ? name : 'overview') as ViewName;
  const query = at < 0 ? '' : text.slice(at + 1);
  if (query === '') return { ...current, view, page: 1, install: '', session: '' };
  const params = new URLSearchParams(query);
  const page = params.get('page') ?? '';
  return {
    view,
    days: params.get('days') ?? DEFAULTS.days,
    client: params.get('client') ?? '',
    actor: params.get('actor') ?? '',
    channel: params.get('channel') ?? '',
    version: params.get('version') ?? '',
    start: params.get('start') ?? current.start,
    page: /^[1-9]\d{0,3}$/.test(page) ? Number(page) : 1,
    install: view === 'sessions' ? (params.get('install') ?? '') : '',
    session: view === 'sessions' ? (params.get('session') ?? '') : '',
  };
}

let state = stateOf(location.hash, DEFAULTS);

const sameState = (a: State, b: State) =>
  (Object.keys(a) as (keyof State)[]).every((key) => a[key] === b[key]);

/** The period and filters as parameters. */
function filterParams(from: State = state): URLSearchParams {
  const params = new URLSearchParams({ days: from.days });
  for (const key of FILTER_KEYS) {
    if (from[key]) params.set(key, from[key]);
  }
  return params;
}

/** The address's parameters for `from`: the filters, Paths' start, Sessions' page and session. */
function query(from: State = state): string {
  const params = filterParams(from);
  if (from.view === 'paths' && from.start) params.set('start', from.start);
  if (from.view === 'sessions') {
    if (from.page > 1) params.set('page', String(from.page));
    if (from.install) params.set('install', from.install);
    if (from.session) params.set('session', from.session);
  }
  return params.toString();
}

/** The address of `changes` made to the state: a link's href. */
const hrefOf = (changes: Partial<State>) => {
  const to = { ...state, ...changes };
  return `#${to.view}?${query(to)}`;
};

/** Sessions' list at `page`, with the address's filters. */
const listHref = (page = state.page) =>
  hrefOf({ view: 'sessions', page, install: '', session: '' });

/** A session's address: the list's, with the install and the session. */
const sessionHref = (install: string, session: string) =>
  hrefOf({ view: 'sessions', install, session });

/** Whether Sessions is showing a session (or an address that tries to name one). */
const sessionOpen = () =>
  state.view === 'sessions' && (state.install !== '' || state.session !== '');

function writeHash(): void {
  history.replaceState(null, '', `#${state.view}?${query()}`);
}

/** The API request for the view: only what each view needs. */
function requestPath(): string {
  if (sessionOpen()) {
    return `/api/session?${new URLSearchParams({ install: state.install, session: state.session }).toString()}`;
  }
  if (state.view === 'sessions') {
    const params = filterParams();
    if (state.page > 1) params.set('page', String(state.page));
    return `/api/sessions?${params.toString()}`;
  }
  const params = filterParams();
  if (state.view === 'paths' && state.start) params.set('start', state.start);
  return `/api/${state.view}?${params.toString()}`;
}

async function load<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

// ---------------------------------------------------------------------------------------------
// Pivots: rows to series.

/** Every day of the period, oldest first, ending `today`. */
function daysOf(today: string, days: number): string[] {
  const end = Date.parse(`${today}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) =>
    new Date(end - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );
}

/** Rows of (day, key, value) as one series per key over `days`. */
function pivot(
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

const distinct = (rows: readonly Row[], key: string) => [
  ...new Set(rows.map((row) => String(row[key] ?? ''))),
];

// ---------------------------------------------------------------------------------------------
// Cards.

const resizers = new Set<() => void>();
new ResizeObserver(() => resizers.forEach((draw) => draw())).observe(document.documentElement);

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
        td.textContent = typeof value === 'number' ? value.toLocaleString('en-GB') : value;
        if (typeof value === 'number') td.className = 'num';
      }
    }
  }
  return table;
}

function button(label: string, onClick: () => void, name = label): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  node.setAttribute('aria-label', name);
  node.addEventListener('click', onClick);
  return node;
}

function card(spec: CardSpec): HTMLElement {
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
    count.textContent = spec.count.toLocaleString('en-GB');
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
  const tableHolder = document.createElement('div');
  tableHolder.className = spec.tall ? 'table-holder tall' : 'table-holder';
  tableHolder.hidden = drawn;
  tableHolder.append(tableElement(spec.table, spec.title));
  const tools = document.createElement('footer');
  tools.className = 'tools';
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
        const text = spec.csv ? csvText(spec.csv()) : csvOf(spec.table);
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
function tiles(items: readonly { label: string; value: number | string }[]): HTMLElement {
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

// ---------------------------------------------------------------------------------------------
// The views.

interface Answer {
  readonly today: string;
  readonly filters: { days: number };
  /** When the answer was made (ms), the newest event received (ms), the rollup's last day. */
  readonly asOf?: number;
  readonly receivedAt?: number | null;
  readonly rolledUpThrough?: string | null;
  readonly [key: string]: unknown;
}

const rowsOf = (answer: Answer, key: string) => (answer[key] as Row[] | undefined) ?? [];

/** Events by actor, a column a day (a week for a year), person/agent/script. */
function actorCard(answer: Answer, id: string): HTMLElement {
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

function overview(answer: Answer): HTMLElement[] {
  const totals = answer['totals'] as { today?: number; last7?: number; last30?: number };
  const active = rowsOf(answer, 'active');
  const days = daysOf(answer.today, answer.filters.days);
  const clients = ['mac', 'android', 'cli', 'mcp'].filter((c) =>
    active.some((row) => row['client'] === c),
  );
  const series = pivot(
    active,
    days,
    (row) => String(row['client']),
    'installs',
    clients,
    (k) => CLIENT_LABELS[k] ?? k,
    (_, i) => slot(i),
  );
  const versions = rowsOf(answer, 'versions');
  return [
    tiles([
      { label: 'Active Installs Today', value: totals.today ?? 0 },
      { label: 'Active Installs, Last 7 Days', value: totals.last7 ?? 0 },
      { label: 'Active Installs, Last 30 Days', value: totals.last30 ?? 0 },
    ]),
    card({
      id: 'weekly-active',
      title: 'Weekly Active Installs by Client',
      note: 'Each day: installs that did anything in the 7 days up to it.',
      chart: (width) =>
        lineChart({ categories: days, series, label: 'Weekly active installs by client' }, width),
      legend: series,
      legendShape: 'line',
      table: {
        columns: ['Day', ...series.map((s) => s.label)],
        rows: days.map((day, i) => [day, ...series.map((s) => s.values[i] ?? 0)]),
      },
      empty: active.length === 0,
    }),
    actorCard(answer, 'actor-split'),
    card({
      id: 'top-versions',
      title: 'Top Versions',
      note: 'Installs active in the period, by version and client.',
      chart: null,
      table: {
        columns: ['Version', 'Client', 'Installs'],
        rows: versions.map((row) => [
          String(row['version']),
          CLIENT_LABELS[String(row['client'])] ?? titled(String(row['client'])),
          Number(row['installs']),
        ]),
      },
      empty: versions.length === 0,
    }),
  ];
}

function commands(answer: Answer): HTMLElement[] {
  const rows = rowsOf(answer, 'commands');
  const names = distinct(rows, 'name');
  const sources = ['key', 'palette', 'button', 'menu', 'tray', 'hotkey', 'editor', 'other'];
  const sourceOf = (row: Row) =>
    sources.includes(String(row['source'])) ? String(row['source']) : 'other';
  const used = sources.filter((s) => rows.some((row) => sourceOf(row) === s));
  const legend = used.map((s) => ({
    key: s,
    label: SOURCE_LABELS[s] ?? s,
    color: slot(sources.indexOf(s)),
  }));
  const top = names.map((name) => {
    const own = rows.filter((row) => row['name'] === name);
    const parts = used.map((s) =>
      own.filter((row) => sourceOf(row) === s).reduce((sum, row) => sum + Number(row['runs']), 0),
    );
    return {
      name,
      parts,
      runs: parts.reduce((sum, n) => sum + n, 0),
      installs: Number(own[0]?.['installs'] ?? 0),
    };
  });
  const commandRows: BarRow[] = top.map(({ name, parts }) => ({
    label: displayName('command', name),
    id: name,
    parts,
  }));
  const installsColumn: BarColumn = {
    label: 'Installs',
    values: top.map(({ installs }) => formatNumber(installs)),
  };
  const shortcuts = rowsOf(answer, 'shortcuts').slice(0, 25);
  const unused = rowsOf(answer, 'unused');
  const chips = document.createElement('ul');
  chips.className = 'chips';
  chips.setAttribute('aria-label', 'Never Used Names');
  for (const row of unused) {
    const chip = document.createElement('li');
    chip.className = 'chip';
    const event = eventName(`${String(row['kind'])}:${String(row['name'])}`);
    chip.textContent = event.title;
    chip.title = event.id;
    chips.append(chip);
  }
  return [
    card({
      id: 'top-commands',
      title: 'Top 25 Commands',
      note: 'Runs, split by where each was run from, and how many installs ran it.',
      chart: (width) =>
        bars(
          {
            label: 'Top 25 commands by runs',
            unit: 'runs',
            series: legend,
            rows: commandRows,
            columns: [installsColumn],
            totalLabel: 'Runs',
          },
          width,
        ),
      legend,
      table: {
        columns: ['Command', 'Runs', 'Installs', ...legend.map((s) => s.label)],
        rows: top.map(({ name, runs, installs, parts }) => [
          commandName(name),
          runs,
          installs,
          ...parts,
        ]),
      },
      empty: rows.length === 0,
    }),
    card({
      id: 'shortcuts',
      title: 'Shortcuts',
      note: "Each combination's share of its command's runs, its default, and how many installs rebound it.",
      chart: (width) =>
        bars(
          {
            label: 'Key share of each command',
            unit: 'of the runs by this key',
            suffix: '%',
            series: [{ key: 'share', label: 'Key Share', color: 'var(--s1)' }],
            rows: shortcuts.map((row) => ({
              label: `${displayName('command', String(row['name']))} · ${String(row['keys'])}`,
              id: String(row['name']),
              parts: [Number(row['key_share'])],
              note: `${formatNumber(Number(row['key_runs']))} runs`,
            })),
            columns: [
              {
                label: 'Default',
                width: 104,
                values: shortcuts.map((row) => String(row['default_keys'] || 'None')),
              },
              {
                label: 'Rebound',
                values: shortcuts.map((row) => formatNumber(Number(row['rebound_installs']))),
              },
            ],
            totalLabel: 'Key Share',
          },
          width,
        ),
      table: {
        columns: [
          'Command',
          'Keys',
          'Default Keys',
          'Key Runs',
          'All Runs',
          'Key Share %',
          'Installs',
          'Rebound',
        ],
        rows: shortcuts.map((row) => [
          commandName(String(row['name'])),
          String(row['keys']),
          String(row['default_keys'] || 'None'),
          Number(row['key_runs']),
          Number(row['all_runs']),
          Number(row['key_share']),
          Number(row['installs']),
          Number(row['rebound_installs']),
        ]),
      },
      empty: shortcuts.length === 0,
    }),
    card({
      id: 'never-used',
      title: 'Never Used',
      count: unused.length,
      note: 'Catalogued commands, controls, screens, dialogs, menus, settings, CLI commands and MCP tools nobody used in this period.',
      chart: null,
      custom: chips,
      table: {
        columns: ['Kind', 'Name'],
        rows: unused.map((row) => [
          titled(String(row['kind'])),
          eventName(`${String(row['kind'])}:${String(row['name'])}`),
        ]),
      },
      empty: unused.length === 0,
    }),
  ];
}

function firstRun(answer: Answer): HTMLElement[] {
  const steps = rowsOf(answer, 'steps');
  const order = distinct(steps, 'step');
  const stepLabel = (step: unknown) => FIRSTRUN_LABELS[String(step)] ?? titled(String(step));
  const totals = order.map((step) => ({
    label: stepLabel(step),
    value: steps
      .filter((row) => row['step'] === step)
      .reduce((sum, row) => sum + Number(row['installs']), 0),
  }));
  const gaveUp = rowsOf(answer, 'gaveUp');
  const capped = Number(answer['days']) < answer.filters.days;
  return [
    card({
      id: 'funnel',
      title: 'First Run Funnel',
      note: `Installs reaching each step${capped ? ', over the last 90 days' : ''}.`,
      chart: (width) => funnel({ label: 'First run funnel', steps: totals }, width),
      table: {
        columns: ['Step', 'Client', 'Installs', 'Finished the Step'],
        rows: steps.map((row) => [
          stepLabel(row['step']),
          CLIENT_LABELS[String(row['client'])] ?? '',
          Number(row['installs']),
          Number(row['done']),
        ]),
      },
      empty: steps.length === 0,
    }),
    card({
      id: 'gave-up',
      title: 'Where Installs Gave Up',
      note: 'The last step reached by installs that never finished the first run.',
      chart: (width) =>
        bars(
          {
            label: 'Where installs gave up',
            unit: 'installs',
            series: [{ key: 'installs', label: 'Installs', color: 'var(--s2)' }],
            rows: gaveUp.map((row) => ({
              label: [
                stepLabel(row['step']),
                STEP_RESULT_LABELS[String(row['result'])] ?? '',
                row['error'] ? titled(String(row['error'])) : '',
              ]
                .filter(Boolean)
                .join(' · '),
              parts: [Number(row['installs'])],
            })),
          },
          width,
        ),
      table: {
        columns: ['Step', 'Client', 'Result', 'Error', 'Installs'],
        rows: gaveUp.map((row) => [
          stepLabel(row['step']),
          CLIENT_LABELS[String(row['client'])] ?? '',
          STEP_RESULT_LABELS[String(row['result'])] ?? '',
          row['error'] ? titled(String(row['error'])) : '',
          Number(row['installs']),
        ]),
      },
      empty: gaveUp.length === 0,
    }),
  ];
}

function paths(answer: Answer): HTMLElement[] {
  const options = (answer['options'] as { event: string; events: number }[] | undefined) ?? [];
  const events = options.map((option) => option.event);
  // The box shows display names; a name two events share says which kind each is ("Command
  // Palette · Dialog"), so each maps back to its event.
  const titles = options.map((option) => eventName(option.event).title);
  const shownAs = new Map(
    options.map((option) => {
      const { title } = eventName(option.event);
      const shared = titles.indexOf(title) !== titles.lastIndexOf(title);
      return [option.event, shared ? `${title} · ${kindName(option.event)}` : title];
    }),
  );
  const byShown = new Map([...shownAs].map(([event, shown]) => [shown, event]));
  const picker = document.createElement('div');
  picker.className = 'picker';
  const label = document.createElement('label');
  label.htmlFor = 'start';
  label.textContent = 'Start From';
  const input = document.createElement('input');
  input.id = 'start';
  input.type = 'search';
  input.value = shownAs.get(state.start) ?? eventName(state.start).title;
  input.title = eventName(state.start).id;
  input.setAttribute('list', 'start-options');
  input.autocomplete = 'off';
  input.spellcheck = false;
  const list = document.createElement('datalist');
  list.id = 'start-options';
  // Each catalogued event, the most frequent first, with how often it occurred in the period.
  for (const option of options) {
    const node = document.createElement('option');
    node.value = shownAs.get(option.event) ?? option.event;
    node.label = `${eventName(option.event).id} · ${option.events.toLocaleString('en-GB')} ${
      option.events === 1 ? 'time' : 'times'
    }`;
    list.append(node);
  }
  const chosen = options.find((option) => option.event === state.start);
  const occurrences = document.createElement('span');
  occurrences.className = 'occurrences';
  occurrences.textContent = chosen
    ? `${chosen.events.toLocaleString('en-GB')} ${chosen.events === 1 ? 'time' : 'times'} in the period`
    : '';
  input.addEventListener('change', () => {
    // A display name, or an id typed as recorded ("command:note.new").
    const event = byShown.get(input.value) ?? input.value;
    if (events.includes(event) && event !== state.start) {
      state.start = event;
      void render();
    }
  });
  picker.append(label, input, list, occurrences);

  const root = answer['tree'] as TreeNode | null;
  const flat: Cell[][] = [];
  const walk = (node: TreeNode, trail: string[]) => {
    const here = [...trail, eventName(node.event).title];
    if (trail.length > 0) {
      flat.push([
        { title: here.join(' → '), id: eventName(node.event).id },
        node.sessions,
        node.share,
      ]);
    }
    node.children.forEach((child) => walk(child, here));
  };
  if (root) walk(root, []);
  return [
    picker,
    card({
      id: 'paths',
      wide: true,
      title: `What Comes After ${eventName(state.start).title}`,
      note: `The three most common next events, three steps deep, over the last ${String(answer['days'])} days. A path fewer than 5 sessions took isn't shown.`,
      chart: root
        ? (width) => tree({ label: `Paths after ${eventName(state.start).title}`, root }, width)
        : null,
      table: { columns: ['Path', 'Sessions', 'Share %'], rows: flat },
      empty: !root,
    }),
  ];
}

function platforms(answer: Answer): HTMLElement[] {
  const platformRows = rowsOf(answer, 'platforms');
  const adoption = rowsOf(answer, 'adoption');
  const days = daysOf(answer.today, answer.filters.days);
  const versions = distinct(adoption, 'version').sort((a, b) =>
    a === 'Other' ? 1 : b === 'Other' ? -1 : b.localeCompare(a, 'en', { numeric: true }),
  );
  const series = pivot(
    adoption,
    days,
    (row) => String(row['version']),
    'installs',
    versions,
    (k) => k,
    (k, i) => (k === 'Other' ? 'var(--other)' : slot(i)),
  );
  const sizes = rowsOf(answer, 'sizes');
  const sizeKeys = ['compact', 'medium', 'expanded', 'unknown'].filter((k) =>
    sizes.some((row) => row['size_class'] === k),
  );
  const sizeSeries = sizeKeys.map((k, i) => ({
    key: k,
    label: k[0]!.toUpperCase() + k.slice(1),
    color: slot(i),
  }));
  const sizeClients = distinct(sizes, 'client');
  // Main windows' sizes as recorded, to 10 px or dp (PEN-174); Other has no width or height.
  const windowSizes = rowsOf(answer, 'windowSizes');
  const sizeOf = (row: Row) =>
    row['width'] === null || row['height'] === null
      ? 'Other'
      : `${String(row['width'])} × ${String(row['height'])}`;
  return [
    card({
      id: 'os-versions',
      title: 'Clients and OS Versions',
      chart: (width) =>
        bars(
          {
            label: 'Installs by client and OS version',
            unit: 'installs',
            series: [{ key: 'installs', label: 'Installs', color: 'var(--s1)' }],
            rows: platformRows.map((row) => ({
              label: `${CLIENT_LABELS[String(row['client'])] ?? ''} · ${osName(String(row['os']))} ${String(row['os_version'])}`,
              parts: [Number(row['installs'])],
            })),
          },
          width,
        ),
      table: {
        columns: ['Client', 'OS', 'OS Version', 'Installs'],
        rows: platformRows.map((row) => [
          CLIENT_LABELS[String(row['client'])] ?? '',
          osName(String(row['os'])),
          String(row['os_version']),
          Number(row['installs']),
        ]),
      },
      empty: platformRows.length === 0,
    }),
    card({
      id: 'adoption',
      title: 'Version Adoption',
      note: 'Installs active each day by version: the 6 with most installs, then Other.',
      chart: (width) => stackedArea({ categories: days, series, label: 'Version adoption' }, width),
      legend: series,
      table: {
        columns: ['Day', ...series.map((s) => s.label)],
        rows: days.map((day, i) => [day, ...series.map((s) => s.values[i] ?? 0)]),
      },
      empty: adoption.length === 0,
    }),
    card({
      id: 'size-classes',
      title: 'Window Size Classes',
      chart: (width) =>
        bars(
          {
            label: 'Installs by window size class',
            unit: 'installs',
            series: sizeSeries,
            rows: sizeClients.map((client) => ({
              label: CLIENT_LABELS[client] ?? client,
              parts: sizeKeys.map((k) =>
                Number(
                  sizes.find((row) => row['client'] === client && row['size_class'] === k)?.[
                    'installs'
                  ] ?? 0,
                ),
              ),
            })),
          },
          width,
        ),
      legend: sizeSeries,
      table: {
        columns: ['Client', 'Size Class', 'Installs'],
        rows: sizes.map((row) => [
          CLIENT_LABELS[String(row['client'])] ?? '',
          titled(String(row['size_class'])),
          Number(row['installs']),
        ]),
      },
      empty: sizes.length === 0,
    }),
    card({
      id: 'window-sizes',
      title: 'Common Window Sizes',
      note: 'Installs by main window size: the 10 most common per client, then Other.',
      chart: (width) =>
        bars(
          {
            label: 'Installs by main window size',
            unit: 'installs',
            series: [{ key: 'installs', label: 'Installs', color: 'var(--s1)' }],
            rows: windowSizes.map((row) => ({
              label: `${CLIENT_LABELS[String(row['client'])] ?? ''} · ${sizeOf(row)}`,
              parts: [Number(row['installs'])],
            })),
          },
          width,
        ),
      table: {
        columns: ['Client', 'Window Size', 'Installs'],
        rows: windowSizes.map((row) => [
          CLIENT_LABELS[String(row['client'])] ?? '',
          sizeOf(row),
          Number(row['installs']),
        ]),
      },
      empty: windowSizes.length === 0,
    }),
  ];
}

function agents(answer: Answer): HTMLElement[] {
  const rows = rowsOf(answer, 'agents');
  const byCalls = distinct(rows, 'agent')
    .map((agent) => ({
      agent,
      calls: rows
        .filter((row) => row['agent'] === agent)
        .reduce((s, row) => s + Number(row['calls']), 0),
    }))
    .sort((a, b) => b.calls - a.calls);
  // Eight colours: the rest of the agents share Other.
  const shown = byCalls.slice(0, byCalls.length > 8 ? 7 : 8).map((a) => a.agent);
  const agentOf = (row: Row) =>
    shown.includes(String(row['agent'])) ? String(row['agent']) : 'other';
  const keys = [...shown, ...(byCalls.length > shown.length ? ['other'] : [])];
  const legend = keys.map((k, i) => ({
    key: k,
    label: k === 'other' && !shown.includes('other') ? 'Others' : agentLabel(k),
    color: k === 'other' ? 'var(--other)' : slot(i),
  }));
  const kindLabel = (kind: unknown) => (kind === 'tool' ? 'MCP' : 'CLI');
  const names = distinct(rows, 'name').map((name) => ({
    name,
    kind: String(rows.find((row) => row['name'] === name)?.['kind']),
  }));
  const nameRows: BarRow[] = names.map(({ name, kind }) => ({
    label: `${kindLabel(kind)} · ${displayName(kind, name)}`,
    id: name,
    parts: keys.map((k) =>
      rows
        .filter((row) => row['name'] === name && agentOf(row) === k)
        .reduce((s, row) => s + Number(row['calls']), 0),
    ),
  }));
  // Each command or tool, by agent client: the share of its calls that ended in each result.
  const share = (part: number, calls: number) =>
    calls ? Math.round((1000 * part) / calls) / 10 : 0;
  const rateRows = rows.map((row) => {
    const calls = Number(row['calls']);
    return {
      label: `${kindLabel(row['kind'])} · ${displayName(String(row['kind']), String(row['name']))} · ${agentLabel(String(row['agent']))}`,
      id: String(row['name']),
      calls,
      counts: RESULTS.map((result) => Number(row[result.key] ?? 0)),
    };
  });
  return [
    actorCard(answer, 'agents-actors'),
    card({
      id: 'agent-calls',
      title: 'CLI Commands and MCP Tools by Agent',
      note: "Calls, split by the agent client (an MCP tool's), or who ran the CLI.",
      chart: (width) =>
        bars(
          {
            label: 'CLI commands and MCP tools by agent',
            unit: 'calls',
            series: legend,
            rows: nameRows,
          },
          width,
        ),
      legend,
      table: {
        columns: ['Kind', 'Name', 'Agent', 'Calls', 'Installs'],
        rows: rows.map((row) => [
          kindLabel(row['kind']),
          { title: displayName(String(row['kind']), String(row['name'])), id: String(row['name']) },
          agentLabel(String(row['agent'])),
          Number(row['calls']),
          Number(row['installs']),
        ]),
      },
      empty: rows.length === 0,
    }),
    card({
      id: 'result-rates',
      title: 'Result Rates',
      note: 'How each CLI command and MCP tool ended, by agent client: its share of the calls.',
      chart: (width) =>
        bars(
          {
            label: 'Result rates by agent client',
            unit: 'of the calls',
            suffix: '%',
            series: RESULTS,
            rows: rateRows.map((row) => ({
              label: row.label,
              id: row.id,
              parts: row.counts.map((count) => share(count, row.calls)),
            })),
            columns: [{ label: 'Calls', values: rateRows.map((row) => formatNumber(row.calls)) }],
            totalLabel: 'Results',
            showTotal: false,
          },
          width,
        ),
      legend: RESULTS,
      table: {
        columns: ['Name', 'Calls', ...RESULTS.map((result) => `${result.label} %`)],
        rows: rateRows.map((row) => [
          { title: row.label, id: row.id },
          row.calls,
          ...row.counts.map((count) => share(count, row.calls)),
        ]),
      },
      empty: rows.length === 0,
    }),
  ];
}

function health(answer: Answer): HTMLElement[] {
  const rows = rowsOf(answer, 'health');
  const days = daysOf(answer.today, answer.filters.days);
  const keys = ['accepted', 'dropped', 'written'];
  const labels: Record<string, string> = {
    accepted: 'Accepted',
    dropped: 'Dropped',
    written: 'Written',
  };
  const index = new Map(days.map((day, i) => [day, i]));
  const series: Series[] = keys.map((key, k) => {
    const values = days.map(() => 0);
    for (const row of rows) {
      const i = index.get(String(row['day']));
      if (i !== undefined) values[i] = Number(row[key] ?? 0);
    }
    return { key, label: labels[key] ?? key, color: slot(k), values };
  });
  const sum = (key: string) => rows.reduce((s, row) => s + Number(row[key] ?? 0), 0);
  const cap = Number(answer['writeCap']);
  const peak = Math.max(0, ...rows.map((row) => Number(row['written'] ?? 0)));
  const sync = rowsOf(answer, 'sync');
  const results = distinct(sync, 'result');
  return [
    tiles([
      { label: 'Batches', value: sum('batches') },
      { label: 'Events Accepted', value: sum('accepted') },
      { label: 'Events Dropped', value: sum('dropped') },
      { label: 'Forgets', value: sum('forgets') },
    ]),
    card({
      id: 'ingest',
      title: 'Events per Day',
      note: `Rows written on the busiest day: ${peak.toLocaleString('en-GB')} of the ${cap.toLocaleString('en-GB')} a day D1's free plan allows (${((100 * peak) / cap).toFixed(1)}%).`,
      chart: (width) =>
        lineChart(
          { categories: days, series, label: 'Events accepted, dropped and written per day' },
          width,
        ),
      legend: series,
      legendShape: 'line',
      table: {
        columns: ['Day', 'Batches', 'Accepted', 'Dropped', 'Written', 'Forgets'],
        rows: rows.map((row) => [
          String(row['day']),
          Number(row['batches']),
          Number(row['accepted']),
          Number(row['dropped']),
          Number(row['written']),
          Number(row['forgets']),
        ]),
      },
      empty: rows.length === 0,
    }),
    card({
      id: 'sync',
      title: 'Sync Passes',
      chart: (width) =>
        bars(
          {
            label: 'Sync passes by result',
            unit: 'passes',
            series: [{ key: 'passes', label: 'Passes', color: 'var(--s1)' }],
            rows: results.map((result) => ({
              label: SYNC_LABELS[result] ?? 'Other',
              parts: [
                sync
                  .filter((row) => row['result'] === result)
                  .reduce((s, row) => s + Number(row['passes']), 0),
              ],
            })),
          },
          width,
        ),
      table: {
        columns: ['Client', 'Result', 'Took', 'Passes', 'Installs'],
        rows: sync.map((row) => [
          CLIENT_LABELS[String(row['client'])] ?? '',
          SYNC_LABELS[String(row['result'])] ?? titled(String(row['result'])),
          String(row['took']),
          Number(row['passes']),
          Number(row['installs']),
        ]),
      },
      empty: sync.length === 0,
    }),
  ];
}

// ---------------------------------------------------------------------------------------------
// Sessions (PEN-173): the recent sessions, and one session's events in order.

/** What a view's renderer gives render() besides its body: its own header, range and title. */
interface Rendered {
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

/** "20 Nov, 09:14" from ms (UTC, as the range line says). */
function when(ms: number): string {
  return new Date(ms).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  if (className) made.className = className;
  made.append(...children);
  return made;
}

/** A link styled as a button; with no href it is disabled (aria-disabled), as at a list's end. */
function linkButton(label: string, href: string | null): HTMLAnchorElement {
  const link = node('a', 'btn', label);
  if (href) link.href = href;
  else {
    // Without an href an <a> is no link at all: it keeps the role, disabled.
    link.setAttribute('role', 'link');
    link.setAttribute('aria-disabled', 'true');
  }
  return link;
}

const backLink = () => {
  const link = node('a', 'back', '← All Sessions');
  link.href = listHref();
  return link;
};

const eventsWord = (n: number) => `${n.toLocaleString('en-GB')} ${n === 1 ? 'event' : 'events'}`;
const clientName = (client: unknown) => CLIENT_LABELS[String(client)] ?? titled(String(client));
const screenCell = (name: Row[string] | undefined): Cell =>
  name ? eventName(`screen:${String(name)}`) : 'No Screens';

function sessionsList(answer: Answer): Rendered {
  const rows = rowsOf(answer, 'sessions');
  const total = Number(answer['total'] ?? 0);
  const page = Number(answer['page'] ?? 1);
  const size = Number(answer['pageSize'] ?? 50);
  const days = Number(answer['days'] ?? answer.filters.days);
  // A page past the end came back as page 1: the address and links follow what is shown.
  if (page !== state.page) {
    state.page = page;
    writeHash();
  }
  const capped = days < answer.filters.days;
  let before: HTMLElement | undefined;
  if (total > 0) {
    const from = (page - 1) * size + 1;
    const to = Math.min(page * size, total);
    before = node(
      'div',
      'pager',
      node(
        'span',
        'pager-range',
        `${from.toLocaleString('en-GB')}–${to.toLocaleString('en-GB')} of ${total.toLocaleString('en-GB')}`,
      ),
      linkButton('Newer', page > 1 ? listHref(page - 1) : null),
      linkButton('Older', to < total ? listHref(page + 1) : null),
    );
    before.setAttribute('aria-label', 'Pages');
  }
  const length = (row: Row) =>
    sessionLength({
      started: Number(row['started']),
      ended: Number(row['ended']),
      events: Number(row['events']),
      took: row['took'] === null ? null : String(row['took'] ?? ''),
    });
  const os = (row: Row) => `${osName(String(row['os']))} ${String(row['os_version'])}`;
  const screenId = (name: Row[string] | undefined) =>
    name ? eventName(`screen:${String(name)}`).id : '';
  return {
    rangeDays: days,
    body: [
      card({
        id: 'recent-sessions',
        title: 'Recent Sessions',
        wide: true,
        tall: true,
        note: `Sessions with an event that matches the filters, newest first${capped ? ', over the last 90 days' : ''}. Choose a start time to read the session.`,
        chart: null,
        ...(before ? { before } : {}),
        table: {
          columns: [
            'Started',
            'Length',
            'Client',
            'Version',
            'OS',
            'Events',
            'First Screen',
            'Last Screen',
          ],
          rows: rows.map((row) => [
            {
              text: when(Number(row['started'])),
              href: sessionHref(String(row['install']), String(row['session'])),
            },
            length(row),
            clientName(row['client']),
            String(row['version']),
            os(row),
            Number(row['events']),
            screenCell(row['first_screen']),
            screenCell(row['last_screen']),
          ]),
        },
        file: `penmoss-sessions-${state.days}d.csv`,
        csv: () => [
          [
            'Started',
            'Length',
            'Client',
            'Version',
            'OS',
            'Events',
            'First Screen',
            'First Screen ID',
            'Last Screen',
            'Last Screen ID',
            'Install',
            'Session',
          ],
          ...rows.map((row) => {
            const first = screenCell(row['first_screen']);
            const last = screenCell(row['last_screen']);
            return [
              new Date(Number(row['started'])).toISOString(),
              Math.round((Number(row['ended']) - Number(row['started'])) / 1000),
              clientName(row['client']),
              String(row['version']),
              os(row),
              Number(row['events']),
              typeof first === 'string' ? first : (first as EventName).title,
              screenId(row['first_screen']),
              typeof last === 'string' ? last : (last as EventName).title,
              screenId(row['last_screen']),
              String(row['install']).slice(0, 8),
              String(row['session']),
            ];
          }),
        ],
        empty: rows.length === 0,
      }),
    ],
  };
}

/** A session address that names no session: shown without asking the API. */
function notASessionLink(): HTMLElement[] {
  const heading = node('h1', 'view-title', 'Not a Session Link');
  return [
    backLink(),
    heading,
    node('p', 'gone', "This address doesn't name a session."),
    linkButton('All Sessions', listHref()),
  ];
}

/** Copy Link: the address to the clipboard, or, when the browser refuses, a field to copy from. */
function copyLink(status: HTMLElement, head: HTMLElement): HTMLButtonElement {
  let shown = 0;
  const copy = button('Copy Link', () => {
    const href = location.href;
    const refused = () => {
      head.parentElement?.querySelector('.copy-fallback')?.remove();
      const field = document.createElement('input');
      field.id = 'session-link';
      field.readOnly = true;
      field.value = href;
      const label = node('label', '', 'Session Link');
      label.htmlFor = field.id;
      const fallback = node(
        'div',
        'copy-fallback',
        label,
        field,
        node('p', '', 'Select the link and copy it.'),
      );
      head.after(fallback);
      field.focus();
      field.select();
    };
    if (!navigator.clipboard) {
      refused();
      return;
    }
    navigator.clipboard.writeText(href).then(() => {
      const mine = ++shown;
      status.textContent = 'Link Copied';
      setTimeout(() => {
        if (mine === shown) status.textContent = '';
      }, 3000);
    }, refused);
  });
  copy.className = 'btn';
  return copy;
}

function sessionPage(answer: Answer): Rendered {
  const install = String(answer['install']);
  const session = String(answer['session']);
  const events = (answer['events'] as TimelineEvent[] | undefined) ?? [];
  const others = rowsOf(answer, 'others');
  const othersTotal = Number(answer['othersTotal'] ?? others.length);
  if (events.length === 0) {
    return {
      rangeDays: 90,
      title: 'Session Not Found',
      head: [backLink(), node('h1', 'view-title', 'Session Not Found')],
      body: [
        node(
          'p',
          'gone',
          "Nothing from this session in the last 90 days. It may be older, which this tab doesn't read, or its install deleted its shared data.",
        ),
        linkButton('All Sessions', listHref()),
      ],
    };
  }
  const at = events.map((e) => e.at);
  const index = others.findIndex((row) => row['session'] === session);
  const own = others[index];
  const first = events[0]!;
  const started = own ? Number(own['started']) : Math.min(...at);
  const length = sessionLength({
    started,
    ended: own ? Number(own['ended']) : Math.max(...at),
    events: own ? Number(own['events']) : events.length,
    took: own
      ? (own['took'] as string | null)
      : typeof first.props['took'] === 'string'
        ? first.props['took']
        : null,
  });
  const title = `Session on ${stamp(started)}`;

  // The header row: the h1, then Copy Link, Previous Session and Next Session.
  const copied = node('span', 'copied');
  copied.setAttribute('role', 'status');
  const head = node('div', 'session-head');
  const neighbour = (row: Row | undefined) =>
    row ? sessionHref(install, String(row['session'])) : null;
  const actions = node(
    'div',
    'session-actions',
    copied,
    copyLink(copied, head),
    linkButton('Previous Session', index > 0 ? neighbour(others[index - 1]) : null),
    linkButton('Next Session', index >= 0 ? neighbour(others[index + 1]) : null),
  );
  head.append(node('h1', 'view-title', title), actions);

  const ids = node(
    'p',
    'ids',
    [`Install ${shortInstall(install)}`, `Session ${session}`, windowName(first.size_class)]
      .filter(Boolean)
      .join(' · '),
  );
  const actors = [...new Set(events.map((e) => e.actor))].map((a) => ACTOR_LABELS[a] ?? titled(a));

  // The timeline: one list of events, one current index (timeline.ts).
  const timeline = createTimeline(events);
  const parts = stretches(events);
  const screenOf = (i: number): Cell => {
    const part = parts.find((p) => i >= p.first && i < p.end);
    return part ? { title: part.title, id: part.id } : '';
  };
  const times = timesOf(events);
  const timelineCard = card({
    id: 'timeline',
    title: 'Timeline',
    note: `Every event in order, divided where the screen changes.${answer['more'] ? ' Showing the first 5,000 events.' : ''}`,
    chart: null,
    custom: timeline.element,
    flush: true,
    table: {
      columns: ['Seq', 'Since Start', 'Gap', 'Kind', 'Event', 'Screen', 'Details'],
      rows: events.map((event, i) => [
        event.seq,
        times[i]!.since,
        times[i]!.gap,
        kindName(`${event.kind}:${event.name}`),
        eventName(`${event.kind}:${event.name}`),
        screenOf(i),
        propsInWords(event.kind, event.props, event.name)
          .map((prop) => `${prop.label} ${prop.value}`)
          .join(' · '),
      ]),
    },
    file: `penmoss-session-${session}.csv`,
  });

  // This Install's Sessions: the 500 nearest, oldest first, the open one marked.
  const list = node('ol', 'ss');
  list.setAttribute('aria-label', "This Install's Sessions");
  for (const row of others) {
    const open = row['session'] === session;
    const link = node(
      'a',
      'ss-item',
      node('span', 'ss-when', when(Number(row['started']))),
      node(
        'span',
        'ss-meta',
        [
          clientName(row['client']),
          sessionLength({
            started: Number(row['started']),
            ended: Number(row['ended']),
            events: Number(row['events']),
            took: row['took'] as string | null,
          }),
          eventsWord(Number(row['events'])),
        ].join(' · '),
      ),
    );
    link.href = sessionHref(install, String(row['session']));
    if (open) {
      link.setAttribute('aria-current', 'page');
      link.append(node('span', 'ss-this', 'This Session'));
    }
    list.append(node('li', '', link));
  }
  const cut = cutLine(othersTotal, Math.max(0, index), Math.max(0, others.length - index - 1));
  const sideCard = card({
    id: 'install-sessions',
    title: "This Install's Sessions",
    count: othersTotal,
    note: 'Every session of this install in the last 90 days, oldest first, whatever the filters.',
    ...(cut ? { before: node('p', 'cut', cut) } : {}),
    chart: null,
    custom: list,
    table: {
      columns: ['Started', 'Client', 'Length', 'Events'],
      rows: others.map((row) => [
        when(Number(row['started'])),
        clientName(row['client']),
        sessionLength({
          started: Number(row['started']),
          ended: Number(row['ended']),
          events: Number(row['events']),
          took: row['took'] as string | null,
        }),
        Number(row['events']),
      ]),
    },
    file: `penmoss-install-sessions-${session}.csv`,
  });
  sideCard.classList.add('side');

  return {
    rangeDays: 90,
    title,
    head: [backLink(), head],
    body: [
      ids,
      sessionTiles([
        { label: 'Length', value: length },
        { label: 'Events', value: own ? Number(own['events']) : events.length },
        { label: 'Client', value: clientName(first.client) },
        { label: 'Actor', value: actors.join(', ') },
        { label: 'Version', value: first.version },
        { label: 'Channel', value: titled(first.channel) },
        { label: 'OS', value: `${osName(first.os)} ${first.os_version}` },
      ]),
      node('div', 'session-cols', timelineCard, sideCard),
    ],
    after: () => {
      // The open session in the middle of its list's box; the window doesn't move.
      const item = list.querySelector('[aria-current]')?.parentElement;
      if (item) list.scrollTop = item.offsetTop - list.clientHeight / 2 + item.offsetHeight / 2;
    },
  };
}

/** A session's tiles: words as well as figures, two to a row on a phone. */
function sessionTiles(items: readonly { label: string; value: number | string }[]): HTMLElement {
  const list = tiles(items);
  list.classList.add('session-tiles');
  return list;
}

/** Sessions: the list, or one session when the address names one. */
function sessions(answer: Answer): Rendered {
  return sessionOpen() ? sessionPage(answer) : sessionsList(answer);
}

/** "19 Nov, 17:58 UTC" from ms. */
function stamp(ms: number): string {
  return `${new Date(ms).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  })} UTC`;
}

/** How fresh the view is: when the answer was made, the newest event, and the rollup's day. */
function freshnessLine(answer: Answer): HTMLElement {
  const line = document.createElement('p');
  line.className = 'freshness';
  line.dataset['testid'] = 'freshness';
  const parts = [
    `Data as of ${stamp(answer.asOf ?? Date.now())}`,
    answer.receivedAt ? `newest event ${stamp(answer.receivedAt)}` : 'no events yet',
    answer.rolledUpThrough
      ? `rollups through ${shortDay(answer.rolledUpThrough)}`
      : 'no rollups yet',
  ];
  line.textContent = `${parts.join(' · ')}. Answers are kept up to 5 minutes.`;
  return line;
}

const RENDERERS: Record<ViewName, (answer: Answer) => HTMLElement[] | Rendered> = {
  overview,
  commands,
  firstrun: firstRun,
  paths,
  sessions,
  platforms,
  agents,
  health,
};

// ---------------------------------------------------------------------------------------------
// The page.

const main = document.querySelector<HTMLElement>('#view')!;
const status = document.querySelector<HTMLElement>('#status')!;
const strip = document.querySelector<HTMLElement>('nav.views')!;
let rendering = 0;

/**
 * The tab strip: the current tab marked and scrolled into the strip (by its scrollLeft, never
 * scrollIntoView, which would move the window too), and every tab's link carrying the filters (and
 * Paths' its Start From), so a tab click keeps them.
 */
function updateTabs(): void {
  for (const link of strip.querySelectorAll<HTMLAnchorElement>('a[data-view]')) {
    const view = link.dataset['view'] as ViewName;
    link.setAttribute('href', hrefOf({ view, page: 1, install: '', session: '' }));
    if (view !== state.view) {
      link.removeAttribute('aria-current');
      continue;
    }
    link.setAttribute('aria-current', 'page');
    const box = strip.getBoundingClientRect();
    const tab = link.getBoundingClientRect();
    if (tab.left < box.left) strip.scrollLeft += tab.left - box.left;
    else if (tab.right > box.right) strip.scrollLeft += tab.right - box.right;
  }
}

/** Draws the view the state names. True when it is still the current render once drawn. */
async function render(): Promise<boolean> {
  const ticket = ++rendering;
  writeHash();
  hideTip();
  updateTabs();
  document.title = `${VIEW_NAMES[state.view]} · Penmoss Usage`;
  if (sessionOpen() && !(INSTALL_ID.test(state.install) && SESSION_ID.test(state.session))) {
    // An address that names no session: nothing to ask the API.
    resizers.clear();
    main.replaceChildren(...notASessionLink());
    main.removeAttribute('aria-busy');
    status.textContent = '';
    document.title = 'Not a Session Link · Penmoss Usage';
    return true;
  }
  // The last view stays, dimmed, until the next one is ready.
  main.setAttribute('aria-busy', 'true');
  try {
    const answer = await load<Answer>(requestPath());
    if (ticket !== rendering) return false;
    resizers.clear();
    const drawn = RENDERERS[state.view](answer);
    const page: Rendered = Array.isArray(drawn) ? { body: drawn } : drawn;
    const heading = document.createElement('h1');
    heading.className = 'view-title';
    heading.textContent = VIEW_NAMES[state.view];
    const range = document.createElement('p');
    range.className = 'range';
    const first = daysOf(answer.today, page.rangeDays ?? answer.filters.days)[0] ?? answer.today;
    range.textContent = `${shortDay(first)} to ${shortDay(answer.today)} (UTC)`;
    main.replaceChildren(...(page.head ?? [heading]), range, freshnessLine(answer), ...page.body);
    document.title = `${page.title ?? VIEW_NAMES[state.view]} · Penmoss Usage`;
    status.textContent = '';
    page.after?.();
    return true;
  } catch (error) {
    if (ticket !== rendering) return false;
    status.textContent = `Couldn't load this view: ${error instanceof Error ? error.message : String(error)}`;
    return true;
  } finally {
    if (ticket === rendering) main.removeAttribute('aria-busy');
  }
}

/** The filter bar's selects, set to the state. */
function showFilters(): void {
  for (const key of ['days', ...FILTER_KEYS] as const) {
    document.querySelector<HTMLSelectElement>(`#filter-${key}`)!.value = state[key];
  }
}

function setUpFilters(): void {
  for (const key of ['days', ...FILTER_KEYS] as const) {
    const select = document.querySelector<HTMLSelectElement>(`#filter-${key}`)!;
    select.value = state[key];
    select.addEventListener('change', () => {
      // A filter replaces the address, as it always has; on Sessions it goes back to the list's
      // first page, so Back from there skips an open session.
      state = { ...state, [key]: select.value, page: 1, install: '', session: '' };
      void render();
    });
  }
  void load<{ versions: string[] }>('/api/versions?days=395').then(({ versions }) => {
    const select = document.querySelector<HTMLSelectElement>('#filter-version')!;
    for (const version of versions) {
      const option = document.createElement('option');
      option.value = version;
      option.textContent = version;
      select.append(option);
    }
    select.value = state.version;
  });
}

// Moving around (PEN-173): links push history entries, so Back returns to each step, its
// filters and where it was scrolled. The page restores the scroll itself, after the view is
// drawn, rather than the browser before the answer arrives.
history.scrollRestoration = 'manual';
/** Where each address was scrolled when it was left. */
const positions = new Map<string, number>();
/** Whether the address is changing because a link here was clicked (then it opens at the top). */
let navigating = false;

document.addEventListener('click', (event) => {
  // A plain left click only: Cmd, Ctrl, Shift or Alt (or a middle click) opens a new tab or window.
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = (event.target as Element | null)?.closest?.<HTMLAnchorElement>('a[href^="#"]');
  if (!link) return;
  event.preventDefault();
  const target = link.getAttribute('href')!;
  // The address already showing: no hashchange comes, and nothing changes.
  if (target === location.hash) return;
  navigating = true;
  location.hash = target;
});

window.addEventListener('hashchange', (event) => {
  positions.set(new URL(event.oldURL).hash, window.scrollY);
  const clicked = navigating;
  navigating = false;
  const bare = !location.hash.includes('?') || location.hash.endsWith('?');
  const next = stateOf(location.hash, state);
  if (!bare && sameState(next, state)) return;
  state = next;
  showFilters();
  void render().then((current) => {
    if (!current) return;
    // After the cards' own chart redraws, which are queued the same way, so the page is at its
    // full height.
    requestAnimationFrame(() => {
      window.scrollTo(0, clicked ? 0 : (positions.get(location.hash) ?? 0));
    });
  });
});

setUpFilters();
void render();
