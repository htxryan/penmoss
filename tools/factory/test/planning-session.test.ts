/**
 * The planning session is found and stopped by the id `claude --bg` prints (PEN-70, 9 Nov 2026).
 * PEN-70's planning session started, but Claude Code titled it "tooltip-delay-pen-70" itself, so
 * looking it up by the card's name failed and the card was set Blocked while the session worked
 * on. And `claude stop` takes the short id, not the session id.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FactoryConfig } from '../src/config.ts';
import type { Exec } from '../src/exec.ts';
import {
  findSession,
  launchSession,
  planFiles,
  sessionName,
  stopSession,
} from '../src/planning-host.ts';
import { testConfig } from './helpers.ts';

const SESSION = '0ff38e2e-d7ae-49ac-a926-ac08c4870f2d';

/** `claude agents --json` as Claude Code printed it while PEN-70's planning ran. */
const AGENTS = JSON.stringify([
  {
    pid: 1,
    id: 'c65d77b6',
    kind: 'interactive',
    sessionId: 'c65d77b6-x',
    name: 'Penmoss Factory',
    status: 'waiting',
  },
  {
    pid: 39757,
    id: '0ff38e2e',
    kind: 'background',
    sessionId: SESSION,
    name: 'tooltip-delay-pen-70',
    status: 'busy',
  },
]);

function fakeClaude(): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = (_cmd, args) => {
    calls.push([...args]);
    if (args[0] === 'agents') return Promise.resolve({ code: 0, stdout: AGENTS, stderr: '' });
    if (args.includes('--bg'))
      return Promise.resolve({
        code: 0,
        stdout: `backgrounded · 0ff38e2e · ${args[args.indexOf('--name') + 1] ?? '?'}\n  claude stop 0ff38e2e      stop this session\n`,
        stderr: '',
      });
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
  return { exec, calls };
}

const config = (): FactoryConfig => ({
  ...testConfig(),
  stateDir: mkdtempSync(join(tmpdir(), 'factory-plan-')),
});

describe('the planning session', () => {
  it('is started with its display name, and launch returns the id --bg printed', async () => {
    const c = config();
    const { exec, calls } = fakeClaude();
    const started = await launchSession(c, exec, planFiles(c, 70), 70, 'plan PEN-70', {});
    const args = calls[0] ?? [];
    expect(args[args.indexOf('--name') + 1]).toBe(sessionName(c, 70));
    // No Remote Control: the setup token it runs on can't open one (A1281).
    expect(args).not.toContain('--remote-control');
    expect(started).toEqual({ id: '0ff38e2e' });
  });

  it('is found by that id even when Claude Code retitled it', async () => {
    const c = config();
    const { exec } = fakeClaude();
    expect(await findSession(c, exec, 70, {})).toBeUndefined();
    await expect(findSession(c, exec, 70, {}, { id: '0ff38e2e' })).resolves.toEqual({
      sessionId: SESSION,
      id: '0ff38e2e',
      status: 'busy',
    });
    await expect(findSession(c, exec, 70, {}, { sessionId: SESSION })).resolves.toMatchObject({
      id: '0ff38e2e',
    });
  });

  it('is stopped with the short id that claude stop takes', async () => {
    const c = config();
    const { exec, calls } = fakeClaude();
    await stopSession(c, exec, 70, SESSION, {});
    expect(calls.at(-1)).toEqual(['stop', '0ff38e2e']);
  });
});
