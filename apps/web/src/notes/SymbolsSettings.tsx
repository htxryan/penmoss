import {
  DEFAULT_SYMBOLS,
  MAX_SYMBOLS,
  SYMBOL_COLOUR_KEYS,
  SYMBOL_COLOUR_LABELS,
  SYMBOL_GLYPH_PRESETS,
  glyphKey,
  glyphProblem,
  symbolColourLabel,
  symbolColourVar,
  symbolSpokenName,
  type LineSymbol,
  type SymbolColour,
} from '@penmoss/core/line-symbols';
import { formatCombo } from '@penmoss/editor/keys';
import { Icon } from '@penmoss/ui/icons';
import { useId, useState } from 'react';
import { useCommands, useCommandsVersion, useKeys } from '../commands/hooks';
import { ColourPicker, type ColourSwatch } from '../shell/ColourPicker';
import { GlyphPicker } from './GlyphPicker';
import { SPACES_CLASH, symbolKeysMayClash, useLineSymbols } from './symbols';

/** The glyph a new symbol gets: the first preset the list does not have yet (A939). */
function nextGlyph(symbols: readonly LineSymbol[]): string {
  const taken = new Set(symbols.map((symbol) => glyphKey(symbol.glyph)));
  return SYMBOL_GLYPH_PRESETS.find((glyph) => !taken.has(glyphKey(glyph))) ?? '•';
}

/** The theme's colours, as the colour picker's swatches (D14). */
const SWATCHES: readonly ColourSwatch[] = SYMBOL_COLOUR_KEYS.map((colour) => ({
  value: colour,
  label: SYMBOL_COLOUR_LABELS[colour],
  css: symbolColourVar(colour),
}));

/** A rule's words as a sentence: "Glyph cannot hold a space". */
const sentence = (problem: string | null) =>
  problem ? `${problem.charAt(0).toUpperCase()}${problem.slice(1)}.` : null;

/** A slot's shortcut as keycaps show it, or "no shortcut". */
function SlotKeys({ slot }: { slot: number }) {
  const keys = useKeys(`editor.symbol${slot + 1}`);
  return (
    <kbd className="symbol-keys" data-testid={`symbol-keys-${slot + 1}`}>
      {keys[0] ? formatCombo(keys[0]) : '—'}
    </kbd>
  );
}

/**
 * Settings → Symbols (T44, A743): the person's line symbols, up to nine, one per shortcut slot,
 * each a glyph and a colour. Reorder, add, remove and restore the defaults. A synced setting,
 * like the theme; changing it never changes a note: a glyph taken off the list shows as text
 * again (A742). The glyph comes from a picker of presets or is pasted in, the colour from the
 * theme's or any of one's own (T51 items 9 and 10, A939). Symbols are known by their glyphs:
 * there are no names to give (A940), and a new or changed glyph is stored as its own name, so
 * older builds still read the list.
 */
