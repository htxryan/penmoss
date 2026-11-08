/**
 * Stopping a slot's emulator from the host (F8): at the Android proof's timeout, since
 * `am instrument -w` never times out by itself, and before each proof, so a run that stopped
 * mid-proof doesn't leave the next one an emulator on its port or a locked AVD.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emulatorPattern, stopSlotEmulator } from '../src/avd.ts';
import { nodeExec } from '../src/exec.ts';
import { testConfig } from './helpers.ts';

function setUp() {
  const state = mkdtempSync(join(tmpdir(), 'factory-avd-'));
  const config = { ...testConfig(), stateDir: state };
  // A name and port no real emulator has.
  const slot = {
    ...config.slots[0]!,
    avd: `penmoss-unit-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    emulatorPort: 59990,
  };
  const avd = join(state, 'avd', `${slot.avd}.avd`);
  mkdirSync(avd, { recursive: true });
  return { config, slot, avd };
}

/** A stand-in emulator: a process whose command line names the slot's AVD and port. */
function fakeEmulator(avd: string, port: number, ignoreTerm = false) {
  const body = ignoreTerm ? "trap '' TERM; while :; do /bin/sleep 0.1; done" : 'sleep 30; :';
  const child = spawn(
    'sh',
    ['-c', body, 'emulator', '-avd', avd, '-port', String(port), '-no-window'],
    {
      stdio: 'ignore',
    },
  );
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return { child, exited };
}

describe('stopSlotEmulator', () => {
  it("matches the slot's AVD and console port as proof.sh starts the emulator", () => {
    const { slot } = setUp();
    expect(emulatorPattern(slot)).toBe(` -avd ${slot.avd} -port 59990( |$)`);
  });

  it("stops the slot's emulator, and only that one", async () => {
    const { config, slot } = setUp();
    const mine = fakeEmulator(slot.avd, slot.emulatorPort);
    const other = fakeEmulator(slot.avd, slot.emulatorPort + 2);
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await stopSlotEmulator(config, slot, nodeExec, 2000)).toBe(true);
      await mine.exited;
      expect(other.child.exitCode).toBeNull();
      expect(other.child.signalCode).toBeNull();
    } finally {
      mine.child.kill('SIGKILL');
      other.child.kill('SIGKILL');
    }
  });

  it('kills an emulator that ignores SIGTERM once the grace has passed', async () => {
    const { config, slot } = setUp();
    const stuck = fakeEmulator(slot.avd, slot.emulatorPort, true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await stopSlotEmulator(config, slot, nodeExec, 600)).toBe(true);
      await stuck.exited;
      expect(stuck.child.signalCode).toBe('SIGKILL');
    } finally {
      stuck.child.kill('SIGKILL');
    }
  });

  it("removes the AVD's stale lock files, which would refuse the next boot", async () => {
    const { config, slot, avd } = setUp();
    writeFileSync(join(avd, 'hardware-qemu.ini.lock'), '');
    mkdirSync(join(avd, 'multiinstance.lock'));
    writeFileSync(join(avd, 'config.ini'), 'hw.ramSize=3072\n');
    expect(await stopSlotEmulator(config, slot, nodeExec)).toBe(false);
    expect(existsSync(join(avd, 'hardware-qemu.ini.lock'))).toBe(false);
    expect(existsSync(join(avd, 'multiinstance.lock'))).toBe(false);
    expect(existsSync(join(avd, 'config.ini'))).toBe(true);
  });
});
