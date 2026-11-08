// Consistency checker: compares what the tester typed against the expected
// test paragraph and reports lost, extra and duplicated characters.

import type { Editor } from '@tiptap/core';
import { logMark } from './ime-log';

/** The paragraph the tester types during each keyboard session. Shown in the protocol. */
export const TEST_PARAGRAPH =
  "The quick brown fox jumps over the lazy dog while Ryan's kettle boils. " +
  'On Tuesday at 7:45 we packed 3 boxes, 12 books and a lamp; nothing broke! ' +
  'Is this editor really fast enough for long writing on a phone? ' +
  "Let's find out, one sentence at a time, without fixing anything by hand.";

export type DiffOp = { op: 'equal' | 'lost' | 'extra' | 'duplicated'; text: string };

export interface CheckResult {
  label: string;
  checkedAt: string;
  expectedLength: number;
  actualLength: number;
  lost: number;
  extra: number;
  duplicated: number;
  exact: boolean;
  actual: string;
  ops: DiffOp[];
}

/** NBSP (Chromium writes it for trailing spaces in contenteditable) counts as a space. */
export function normalize(text: string): string {
  return text.replace(/ /g, ' ').trim();
}

/** Character-level LCS diff of `expected` → `actual`. Extra runs that repeat the text just before them are marked duplicated. */
export function diffChars(expected: string, actual: string): DiffOp[] {
  const a = expected.slice(0, 4000);
  const b = actual.slice(0, 4000);
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const lcs = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  const add = (op: DiffOp['op'], ch: string) => {
    const last = ops[ops.length - 1];
    if (last && last.op === op) last.text += ch;
    else ops.push({ op, text: ch });
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      add('equal', a[i]!);
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i * width + j + 1]! >= lcs[(i + 1) * width + j]!)) {
      add('extra', b[j]!);
      j++;
    } else {
      add('lost', a[i]!);
      i++;
    }
  }
  // Classify extra runs that duplicate the preceding actual text ("thethe", "boxes,,").
  let produced = '';
  for (const op of ops) {
    if (op.op === 'extra' && produced.endsWith(op.text)) op.op = 'duplicated';
    if (op.op !== 'lost') produced += op.text;
  }
  return ops;
}

export function compare(label: string, expected: string, actualRaw: string): CheckResult {
  const exp = normalize(expected);
  const actual = normalize(actualRaw);
  const ops = diffChars(exp, actual);
  const count = (op: DiffOp['op']) =>
    ops.filter((o) => o.op === op).reduce((sum, o) => sum + o.text.length, 0);
  const lost = count('lost');
  const extra = count('extra');
  const duplicated = count('duplicated');
  return {
    label,
    checkedAt: new Date().toISOString(),
    expectedLength: exp.length,
    actualLength: actual.length,
    lost,
    extra,
    duplicated,
    exact: lost + extra + duplicated === 0,
    actual,
    ops,
  };
}

/** Tracks one typing test: a heading plus an empty paragraph appended to the note. */
export class TypingTest {
  private start: number | null = null;
  private label = '';
  private runs = 0;
  readonly results: CheckResult[] = [];

  constructor(private readonly editor: Editor) {
    editor.on('transaction', ({ transaction }) => {
      if (this.start !== null && transaction.docChanged) {
        this.start = transaction.mapping.map(this.start, -1);
      }
    });
  }

  get active(): boolean {
    return this.start !== null;
  }

  /** Append "Typing test N · label" and an empty paragraph, then put the caret there. */
  begin(label: string): void {
    this.runs++;
    this.label = label || `run ${this.runs}`;
    const { editor } = this;
    const end = editor.state.doc.content.size;
    editor
      .chain()
      .insertContentAt(end, [
        {
          type: 'heading',
          attrs: { level: 3 },
          content: [{ type: 'text', text: `Typing test ${this.runs} · ${this.label}` }],
        },
        { type: 'paragraph' },
      ])
      .run();
    // The empty paragraph is the last block before the trailing node (if any); find it.
    const doc = editor.state.doc;
    let paragraphStart = doc.content.size - 1;
    doc.forEach((node, offset) => {
      if (
        node.type.name === 'heading' &&
        node.textContent.startsWith(`Typing test ${this.runs} `)
      ) {
        paragraphStart = offset + node.nodeSize + 1;
      }
    });
    this.start = paragraphStart;
    editor.chain().focus(paragraphStart).scrollIntoView().run();
    // TipTap defers view.focus() to the next animation frame; focus now so the
    // first keystrokes after begin() (e.g. from the instrumentation test) land.
    editor.view.focus();
    logMark(`test-start ${this.label}`);
  }

  /** Text typed since begin(), blocks joined by newlines. */
  text(): string {
    if (this.start === null) return '';
    const doc = this.editor.state.doc;
    return doc.textBetween(this.start, doc.content.size, '\n', '￼');
  }

  /** ProseMirror JSON of the blocks typed since begin(). */
  json(): unknown {
    if (this.start === null) return [];
    const doc = this.editor.state.doc;
    return doc.slice(Math.max(0, this.start - 1), doc.content.size).content.toJSON();
  }

  check(expected = TEST_PARAGRAPH): CheckResult | null {
    if (this.start === null) return null;
    const result = compare(this.label, expected, this.text());
    this.results.push(result);
    logMark(
      `test-check ${this.label} lost=${result.lost} extra=${result.extra} dup=${result.duplicated}`,
    );
    return result;
  }
}

export function summarize(result: CheckResult): string {
  if (result.exact) return `${result.label}: exact match (${result.actualLength} chars).`;
  return `${result.label}: ${result.lost} lost, ${result.duplicated} duplicated, ${result.extra} other extra characters (expected ${result.expectedLength}, got ${result.actualLength}).`;
}
