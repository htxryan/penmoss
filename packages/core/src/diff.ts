/**
 * Line diffs and three-way merges of markdown (T21): the history panel's
 * "what this version changed" and reverting an agent's edit (A3), which runs
 * in the NoteDoc. No dependencies, no DOM.
 *
 * `diffLines` is Myers' O((N+M)·D) algorithm after the common prefix and
 * suffix are trimmed, so an edit to a long note costs little.
 */

export type DiffOp =
  | { readonly op: 'same'; readonly line: string }
  | { readonly op: 'add'; readonly line: string }
  | { readonly op: 'del'; readonly line: string };

/** A change to `base`: lines `start` to `end` (exclusive) replaced by `lines`. */
export interface Hunk {
  readonly start: number;
  readonly end: number;
  readonly lines: readonly string[];
}

/** The shortest edit script from `a` to `b`, as kept, deleted and added lines in order. */
export function diffLines(a: readonly string[], b: readonly string[]): DiffOp[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const out: DiffOp[] = a.slice(0, prefix).map((line) => ({ op: 'same', line }));
  out.push(...myers(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix)));
  for (const line of a.slice(a.length - suffix)) out.push({ op: 'same', line });
  return out;
}

function myers(a: readonly string[], b: readonly string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((line) => ({ op: 'add', line }));
  if (m === 0) return a.map((line) => ({ op: 'del', line }));
  const max = n + m;
  const offset = max + 1;
  let v: Int32Array = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  trace.push(v);
  // Walk back through the saved frontiers.
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0; d--) {
    v = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : v[offset + prevK]!;
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ op: 'same', line: a[--x]! });
      y--;
    }
    if (d === 0) break;
    if (x === prevX) ops.push({ op: 'add', line: b[--y]! });
    else ops.push({ op: 'del', line: a[--x]! });
  }
  while (x > 0 && y > 0) {
    ops.push({ op: 'same', line: a[--x]! });
    y--;
  }
  return ops.reverse();
}

/** The changes that turn `base` into `other`, as hunks in base order. */
export function hunks(base: readonly string[], other: readonly string[]): Hunk[] {
  const out: Hunk[] = [];
  let index = 0;
  let open: { start: number; end: number; lines: string[] } | null = null;
  for (const op of diffLines(base, other)) {
    if (op.op === 'same') {
      if (open) out.push(open);
      open = null;
      index++;
      continue;
    }
    open ??= { start: index, end: index, lines: [] };
    if (op.op === 'del') {
      open.end++;
      index++;
    } else open.lines.push(op.line);
  }
  if (open) out.push(open);
  return out;
}

/** A region both sides changed differently; the merge kept `ours`. */
export interface MergeConflict {
  /** The first line of the region in the merged text (0-based). */
  readonly at: number;
  readonly base: readonly string[];
  readonly ours: readonly string[];
  readonly theirs: readonly string[];
}

export interface MergeResult {
  readonly lines: string[];
  readonly conflicts: MergeConflict[];
}

/** `base[start, end)` with the given hunks (all inside that range) applied. */
function applyHunks(
  base: readonly string[],
  start: number,
  end: number,
  changes: readonly Hunk[],
): string[] {
  const out: string[] = [];
  let at = start;
  for (const hunk of changes) {
    out.push(...base.slice(at, hunk.start), ...hunk.lines);
    at = hunk.end;
  }
  out.push(...base.slice(at, end));
  return out;
}

/**
 * A three-way merge: the changes from `base` to `ours` and from `base` to
 * `theirs`, both applied. Where they touch the same lines (or insert at the
 * same place) and differ, `ours` is kept and the region is reported as a
 * conflict; identical changes on both sides are taken once.
 */
export function merge3(
  base: readonly string[],
  ours: readonly string[],
  theirs: readonly string[],
): MergeResult {
  const tagged = [
    ...hunks(base, ours).map((hunk) => ({ hunk, side: 'ours' as const })),
    ...hunks(base, theirs).map((hunk) => ({ hunk, side: 'theirs' as const })),
  ].sort((p, q) => p.hunk.start - q.hunk.start || (p.side === 'ours' ? -1 : 1));

  const lines: string[] = [];
  const conflicts: MergeConflict[] = [];
  let at = 0;
  let i = 0;
  while (i < tagged.length) {
    const first = tagged[i]!.hunk;
    let start = first.start;
    let end = first.end;
    const group = [tagged[i]!];
    i++;
    while (i < tagged.length) {
      const next = tagged[i]!.hunk;
      if (!(next.start < end || next.start === start)) break;
      group.push(tagged[i]!);
      end = Math.max(end, next.end);
      start = Math.min(start, next.start);
      i++;
    }
    lines.push(...base.slice(at, start));
    const mine = group.filter((entry) => entry.side === 'ours').map((entry) => entry.hunk);
    const other = group.filter((entry) => entry.side === 'theirs').map((entry) => entry.hunk);
    const oursText = applyHunks(base, start, end, mine);
    const theirsText = applyHunks(base, start, end, other);
    if (other.length === 0) lines.push(...oursText);
    else if (mine.length === 0) lines.push(...theirsText);
    else if (oursText.join('\n') === theirsText.join('\n')) lines.push(...oursText);
    else {
      conflicts.push({
        at: lines.length,
        base: base.slice(start, end),
        ours: oursText,
        theirs: theirsText,
      });
      lines.push(...oursText);
    }
    at = end;
  }
  lines.push(...base.slice(at));
  return { lines, conflicts };
}

/** Lines of a text (a trailing newline does not make an empty last line). */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * `+3 −1 lines`: how two versions' markdown differ, for a summary (A177).
 * It counts the body's lines of text, so a paragraph appended is one line
 * (not two with the blank line before it) and a five-line note is five
 * lines, whatever its frontmatter. When only the frontmatter differs it
 * says what: `Title changed`, `Tags changed` or both.
 */
export function summarise(before: string, after: string): string {
  const was = versionParts(before);
  const now = versionParts(after);
  let added = 0;
  let removed = 0;
  for (const op of diffLines(was.body, now.body)) {
    if (op.op === 'add') added++;
    else if (op.op === 'del') removed++;
  }
  if (added > 0 || removed > 0) {
    return `+${added} −${removed} ${added + removed === 1 ? 'line' : 'lines'}`;
  }
  const title = was.title !== now.title;
  const tags = was.tags !== now.tags;
  if (title && tags) return 'Title and tags changed';
  if (title) return 'Title changed';
  if (tags) return 'Tags changed';
  return 'No text changes';
}

/** A version's markdown as its title and tags lines and its body's non-blank lines. */
function versionParts(markdown: string): { title: string; tags: string; body: string[] } {
  const lines = splitLines(markdown);
  let start = 0;
  const title: string[] = [];
  const tags: string[] = [];
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) {
      for (const line of lines.slice(1, end)) (line.startsWith('title:') ? title : tags).push(line);
      start = end + 1;
    }
  }
  return {
    title: title.join('\n'),
    tags: tags.join('\n'),
    body: lines.slice(start).filter((line) => line.trim() !== ''),
  };
}
