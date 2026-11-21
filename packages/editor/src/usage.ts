/**
 * Session detail from the note editor (PEN-177): the note's shape when it opens, typing bursts,
 * block splices, the cursor and the selection, by block position and length, never a character.
 * The same code runs in the Mac's page and Android's editor page; the host adds the note's and
 * its folder's refs (the Mac's main process, Android's Kotlin), and core's catalogue checks each
 * event (`@penmoss/core/analytics`, `detail.ts`).
 *
 * - `blockTokens(doc)` flattens a note into blocks in reading order: each list item is a block,
 *   and a quote, a callout and a table are one block each, whatever they hold. A block's length
 *   is its characters: each character of text, and each inline picture, link, formula or break,
 *   counts one. A paragraph holding only a picture, a drawing or an attachment is that block.
 * - A transaction whose steps only replace text inside one block is typing: its characters typed
 *   and deleted are added to that block's burst (core's TypingGate, at most one a second per
 *   block). Any other change (a split, a merge, a paste of blocks, a turn into, a move) flushes
 *   the bursts and records one splice, worked out by comparing the tokens before and after.
 * - A splice too large for one event (more than MAX_INDEX blocks, past the shape's caps, at a
 *   position over MAX_INDEX, or across the end of a capped shape) is sent as a fresh `note open`
 *   with `how: resync`; one wholly past a capped shape's end changes nothing a replay has.
 * - Changes the Yjs binding renders (sync, an agent, another window) are recorded the same way
 *   with `remote: true`, and never move the cursor or the selection.
 * - The cursor and a non-empty selection settle through core's SettleGate (300 ms, at most one
 *   a second, a repeat dropped); a cursor moved by typing is marked, not recorded.
 * - The shape is recorded once the note's content has loaded, never from the empty placeholder
 *   an editor shows before it: a note whose text arrives after the editor mounts (the Mac reads
 *   it from disk) waits for the first document that isn't the placeholder, and that change is
 *   the open, not a splice. A note that is really empty is recorded as the person first edits it
 *   (its open, then the edit), or as it closes.
 *
 * Only the blocks a keystroke touches are worked on: block counts are cached per node, and each
 * top-level block's tokens by node, so a 2,000-block note costs a keystroke well under 1 ms
 * (`usage.budget.test.ts`).
 */
import {
  blockToken,
  capShape,
  clampUsage,
  fitsShape,
  MAX_INDEX,
  SettleGate,
  textChange,
  tokenLength,
  TypingGate,
  withLength,
  type BlockInfo,
  type Props,
  type ScrollClock,
} from '@penmoss/core/analytics';
import type { Editor } from '@tiptap/core';
import type { Fragment, Node as PMNode, ResolvedPos } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { AddMarkStep, RemoveMarkStep, ReplaceStep } from '@tiptap/pm/transform';
import { isRemoteTransaction } from './collab/binding';
import { drawingOf } from './extensions/drawing';

const LISTS: Readonly<Record<string, 'b' | 'n' | 't'>> = {
  bulletList: 'b',
  orderedList: 'n',
  taskList: 't',
};

const isList = (node: PMNode) => Object.hasOwn(LISTS, node.type.name);

/** Characters in `node`: each of its text, and each inline leaf (a picture, a link, a break), one. */
function measure(node: PMNode): number {
  if (node.isText) return node.text?.length ?? 0;
  if (node.isInline && node.isLeaf) return 1;
  let total = 0;
  node.forEach((child) => {
    total += measure(child);
  });
  return total;
}

function measureFragment(fragment: Fragment): number {
  let total = 0;
  fragment.forEach((child) => {
    total += measure(child);
  });
  return total;
}

/** A list item's own characters: its children but nested lists, which are blocks of their own. */
function itemLength(item: PMNode): number {
  let total = 0;
  item.forEach((child) => {
    if (!isList(child)) total += measure(child);
  });
  return total;
}

