/**
 * The planning session is found and stopped by the id `claude --bg` prints (PEN-70, 9 Nov 2026).
 * PEN-70's planning session started, but Claude Code titled it "tooltip-delay-pen-70" itself, so
 * looking it up by the card's name failed and the card was set Blocked while the session worked
 * on. And `claude stop` takes the short id, not the session id. Also the sessions' flags, names
 * and chat links, and the plan page as text.
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
  planningEnv,
  planningFlags,
  planText,
  sessionIssue,
  sessionName,
  stopSession,
  writeMeta,
} from '../src/planning-host.ts';
import { linearConfig, testConfig } from './helpers.ts';

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
  it('is started with its display name and Remote Control, and launch returns the id --bg printed', async () => {
    const c = config();
    const { exec, calls } = fakeClaude();
    const started = await launchSession(c, exec, planFiles(c, 70), 70, 'plan PEN-70', {});
    const args = calls[0] ?? [];
    expect(args[args.indexOf('--name') + 1]).toBe(sessionName(c, 70));
    // Its chat in the Claude app, on Ryan's own login (A1286).
    expect(args[args.indexOf('--remote-control') + 1]).toBe(sessionName(c, 70));
    expect(args.indexOf('--remote-control')).toBeLessThan(args.indexOf('--'));
    // Claude's default model and effort from the config, not Ryan's own defaults (A1363).
    const alias = c.models[c.agents.claude.defaultModel]!;
    expect(args[args.indexOf('--model') + 1]).toBe(alias.model);
    expect(args[args.indexOf('--effort') + 1]).toBe(alias.effort);
    expect(args.indexOf('--effort')).toBeLessThan(args.indexOf('--'));
    expect(started).toEqual({ id: '0ff38e2e' });
  });

  /**
   * `claude` as 2.1.330 behaves on a resume (20 Nov 2026): one still listed in `claude agents`, or
   * given flags, gets a copy with a new id; a stopped one given none is woken under its own id.
   */
  function resumingClaude(listedAtFirst: boolean) {
    const calls: string[][] = [];
    let listed = listedAtFirst;
    const exec: Exec = (_cmd, args) => {
      calls.push([...args]);
      if (args[0] === 'agents')
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify(
            listed
              ? [{ id: '0ff38e2e', kind: 'background', sessionId: SESSION, status: 'idle' }]
              : [],
          ),
          stderr: '',
        });
      if (args[0] === 'stop') {
        listed = false;
        return Promise.resolve({ code: 0, stdout: 'stopped 0ff38e2e', stderr: '' });
      }
      const copy = listed || args.indexOf('--bg') !== args.indexOf('--') - 1;
      return Promise.resolve({
        code: 0,
        stdout: copy
          ? 'note: session 0ff38e2e is already running in the background, so this started a copy as 1bbc4b13. `claude attach 0ff38e2e` opens the original.\nbackgrounded · 1bbc4b13\n'
          : 'note: woke session 0ff38e2e with its saved options (--name, --remote-control, --model).\nbackgrounded · 0ff38e2e · [PF] Penmoss PEN-70 plan\n',
        stderr: '',
      });
    };
    return { exec, calls };
  }
  const noJobs = { dir: mkdtempSync(join(tmpdir(), 'claude-jobs-')), waitMs: 0 };

  it('is resumed as the same session: stopped first, then woken with no flags (A1665)', async () => {
    const c = config();
    const { exec, calls } = resumingClaude(true);
    const sleep = () => Promise.resolve();
    const resumed = await launchSession(c, exec, planFiles(c, 70), 70, 'Ryan said', {}, SESSION, {
      ...noJobs,
      sleep,
    });
    expect(calls.find((a) => a[0] === 'stop')).toEqual(['stop', '0ff38e2e']);
    const launch = calls.find((a) => a.includes('--bg'))!;
    // Its saved options carry the name, Remote Control, model and tools: flags would start a copy.
    expect(launch).toEqual(['--resume', SESSION, '--bg', '--', 'Ryan said']);
    expect(resumed).toMatchObject({ id: '0ff38e2e', resumed: true });
    expect(resumed.note).toMatch(/^woke session 0ff38e2e/);
  });

  it('is not stopped again when it has already stopped, and says when only a copy could start (A1665)', async () => {
    const c = config();
    const stopped = resumingClaude(false);
    await expect(
      launchSession(c, stopped.exec, planFiles(c, 70), 70, 'go on', {}, SESSION, noJobs),
    ).resolves.toMatchObject({ id: '0ff38e2e', resumed: true });
    expect(stopped.calls.some((a) => a[0] === 'stop')).toBe(false);
    // A session `claude stop` can't stop is still listed: Claude Code starts a copy, and says so.
    const stuck = resumingClaude(true);
    const exec: Exec = (cmd, args, o) =>
      args[0] === 'stop'
        ? Promise.resolve({ code: 1, stdout: '', stderr: 'no' })
        : stuck.exec(cmd, args, o);
    const copy = await launchSession(c, exec, planFiles(c, 70), 70, 'go on', {}, SESSION, {
      ...noJobs,
      sleep: () => Promise.resolve(),
    });
    expect(copy).toMatchObject({ id: '1bbc4b13', resumed: false });
    expect(copy.note).toMatch(/started a copy as 1bbc4b13/);
  });

  it("runs on Ryan's own Claude.ai login: no setup token or API key in its environment (A1286)", () => {
    const env = planningEnv({
      PATH: '/opt/homebrew/bin:/usr/bin',
      HOME: '/Users/r',
      USER: 'r',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-factory',
      ANTHROPIC_API_KEY: 'sk-ant-api03-key',
      GH_TOKEN: 'ghs_x',
    });
    expect(env).toEqual({
      PATH: '/opt/homebrew/bin:/usr/bin',
      HOME: '/Users/r',
      USER: 'r',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    });
    expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(planningEnv({})).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    });
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
    // factory:chat gives the link and the terminal command.
    const files = planFiles(c, 70);
    mkdirSync(files.root, { recursive: true });
    writeMeta(files, { sessionId: SESSION, ...started });
    expect(planningChat(c, 70)).toEqual({
      command: 'claude attach 0ff38e2e',
      chatUrl: 'https://claude.ai/code/session_01Ft4U3apUr33bjvQoKRcUFV',
    });
  });

  it('looks for the job file in the HOME it runs with', async () => {
    const c = config();
    const { exec } = fakeClaude();
    const home = mkdtempSync(join(tmpdir(), 'claude-home-'));
    mkdirSync(join(home, '.claude', 'jobs', '0ff38e2e'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'jobs', '0ff38e2e', 'state.json'),
      JSON.stringify({ bridgeSessionId: 'cse_01Home' }),
    );
    const started = await launchSession(
      c,
      exec,
      planFiles(c, 70),
      70,
      'plan',
      planningEnv({ HOME: home }),
    );
    expect(started).toEqual({ id: '0ff38e2e', chatUrl: 'https://claude.ai/code/session_01Home' });
  });

  it('has no chat link when Claude Code reports none in time, and factory:chat still attaches', async () => {
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
    expect(planningChat(c, 70)).toEqual({ command: 'claude attach 0ff38e2e', chatUrl: null });
  });

  it('reads only a Remote Control id from the job file', () => {
    expect(chatUrlFromJob('{"bridgeSessionId":"session_01Ab"}')).toBe(
      'https://claude.ai/code/session_01Ab',
    );
    expect(chatUrlFromJob('{"bridgeSessionId":"cse_01Ab"}')).toBe(
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

describe('planning sessions', () => {
  it('scope every tool to the snapshot and the output folder, with no MCP and no Chrome (F0.5)', () => {
    const flags = planningFlags({
      root: '/p/9',
      repo: '/p/9/repo',
      out: '/p/9/out',
      meta: '/p/9/meta.json',
      attachments: '/p/9/attachments',
    });
    expect(flags).toEqual(
      expect.arrayContaining([
        '--no-chrome',
        '--strict-mcp-config',
        '{"mcpServers":{}}',
        'dontAsk',
        // `//` is an absolute path in a Claude Code rule; `/` is relative to the settings file.
        'Read(//p/9/repo/**)',
        'Read(//p/9/out/**)',
        // The issue's images, which the host downloads: read, never written.
        'Read(//p/9/attachments/**)',
        'Edit(//p/9/out/**)',
      ]),
    );
    // Remote Control stays on: the session runs on Ryan's own login, which can open it (A1286).
    expect(flags).not.toContain('--settings');
    expect(flags.join(' ')).not.toContain('remoteControlAtStartup');
    expect(flags).not.toContain('Edit(//p/9/attachments/**)');
    expect(flags.some((f) => f.startsWith('Bash'))).toBe(false);
    // Claude Code never matches a file write against a Write rule, only against Edit.
    expect(flags.some((f) => f.startsWith('Write('))).toBe(false);
    expect(flags.some((f) => /^(Read|Edit)\(\/[^/]/.test(f))).toBe(false);
  });
  it('names each session after its card, as the active tracker numbers it', () => {
    const github = testConfig();
    const linear = linearConfig();
    expect(sessionName(github, 9)).toBe('[PF] Penmoss #9 plan');
    expect(sessionName(linear, 41)).toBe('[PF] Penmoss PEN-41 plan');
    expect(sessionIssue(linear, '[PF] Penmoss PEN-41 plan')).toBe(41);
    // A session started before the prefix (A1288) is still the card's.
    expect(sessionIssue(linear, 'Penmoss PEN-41 plan')).toBe(41);
    expect(sessionIssue(linear, '[PF] Penmoss PEN-41 run')).toBeUndefined();
    // Another tracker's session, or anyone else's, isn't this card's.
    expect(sessionIssue(linear, 'Penmoss #41 plan')).toBeUndefined();
    expect(sessionIssue(github, 'Penmoss PEN-41 plan')).toBeUndefined();
    expect(sessionIssue(linear, 'My own session')).toBeUndefined();
  });
  it('gives factory:chat the Claude app link and the command that join the planning session (A1281, A1286)', () => {
    const config = { ...linearConfig(), stateDir: mkdtempSync(join(tmpdir(), 'chat-')) };
    expect(planningChat(config, 41)).toEqual({ error: 'PEN-41 has no planning session yet' });
    const files = planFiles(config, 41);
    mkdirSync(files.root, { recursive: true });
    writeMeta(files, { sessionId: '5be0ac96-5e8e-4b08' });
    expect(planningChat(config, 41)).toEqual({ command: 'claude attach 5be0ac96', chatUrl: null });
    writeMeta(files, {
      sessionId: '5be0ac96-5e8e-4b08',
      chatUrl: 'https://claude.ai/code/session_01Ab',
    });
    expect(planningChat(config, 41)).toEqual({
      command: 'claude attach 5be0ac96',
      chatUrl: 'https://claude.ai/code/session_01Ab',
    });
    writeMeta(files, {
      sessionId: '5be0ac96-5e8e-4b08',
      agreed: {
        quote: 'complete',
        channel: 'issue',
        at: 'x',
        trivial: false,
        planUrl: null,
        designUrl: null,
        planVersion: 1,
        designVersion: null,
      },
    });
    expect(planningChat(config, 41)).toEqual({
      error: "PEN-41's plan is agreed; its planning session has ended",
    });
  });

  it("turns the plan page into text, without its styles, scripts or diagrams' markup", () => {
    const html =
      '<html><style>p{}</style><body><h1>Plan</h1><p>Do &amp; test</p><svg><text>x</text></svg><script>1</script><ul><li>AC1</li></ul></body></html>';
    expect(planText(html)).toBe('Plan\nDo & test\nAC1');
  });
});
