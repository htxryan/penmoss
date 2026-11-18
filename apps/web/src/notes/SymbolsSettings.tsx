import { COLOUR_LOCKED_NOTE, isColourLocked } from '@penmoss/core/colour-lock';
import {
  DEFAULT_SYMBOLS,
  MAX_SYMBOLS,
  SYMBOL_COLOUR_KEYS,
  SYMBOL_COLOUR_LABELS,
  SYMBOL_GLYPH_PRESETS,
  SYMBOL_KIND_KEYS,
  glyphKey,
  kindSymbol,
  glyphProblem,
  symbolColourLabel,
  symbolColourVar,
  symbolInk,
  symbolSpokenName,
  type LineSymbol,
  type SymbolColour,
  type SymbolKind,
} from '@penmoss/core/line-symbols';
import { formatCombo } from '@penmoss/editor/keys';
import { Icon, type IconName } from '@penmoss/ui/icons';
import { useId, useState } from 'react';
import { useCommands, useCommandsVersion, useKeys } from '../commands/hooks';
import { ColourPicker, type ColourSwatch } from '../shell/ColourPicker';
import { Menu, MenuItem } from '../shell/Menu';
import { useReorder } from '../shell/reorder';
import '../theme/look-settings.css';
import { GlyphPicker } from './GlyphPicker';
import { SPACES_CLASH, symbolKeysMayClash, useLineSymbols } from './symbols';
import { SettingsHeader } from '../pages/SettingsHeader';

/** The glyph a new symbol gets: the first preset the list does not have yet (A939). */
function nextGlyph(symbols: readonly LineSymbol[]): string {
  const taken = new Set(
    symbols.filter((symbol) => !symbol.kind).map((symbol) => glyphKey(symbol.glyph)),
  );
  return SYMBOL_GLYPH_PRESETS.find((glyph) => !taken.has(glyphKey(glyph))) ?? '•';
}

/** A list item row's icon, and what its shortcut does (A1632). */
const KINDS: Readonly<Record<SymbolKind, { icon: IconName; does: string }>> = {
  checkbox: { icon: 'checklist', does: '☐ → ☑ → no box' },
  bullet: { icon: 'list', does: 'Line ⇄ bulleted item' },
  ordered: { icon: 'hash', does: 'Line ⇄ numbered item' },
};

/** A row's key among the rows: its glyph, or its kind for a list item. */
const rowKey = (symbol: LineSymbol) =>
  symbol.kind ? `kind:${symbol.kind}` : glyphKey(symbol.glyph);