/** The kind and size of a block that isn't a list item. */
function blockInfo(node: PMNode): BlockInfo {
  switch (node.type.name) {
    case 'paragraph': {
      if (node.childCount === 1) {
        const only = node.firstChild!;
        if (only.type.name === 'image') return { kind: drawingOf(only) ? 'drawing' : 'image' };
        if (only.type.name === 'attachment') return { kind: 'file' };
      }
      return { kind: 'p', chars: measure(node) };
    }
    case 'heading':
      return { kind: 'h', level: Number(node.attrs['level']) || 1, chars: measure(node) };
    case 'blockquote':
      return { kind: 'quote', chars: measure(node) };
    case 'callout':
      return { kind: 'callout', chars: measure(node) };
    case 'codeBlock':
      return { kind: 'code', chars: measure(node) };
    case 'rawMarkdown':
      return { kind: 'raw', chars: measure(node) };
    case 'blockMath':
      return { kind: 'math', chars: String(node.attrs['latex'] ?? '').length };
    case 'table': {
      let cols = 0;
      node.forEach((row) => {
        cols = Math.max(cols, row.childCount);
      });
      return { kind: 'table', rows: node.childCount, cols, chars: measure(node) };
    }
    case 'horizontalRule':
      return { kind: 'hr' };
    case 'embed':
      return { kind: 'embed' };
    default:
      return { kind: 'other' };
  }
}

function itemToken(item: PMNode, list: PMNode, depth: number): string {
  return blockToken({
    kind: 'li',
    list: LISTS[list.type.name] ?? 'b',
    depth,
    chars: itemLength(item),
  });
}

function pushList(list: PMNode, depth: number, out: string[]): void {
  list.forEach((item) => {
    out.push(itemToken(item, list, depth));
    item.forEach((child) => {
      if (isList(child)) pushList(child, depth + 1, out);
    });
  });
}

const topCache = new WeakMap<PMNode, readonly string[]>();

/** A top-level block's tokens: one, or a list's items in reading order. */
function topTokens(node: PMNode): readonly string[] {
  const cached = topCache.get(node);
  if (cached) return cached;
  let tokens: string[];
  if (isList(node)) {
    tokens = [];
    pushList(node, 1, tokens);
  } else {
    tokens = [blockToken(blockInfo(node))];
  }
  topCache.set(node, tokens);
  return tokens;
}

/** A note's blocks in reading order, as tokens (core's BLOCK_PATTERN). */
export function blockTokens(doc: PMNode): string[] {
  const tokens: string[] = [];
  doc.forEach((node) => {
    for (const token of topTokens(node)) tokens.push(token);
  });
  return tokens;
}

const countCache = new WeakMap<PMNode, number>();

/** How many blocks a list item is: itself and its nested lists' items. */
function itemCount(item: PMNode): number {
  const cached = countCache.get(item);
  if (cached !== undefined) return cached;
  let count = 1;
  item.forEach((child) => {
    if (isList(child)) count += listCount(child);
  });
  countCache.set(item, count);
  return count;
}

function listCount(list: PMNode): number {
  let count = 0;
  list.forEach((item) => {
    count += itemCount(item);
  });
  return count;
}

/** The block a position is in: its index, and the list item it is (null for a top-level block). */
interface BlockAt {
  readonly index: number;
  /** The top-level block's index in the note. */
  readonly top: number;
  /** For a list item: the item, its list and its depth. */
  readonly item: { readonly node: PMNode; readonly list: PMNode; readonly depth: number } | null;
}

function blockAt($pos: ResolvedPos, prefix: readonly number[]): BlockAt {
  const doc = $pos.doc;
  if (doc.childCount === 0) return { index: 0, top: 0, item: null };
  const top = Math.min($pos.index(0), doc.childCount - 1);
  let index = prefix[top] ?? 0;
  const node = doc.child(top);
  if ($pos.depth < 1 || !isList(node)) return { index, top, item: null };
  let list = node;
  let depth = 1;
  let level = 1;
  let item: BlockAt['item'] = null;
  for (;;) {
    if ($pos.depth < level) return { index, top, item };
    const at = $pos.index(level);
    for (let j = 0; j < at && j < list.childCount; j++) index += itemCount(list.child(j));
    if (at >= list.childCount) return { index, top, item };
    const child = list.child(at);
    item = { node: child, list, depth };
    if ($pos.depth < level + 1) return { index, top, item };
    const inner = $pos.index(level + 1);
    if (inner >= child.childCount || !isList(child.child(inner))) return { index, top, item };
    index += 1;
    for (let j = 0; j < inner; j++) {
      const sibling = child.child(j);
      if (isList(sibling)) index += listCount(sibling);
    }
    list = child.child(inner);
    depth += 1;
    level += 2;
  }
}

