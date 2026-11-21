/**
 * Typed lengths (PEN-177): how long the text in a dialog's field is, never the text, recorded as
 * `input <dialog>` with the field and its length once typing settles (500 ms), or at once when the
 * field closes with a change pending. A length equal to the last recorded is dropped, and the
 * length the field opened with counts as recorded. The settling is core's SettleGate, the same
 * rules Android's twin follows (scroll-v1.json pins them).
 *
 * Every text field inside a tracked dialog uses it, and Settings' Search Settings field
 * (`settingsSearch`): the runtime audit (tracked-controls.spec.ts) fails on a text field in a
 * dialog without it (`data-typed`) or a `data-untracked` reason. A React field uses the hooks; a
 * field the editor builds itself (the selection toolbar's link form) carries `data-typed` and
 * `data-typed-field`, which `installTypedTracking` records the same way.
 */
import {
  clampUsage,
  INPUT_FIELDS,
  INPUT_SETTLE_MS,
  SettleGate,
  type InputField,
} from '@penmoss/core/analytics';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { record } from './record';

/** What a field carries so the audit sees it is recorded. */
export interface TypedLengthMarks {
  readonly 'data-typed': string;
}

/** A gate that records `dialog`'s `field`, starting from `opened` characters. */
function typedGate(dialog: string, field: InputField, opened: number): SettleGate<number> {
  const gate = new SettleGate<number>((chars) => record('input', dialog, { field, chars }), {
    settleMs: INPUT_SETTLE_MS,
  });
  gate.mark(clampUsage('chars', opened));
  return gate;
}

/**
 * Records `chars`, the length of the text in the field `field` of the dialog `dialog` (a
 * catalogue name, INPUT_NAMES); spread what it returns on the field. `chars` null: the field's
 * text isn't there yet (a rich field reading its draft), and the length it first has counts as
 * the one it opened with.
 */
export function useTypedChars(
  dialog: string,
  field: InputField,
  chars: number | null,
): TypedLengthMarks {
  const gate = useRef<SettleGate<number> | null>(null);
  const latest = useRef(chars);
  useLayoutEffect(() => {
    latest.current = chars;
  });
  const ready = chars !== null;
  useEffect(() => {
    if (!ready) return;
    const next = typedGate(dialog, field, latest.current ?? 0);
    gate.current = next;
    return () => {
      // The field closes: a change still settling is sent now.
      next.flush();
      if (gate.current === next) gate.current = null;
    };
  }, [dialog, field, ready]);
  useEffect(() => {
    if (chars !== null) gate.current?.moved(clampUsage('chars', chars));
  }, [chars]);
  return { 'data-typed': dialog };
}

/**
 * Records the length of `value`, the text of the field `field` in the dialog `dialog` (a catalogue
 * name, INPUT_NAMES); spread what it returns on the field.
 */
export function useTypedLength(dialog: string, field: InputField, value: string): TypedLengthMarks {
  return useTypedChars(dialog, field, value.length);
}

const FIELDS: ReadonlySet<string> = new Set(INPUT_FIELDS);

/** The dialog and field a DOM-built field names, or null for one the hooks record. */
function typedField(target: EventTarget | null): {
  readonly element: HTMLInputElement | HTMLTextAreaElement;
  readonly dialog: string;
  readonly field: InputField;
} | null {
  const element = target as HTMLInputElement | HTMLTextAreaElement | null;
  const dialog = element?.dataset?.['typed'];
  const field = element?.dataset?.['typedField'];
  if (!dialog || !field || !FIELDS.has(field) || typeof element.value !== 'string') return null;
  return { element, dialog, field: field as InputField };
}

/**
 * Records the fields the page builds outside React (the selection toolbar's link form), marked
 * `data-typed="<dialog>"` and `data-typed-field="<field>"`: from the moment one takes focus (its
 * text then counts as recorded), each length once typing settles, and what waits when it loses
 * focus (its form closes). Returns the uninstaller.
 */
export function installTypedTracking(doc: Document): () => void {
  const gates = new WeakMap<EventTarget, SettleGate<number>>();
  const onFocusIn = (event: Event) => {
    const typed = typedField(event.target);
    if (!typed || gates.has(typed.element)) return;
    gates.set(typed.element, typedGate(typed.dialog, typed.field, typed.element.value.length));
  };
  const onInput = (event: Event) => {
    const typed = typedField(event.target);
    if (!typed) return;
    let gate = gates.get(typed.element);
    if (!gate) {
      // Typed into without a focus seen (set by a script): it starts from nothing.
      gate = typedGate(typed.dialog, typed.field, 0);
      gates.set(typed.element, gate);
    }
    gate.moved(clampUsage('chars', typed.element.value.length));
  };
  const onFocusOut = (event: Event) => {
    const gate = gates.get(event.target as EventTarget);
    if (!gate) return;
    gate.flush();
    gates.delete(event.target as EventTarget);
  };
  doc.addEventListener('focusin', onFocusIn, true);
  doc.addEventListener('input', onInput, true);
  doc.addEventListener('focusout', onFocusOut, true);
  return () => {
    doc.removeEventListener('focusin', onFocusIn, true);
    doc.removeEventListener('input', onInput, true);
    doc.removeEventListener('focusout', onFocusOut, true);
  };
}