/** What a row is called in messages: its glyph, or its name for a list item ("Checkbox"). */
const callOf = (symbol: LineSymbol) => (symbol.kind ? symbol.name : symbol.glyph);

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
 * older builds still read the list. Each row shows its slot's keys, read from the bindings, so a
 * rebound key shows as rebound; a row moves by its handle (drag, or Alt+↑ and Alt+↓), which
 * changes its keys (PEN-146, Show the Keys). An emoji comes in its own colours, so its row's
 * colour is disabled with a note saying so; the colour is kept for a glyph that takes one (A1588).
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
  const ids = symbols.map(rowKey);
  const reorder = useReorder({
    ids,
    type: 'application/x-penmoss-symbol',
    disabled,
    onMove: (key, index) => {
      const next = [...symbols];
      const [moved] = next.splice(ids.indexOf(key), 1);
      next.splice(index, 0, moved!);
      const combo = commands.keysOf(`editor.symbol${index + 1}`)[0];
      change(
        next,
        `${callOf(moved!)} is now symbol ${index + 1}${combo ? `, ${formatCombo(combo)}` : ''}.`,
      );
    },
  });
  /** The other symbol with this glyph, said as a sentence, or null. */
  const takenBy = (index: number) => (glyph: string) => {
    const other = symbols.findIndex(
      (symbol, at) => at !== index && !symbol.kind && glyphKey(symbol.glyph) === glyphKey(glyph),
    );
    return other < 0 ? null : `Already symbol ${other + 1}`;
  };
  return (
    <section
      className="settings-section symbols-settings lf-page"
      aria-labelledby={`${id}-h`}
      data-testid="symbols-settings"
    >
      <SettingsHeader
        id={`${id}-h`}
        title="Symbols"
        intro="A symbol at the start of a line marks it; a Checkbox or list item makes the line one."
      />
      <ol className="symbol-list lf-group" aria-label="Your Symbols" data-setting="symbols">
        {symbols.map((symbol, index) => {
          const grip = (
            <button
              type="button"
              className="icon-btn lf-grip"
              data-ui="item"
              aria-label={`Move ${symbol.kind ? symbol.name : symbolSpokenName(symbol)}, symbol ${index + 1} of ${symbols.length}`}
              aria-description="Drag, or press Alt and the up or down arrow"
              data-tip={`Drag to Move ${callOf(symbol)}`}
              data-testid={`symbol-move-${index + 1}`}
              disabled={disabled}
              {...reorder.handleProps(ids[index]!)}
            >
              <Icon name="grip" size={14} />
            </button>
          );
          const remove = (
            <span className="symbol-actions">
              <button
                type="button"
                className="btn quiet danger"
                data-ui="item"
                aria-label={`Remove ${symbol.kind ? symbol.name : symbolSpokenName(symbol)}`}
                data-tip={`Remove ${callOf(symbol)}`}
                data-testid={`symbol-remove-${index + 1}`}
                disabled={disabled}
                onClick={() =>
                  change(
                    symbols.filter((_, at) => at !== index),
                    symbol.kind
                      ? `Removed ${symbol.name}. Your lists stay as they are.`
                      : `Removed ${symbol.glyph}. Lines with ${symbol.glyph} show it as text.`,
                  )
                }
              >
                <Icon name="close" />
              </button>
            </span>
          );
          if (symbol.kind) {
            // A list item (A1632): no glyph or colour to choose, only its place and keys.
            return (
              <li
                key={ids[index]}
                className="symbol-row symbol-row-kind"
                data-testid="symbol-row"
                data-kind={symbol.kind}
                {...reorder.rowProps(ids[index]!)}
              >
                {grip}
                <SlotKeys slot={index} />
                <span className="symbol-kind-icon" aria-hidden="true">
                  <Icon name={KINDS[symbol.kind].icon} size={16} />
                </span>
                <span className="symbol-kind-name">{symbol.name}</span>
                <span className="lf-help symbol-kind-does">{KINDS[symbol.kind].does}</span>
                {remove}
              </li>
            );
          }
          const locked = isColourLocked(symbol.glyph);
          return (
            <li
              key={ids[index]}
              className="symbol-row"
              data-testid="symbol-row"
              {...reorder.rowProps(ids[index]!)}
            >
              {grip}
              <SlotKeys slot={index} />
              <GlyphPicker
                glyph={symbol.glyph}
                label={`Glyph ${symbol.glyph}`}
                colour={symbolInk(symbol)}
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
                disabled={disabled || locked}
                describedBy={locked ? `${id}-locked-${index + 1}` : undefined}
                testId={`symbol-colour-${index + 1}`}
                onChange={(colour) => update(index, { colour: colour as SymbolColour })}
              />
              {locked ? (
                <span
                  id={`${id}-locked-${index + 1}`}
                  className="lf-help symbol-colour-note"
                  data-testid={`symbol-colour-note-${index + 1}`}
                >
                  {COLOUR_LOCKED_NOTE}
                </span>
              ) : null}
              {remove}
            </li>
          );
        })}
      </ol>
      {symbols.length === 0 ? (
        <p className="muted">No symbols: add one, or restore the defaults.</p>
      ) : null}
      <div className="settings-actions symbol-foot">
        <Menu
          label="Add"
          icon="plus"
          text="Add"
          title="Add a Symbol or List Item"
          className="btn"
          testId="symbol-add"
          setting="add-a-symbol-or-list-item"
          disabled={disabled || symbols.length >= MAX_SYMBOLS}
        >
          <MenuItem
            icon="star"
            data-testid="symbol-add-symbol"
            onClick={() => {
              const glyph = nextGlyph(symbols);
              change(
                [...symbols, { glyph, name: glyph, colour: 'accent' }],
                `Added ${glyph} as symbol ${symbols.length + 1}.`,
              );
            }}
          >
            Symbol
          </MenuItem>
          {SYMBOL_KIND_KEYS.map((kind) => {
            const item = kindSymbol(kind);
            const there = symbols.some((symbol) => symbol.kind === kind);
            return (
              <MenuItem
                key={kind}
                icon={KINDS[kind].icon}
                data-testid={`symbol-add-${kind}`}
                disabled={there}
                hint={there ? <span className="muted">In the List</span> : undefined}
                onClick={() =>
                  change([...symbols, item], `Added ${item.name} as symbol ${symbols.length + 1}.`)
                }
              >
                {item.name}
              </MenuItem>
            );
          })}
        </Menu>
        <span className="lf-help" data-testid="symbols-count">
          {symbols.length} of {MAX_SYMBOLS}
        </span>
        <span className="symbol-foot-end">
          <button
            type="button"
            className="btn quiet"
            data-command="app.shortcuts"
            data-setting="change-their-shortcuts"
            onClick={() => commands.run('app.shortcuts')}
          >
            Change Their Shortcuts
          </button>
          <button
            type="button"
            className="btn quiet"
            data-ui="submit"
            data-setting="restore-defaults"
            disabled={disabled || !custom}
            onClick={() => {
              reset();
              setNotice(`Restored ${DEFAULT_SYMBOLS.map(callOf).join(' ')}.`);
            }}
          >
            Restore Defaults
          </button>
        </span>
      </div>
      {symbolKeysMayClash((slot) => commands.keysOf(slot)) ? (
        <p className="muted settings-help" data-testid="symbols-spaces">
          {SPACES_CLASH}
        </p>
      ) : null}
      <p className="muted settings-help" data-testid="symbols-plain-text">
        A symbol is plain text in the note (<code>★ Call the bank</code>), so agents see it too. Up
        to {MAX_SYMBOLS}; each one&rsquo;s shortcut follows its place in the list.
      </p>
      <p role="status" className="muted settings-help" data-testid="symbols-notice">
        {notice ??
          'Drag a row, or press Alt+↑ or Alt+↓ on it, to change its key. A glyph is a symbol or emoji without letters, digits or markdown characters. Removing a symbol leaves it as text in your notes.'}
      </p>
    </section>
  );
}