/** The prefix sums of each top-level block's count of blocks. */
function prefixOf(doc: PMNode): number[] {
  const prefix: number[] = [];
  let total = 0;
  doc.forEach((node) => {
    prefix.push(total);
    total += isList(node) ? listCount(node) : 1;
  });
  return prefix;
}

/** Whether a step only replaces text inside one block, and what it typed and deleted. */
function inlineChange(
  step: ReplaceStep,
  doc: PMNode,
): { readonly $from: ResolvedPos; readonly typed: number; readonly deleted: number } | null {
  const $from = doc.resolve(step.from);
  const $to = step.to === step.from ? $from : doc.resolve(step.to);
  if (!$from.sameParent($to) || !$from.parent.inlineContent) return null;
  const { slice } = step;
  const content = slice.content;
  let inserted: Fragment;
  if (slice.openStart === 0 && slice.openEnd === 0) {
    let inline = true;
    content.forEach((child) => {
      if (!child.isInline) inline = false;
    });
    if (!inline) return null;
    inserted = content;
  } else if (
    slice.openStart === 1 &&
    slice.openEnd === 1 &&
    content.childCount === 1 &&
    content.firstChild!.isTextblock
  ) {
    inserted = content.firstChild!.content;
  } else {
    return null;
  }
  const deleted = step.to > step.from ? measureFragment(doc.slice(step.from, step.to).content) : 0;
  return { $from, typed: measureFragment(inserted), deleted };
}

/** What the editor records; the host adds `note` and `folder` refs and sends it. */
export type NoteUsageRecord = (
  name: 'open' | 'typing' | 'blocks' | 'cursor' | 'select',
  props: Props,
) => void;

export interface NoteUsageOptions {
  readonly record: NoteUsageRecord;
  /** The note's title's length now (for `titleChars`). */
  readonly titleLength?: () => number;
  /** The gates' clock: the real one, or a test's. */
  readonly clock?: ScrollClock;
}

/** Where the cursor is: a block's position, or the title. */
type CursorAt = number | 'title';

interface Selected {
  readonly block: number;
  readonly chars: number;
  readonly span: number;
}

const sameSelection = (a: Selected, b: Selected) =>
  a.block === b.block && a.chars === b.chars && a.span === b.span;

/** Whether `doc` is the empty placeholder an editor shows before its note's content is in. */
function isPlaceholder(doc: PMNode): boolean {
  if (doc.childCount === 0) return true;
  if (doc.childCount > 1) return false;
  const only = doc.firstChild!;
  return only.type.name === 'paragraph' && only.content.size === 0;
}

/** A burst's key: `l` (this editor) or `r` (remote), then the block's position, `-` past the cap, or `t` the title. */
type BurstKey = string;

/** One note's session detail, attached to its editor while the note shows. */
export class NoteUsage {
  /** The note's blocks as this editor last recorded or knew them. */
  private tokens: string[] = [];
  /** How many blocks the replay holds: the shape last sent, then each splice. */
  private shown = 0;
  private prefix: number[] = [];
  private opened = false;
  /** `open()` was called on the empty placeholder: how the open is sent once the content is in. */
  private waiting: 'open' | 'switch' | null = null;
  private readonly typing: TypingGate<BurstKey>;
  private readonly cursor: SettleGate<CursorAt>;
  private readonly selection: SettleGate<Selected>;
  private readonly off: () => void;

