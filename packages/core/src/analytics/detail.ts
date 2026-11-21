/**
 * Session detail (PEN-177): what the `note`, `input` and `tree` kinds record, in the standard
 * Share Usage Data set, so a session can be replayed without a word of it being recorded.
 *
 * - A note's shape: its blocks in reading order, each a token naming its kind and, for a block
 *   with text, its length in characters (`p:182`, `h2:18`, `li.t.2:31`, `table.4x3:96`, `hr`).
 *   BLOCK_PATTERN is the whole grammar, so no word can pass it.
 * - Typing: characters typed and deleted per block, about once a second (TypingGate), and every
 *   change to which blocks there are as one splice (`note blocks`).
 * - Lengths and counts are exact (O1) and held to their types by `clampUsage`, so a real note
 *   never makes an event the validator refuses.
 * - Notes and folders are named by a ref: 16 hex characters of a keyed hash of their real id,
 *   made only where the key is (the Mac's main process, Android's Kotlin; `node/ref-key.ts`).
 *
 * `replayShape` applies a session's note events to its opening shape: the test oracle, and what
 * the dashboard's replay will call. Kotlin's twins (clampUsage, the props line) are pinned by
 * `apps/android/contract/analytics-v1.json`.
 */
import { SCROLL_MIN_GAP_MS, realScrollClock, type ScrollClock } from './scroll';
import type { PropValue, Props } from './events';

/** The most a block index, a count of blocks, a list's or folder's depth may be. */
export const MAX_INDEX = 5000;
/** The most a length or a count of characters may be (a huge paste is recorded as this). */
export const MAX_CHARS = 1_000_000;
/** A shape holds at most this many tokens… */
export const MAX_SHAPE_TOKENS = 5000;
/** …and at most this many bytes as JSON (quotes, commas and brackets counted). */
export const MAX_SHAPE_BYTES = 32 * 1024;
/** A table's rows or columns over this are recorded as this. */
export const MAX_TABLE_SIDE = 999;
/** A list deeper than this is recorded at this depth. */
export const MAX_LIST_DEPTH = 9;

/** A note's or folder's ref: the first 16 hex characters of HMAC-SHA256 (`node/ref-key.ts`). */
export const REF_PATTERN = /^[0-9a-f]{16}$/;

/**
 * A block's token. Paragraph `p`, heading `h1`–`h6`, list item `li.<b|n|t>.<depth>` (bulleted,
 * numbered, checklist), `quote`, `code`, `callout`, `math`, `raw` and `table.<rows>x<cols>`, each
 * with `:<length>`; then `image`, `embed`, `hr` (a divider), `file` (an attachment), `drawing`
 * and `other`, which have no length.
 */
export const BLOCK_PATTERN =
  /^(?:(?:p|h[1-6]|li\.[bnt]\.[1-9]|quote|code|callout|math|raw|table\.\d{1,3}x\d{1,3}):\d{1,7}|image|embed|hr|file|drawing|other)$/;

/** The kinds of a block, as a token starts. */
export type BlockKind =
  | 'p'
  | 'h'
  | 'li'
  | 'quote'
  | 'code'
  | 'callout'
  | 'math'
  | 'raw'
  | 'table'
  | 'image'
  | 'embed'
  | 'hr'
  | 'file'
  | 'drawing'
  | 'other';

/** What a token is made from. */
export interface BlockInfo {
  readonly kind: BlockKind;
  /** A heading's level, 1–6. */
  readonly level?: number;
  /** A list item's list: bulleted, numbered or checklist. */
  readonly list?: 'b' | 'n' | 't';
  /** A list item's depth, from 1. */
  readonly depth?: number;
  readonly rows?: number;
  readonly cols?: number;
  /** Its length in characters (kinds with text). */
  readonly chars?: number;
}

/**
 * What each clamped value is: `chars` (a length, typed, deleted or selected), `index` (a block's
 * position, a count of blocks, a depth in the tree, a selection's span), `side` (a table's rows
 * or columns), `depth` (a list item's).
 */
export type ClampType = 'chars' | 'index' | 'side' | 'depth';

