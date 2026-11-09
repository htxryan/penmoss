/**
 * A notification never stops a run: PEN-75's first review step failed with
 * `spawn terminal-notifier ENOENT` on a Mac without the optional terminal-notifier, after the
 * card had already gone to In Review, and the run was set Blocked.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FactoryConfig } from '../src/config.ts';
import type { Exec } from '../src/exec.ts';
import { hostDeps, type HostOptions } from '../src/host.ts';
import { uiLinkPath } from '../src/ui/link.ts';
import { testConfig } from './helpers.ts';

function options(config: FactoryConfig, exec: Exec, lines: string[]): HostOptions {
  const slot = config.slots[0];
  if (!slot) throw new Error('the config has no slot');
  return {
    config,
    slot,
    runId: '75-test',
    board: { items: [] },
    gh: {} as never,
    tracker: {} as never,
    exec,
    secrets: {},
    pushToken: () => Promise.resolve('the-write-token'),
    sandboxToken: () => Promise.resolve('the-read-token'),
    proofStore: {} as never,
    agent: {} as never,
    log: (line) => lines.push(line),
  };
}

/** An exec where the named commands fail to spawn, as a missing binary does. */
function execMissing(...missing: string[]): { exec: Exec; ran: string[] } {
  const ran: string[] = [];
  const exec: Exec = (cmd) => {
    if (missing.includes(cmd))
      return Promise.reject(Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' }));
    ran.push(cmd);
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
  return { exec, ran };
}

function withUi(): FactoryConfig {
  const config = { ...testConfig(), stateDir: mkdtempSync(join(tmpdir(), 'factory-notify-')) };
  writeFileSync(uiLinkPath(config), 'http://127.0.0.1:7878/?token=t\n');
  return config;
}

describe('notifications', () => {
  it('fall back to osascript when terminal-notifier is not installed', async () => {
    const { exec, ran } = execMissing('terminal-notifier');
    const lines: string[] = [];
    const deps = hostDeps(options(withUi(), exec, lines));
    await expect(deps.notify('Penmoss PEN-75 is ready for review', 'the footer')).resolves.toBe(
      undefined,
    );
    expect(ran).toEqual(['osascript']);
    expect(lines).toEqual([]);
  });

  it('use terminal-notifier when it is there, and nothing else', async () => {
    const { exec, ran } = execMissing();
    const deps = hostDeps(options(withUi(), exec, []));
    await deps.notify('Penmoss PEN-75 is ready for review', 'the footer');
    expect(ran).toEqual(['terminal-notifier']);
  });

  it('never throw when no notification can be shown, and say so in the log', async () => {
    const { exec } = execMissing('terminal-notifier', 'osascript');
    const lines: string[] = [];
    const deps = hostDeps(options(withUi(), exec, lines));
    await expect(deps.notify('Penmoss PEN-75 is ready for review', 'the footer')).resolves.toBe(
      undefined,
    );
    expect(lines).toEqual([`couldn't show the notification "Penmoss PEN-75 is ready for review"`]);
  });
});