  constructor(
    private readonly editor: Editor,
    private readonly options: NoteUsageOptions,
  ) {
    const clock = options.clock;
    this.typing = new TypingGate<BurstKey>((key, typed, deleted) => {
      const remote = key.startsWith('r');
      const at = key.slice(1);
      this.options.record('typing', {
        ...(at === 't' ? { title: true } : at === '-' ? {} : { block: Number(at) }),
        typed: clampUsage('chars', typed),
        deleted: clampUsage('chars', deleted),
        ...(remote ? { remote: true } : {}),
      });
    }, clock);
    this.cursor = new SettleGate<CursorAt>(
      (at) => this.emit('cursor', at === 'title' ? { title: true } : { block: at }),
      clock ? { clock } : {},
    );
    this.selection = new SettleGate<Selected>((selected) => this.emit('select', { ...selected }), {
      ...(clock ? { clock } : {}),
      equals: sameSelection,
    });
    const onTransaction = ({
      transaction,
      appendedTransactions,
    }: {
      transaction: Transaction;
      appendedTransactions?: Transaction[];
    }) => this.transactions([transaction, ...(appendedTransactions ?? [])]);
    const onBlur = () => this.typing.flush();
    editor.on('transaction', onTransaction);
    editor.on('blur', onBlur);
    this.off = () => {
      editor.off('transaction', onTransaction);
      editor.off('blur', onBlur);
    };
  }

  /** Records another note event, after any burst that waits. */
  private emit(name: 'open' | 'blocks' | 'cursor' | 'select', props: Props): void {
    this.typing.flush();
    this.options.record(name, props);
  }

  /** Records `note open` (the note shows: `open`, or its tab is switched to: `switch`). */
  open(how: 'open' | 'switch' = 'open'): void {
    this.typing.flush();
    this.cursor.reset();
    this.selection.reset();
    this.opened = true;
    const doc = this.editor.state.doc;
    if (isPlaceholder(doc)) {
      // Not loaded yet, or really empty: the first change, or the close, says which.
      this.waiting = how;
      this.tokens = blockTokens(doc);
      this.prefix = prefixOf(doc);
      this.shown = this.tokens.length;
      return;
    }
    this.waiting = null;
    this.sendShape(how);
  }

  /** Sends the open that waits for the note's content, of `doc` (the editor's now by default). */
  private sendWaiting(doc: PMNode = this.editor.state.doc, titleChars?: number): void {
    const how = this.waiting;
    if (!how) return;
    this.waiting = null;
    this.sendShape(how, doc, titleChars);
  }

  private sendShape(
    how: 'open' | 'switch' | 'resync',
    doc: PMNode = this.editor.state.doc,
    titleChars = this.options.titleLength?.() ?? 0,
  ): void {
    this.tokens = blockTokens(doc);
    this.prefix = prefixOf(doc);
    const { shape, more } = capShape(this.tokens);
    this.shown = shape.length;
    this.emit('open', {
      how,
      titleChars: clampUsage('chars', titleChars),
      shape,
      ...(more ? { more: true } : {}),
    });
  }

  /** The title changed from `before` to `after`, by typing here. */
  title(before: string, after: string): void {
    if (!this.opened) return;
    // An edit here: the note is shown as it is, empty or not, from before this change.
    this.sendWaiting(this.editor.state.doc, before.length);
    const { typed, deleted } = textChange(before, after);
    this.typing.add('lt', typed, deleted);
    this.cursor.mark('title');
  }

  /** The caret went into the title. */
  titleFocused(): void {
    if (this.opened && !this.waiting) this.cursor.moved('title');
  }

  /** Sends what waits now: the note is switched away from, closes, or the page hides. */
  flush(): void {
    this.typing.flush();
    this.cursor.flush();
    this.selection.flush();
  }

  /** Stops listening; what waits is sent first, an empty note's open too. */
  destroy(): void {
    this.sendWaiting();
    this.flush();
    this.cursor.stop();
    this.selection.stop();
    this.off();
  }

  private burstKey(remote: boolean, index: number): BurstKey {
    const past = index >= this.shown || index > MAX_INDEX;
    return `${remote ? 'r' : 'l'}${past ? '-' : index}`;
  }

  /** One dispatch's transactions, in order. */
  transactions(transactions: readonly Transaction[]): void {
    if (!this.opened) return;
    if (this.waiting) {
      const first = transactions.find((tr) => tr.docChanged);
      // Only the caret moved in the placeholder: nothing to record until there is a note.
      if (!first) return;
      if (isRemoteTransaction(first)) {
        // The note's content arrived (from disk, sync or another window): that is its open.
        if (!isPlaceholder(this.editor.state.doc)) this.sendWaiting();
        return;
      }
      // The person edits a note that is really empty: its open, then the edit.
      this.sendWaiting(first.before);
    }
    let docChanged = false;
    let local = false;
    for (const tr of transactions) {
      const remote = isRemoteTransaction(tr);
      if (!remote) local = true;
      if (!tr.docChanged) continue;
      docChanged = true;
      this.change(tr, remote);
    }
    if (!local) return;
    this.selected(this.editor.state, docChanged);
  }

