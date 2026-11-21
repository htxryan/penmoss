/**
 * Typed lengths (PEN-177): how long the text in a dialog's field is, never the text, recorded as
 * `input <dialog>` with the field and its length once typing settles (500 ms), or at once when the
 * field closes with a change pending. A length equal to the last recorded is dropped, and the
 * length the field opened with counts as recorded. The settling is core's SettleGate, the same
 * rules Android's twin follows (scroll-v1.json pins them).
 *
 * Every text field inside a tracked dialog uses it, and Settings' Search Settings field
 * (`settingsSearch`): the runtime audit (tracked-controls.spec.ts) fails on a text field in a
 * dialog without it (`data-typed`) or a `data-untracked` reason.
 */
import { clampUsage, INPUT_SETTLE_MS, SettleGate, type InputField } from '@penmoss/core/analytics';
import { useEffect, useRef } from 'react';
import { record } from './record';

/** What a field carries so the audit sees it is recorded. */
export interface TypedLengthMarks {
  readonly 'data-typed': string;
}

/**
 * Records the length of `value`, the text of the field `field` in the dialog `dialog` (a catalogue
 * name, INPUT_NAMES); spread what it returns on the field.
 */
export function useTypedLength(dialog: string, field: InputField, value: string): TypedLengthMarks {
  const gate = useRef<SettleGate<number> | null>(null);
  const opened = useRef(value.length);
  useEffect(() => {
    const next = new SettleGate<number>((chars) => record('input', dialog, { field, chars }), {
      settleMs: INPUT_SETTLE_MS,
    });
    next.mark(clampUsage('chars', opened.current));
    gate.current = next;
    return () => {
      // The field closes: a change still settling is sent now.
      next.flush();
      if (gate.current === next) gate.current = null;
    };
  }, [dialog, field]);
  useEffect(() => {
    gate.current?.moved(clampUsage('chars', value.length));
  }, [value]);
  return { 'data-typed': dialog };
}
