import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeAgent, DENY_RULES } from '../src/agents/claude.ts';
import { nodeExec } from '../src/exec.ts';
import { fill, promptTemplate } from '../src/prompt.ts';

describe('the Claude adapter', () => {
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
    expect(agent.env['ENABLE_CLAUDEAI_MCP_SERVERS']).toBe('false');
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
  it('refuses a missing value', () => {
    expect(() => fill('{{nope}}', {})).toThrow('{{nope}}');
  });
});
