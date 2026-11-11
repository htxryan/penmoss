import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REMOTE_RUNNER } from '../src/agents/claude.ts';
import {
  chatUrlFromDebug,
  interactiveArgs,
  lastAssistantText,
  resultEvent,
  seedConfig,
} from '../sandbox/remote-claude.ts';

const assistant = (content: unknown) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content } });

describe('the in-sandbox runner of a session with a chat', () => {
  it('seeds the config so nothing waits on a keypress, keeping what was there', () => {
    const seeded = seedConfig(
      { numStartups: 3, projects: { '/w': { history: [1] }, '/other': { x: 1 } } },
      { organizationUuid: 'org' },
      '/w',
    );
    expect(seeded).toMatchObject({
      numStartups: 3,
      hasCompletedOnboarding: true,
      remoteDialogSeen: true,
      bypassPermissionsModeAccepted: true,
      oauthAccount: { organizationUuid: 'org' },
      projects: {
        '/w': { history: [1], hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
        '/other': { x: 1 },
      },
    });
  });

  it("finds the chat's link in the debug log", () => {
    expect(
      chatUrlFromDebug('x\n2026 [DEBUG] [remote-bridge] Created session cse_01Ft4U3a\ny'),
    ).toBe('https://claude.ai/code/session_01Ft4U3a');
    expect(chatUrlFromDebug('[remote-bridge] Fetched bridge credentials')).toBeUndefined();
  });

  it("takes the transcript's last assistant text, past tool calls and partial lines", () => {
    const transcript = [
      assistant([{ type: 'text', text: 'first' }]),
      assistant([{ type: 'tool_use', name: 'Bash', input: {} }]),
      JSON.stringify({ type: 'user', message: { content: 'tool result' } }),
      assistant([
        { type: 'text', text: 'last ' },
        { type: 'text', text: 'words' },
      ]),
      assistant([{ type: 'tool_use', name: 'Read', input: {} }]),
      '{"type":"assist',
    ].join('\n');
    expect(lastAssistantText(transcript)).toBe('last words');
  });

  it('ends like claude -p: a result, an error when the turn failed', () => {
    const transcript = assistant([{ type: 'text', text: "You've hit your limit · resets 3pm" }]);
    expect(resultEvent({ hook_event_name: 'Stop' }, assistant('done'), 's1')).toEqual({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      session_id: 's1',
    });
    expect(
      resultEvent({ hook_event_name: 'StopFailure', error: 'rate_limit' }, transcript, undefined),
    ).toMatchObject({ is_error: true, result: "You've hit your limit · resets 3pm" });
    expect(
      resultEvent({ hook_event_name: 'Stop', last_assistant_message: 'said' }, '', 's'),
    ).toMatchObject({ result: 'said' });
  });

  it("drops claude -p's own flags and keeps the factory's", () => {
    expect(
      interactiveArgs([
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--print',
        '--verbose',
        '--dangerously-skip-permissions',
        '--output-format',
        'stream-json',
        '--model',
        'opus',
        '-p',
        '-',
      ]),
    ).toEqual([
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--dangerously-skip-permissions',
      '--model',
      'opus',
    ]);
  });
});

// A stand-in for Claude Code: it records what it was given, writes a transcript, reports its
// Remote Control session in the debug log, runs the hooks as Claude Code would, and then never
// exits by itself, as an interactive session doesn't.
const FAKE = String.raw`#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process');
const argv = process.argv.slice(2), env = process.env;
const cfg = env.CLAUDE_CONFIG_DIR, record = env.FAKE_RECORD;
fs.writeFileSync(record, JSON.stringify({
  argv, tty: process.stdout.isTTY === true, token: env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
  credentials: JSON.parse(fs.readFileSync(path.join(cfg, '.credentials.json'), 'utf8')),
  config: JSON.parse(fs.readFileSync(path.join(cfg, '.claude.json'), 'utf8')),
}));
const hook = (input) => execFileSync('node', [env.FACTORY_RC_SELF, 'hook'], { input: JSON.stringify(input) });
const transcript = path.join(cfg, 'projects', 'w', 's1.jsonl');
fs.mkdirSync(path.dirname(transcript), { recursive: true });
const say = (text) => fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n');
fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: argv.at(-1) } }) + '\n');
hook({ hook_event_name: 'SessionStart', session_id: 's1', transcript_path: transcript });
fs.writeFileSync(argv[argv.indexOf('--debug-file') + 1], '[remote-bridge] Created session cse_TEST123\n');
setTimeout(() => {
  if (env.FAKE_FAIL) { say("You've hit your limit · resets 3pm"); hook({ hook_event_name: 'StopFailure', error: 'rate_limit' }); }
  else { say('FINISHED'); hook({ hook_event_name: 'Stop', session_id: 's1' }); }
}, 1200);
setInterval(() => {}, 1000);
`;

function runner(fail: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'factory-rc-'));
  const bin = join(root, 'bin');
  const login = join(root, 'login');
  const work = join(root, 'work');
  const home = join(root, 'home');
  for (const d of [bin, login, work, home]) mkdirSync(d);
  writeFileSync(join(bin, 'claude'), FAKE);
  chmodSync(join(bin, 'claude'), 0o755);
  writeFileSync(
    join(login, 'credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'at', expiresAt: 1 } }),
  );
  writeFileSync(join(login, 'account.json'), JSON.stringify({ organizationUuid: 'org' }));
  const record = join(root, 'record.json');
  const r = spawnSync(
    'node',
    [
      REMOTE_RUNNER,
      'run',
      '--name',
      'Penmoss PEN-1 run',
      '--',
      'claude',
      '--print',
      '--dangerously-skip-permissions',
      '--output-format',
      'stream-json',
      '--model',
      'opus',
      '-p',
      '-',
    ],
    {
      cwd: work,
      input: 'Do the work.',
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        PATH: `${bin}:${process.env['PATH'] ?? ''}`,
        HOME: home,
        FACTORY_CLAUDE_LOGIN: login,
        CLAUDE_CODE_OAUTH_TOKEN: 'setup-token',
        FAKE_RECORD: record,
        ...(fail ? { FAKE_FAIL: '1' } : {}),
      },
    },
  );
  const lines = r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { r, lines, record: JSON.parse(readFileSync(record, 'utf8')) as Record<string, unknown> };
}

