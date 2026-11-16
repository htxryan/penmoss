/**
 * Per-platform settings on Android (PEN-156, A1605): apps/android/contract/platform-settings-v1.json
 * is `@penmoss/core/settings`' list of the settings each platform keeps its own copy of, so the
 * Kotlin `PlatformSettings`, which marks them with the phone in Settings, is held to the keys the
 * phone's engine page actually keeps apart. The Kotlin `PlatformSettingsTest` reads the same file.
 *
 * After changing the list, write the file again:
 * `PENMOSS_WRITE_CONTRACTS=1 pnpm --filter @penmoss/web test android-platform-settings-contract`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  isPlatformSetting,
  PLATFORM_SETTING_KEYS,
  PLATFORM_SETTING_PREFIXES,
  SETTINGS_PLATFORMS,
} from '@penmoss/core/settings';
import { describe, expect, it } from 'vitest';

const FILE = fileURLToPath(
  new URL('../../../android/contract/platform-settings-v1.json', import.meta.url),
);

/** Keys the phone reads, each with whether it is kept per platform. */
const SAMPLES = [
  'theme.id',
  'theme.mode',
  'theme.custom.custom-ink',
  'font.interface',
  'font.noteSize',
  'sidebar.graph',
  'sidebar.capture',
  'sidebar.sectionOrder',
  'sidebar.hiddenSections',
  'sidebar.recentCount',
  'quickAccess.showNotebook',
  'quickAccess.notes',
  'keys.app.search',
  'keysTyped',
  'symbols.list',
  'capture.destination',
  'timeZone',
  'template.daily',
];

describe('the per-platform settings contract (A1605)', () => {
  it('is core’s list, as the phone reads it', () => {
    const now = {
      version: 1,
      platforms: [...SETTINGS_PLATFORMS],
      android: 'mobile',
      keys: [...PLATFORM_SETTING_KEYS],
      prefixes: [...PLATFORM_SETTING_PREFIXES],
      samples: Object.fromEntries(SAMPLES.map((key) => [key, isPlatformSetting(key)])),
    };
    if (process.env['PENMOSS_WRITE_CONTRACTS'])
      writeFileSync(FILE, `${JSON.stringify(now, null, 2)}\n`);
    const written = JSON.parse(readFileSync(FILE, 'utf8')) as unknown;
    expect(written).toEqual(now);
  });
});
