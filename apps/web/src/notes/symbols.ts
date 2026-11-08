/**
 * The person's line symbols (T44, A743): `symbols.list`, a synced per-user setting the web
 * keeps in its WorkspaceDoc like the theme, for the editors and Settings → Symbols. Editors
 * read it through one `SymbolSource` per workspace, so a change here or on another device
 * redraws every open and kept note (A741: no note changes).
 */
import {
  DEFAULT_SYMBOLS,
  SYMBOLS_SETTING,
  symbolListProblem,
  symbolsOf,
  type LineSymbol,
} from '@penmoss/core/line-symbols';
import type { SymbolSource } from '@penmoss/editor';
import { symbolCommandTitle } from '@penmoss/editor/commands';
import { isApplePlatform } from '@penmoss/editor/keys';
import { useCallback, useEffect } from 'react';
import type { SettingsSource } from '../commands/bindings';
import type { CommandCenter } from '../commands/center';
import { useWorkspace, useWorkspaceState } from '../workspace/hooks';

const sources = new WeakMap<SettingsSource, SymbolSource>();

/** The list as editors read it: told only when the list itself changes. */
export function symbolSource(settings: SettingsSource): SymbolSource {
  const known = sources.get(settings);
  if (known) return known;
  const source: SymbolSource = {
    get: () => symbolsOf(settings.settings()),
    subscribe: (listener) => {
      let last = JSON.stringify(source.get());
      return settings.subscribe(() => {
        const next = JSON.stringify(source.get());
        if (next === last) return;
        last = next;
        listener();
      });
    },
  };
  sources.set(settings, source);
  return source;
}

/**
 * Keeps the symbol commands' titles on the person's glyphs (T51 item 12, A940): "Toggle
 * Symbol ★" in the palette, the shortcuts and the Mac menus, following the list as it changes.
 */
export function useSymbolCommandTitles(commands: CommandCenter, settings: SettingsSource): void {
  useEffect(() => {
    const source = symbolSource(settings);
    const retitle = () => {
      const symbols = source.get();
      commands.setTitles((id) => symbolCommandTitle(id, symbols));
    };
    retitle();
    return source.subscribe(retitle);
  }, [commands, settings]);
}

/** Settings → Symbols: the list, and a way to change it. */
export function useLineSymbols(): {
  readonly symbols: readonly LineSymbol[];
  /** Whether the person has their own list (else the defaults show). */
  readonly custom: boolean;
  /** Stores a list; refused (with why) when it is not one the rules allow. */
  readonly save: (symbols: readonly LineSymbol[]) => string | null;
  /** Back to the defaults. */
  readonly reset: () => void;
  /** This device's copy is read, so a change holds. */
  readonly canChange: boolean;
} {
  const workspace = useWorkspace();
  // Re-renders when settings change (here or by sync); writable once this device's copy is read.
  const { loaded } = useWorkspaceState();
  const settings = workspace.settings();
  const save = useCallback(
    (symbols: readonly LineSymbol[]) => {
      const value = symbols.map(({ glyph, name, colour }) => ({
        glyph,
        name: name.trim(),
        colour,
      }));
      const problem = symbolListProblem(value);
      if (problem) return problem;
      workspace.setSetting(SYMBOLS_SETTING, value);
      return null;
    },
    [workspace],
  );
  const reset = useCallback(() => workspace.setSetting(SYMBOLS_SETTING, undefined), [workspace]);
  return {
    symbols: symbolsOf(settings),
    custom: settings[SYMBOLS_SETTING] !== undefined && symbolsOf(settings) !== DEFAULT_SYMBOLS,
    save,
    reset,
    canChange: loaded,
  };
}

/**
 * macOS takes ⌃1–9 for Mission Control's "Switch to Desktop N" when that is turned on (A744):
 * said beside the symbol keys on a Mac, while any of them is still ⌃ and a digit.
 */
export const SPACES_CLASH =
  'If ⌃ and a digit switch Spaces on this Mac, rebind them in Keyboard Shortcuts.';

export function symbolKeysMayClash(keysOf: (id: string) => readonly string[]): boolean {
  if (!isApplePlatform()) return false;
  return Array.from({ length: 9 }, (_, slot) => keysOf(`editor.symbol${slot + 1}`)).some((keys) =>
    keys.some((combo) => /^Ctrl\+[0-9]$/.test(combo)),
  );
}