  private change(tr: Transaction, remote: boolean): void {
    const bursts = new Map<number, { typed: number; deleted: number; at: number }>();
    let inline = true;
    for (let i = 0; i < tr.steps.length && inline; i++) {
      const step = tr.steps[i]!;
      const doc = tr.docs[i]!;
      if (!(step instanceof ReplaceStep)) {
        // A mark added or removed changes no block or length; anything else is structure.
        if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) continue;
        inline = false;
        break;
      }
      const change = inlineChange(step, doc);
      if (!change) {
        inline = false;
        break;
      }
      const at = blockAt(change.$from, this.prefix);
      const burst = bursts.get(at.index) ?? { typed: 0, deleted: 0, at: at.top };
      burst.typed += change.typed;
      burst.deleted += change.deleted;
      bursts.set(at.index, burst);
    }
    if (inline) {
      // A top-level paragraph can turn into a picture, or out of one, by typing: then it is structure.
      for (const [index, burst] of bursts) {
        const token = this.tokens[index];
        const length = token === undefined ? null : tokenLength(token);
        if (length === null) {
          inline = false;
          break;
        }
        const node = tr.doc.maybeChild(burst.at);
        if (node?.type.name === 'paragraph') {
          const fresh = blockToken(blockInfo(node));
          if (fresh !== withLength(token!, length + burst.typed - burst.deleted)) {
            inline = false;
            break;
          }
        }
      }
    }
    if (!inline) {
      this.splice(tr.doc, remote);
      return;
    }
    for (const [index, burst] of bursts) {
      const token = this.tokens[index]!;
      this.tokens[index] = withLength(token, tokenLength(token)! + burst.typed - burst.deleted);
      this.typing.add(this.burstKey(remote, index), burst.typed, burst.deleted);
    }
  }

  /** Which blocks there are changed: one splice, or a resync. */
  private splice(doc: PMNode, remote: boolean): void {
    const before = this.tokens;
    const after = blockTokens(doc);
    this.prefix = prefixOf(doc);
    const max = Math.min(before.length, after.length);
    let start = 0;
    while (start < max && before[start] === after[start]) start += 1;
    let end = 0;
    while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) {
      end += 1;
    }
    this.tokens = after;
    const removed = before.length - start - end;
    const inserted = after.slice(start, after.length - end);
    if (removed === 0 && inserted.length === 0) return;
    // Wholly past what a capped shape holds: nothing the replay has changes.
    if (this.shown < before.length && start >= this.shown) return;
    if (
      start > MAX_INDEX ||
      removed > MAX_INDEX ||
      start + removed > this.shown ||
      !fitsShape(inserted)
    ) {
      this.sendShape('resync');
      return;
    }
    this.shown += inserted.length - removed;
    this.emit('blocks', {
      block: start,
      removed,
      inserted,
      ...(remote ? { remote: true } : {}),
    });
  }

  private selected(state: EditorState, docChanged: boolean): void {
    const { selection, doc } = state;
    const from = blockAt(doc.resolve(selection.from), this.prefix).index;
    if (selection.empty) {
      if (docChanged) this.cursor.mark(from);
      else if (from <= MAX_INDEX) this.cursor.moved(from);
      return;
    }
    if (docChanged || from > MAX_INDEX) return;
    const to = blockAt(doc.resolve(selection.to), this.prefix).index;
    this.selection.moved({
      block: from,
      chars: clampUsage('chars', measureFragment(doc.slice(selection.from, selection.to).content)),
      span: clampUsage('index', to - from + 1),
    });
  }
}

/** Starts recording `editor`'s session detail; call `open()` once the note shows. */
export function attachNoteUsage(editor: Editor, options: NoteUsageOptions): NoteUsage {
  return new NoteUsage(editor, options);
}
