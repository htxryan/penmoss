/**
 * The dashboard's page (PEN-137): a filter bar, seven views, and for each chart a legend (two
 * series or more), a Table toggle and Download CSV. Everything comes from /api/<view>; nothing is
 * per install.
 */
import {
  bars,
  eventLabel,
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

type Row = Record<string, string | number | null>;
type Cell = string | number;

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
}

const VIEW_NAMES = {
  overview: 'Overview',
  commands: 'Commands & Shortcuts',
  firstrun: 'First Run',
  paths: 'Paths',
  platforms: 'Platforms',
  agents: 'Agents',
  health: 'Health',
} as const;
type ViewName = keyof typeof VIEW_NAMES;

const CLIENT_LABELS: Record<string, string> = {
  mac: 'Mac',
  android: 'Android',
  cli: 'CLI',
  mcp: 'MCP',
};
const ACTOR_LABELS: Record<string, string> = { person: 'Person', agent: 'Agent', script: 'Script' };
/** The MCP clients' fixed list (core's AGENT_CLIENTS), as people name them. */
const AGENT_CLIENT_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  cursor: 'Cursor',
  vscode: 'VS Code',
  windsurf: 'Windsurf',
  zed: 'Zed',
  gemini: 'Gemini',
  goose: 'Goose',
  cline: 'Cline',
  continue: 'Continue',
  penmoss: 'Penmoss',
  other: 'Other Agent',
};
/** Who ran a CLI command or MCP tool: an agent client by name, else the actor. */
const agentLabel = (key: string) => AGENT_CLIENT_LABELS[key] ?? ACTOR_LABELS[key] ?? titled(key);
/** The first run's screens (FIRSTRUN_STEPS), as the funnel names them. */
const FIRSTRUN_LABELS: Record<string, string> = {
  welcome: 'Welcome',
  goal: 'Choose a Goal',
  way: 'Choose a Way',
  github: 'Sign In with GitHub',
  accounts: 'Choose an Account',
  create: 'Create a Repository',
  list: 'Choose a Repository',
  branch: 'Choose a Branch',
  repo: 'Open a Repository',
  folder: 'Choose a Folder',
  url: 'Enter a Git URL',
  'git-missing': 'Git Missing',
  name: 'Name the Notebook',
  setup: 'Set Up',
  consent: 'Consent Answered',
};
const STEP_RESULT_LABELS: Record<string, string> = { done: 'Done', back: 'Back', failed: 'Failed' };
/** A CLI command's or MCP tool's results, in order: blue, then orange, aqua, and the rest. */
const RESULTS = [
  { key: 'ok', label: 'OK', color: 'var(--s1)' },
  { key: 'invalid', label: 'Invalid', color: 'var(--s2)' },
  { key: 'not_found', label: 'Not Found', color: 'var(--s3)' },
  { key: 'conflict', label: 'Conflict', color: 'var(--s4)' },
  { key: 'failed', label: 'Failed', color: 'var(--s5)' },
] as const;

/** Words kept lower case inside a Title Case label (A938). */
const SHORT_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'nor',
  'as',
  'at',
  'by',
  'for',
  'from',
  'in',
  'into',
  'of',
  'on',
  'per',
  'to',
  'with',
]);

/** An id ("git-missing", "notFound") as a Title Case label ("Git Missing", "Not Found"). */
function titled(id: string): string {
  const words = id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_.-]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  return words
    .map((word, i) =>
      i > 0 && i < words.length - 1 && SHORT_WORDS.has(word)
        ? word
        : word[0]!.toUpperCase() + word.slice(1),
    )
    .join(' ');
}
const SOURCE_LABELS: Record<string, string> = {
  key: 'Key',
  palette: 'Palette',
  button: 'Button',
  menu: 'Menu',
  tray: 'Tray',
  hotkey: 'Hotkey',
  editor: 'Editor',
  other: 'Other',
  '': 'Other',
};
const SYNC_LABELS: Record<string, string> = {
  ok: 'OK',
  conflict: 'Conflict',
  offline: 'Offline',
  failed: 'Failed',
};
/** Person, agent, script: blue, orange, aqua (series 1–3). */
const ACTOR_COLOURS: Record<string, string> = {
  person: 'var(--s1)',
  agent: 'var(--s2)',
  script: 'var(--s3)',
};
const slot = (i: number) => (i < 8 ? `var(--s${i + 1})` : 'var(--other)');

// ---------------------------------------------------------------------------------------------
// State: the filters and the view, in the address so a reload keeps them.

interface State {
  view: ViewName;
  days: string;
  client: string;
  actor: string;
  channel: string;
  version: string;
  start: string;
}

function readState(): State {
  const [view = 'overview', query = ''] = location.hash.slice(1).split('?');
  const params = new URLSearchParams(query);
  return {
    view: (view in VIEW_NAMES ? view : 'overview') as ViewName,
    days: params.get('days') ?? '30',
    client: params.get('client') ?? '',
    actor: params.get('actor') ?? '',
    channel: params.get('channel') ?? '',
    version: params.get('version') ?? '',
    start: params.get('start') ?? 'command:app.palette',
  };
}

let state = readState();

function query(withStart: boolean): string {
  const params = new URLSearchParams({ days: state.days });
  for (const key of ['client', 'actor', 'channel', 'version'] as const) {
    if (state[key]) params.set(key, state[key]);
  }
  if (withStart && state.start) params.set('start', state.start);
  return params.toString();
}

