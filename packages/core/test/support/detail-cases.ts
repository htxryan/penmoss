/**
 * Events of session detail's kinds (PEN-177), valid and not: for every name, one with every
 * prop it takes; then, for every prop, values outside its type; a prop that isn't the name's
 * own; and each kind from the CLI and the MCP server. `analytics-contract.test.ts` writes each
 * with the problem eventProblem finds into analytics-v1.json, which Android's validator replays.
 */
import { MAX_SHAPE_BYTES } from '../../src/analytics/detail';

const BASE = {
  session: '0123456789abcdef',
  seq: 0,
  at: 1_763_550_000_000,
  client: 'mac',
  actor: 'person',
  version: '1.4.0',
  channel: 'stable',
  os: 'macos',
  osVersion: '26.1',
  sizeClass: 'expanded',
} as const;

const NOTE = '0123456789abcdef';
const FOLDER = 'fedcba9876543210';

/** Each name with every prop it takes, valid. */
const VALID: ReadonlyArray<readonly [string, string, Record<string, unknown>]> = [
  [
    'note',
    'open',
    {
      note: NOTE,
      folder: FOLDER,
      how: 'open',
      titleChars: 24,
      shape: [
        'h1:24',
        'p:182',
        'h2:18',
        'li.b.1:12',
        'li.n.2:7',
        'li.t.9:31',
        'quote:40',
        'code:640',
        'callout:22',
        'math:9',
        'raw:15',
        'table.4x3:96',
        'table.999x999:1000000',
        'image',
        'embed',
        'hr',
        'file',
        'drawing',
        'other',
        'p:0',
      ],
      more: true,
    },
  ],
  ['note', 'typing', { note: NOTE, block: 3, typed: 12, deleted: 2, remote: true }],
  ['note', 'blocks', { note: NOTE, block: 2, removed: 1, inserted: ['p:4', 'h2:9'], remote: true }],
  ['note', 'cursor', { note: NOTE, block: 5000 }],
  ['note', 'select', { note: NOTE, block: 0, chars: 1_000_000, span: 5000 }],
  ['tree', 'expand', { folder: FOLDER, depth: 0, source: 'click' }],
  ['tree', 'collapse', { folder: FOLDER, depth: 3, source: 'reveal' }],
  ['tree', 'open', { note: NOTE, folder: FOLDER, depth: 1, source: 'key' }],
  ['input', 'palette', { field: 'query', chars: 0 }],
  ['input', 'settingsSearch', { field: 'query', chars: 12 }],
  ['input', 'folderName', { field: 'name', chars: 1_000_000 }],
];

/** Also valid: the props a name takes in its other forms. */
const ALSO_VALID: ReadonlyArray<readonly [string, string, Record<string, unknown>]> = [
  ['note', 'open', { note: NOTE, how: 'resync', titleChars: 0, shape: [] }],
  ['note', 'typing', { note: NOTE, title: true, typed: 1, deleted: 0 }],
  ['note', 'typing', { note: NOTE, typed: 1_000_000, deleted: 0 }],
  ['note', 'cursor', { note: NOTE, title: true }],
  ['tree', 'open', { note: NOTE, depth: 0, source: 'click' }],
];

const ref = ['0123456789ABCDEF', '0123456789abcde', '0123456789abcdef0', 'zebracanary12345', 42];
const index = [-1, 5001, 1.5, '3', true, Number.NaN];
const chars = [-1, 1_000_001, 2.5, '12', false];
const longShape = Array.from({ length: 5001 }, () => 'hr');
const bigShape = Array.from({ length: Math.ceil(MAX_SHAPE_BYTES / 12) + 1 }, () => 'p:1000000');
const shape = [
  ['p:1a'],
  ['p'],
  ['hr:3'],
  ['h7:3'],
  ['li.x.1:3'],
  ['li.b.0:3'],
  ['li.b.10:3'],
  ['table.1000x1:3'],
  ['p:12345678'],
  ['p:1000001'],
  ['Plans for the week'],
  ['paragraph:3'],
  [3],
  'p:3',
  longShape,
  bigShape,
];

/** Values outside each prop's type. */
const INVALID: Readonly<Record<string, readonly unknown[]>> = {
  note: ref,
  folder: ref,
  how: ['reopen', 'Open', true],
  titleChars: chars,
  shape,
  inserted: shape,
  more: [false, 'true', 1],
  block: index,
  title: [false, 'true'],
  typed: chars,
  deleted: chars,
  remote: [false, 1],
  removed: index,
  span: index,
  chars,
  depth: index,
  source: ['palette', 'Click', 'menu'],
  field: ['search', 'Query', 'text'],
};

interface DetailEvent {
  readonly client: string;
  readonly kind: string;
  readonly name: string;
  readonly props: Record<string, unknown>;
}

function event(kind: string, name: string, props: Record<string, unknown>, client = 'mac') {
  return { ...BASE, client, kind, name, props };
}

/** Every case. */
export const DETAIL_CASES: ReadonlyArray<Record<string, unknown> & DetailEvent> = [
  ...VALID.map(([kind, name, props]) => event(kind, name, props)),
  ...ALSO_VALID.map(([kind, name, props]) => event(kind, name, props)),
  ...VALID.map(([kind, name, props]) => event(kind, name, props, 'android')),
  ...[...VALID, ...ALSO_VALID].flatMap(([kind, name, props]) =>
    Object.keys(props).flatMap((prop) =>
      (INVALID[prop] ?? []).map((value) => event(kind, name, { ...props, [prop]: value })),
    ),
  ),
  // A prop that isn't the name's own, even one its kind's other names take.
  event('note', 'cursor', { note: NOTE, block: 1, typed: 3 }),
  event('note', 'typing', { note: NOTE, block: 1, shape: ['p:1'] }),
  event('note', 'open', { note: NOTE, position: 0.4 }),
  event('tree', 'expand', { folder: FOLDER, note: NOTE }),
  event('input', 'palette', { field: 'query', text: 'hello' }),
  event('input', 'palette', { field: 'query', chars: 3, note: NOTE }),
  // A name outside the catalogue.
  event('note', 'close', { note: NOTE }),
  event('input', 'Plans for the week', { chars: 3 }),
  event('tree', 'rename', { folder: FOLDER }),
  // From the CLI and the MCP server: never.
  ...['cli', 'mcp'].flatMap((client) => [
    event('note', 'cursor', { note: NOTE, block: 1 }, client),
    event('input', 'search', { field: 'query', chars: 3 }, client),
    event('tree', 'expand', { folder: FOLDER, depth: 0, source: 'click' }, client),
  ]),
].map((each) =>
  each.client === 'cli' || each.client === 'mcp'
    ? (({ sizeClass: _size, ...rest }) => ({ ...rest, actor: 'agent' }))(each)
    : each,
);
