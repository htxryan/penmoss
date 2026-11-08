/**
 * The slots' Android virtual devices (F8, FD25): one per slot, in the factory's own AVD folder
 * (never ~/.android), made once from the API 37 system image that `penmoss37` uses.
 */
import { appendFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
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

/**
 * What `pgrep -f` finds the slot's emulator by: its AVD and console port, as proof.sh starts it
 * (the launcher and the qemu it runs both carry them). Only the factory's slots use these AVDs.
 */
export function emulatorPattern(slot: SlotConfig): string {
  return ` -avd ${slot.avd} -port ${slot.emulatorPort}( |$)`;
}

/**
 * Stops the slot's emulator if one is up, from the host (F8): at the proof timeout, since
 * `am instrument -w` has no timeout of its own and only ends when the device goes, and before
 * each proof, in case a run stopped mid-proof (the daemon died, a sandbox was killed) left one
 * holding the slot's port. SIGTERM, then SIGKILL after `graceMs`. Then the AVD's lock files go,
 * which an emulator killed outright leaves behind and which would refuse the next boot as a
 * second instance. Returns whether an emulator was running.
 */
export async function stopSlotEmulator(
  config: FactoryConfig,
  slot: SlotConfig,
  exec: Exec,
  graceMs = 10_000,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  const pattern = emulatorPattern(slot);
  const up = async () => (await exec('pgrep', ['-f', pattern])).code === 0;
  const was = await up();
  if (was) {
    await exec('pkill', ['-TERM', '-f', pattern]);
    for (let waited = 0; waited < graceMs && (await up()); waited += 500) await sleep(500);
    if (await up()) await exec('pkill', ['-KILL', '-f', pattern]);
  }
  const dir = join(avdDir(config), `${slot.avd}.avd`);
  if (existsSync(dir))
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.lock')))
      rmSync(join(dir, name), { recursive: true, force: true });
  return was;
}