const CLAMP: Readonly<Record<ClampType, readonly [number, number]>> = {
  chars: [0, MAX_CHARS],
  index: [0, MAX_INDEX],
  side: [1, MAX_TABLE_SIDE],
  depth: [1, MAX_LIST_DEPTH],
};

/** `value` held to its type's range, as a whole number (one rule, with a Kotlin twin). */
export function clampUsage(type: ClampType, value: number): number {
  const [min, max] = CLAMP[type];
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

const LENGTHLESS: ReadonlySet<BlockKind> = new Set([
  'image',
  'embed',
  'hr',
  'file',
  'drawing',
  'other',
]);

/** A block's token, its numbers clamped (`clampUsage`). */
export function blockToken(block: BlockInfo): string {
  if (LENGTHLESS.has(block.kind)) return block.kind;
  const chars = `:${clampUsage('chars', block.chars ?? 0)}`;
  switch (block.kind) {
    case 'h':
      return `h${Math.min(6, Math.max(1, Math.trunc(block.level ?? 1)))}${chars}`;
    case 'li':
      return `li.${block.list ?? 'b'}.${clampUsage('depth', block.depth ?? 1)}${chars}`;
    case 'table':
      return `table.${clampUsage('side', block.rows ?? 1)}x${clampUsage('side', block.cols ?? 1)}${chars}`;
    default:
      return `${block.kind}${chars}`;
  }
}

/** A token's length, or null for a kind without one. */
export function tokenLength(token: string): number | null {
  const colon = token.lastIndexOf(':');
  return colon < 0 ? null : Number(token.slice(colon + 1));
}

/** `token` with its length changed by `delta`, clamped; a token without a length is unchanged. */
export function withLength(token: string, length: number): string {
  const colon = token.lastIndexOf(':');
  return colon < 0 ? token : `${token.slice(0, colon)}:${clampUsage('chars', length)}`;
}

/** How many bytes `tokens` take as JSON: `["p:1","hr"]` (all ASCII). */
export function shapeBytes(tokens: readonly string[]): number {
  let bytes = 2 + Math.max(0, tokens.length - 1);
  for (const token of tokens) bytes += token.length + 2;
  return bytes;
}

/** The tokens a shape prop holds: as many from the start as fit both caps, and whether any are left out. */
export function capShape(tokens: readonly string[]): {
  readonly shape: string[];
  readonly more: boolean;
} {
  let bytes = 2;
  let count = 0;
  for (const token of tokens) {
    if (count === MAX_SHAPE_TOKENS) break;
    const next = bytes + token.length + 2 + (count > 0 ? 1 : 0);
    if (next > MAX_SHAPE_BYTES) break;
    bytes = next;
    count += 1;
  }
  return { shape: tokens.slice(0, count), more: count < tokens.length };
}

/** Whether `tokens` fit a shape prop whole. */
export function fitsShape(tokens: readonly string[]): boolean {
  return tokens.length <= MAX_SHAPE_TOKENS && shapeBytes(tokens) <= MAX_SHAPE_BYTES;
}

/** A shape prop's value: a list of tokens within both caps, each matching BLOCK_PATTERN. */
export function isShape(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > MAX_SHAPE_TOKENS) return false;
  let bytes = 2 + Math.max(0, value.length - 1);
  for (const token of value) {
    if (typeof token !== 'string' || !BLOCK_PATTERN.test(token)) return false;
    const length = tokenLength(token);
    if (length !== null && length > MAX_CHARS) return false;
    bytes += token.length + 2;
  }
  return bytes <= MAX_SHAPE_BYTES;
}

/** The least time between two bursts for one block. */
export const TYPING_GAP_MS = SCROLL_MIN_GAP_MS;

/**
 * Typing bursts (PEN-177): it adds up the characters typed and deleted in each block, and emits
 * at most once every TYPING_GAP_MS per block, the first change opening the second. A second with
 * no change emits nothing. A replacement counts both: selecting 5 characters and typing 1 is
 * typed 1, deleted 5. `flush()` emits every pending burst at once, oldest first (before a
 * splice, a note switch, blur or page hide); `stop()` drops them. Pure, on an injected clock.
 */
export class TypingGate<K> {
  private readonly pending = new Map<
    K,
    { typed: number; deleted: number; timer: unknown; key: K }
  >();

