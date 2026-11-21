/**
 * The modal pickers' parts (their keys are `picker-list.ts`'s): an overlay whose scrim closes it
 * around a dialog, the search field (a combobox over the list, focused as the picker opens) and
 * the list, whose active row scrolls into view.
 */
import { useLayoutEffect, useRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { useTypedLength } from '../analytics/typed';
import type { PickerList } from './picker-list';

/** A picker's overlay and dialog: a press on the scrim closes it. */
export function PickerOverlay({
  testId,
  className,
  label,
  labelledBy,
  onClose,
  children,
}: {
  readonly testId: string;
  /** The dialog's classes besides `dialog`. */
  readonly className: string;
  readonly label?: string;
  readonly labelledBy?: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  return (
    <div
      className="overlay"
      data-testid={testId}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`dialog ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The search field over a picker's list, focused as the picker opens. What is typed in it is
 * recorded by its length only, as `input <dialog>` (PEN-177): `dialog` names the picker.
 */
export function PickerField({
  picker,
  dialog,
  ...props
}: {
  readonly picker: PickerList;
  /** The picker's dialog, as the catalogue names it (DIALOG_NAMES). */
  readonly dialog: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'role'>) {
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => input.current?.focus(), []);
  const typed = useTypedLength(dialog, 'query', String(props.value ?? ''));
  return (
    <input
      ref={input}
      {...typed}
      type="text"
      role="combobox"
      aria-expanded="true"
      aria-controls={picker.listId}
      aria-autocomplete="list"
      aria-activedescendant={picker.activeId}
      autoComplete="off"
      spellCheck={false}
      onKeyDown={picker.onKeyDown}
      {...props}
    />
  );
}

/**
 * A picker's list, its active row kept in view. `focus`: the list itself takes the keys and the
 * focus (the ⌘E switcher, which has no field); it is then tabbable, as a list that can scroll
 * must be (axe's scrollable-region-focusable).
 */
export function PickerListbox({
  picker,
  label,
  className = 'dlg-list',
  focus = false,
  busy,
  children,
}: {
  readonly picker: PickerList;
  readonly label: string;
  readonly className?: string;
  readonly focus?: boolean;
  /** Its rows are still coming (`aria-busy`). */
  readonly busy?: boolean;
  readonly children: ReactNode;
}) {
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (focus) list.current?.focus();
  }, [focus]);
  const { current, items } = picker;
  useLayoutEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${current}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [current, items]);
  return (
    <div
      ref={list}
      className={className}
      id={picker.listId}
      role="listbox"
      aria-label={label}
      aria-busy={busy}
      {...(focus
        ? { tabIndex: 0, 'aria-activedescendant': picker.activeId, onKeyDown: picker.onKeyDown }
        : {})}
    >
      {children}
    </div>
  );
}
