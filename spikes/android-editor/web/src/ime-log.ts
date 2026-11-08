// In-memory IME diagnostics log: raw DOM input events plus the ProseMirror
// transactions they produced, so a lost or duplicated character can be traced
// back to the keyboard event sequence that caused it.

import type { Editor } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';

const MAX_ENTRIES = 50_000;

export interface LogEntry {
  /** ms since navigation start */
  t: number;
  ev: string;
  inputType?: string;
  data?: string | null;
  isComposing?: boolean;
  key?: string;
  keyCode?: number;
  /** ProseMirror selection [from, to] when the event fired */
  sel?: [number, number];
  /** Transaction steps: [from, to, inserted text] */
  steps?: [number, number, string][];
  note?: string;
}

const entries: LogEntry[] = [];
let dropped = 0;

function now() {
  return Math.round(performance.now() * 10) / 10;
}

export function logEntry(entry: Omit<LogEntry, 't'>): void {
  entries.push({ t: now(), ...entry });
  if (entries.length > MAX_ENTRIES) {
    entries.shift();
    dropped++;
  }
}

export function logMark(note: string): void {
  logEntry({ ev: 'mark', note });
}

export function attachImeLog(editor: Editor): void {
  const dom = editor.view.dom;
  const sel = (): [number, number] => {
    const { from, to } = editor.state.selection;
    return [from, to];
  };

  dom.addEventListener(
    'beforeinput',
    (e) => {
      const ev = e;
      logEntry({
        ev: 'beforeinput',
        inputType: ev.inputType,
        data: ev.data,
        isComposing: ev.isComposing,
        sel: sel(),
      });
    },
    { capture: true },
  );
  dom.addEventListener(
    'input',
    (e) => {
      const ev = e as InputEvent;
      logEntry({
        ev: 'input',
        inputType: ev.inputType,
        data: ev.data,
        isComposing: ev.isComposing,
        sel: sel(),
      });
    },
    { capture: true },
  );
  for (const type of ['compositionstart', 'compositionupdate', 'compositionend'] as const) {
    dom.addEventListener(type, (e) => logEntry({ ev: type, data: e.data, sel: sel() }), {
      capture: true,
    });
  }
  for (const type of ['keydown', 'keyup'] as const) {
    dom.addEventListener(
      type,
      (e) =>
        logEntry({
          ev: type,
          key: e.key,
          keyCode: e.keyCode,
          isComposing: e.isComposing,
          sel: sel(),
        }),
      { capture: true },
    );
  }

  editor.on('transaction', ({ transaction }: { transaction: Transaction }) => {
    if (!transaction.docChanged) return;
    const steps: [number, number, string][] = [];
    for (const step of transaction.steps) {
      const json = step.toJSON() as { from?: number; to?: number };
      const slice = (
        step as unknown as {
          slice?: {
            content: {
              textBetween(a: number, b: number, s: string, l: string): string;
              size: number;
            };
          };
        }
      ).slice;
      const text = slice ? slice.content.textBetween(0, slice.content.size, '⏎', '□') : '';
      steps.push([json.from ?? -1, json.to ?? -1, text]);
    }
    logEntry({ ev: 'tx', steps, sel: sel() });
  });
}

export function imeLogSnapshot() {
  return { count: entries.length, dropped, entries };
}

export function imeLogTail(n: number): LogEntry[] {
  return entries.slice(-n);
}