  constructor(
    private readonly emit: (key: K, typed: number, deleted: number) => void,
    private readonly clock: ScrollClock = realScrollClock,
    private readonly gapMs = TYPING_GAP_MS,
  ) {}

  /** `typed` characters added and `deleted` removed in `key`'s block. */
  add(key: K, typed: number, deleted: number): void {
    if (typed <= 0 && deleted <= 0) return;
    const burst = this.pending.get(key);
    if (burst) {
      burst.typed += Math.max(0, typed);
      burst.deleted += Math.max(0, deleted);
      return;
    }
    const next = {
      typed: Math.max(0, typed),
      deleted: Math.max(0, deleted),
      timer: null as unknown,
      key,
    };
    next.timer = this.clock.set(() => this.send(key), this.gapMs);
    this.pending.set(key, next);
  }

  /** Whether a burst waits. */
  get waiting(): boolean {
    return this.pending.size > 0;
  }

  /** Emits every burst now, in the order each began. */
  flush(): void {
    for (const key of [...this.pending.keys()]) this.send(key);
  }

  /** Drops what waits. */
  stop(): void {
    for (const burst of this.pending.values()) this.clock.clear(burst.timer);
    this.pending.clear();
  }

  private send(key: K): void {
    const burst = this.pending.get(key);
    if (!burst) return;
    this.clock.clear(burst.timer);
    this.pending.delete(key);
    this.emit(key, burst.typed, burst.deleted);
  }
}

/** A note event as `replayShape` reads it. */
export interface NoteEventLike {
  readonly kind?: string;
  readonly name: string;
  readonly props: Props;
}

const numberProp = (props: Props, key: string): number | null => {
  const value: PropValue | undefined = props[key];
  return typeof value === 'number' ? value : null;
};

const listProp = (props: Props, key: string): readonly string[] => {
  const value: PropValue | undefined = props[key];
  return Array.isArray(value) ? (value as readonly string[]) : [];
};

/**
 * A note's shape after a session's events: `open`'s shape, then each `note typing` (a block's
 * length changes by typed − deleted) and `note blocks` (`shape.splice(block, removed,
 * ...inserted)`), in order. A `note open` with `how: resync` starts it again. Events of another
 * note (another `note` ref than `open`'s, when both have one) and other kinds are skipped, and so
 * is typing in the title or past the shape's cap (no `block`).
 */
export function replayShape(open: Props, events: readonly NoteEventLike[]): string[] {
  const note = open['note'];
  let shape = [...listProp(open, 'shape')];
  for (const event of events) {
    if (event.kind !== undefined && event.kind !== 'note') continue;
    const props = event.props;
    if (note !== undefined && props['note'] !== undefined && props['note'] !== note) continue;
    if (event.name === 'open' && props['how'] === 'resync') {
      shape = [...listProp(props, 'shape')];
    } else if (event.name === 'typing') {
      const block = numberProp(props, 'block');
      if (block === null || block >= shape.length) continue;
      const token = shape[block]!;
      const length = tokenLength(token);
      if (length === null) continue;
      shape[block] = withLength(
        token,
        length + (numberProp(props, 'typed') ?? 0) - (numberProp(props, 'deleted') ?? 0),
      );
    } else if (event.name === 'blocks') {
      const block = numberProp(props, 'block') ?? 0;
      shape.splice(block, numberProp(props, 'removed') ?? 0, ...listProp(props, 'inserted'));
    }
  }
  return shape;
}

/** The fields a dialog's text field is, for `input <dialog>`. */
export const INPUT_FIELDS = ['query', 'name', 'title', 'body', 'url', 'other'] as const;
export type InputField = (typeof INPUT_FIELDS)[number];

/** How long typing in a field must pause before its length is recorded. */
export const INPUT_SETTLE_MS = 500;

/**
 * The characters typed and deleted between two values of a text (a title field): what differs
 * between their common start and end.
 */
export function textChange(before: string, after: string): { typed: number; deleted: number } {
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;
  let end = 0;
  while (
    end < max - start &&
    before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)
  ) {
    end += 1;
  }
  return { typed: after.length - start - end, deleted: before.length - start - end };
}
