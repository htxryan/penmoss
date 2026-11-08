/**
 * Where transactions changed a document, so plugins can revisit only those
 * nodes instead of walking the whole document on every keystroke.
 */
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { AttrStep } from '@tiptap/pm/transform';

/**
 * Ranges of the final document that `transactions` (applied in order) changed,
 * sorted and merged. One forward pass: each step maps the ranges found so far,
 * then adds its own, so a transaction of many steps (a paste, a long run of
 * typed text) stays cheap. (`Mapping.slice` cannot be used to map through only
 * the later steps: `appendMapping` ignores a slice's bounds.)
 */
export function changedRanges(transactions: readonly Transaction[]): [number, number][] {
  let ranges: [number, number][] = [];
  for (const tr of transactions) {
    tr.steps.forEach((step, index) => {
      const map = tr.mapping.maps[index] ?? step.getMap();
      ranges = ranges.map(([from, to]) => [map.map(from, -1), map.map(to, 1)]);
      // Attribute steps (a language or type change) have an empty step map.
      if (step instanceof AttrStep) addRange(ranges, step.pos, step.pos + 1);
      else map.forEach((_oldStart, _oldEnd, from, to) => addRange(ranges, from, to));
    });
  }
  return ranges;
}

/** Inserts `[from, to]` into sorted, disjoint `ranges`, merging what it touches. */
function addRange(ranges: [number, number][], from: number, to: number): void {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (ranges[mid]![1] < from) low = mid + 1;
    else high = mid;
  }
  let end = low;
  while (end < ranges.length && ranges[end]![0] <= to) {
    from = Math.min(from, ranges[end]![0]);
    to = Math.max(to, ranges[end]![1]);
    end += 1;
  }
  ranges.splice(low, end - low, [from, to]);
}

/**
 * The outermost nodes matching `match` that overlap a changed range (a change
 * inside a table cell finds the table), keyed by position.
 */
export function changedNodes(
  doc: PMNode,
  transactions: readonly Transaction[],
  match: (node: PMNode) => boolean,
): Map<number, PMNode> {
  const found = new Map<number, PMNode>();
  const size = doc.content.size;
  for (const [from, to] of changedRanges(transactions)) {
    const a = Math.max(0, Math.min(from, size));
    const b = Math.min(size, Math.max(to, a + 1));
    if (a >= b) continue;
    doc.nodesBetween(a, b, (node, pos) => {
      if (match(node)) {
        found.set(pos, node);
        return false;
      }
      return !node.isTextblock;
    });
  }
  return found;
}