// `script` is BSD's here; the factory runs only on the Mac.
describe.skipIf(process.platform !== 'darwin')(
  'the runner, against a stand-in claude',
  {
    timeout: 60_000,
  },
  () => {
    it('runs an interactive session in a terminal and streams it as claude -p would', () => {
      const { r, lines, record } = runner(false);
      expect(r.status).toBe(0);
      expect(record['tty']).toBe(true);
      // The setup token is never passed on: it would sign Claude in instead.
      expect(record['token']).toBeNull();
      expect(record['credentials']).toEqual({ claudeAiOauth: { accessToken: 'at', expiresAt: 1 } });
      expect(record['config']).toMatchObject({
        hasCompletedOnboarding: true,
        oauthAccount: { organizationUuid: 'org' },
      });
      const argv = record['argv'] as string[];
      expect(argv).toContain('--remote-control');
      expect(argv[argv.indexOf('--remote-control') + 1]).toBe('Penmoss PEN-1 run');
      expect(argv).not.toContain('--print');
      expect(argv.slice(-2)).toEqual(['--', 'Do the work.']);
      expect(lines[0]).toMatchObject({ type: 'system', subtype: 'init', session_id: 's1' });
      expect(lines).toContainEqual({
        type: 'system',
        subtype: 'factory_chat',
        url: 'https://claude.ai/code/session_TEST123',
      });
      expect(lines.at(-1)).toEqual({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'FINISHED',
        session_id: 's1',
      });
    });

    it('exits 1 with the error as its result when the turn fails', () => {
      const { r, lines } = runner(true);
      expect(r.status).toBe(1);
      expect(lines.at(-1)).toMatchObject({
        type: 'result',
        is_error: true,
        result: "You've hit your limit · resets 3pm",
      });
    });
  },
);
