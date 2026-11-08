/**
 * The slots' Android virtual devices (F8, FD25): one per slot, in the factory's own AVD folder
 * (never ~/.android), made once from the API 37 system image that `penmoss37` uses.
 */
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome, type FactoryConfig, type SlotConfig } from './config.ts';
import type { Exec } from './exec.ts';

export const SYSTEM_IMAGE = 'system-images;android-37.0;google_apis;arm64-v8a';

/** The phone the proof recordings show: a Pixel-sized screen, enough RAM for software rendering. */
export const AVD_SETTINGS: Readonly<Record<string, string>> = {
  'hw.lcd.width': '1080',
  'hw.lcd.height': '2400',
  'hw.lcd.density': '420',
  'hw.ramSize': '3072',
  'hw.keyboard': 'yes',
  'disk.dataPartition.size': '6G',
  'hw.audioInput': 'no',
  'hw.gps': 'no',
};

export function avdDir(config: FactoryConfig): string {
  return join(expandHome(config.stateDir), 'avd');
}

/** Makes the slot's AVD if it isn't there yet. Runs on the host, before the sandbox needs it. */
export async function ensureAvd(
  config: FactoryConfig,
  slot: SlotConfig,
  exec: Exec,
): Promise<void> {
  const dir = avdDir(config);
  if (existsSync(join(dir, `${slot.avd}.ini`))) return;
  const sdk = expandHome(config.toolchain.androidSdk);
  const env = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: process.env['HOME'] ?? '',
    ANDROID_AVD_HOME: dir,
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
    JAVA_HOME: expandHome(config.toolchain.jdk),
  };
  const made = await exec(
    join(sdk, 'cmdline-tools/latest/bin/avdmanager'),
    [
      'create',
      'avd',
      '--name',
      slot.avd,
      '--package',
      SYSTEM_IMAGE,
      '--device',
      'pixel_7',
      '--force',
    ],
    { env, input: 'no\n' },
  );
  if (made.code !== 0)
    throw new Error(`avdmanager couldn't make ${slot.avd}: ${made.stderr.trim()}`);
  appendFileSync(
    join(dir, `${slot.avd}.avd`, 'config.ini'),
    Object.entries(AVD_SETTINGS)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(''),
  );
}
