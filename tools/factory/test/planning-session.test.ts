/**
 * The planning session is found and stopped by the id `claude --bg` prints (PEN-70, 9 Nov 2026).
 * PEN-70's planning session started, but Claude Code titled it "tooltip-delay-pen-70" itself, so
 * looking it up by the card's name failed and the card was set Blocked while the session worked
 * on. And `claude stop` takes the short id, not the session id.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FactoryConfig } from '../src/config.ts';
import type { Exec } from '../src/exec.ts';
import {
  chatUrlFromJob,
  claudeJobsDir,
  findSession,
  launchSession,
  planFiles,
  planningChat,
  sessionName,
  stopSession,
  writeMeta,
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
    expect(started.id).toBe('0ff38e2e');
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

  it("gets its chat link from Claude Code's job file, since --bg prints none (A1257)", async () => {
    const c = config();
    const { exec } = fakeClaude();
    const jobs = mkdtempSync(join(tmpdir(), 'claude-jobs-'));
    mkdirSync(join(jobs, '0ff38e2e'));
    // As Claude Code 2.1.319 wrote it for a `--bg --remote-control` session.
    const state = (bridge?: string) =>
      writeFileSync(
        join(jobs, '0ff38e2e', 'state.json'),
        JSON.stringify({
          state: 'working',
          daemonShort: '0ff38e2e',
          sessionId: SESSION,
          ...(bridge ? { bridgeSessionId: bridge, bridgeOutboundOnly: false } : {}),
        }),
      );
    state();
    // The link comes a moment after --bg returns: the launch waits for it.
    const slept: number[] = [];
    const sleep = (ms: number) => {
      slept.push(ms);
      if (slept.length === 2) state('cse_01Ft4U3apUr33bjvQoKRcUFV');
      return Promise.resolve();
    };
    const started = await launchSession(c, exec, planFiles(c, 70), 70, 'plan', {}, undefined, {
      dir: jobs,
      sleep,
    });
    expect(started).toEqual({
      id: '0ff38e2e',
      chatUrl: 'https://claude.ai/code/session_01Ft4U3apUr33bjvQoKRcUFV',
    });
    expect(slept).toHaveLength(2);
  });

  it('has no chat link, and says so, when Claude Code reports none in time', async () => {
    const c = config();
    const { exec } = fakeClaude();
    const jobs = mkdtempSync(join(tmpdir(), 'claude-jobs-'));
    const started = await launchSession(c, exec, planFiles(c, 70), 70, 'plan', {}, undefined, {
      dir: jobs,
      waitMs: 3_000,
      sleep: () => Promise.resolve(),
    });
    expect(started).toEqual({ id: '0ff38e2e' });
    const files = planFiles(c, 70);
    mkdirSync(files.root, { recursive: true });
    writeMeta(files, { sessionId: SESSION });
    expect(planningChat(c, 70)).toEqual({
      error: expect.stringContaining('reported no Remote Control session') as string,
    });
  });

  it('reads only a Remote Control id from the job file', () => {
    expect(chatUrlFromJob('{"bridgeSessionId":"session_01Ab"}')).toBe(
      'https://claude.ai/code/session_01Ab',
    );
    for (const bad of [
      '{}',
      'not json',
      '{"bridgeSessionId":"cse_../../x"}',
      '{"bridgeSessionId":7}',
    ])
      expect(chatUrlFromJob(bad), bad).toBeUndefined();
    expect(claudeJobsDir({ HOME: '/Users/r' })).toBe('/Users/r/.claude/jobs');
    expect(claudeJobsDir({ HOME: '/Users/r', CLAUDE_CONFIG_DIR: '/c' })).toBe('/c/jobs');
    expect(claudeJobsDir({})).toBeUndefined();
  });

  it('is stopped with the short id that claude stop takes', async () => {
    const c = config();
    const { exec, calls } = fakeClaude();
    await stopSession(c, exec, 70, SESSION, {});
    expect(calls.at(-1)).toEqual(['stop', '0ff38e2e']);
  });
});