function writeHash(): void {
  const params = new URLSearchParams(query(state.view === 'paths'));
  history.replaceState(null, '', `#${state.view}?${params.toString()}`);
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

function csvOf(table: TableSpec): string {
  const cell = (value: Cell) => {
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [table.columns, ...table.rows].map((row) => row.map(cell).join(',')).join('\n') + '\n';
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
      td.textContent = typeof value === 'number' ? value.toLocaleString('en-GB') : value;
      if (typeof value === 'number') td.className = 'num';
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
  body.className = 'chart-body';
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
  tableHolder.className = 'table-holder';
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
        const blob = new Blob([csvOf(spec.table)], { type: 'text/csv' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `penmoss-${spec.id}-${state.days}d.csv`;
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

/** Figures in a row of tiles, every number the same size. */
function tiles(items: readonly { label: string; value: number }[]): HTMLElement {
  const list = document.createElement('dl');
  list.className = 'tiles';
  for (const item of items) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    const label = document.createElement('dt');
    label.textContent = item.label;
    const value = document.createElement('dd');
    value.textContent = formatNumber(item.value);
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
  const commandRows: BarRow[] = top.map(({ name, parts }) => ({ label: name, parts }));
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
    chip.textContent = eventLabel(`${String(row['kind'])}:${String(row['name'])}`);
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
        rows: top.map(({ name, runs, installs, parts }) => [name, runs, installs, ...parts]),
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
              label: `${String(row['name'])} · ${String(row['keys'])}`,
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
          String(row['name']),
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
        rows: unused.map((row) => [titled(String(row['kind'])), String(row['name'])]),
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
  const picker = document.createElement('div');
  picker.className = 'picker';
  const label = document.createElement('label');
  label.htmlFor = 'start';
  label.textContent = 'Start From';
  const input = document.createElement('input');
  input.id = 'start';
  input.type = 'search';
  input.value = state.start;
  input.setAttribute('list', 'start-options');
  input.autocomplete = 'off';
  input.spellcheck = false;
  const list = document.createElement('datalist');
  list.id = 'start-options';
  // Each catalogued event, the most frequent first, with how often it occurred in the period.
  for (const option of options) {
    const node = document.createElement('option');
    node.value = option.event;
    node.label = `${eventLabel(option.event)} · ${option.events.toLocaleString('en-GB')} ${
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
    if (events.includes(input.value) && input.value !== state.start) {
      state.start = input.value;
      void render();
    }
  });
  picker.append(label, input, list, occurrences);

  const root = answer['tree'] as TreeNode | null;
  const flat: Cell[][] = [];
  const walk = (node: TreeNode, trail: string[]) => {
    const here = [...trail, eventLabel(node.event)];
    if (trail.length > 0) flat.push([here.join(' → '), node.sessions, node.share]);
    node.children.forEach((child) => walk(child, here));
  };
  if (root) walk(root, []);
  return [
    picker,
    card({
      id: 'paths',
      wide: true,
      title: `What Comes After ${eventLabel(state.start)}`,
      note: `The three most common next events, three steps deep, over the last ${String(answer['days'])} days. A path fewer than 5 sessions took isn't shown.`,
      chart: root ? (width) => tree({ label: `Paths after ${state.start}`, root }, width) : null,
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
  const osName = (os: string) =>
    ({ macos: 'macOS', android: 'Android', linux: 'Linux', windows: 'Windows' })[os] ?? 'Other';
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
    label: `${kindLabel(kind)} · ${name}`,
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
      label: `${kindLabel(row['kind'])} · ${String(row['name'])} · ${agentLabel(String(row['agent']))}`,
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
          String(row['name']),
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
          row.label,
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

const RENDERERS: Record<ViewName, (answer: Answer) => HTMLElement[]> = {
  overview,
  commands,
  firstrun: firstRun,
  paths,
  platforms,
  agents,
  health,
};

// ---------------------------------------------------------------------------------------------
// The page.

const main = document.querySelector<HTMLElement>('#view')!;
const status = document.querySelector<HTMLElement>('#status')!;
let rendering = 0;

async function render(): Promise<void> {
  const ticket = ++rendering;
  writeHash();
  hideTip();
  for (const link of document.querySelectorAll<HTMLAnchorElement>('nav.views a')) {
    if (link.dataset['view'] === state.view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = `${VIEW_NAMES[state.view]} · Penmoss Usage`;
  // The last view stays, dimmed, until the next one is ready.
  main.setAttribute('aria-busy', 'true');
  try {
    const answer = await load<Answer>(`/api/${state.view}?${query(state.view === 'paths')}`);
    if (ticket !== rendering) return;
    resizers.clear();
    const heading = document.createElement('h1');
    heading.className = 'view-title';
    heading.textContent = VIEW_NAMES[state.view];
    const range = document.createElement('p');
    range.className = 'range';
    const first = daysOf(answer.today, answer.filters.days)[0] ?? answer.today;
    range.textContent = `${shortDay(first)} to ${shortDay(answer.today)} (UTC)`;
    main.replaceChildren(heading, range, freshnessLine(answer), ...RENDERERS[state.view](answer));
    status.textContent = '';
  } catch (error) {
    if (ticket !== rendering) return;
    status.textContent = `Couldn't load this view: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (ticket === rendering) main.removeAttribute('aria-busy');
  }
}

function setUpFilters(): void {
  for (const key of ['days', 'client', 'actor', 'channel', 'version'] as const) {
    const select = document.querySelector<HTMLSelectElement>(`#filter-${key}`)!;
    select.value = state[key];
    select.addEventListener('change', () => {
      state[key] = select.value;
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

window.addEventListener('hashchange', () => {
  const next = readState();
  if (next.view !== state.view) {
    state = { ...state, view: next.view };
    void render();
  }
});

setUpFilters();
void render();
