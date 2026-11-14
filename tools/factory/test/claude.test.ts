import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  claudeAgent,
  claudeFlags,
  DENY_RULES,
  INTERACTIVE_DENY,
  REMOTE_RUNNER,
} from '../src/agents/claude.ts';
import { nodeExec } from '../src/exec.ts';
import { fill, promptTemplate } from '../src/prompt.ts';

describe('the Claude adapter', { timeout: 30_000 }, () => {
  it('adds the isolation flags to the command line, against a stub claude', async () => {
    const agent = await claudeAgent('opus');
    const { command, stdin } = agent.buildPrintCommand({
      prompt: 'do it',
      dangerouslySkipPermissions: true,
    });
    const dir = mkdtempSync(join(tmpdir(), 'factory-claude-'));
    const argvFile = join(dir, 'argv.json');
    // The stub records its arguments and prints a stream-json result line.
    writeFileSync(
      join(dir, 'claude'),
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\nconsole.log(JSON.stringify({type:'system',subtype:'init',mcp_servers:[]}));\n`,
    );
    chmodSync(join(dir, 'claude'), 0o755);
    const r = await nodeExec('sh', ['-c', command], {
      env: { PATH: `${dir}:${process.env['PATH'] ?? ''}` },
      ...(stdin ? { input: stdin } : {}),
    });
    expect(r.code).toBe(0);
    const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
    expect(argv).toEqual(
      expect.arrayContaining([
        '--strict-mcp-config',
        '--setting-sources',
        'project',
        '--model',
        'opus',
      ]),
    );
    expect(JSON.parse(argv[argv.indexOf('--mcp-config') + 1]!)).toEqual({ mcpServers: {} });
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]!) as {
      permissions: { deny: string[] };
    };
    expect(settings.permissions.deny).toEqual([...DENY_RULES]);
    expect(settings.permissions.deny).toContain('Bash(git push:*)');
    // Production deploys happen after merge (FD24): the site's task too, not only wrangler.
    expect(settings.permissions.deny).toContain('Bash(task site:deploy:*)');
    expect(agent.env['ENABLE_CLAUDEAI_MCP_SERVERS']).toBe('false');
    expect(argv).not.toContain('--effort');
  });

  it('passes the effort its model alias names (A1363)', async () => {
    for (const remote of [undefined, '[PF] Penmoss PEN-7 run']) {
      const agent = await claudeAgent('claude-opus-5-5', {}, remote, 'high');
      const { command } = agent.buildPrintCommand({
        prompt: 'do it',
        dangerouslySkipPermissions: true,
      });
      expect(command).toMatch(/(^| )claude .*--effort high /);
      expect(command).toContain("--model 'claude-opus-5-5'");
    }
  });
});

describe('a session with a chat in the Claude app (A1287)', () => {
  const settingsOf = (flags: string) =>
    JSON.parse(/--settings '([^']*)'/.exec(flags)?.[1] ?? '{}') as {
      permissions: { deny: string[] };
      hooks?: Record<string, unknown>;
      skipDangerousModePermissionPrompt?: boolean;
    };

  it('runs the same command line under the in-sandbox runner, prompt on stdin', async () => {
    const agent = await claudeAgent('opus', {}, '[PF] Penmoss PEN-7 run');
    const { command, stdin } = agent.buildPrintCommand({
      prompt: 'do it',
      dangerouslySkipPermissions: true,
    });
    expect(stdin).toBe('do it');
    expect(
      command.startsWith(
        `node '${REMOTE_RUNNER}' run --name '[PF] Penmoss PEN-7 run' -- claude --strict-mcp-config `,
      ),
    ).toBe(true);
    expect(command).toContain('--dangerously-skip-permissions');
    expect(settingsOf(command).hooks).toHaveProperty('Stop');
  });

  it('adds the hooks that end a session, and denies what would wait on a keypress', () => {
    const remote = settingsOf(claudeFlags(true));
    expect(Object.keys(remote.hooks ?? {})).toEqual(['SessionStart', 'Stop', 'StopFailure']);
    expect(remote.permissions.deny).toEqual([...DENY_RULES, ...INTERACTIVE_DENY]);
    expect(remote.permissions.deny).toContain('AskUserQuestion');
    expect(remote.skipDangerousModePermissionPrompt).toBe(true);
    const plain = settingsOf(claudeFlags());
    expect(plain).toEqual({ permissions: { deny: [...DENY_RULES] } });
  });
});

describe('the implement prompt', () => {
  it('fills every placeholder', () => {
    const text = fill(promptTemplate('implement'), {
      branch: 'factory/1-x',
      issue: '# #1 X\n\n{{branch}} stays literal',
      plan: 'None',
      scope: 'web',
    });
    expect(text).not.toMatch(/\{\{(branch|issue|scope)\}\}(?! stays)/);
    expect(text).toContain('Never push');
    expect(text).toContain('<untrusted>');
    expect(text).toContain('.factory/result.json');
  });
  it("names origin/main as main, since the sandbox's local main is stale (PEN-70)", () => {
    const text = promptTemplate('implement');
    expect(text).toContain('`git diff origin/main...HEAD`');
    expect(text).toContain('The local `main` branch is stale');
    // Every other `main` it names is origin's.
    const bare = text.match(/(?<!origin\/)`main`/g) ?? [];
    expect(bare).toEqual(['`main`', '`main`']);
  });
  it('asks for proof specs that bring the change on screen and end on it (PEN-70)', () => {
    const text = promptTemplate('implement');
    expect(text).toContain('scrollIntoViewIfNeeded()');
    expect(text).toContain('end on it');
    expect(text).toContain('ProofShot.take()');
    expect(text).toMatch(/"android": \{ "inScope": true, "proofSpecs"/);
  });
  it('says the sandbox is ready and asks for the scoped check, not the whole one (A1289)', () => {
    const text = promptTemplate('implement');
    expect(text).toContain("the workspace's dependencies are installed");
    expect(text).toContain('`/tmp`');
    expect(text).toContain('task check:changed -- origin/main');
    expect(text).not.toContain('Run `task check` before you finish');
  });
  it("says the factory can't push workflow changes, and infrastructure isn't the branch's (A1314)", () => {
    const text = promptTemplate('implement');
    expect(text).toContain('Never change anything under `.github/workflows/`');
    expect(text).toContain("isn't this branch's to fix");
    expect(text).toContain('"status": "failed"');
  });

  it('says how to add a decision row, so the agent neither pads it nor reads the factory (PEN-63, PEN-73)', () => {
    const text = promptTemplate('implement');
    expect(text).toContain(
      'add it as `| A-NEW-1 | … |` (then `A-NEW-2`, …) after the last row of the A table, and run Prettier on that file',
    );
    expect(text).toContain('The factory numbers the rows and re-formats the table (A1248)');
    expect(text).toContain("Don't pad the row by hand or read the factory's code.");
  });
  it('refuses a missing value', () => {
    expect(() => fill('{{nope}}', {})).toThrow('{{nope}}');
  });
});