export function SymbolsSettings() {
  const { symbols, custom, save, reset, canChange } = useLineSymbols();
  const commands = useCommands();
  // Re-rendered when the keys change, for the note on ⌃ and a digit.
  useCommandsVersion();
  const id = useId();
  const [notice, setNotice] = useState<string | null>(null);
  const disabled = !canChange;
  const change = (next: readonly LineSymbol[], said?: string) => {
    const problem = save(next);
    setNotice(problem ?? said ?? null);
    return problem;
  };
  const update = (index: number, patch: Partial<LineSymbol>) =>
    change(symbols.map((symbol, at) => (at === index ? { ...symbol, ...patch } : symbol)));
  const move = (index: number, by: -1 | 1) => {
    const next = [...symbols];
    const [moved] = next.splice(index, 1);
    next.splice(index + by, 0, moved!);
    change(next, `${moved!.glyph} is now symbol ${index + by + 1}.`);
  };
  /** The other symbol with this glyph, said as a sentence, or null. */
  const takenBy = (index: number) => (glyph: string) => {
    const other = symbols.findIndex(
      (symbol, at) => at !== index && glyphKey(symbol.glyph) === glyphKey(glyph),
    );
    return other < 0 ? null : `Already symbol ${other + 1}`;
  };
  return (
    <section
      className="settings-section"
      aria-labelledby={`${id}-h`}
      data-testid="symbols-settings"
    >
      <h2 id={`${id}-h`}>Symbols</h2>
      <p>
        Mark a line as important, a question, a follow-up, an idea or next with a symbol in the
        margin. Each one is plain text at the start of the line (<code>★ Call the bank</code>), so
        the git mirror and agents see it too. Changes sync to your other devices.
      </p>
      <ol className="symbol-list" aria-label="Your symbols">
        {symbols.map((symbol, index) => (
          <li key={`${index}:${symbol.glyph}`} className="symbol-row" data-testid="symbol-row">
            <SlotKeys slot={index} />
            <GlyphPicker
              glyph={symbol.glyph}
              label={`Glyph ${symbol.glyph}`}
              colour={symbolColourVar(symbol.colour)}
              testId={`symbol-glyph-${index + 1}`}
              disabled={disabled}
              takenBy={takenBy(index)}
              problemOf={(glyph) =>
                sentence(glyphProblem(glyph)) ??
                (takenBy(index)(glyph) ? `${glyph} is already in the list.` : null)
              }
              // The glyph is its name too (A940), for builds that still show names.
              onChoose={(glyph) => update(index, { glyph, name: glyph })}
            />
            <ColourPicker
              label={`Colour of ${symbol.glyph}`}
              value={symbol.colour}
              valueLabel={symbolColourLabel(symbol.colour)}
              css={symbolColourVar(symbol.colour)}
              swatches={SWATCHES}
              disabled={disabled}
              testId={`symbol-colour-${index + 1}`}
              onChange={(colour) => update(index, { colour: colour as SymbolColour })}
            />
            <span className="symbol-actions">
              <button
                type="button"
                className="btn quiet"
                data-ui="item"
                aria-label={`Move ${symbolSpokenName(symbol)} Up`}
                data-tip={`Move ${symbol.glyph} Up`}
                disabled={disabled || index === 0}
                onClick={() => move(index, -1)}
              >
                <Icon name="chevU" />
              </button>
              <button
                type="button"
                className="btn quiet"
                data-ui="item"
                aria-label={`Move ${symbolSpokenName(symbol)} Down`}
                data-tip={`Move ${symbol.glyph} Down`}
                disabled={disabled || index === symbols.length - 1}
                onClick={() => move(index, 1)}
              >
                <Icon name="chevD" />
              </button>
              <button
                type="button"
                className="btn quiet danger"
                data-ui="item"
                aria-label={`Remove ${symbolSpokenName(symbol)}`}
                data-tip={`Remove ${symbol.glyph}`}
                disabled={disabled}
                onClick={() =>
                  change(
                    symbols.filter((_, at) => at !== index),
                    `Removed ${symbol.glyph}. Lines with ${symbol.glyph} show it as text.`,
                  )
                }
              >
                <Icon name="trash" />
              </button>
            </span>
          </li>
        ))}
      </ol>
      {symbols.length === 0 ? (
        <p className="muted">No symbols: add one, or restore the defaults.</p>
      ) : null}
      <div className="settings-actions">
        <button
          type="button"
          className="btn"
          data-ui="submit"
          disabled={disabled || symbols.length >= MAX_SYMBOLS}
          onClick={() => {
            const glyph = nextGlyph(symbols);
            change(
              [...symbols, { glyph, name: glyph, colour: 'accent' }],
              `Added ${glyph} as symbol ${symbols.length + 1}.`,
            );
          }}
        >
          <Icon name="plus" />
          Add a Symbol
        </button>
        <button
          type="button"
          className="btn"
          data-ui="submit"
          disabled={disabled || !custom}
          onClick={() => {
            reset();
            setNotice(`Restored ${DEFAULT_SYMBOLS.map((symbol) => symbol.glyph).join(' ')}.`);
          }}
        >
          Restore Defaults
        </button>
        <button
          type="button"
          className="btn quiet"
          data-command="app.shortcuts"
          onClick={() => commands.run('app.shortcuts')}
        >
          Change Their Shortcuts
        </button>
      </div>
      {symbolKeysMayClash((slot) => commands.keysOf(slot)) ? (
        <p className="muted settings-help" data-testid="symbols-spaces">
          {SPACES_CLASH}
        </p>
      ) : null}
      <p role="status" className="muted settings-help" data-testid="symbols-notice">
        {notice ??
          `Up to ${MAX_SYMBOLS}. A glyph is a symbol or emoji without letters, digits or markdown characters.`}
      </p>
    </section>
  );
}
