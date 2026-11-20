/**
 * A symbol's glyph (T51 item 9, A939; A1568): a button showing the glyph, opening the icon
 * picker on its Characters, symbols and emoji found by name, with the old presets first. A
 * character another symbol already uses is marked and cannot be chosen; one that is not in the
 * list can be pasted into the search, under the same glyph rules (A743). A line symbol is text in
 * the note, so the picker offers no icons here (A1568).
 */
import { glyphKey } from '@penmoss/core/line-symbols';
import { useRef, useState } from 'react';
import { IconPickerDialog } from '../shell/IconPickerDialog';

export function GlyphPicker({
  glyph,
  label,
  colour,
  takenBy,
  problemOf,
  onChoose,
  disabled,
  testId,
}: {
  readonly glyph: string;
  /** The button's accessible name ("Glyph ★"). */
  readonly label: string;
  /**
   * The glyph's colour as CSS, so the button shows the symbol as the margin does; null for an
   * emoji, drawn in its own colours (A1588).
   */
  readonly colour: string | null;
  /** The other symbol using a glyph, or null: such a character is marked and refused. */
  readonly takenBy: (glyph: string) => string | null;
  /** Why a glyph cannot be this symbol's, as a sentence, or null. */
  readonly problemOf: (glyph: string) => string | null;
  /** Stores it; says why not when it cannot. */
  readonly onChoose: (glyph: string) => string | null;
  readonly disabled: boolean;
  readonly testId: string;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const same = (next: string) => glyphKey(next) === glyphKey(glyph);
  return (
    <span className="glyph-anchor">
      <button
        ref={button}
        type="button"
        className="btn glyph-trigger"
        data-ui="menu"
        data-event="glyph-picker.open"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tip={label}
        disabled={disabled}
        data-testid={testId}
        style={colour ? { color: colour } : undefined}
        onClick={() => setOpen(true)}
      >
        {glyph}
      </button>
      {open ? (
        <IconPickerDialog
          title="Choose a Symbol"
          tabs={['characters']}
          value={glyph}
          testId={`${testId}-picker`}
          problemOf={(next) => (same(next) ? null : (takenBy(next) ?? problemOf(next)))}
          // The glyph it has already: nothing to store.
          onPick={(next) => (same(next) ? null : onChoose(next))}
          onClose={() => {
            setOpen(false);
            button.current?.focus();
            // A new glyph is a new row (the list is keyed by glyph): its button takes the focus
            // once drawn, as the one it replaced had it.
            requestAnimationFrame(() => {
              if (button.current?.isConnected) return;
              document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.focus();
            });
          }}
        />
      ) : null}
    </span>
  );
}
