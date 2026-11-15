/**
 * The synced settings a phone reads (A1014), from TypeScript's side: Android's
 * `apps/android/contract/settings-v1.json` lists their keys and defaults, and the Kotlin
 * `SettingsContractTest` checks the phone against it. Here each key is the constant the Mac reads
 * it by, and each default is what that reader gives while the setting is unset, so the contract
 * cannot drift from either side.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  fontChoiceOf,
  INTERFACE_FONT_SETTING,
  NOTE_FONT_SETTING,
  NOTE_FONT_SIZE_SETTING,
  noteFontSizeOf,
} from '@penmoss/core/fonts';
import { DEFAULT_SYMBOLS, SYMBOLS_SETTING, symbolsOf } from '@penmoss/core/line-symbols';
import { QUICK_ACCESS_SETTING, quickAccessOf } from '@penmoss/core/quick-access';
import {
  CAPTURE_DESTINATION_SETTING,
  captureDestinationOf,
  FULL_WIDTH_SETTING,
  fullWidthOf,
  templateOf,
  templateSetting,
  TIME_ZONE_SETTING,
  timeZoneOf,
} from '@penmoss/core/settings';
import {
  HIDDEN_SECTIONS_SETTING,
  hiddenSectionsOf,
  QUICK_ACCESS_NOTEBOOK_SETTING,
  quickAccessShowsNotebook,
  RECENT_COUNT_SETTING,
  recentCountOf,
  SECTION_ORDER_SETTING,
  sectionOrderOf,
} from '@penmoss/core/sidebar-layout';
import { MODE_SETTING, resolveThemeSettings, THEME_SETTING } from '@penmoss/ui/theme';
import { describe, expect, it } from 'vitest';

const FILE = fileURLToPath(new URL('../../../android/contract/settings-v1.json', import.meta.url));

interface Contract {
  readonly keys: readonly string[];
  readonly defaults: Readonly<Record<string, unknown>>;
}

const contract = JSON.parse(readFileSync(FILE, 'utf8')) as Contract;
const unset = {};

/** Each key the phone reads, with what the Mac shows while it is unset. */
const READERS: ReadonlyArray<readonly [string, () => unknown]> = [
  [THEME_SETTING, () => resolveThemeSettings(unset).theme.id],
  [MODE_SETTING, () => resolveThemeSettings(unset).mode],
  [TIME_ZONE_SETTING, () => timeZoneOf(unset)],
  [templateSetting('daily'), () => templateOf(unset, 'daily')],
  [templateSetting('weekly'), () => templateOf(unset, 'weekly')],
  [CAPTURE_DESTINATION_SETTING, () => captureDestinationOf(unset)],
  // Unset, the note keeps the theme's width.
  [FULL_WIDTH_SETTING, () => fullWidthOf(unset) ?? false],
  [SYMBOLS_SETTING, () => symbolsOf(unset)],
  [INTERFACE_FONT_SETTING, () => fontChoiceOf(unset, INTERFACE_FONT_SETTING)],
  [NOTE_FONT_SETTING, () => fontChoiceOf(unset, NOTE_FONT_SETTING)],
  [NOTE_FONT_SIZE_SETTING, () => noteFontSizeOf(unset)],
  [QUICK_ACCESS_SETTING, () => quickAccessOf(unset)],
  [SECTION_ORDER_SETTING, () => sectionOrderOf(unset)],
  [HIDDEN_SECTIONS_SETTING, () => [...hiddenSectionsOf(unset)]],
  [RECENT_COUNT_SETTING, () => recentCountOf(unset)],
  [QUICK_ACCESS_NOTEBOOK_SETTING, () => quickAccessShowsNotebook(unset)],
];

describe('apps/android/contract/settings-v1.json (A1014)', () => {
  it('lists exactly the keys the Mac reads, by their constants, in its order', () => {
    expect(contract.keys).toEqual(READERS.map(([key]) => key));
  });

  it('gives each key the default the Mac shows while it is unset', () => {
    for (const [key, read] of READERS) {
      expect(contract.defaults[key], key).toEqual(read());
    }
    expect(contract.defaults[SYMBOLS_SETTING]).toEqual(DEFAULT_SYMBOLS);
  });
});
