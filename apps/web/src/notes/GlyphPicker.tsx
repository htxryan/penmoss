/**
 * A symbol's glyph picker (T51 item 9, A939): a button showing the glyph, opening a popover
 * with a grid of preset glyphs and a field to paste any other, under the same glyph rules
 * (A743). A preset another symbol already uses is marked and cannot be chosen. Arrow keys
 * move across the grid; Escape, a press outside or Tab away closes it.
 */
import { SYMBOL_GLYPH_PRESETS, glyphKey, MAX_GLYPH_CHARS } from '@penmoss/core/line-symbols';
import { useId, useState } from 'react';
import { onGridKeyDown, usePopover } from '../shell/popover';

/** Presets per row: the arrow keys move by this many up and down. */
const GLYPH_COLUMNS = 7;

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
  /** The button's and the popover's accessible name ("Glyph ★"). */
  readonly label: string;
  /** The glyph's colour as CSS, so the button shows the symbol as the margin does. */
  readonly colour: string;
  /** The other symbol using a glyph, or null: such a preset is marked and refused. */
  readonly takenBy: (glyph: string) => string | null;
  /** Why a glyph cannot be this symbol's, as a sentence, or null. */
  readonly problemOf: (glyph: string) => string | null;
  /** Stores it; says why not when it cannot. */
  readonly onChoose: (glyph: string) => string | null;
  readonly disabled: boolean;
  readonly testId: string;
}) {
  const id = useId();
  const { open, setOpen, button, panel, close, onPanelKeyDown } = usePopover();
  const [custom, setCustom] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const choose = (next: string) => {
    if (glyphKey(next) === glyphKey(glyph)) {
      close(true);
      return;
    }
    const refused = problemOf(next) ?? onChoose(next);
    setProblem(refused);
    if (!refused) close(true);
  };
  const openPanel = () => {
    setCustom('');
    setProblem(null);
    setOpen(true);
    requestAnimationFrame(() => {
      const drawn = panel.current;
      (
        drawn?.querySelector<HTMLElement>('[data-grid-item][tabindex="0"]') ??
        drawn?.querySelector<HTMLElement>('[data-grid-item]')
      )?.focus();
    });
  };
  const current = SYMBOL_GLYPH_PRESETS.findIndex((each) => glyphKey(each) === glyphKey(glyph));

  return (
    <span className="glyph-anchor">
      <button
        ref={button}
        type="button"
        className="btn glyph-trigger"
        data-ui="menu"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${id}-panel` : undefined}
        data-tip={label}
        disabled={disabled}
        data-testid={testId}
        style={{ color: colour }}
        onClick={() => (open ? close(false) : openPanel())}
      >
        {glyph}
      </button>
      {open ? (
        <div
          ref={panel}
          id={`${id}-panel`}
          className="glyph-popover"
          role="dialog"
          aria-label={label}
          data-testid={`${testId}-picker`}
          onKeyDown={onPanelKeyDown}
        >
          <div
            className="glyph-grid"
            role="group"
            aria-label="Symbols"
            onKeyDown={(event) => onGridKeyDown(event, GLYPH_COLUMNS)}
          >
            {SYMBOL_GLYPH_PRESETS.map((preset, index) => {
              const chosen = index === current;
              const taken = chosen ? null : takenBy(preset);
              return (
                <button
                  key={preset}
                  type="button"
                  className="glyph-option"
                  data-ui="option"
                  aria-pressed={chosen}
                  aria-disabled={taken ? true : undefined}
                  aria-label={taken ? `${preset}, ${taken}` : preset}
                  data-tip={taken ?? undefined}
                  data-grid-item=""
                  data-glyph={preset}
                  tabIndex={index === (current < 0 ? 0 : current) ? 0 : -1}
                  onClick={() => {
                    if (!taken) choose(preset);
                  }}
                >
                  {preset}
                </button>
              );
            })}
          </div>
          <form
            className="glyph-custom"
            onSubmit={(event) => {
              event.preventDefault();
              choose(custom.trim());
            }}
          >
            <label className="sr-only" htmlFor={`${id}-custom`}>
              Custom Glyph
            </label>
            <input
              id={`${id}-custom`}
              className="input"
              placeholder="Paste a symbol or emoji"
              value={custom}
              maxLength={MAX_GLYPH_CHARS}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? `${id}-problem` : undefined}
              data-testid={`${testId}-custom`}
              onChange={(event) => {
                setCustom(event.target.value);
                setProblem(null);
              }}
            />
            <button
              type="submit"
              className="btn"
              data-ui="submit"
              disabled={custom.trim() === ''}
              data-testid={`${testId}-use`}
            >
              Use
            </button>
          </form>
          {problem ? (
            <span id={`${id}-problem`} className="glyph-problem" role="alert">
              {problem}
            </span>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}
