import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DENY_RULES } from '../src/agents/claude.ts';
import { bashPattern, opencodeAgent, opencodeConfig } from '../src/agents/opencode.ts';

describe('the OpenCode adapter (F12)', () => {
  const config = JSON.parse(opencodeConfig()) as {
    permission: { '*': string; bash: Record<string, string>; external_directory: string };
    mcp: object;
  };
  it("denies everything Claude's deny list denies", () => {
    for (const rule of DENY_RULES)
      expect(config.permission.bash[bashPattern(rule)], rule).toBe('deny');
    expect(config.permission.external_directory).toBe('deny');
    expect(config.mcp).toEqual({});
  });
  it('turns Claude rules into OpenCode patterns', () => {
    expect(bashPattern('Bash(git push:*)')).toBe('git push*');
    expect(bashPattern('Bash(security:*)')).toBe('security*');
  });
  it('runs opencode with the model, JSON output and no permission bypass', async () => {
    const agent = await opencodeAgent('opencode-go/kimi-k3');
    const { command } = agent.buildPrintCommand({
      prompt: 'do it',
      dangerouslySkipPermissions: true,
    });
    expect(command).toMatch(
      /^opencode run --standalone --format json --model 'opencode-go\/kimi-k3'/,
    );
    expect(command).not.toContain('--dangerously-skip-permissions');
  });
  it('parses its JSON stream', async () => {
    const agent = await opencodeAgent('m');
    const line = JSON.stringify({ type: 'text', part: { type: 'text', text: 'hello' } });
    expect(() => agent.parseStreamLine(line)).not.toThrow();
  });
  it('reads `opencode run --format json` output: session, tool calls, result, tokens, errors', async () => {
    // The event shapes of OpenCode's JSON stream, so a Sandcastle upgrade that stops reading
    // them fails here rather than on a live run. Replace with a recording from the first one.
    const agent = await opencodeAgent('m');
    const stream = readFileSync(new URL('fixtures/opencode-run.jsonl', import.meta.url), 'utf8');
    const events = ['opencode v1 (not JSON)', ...stream.split('\n')].flatMap((line) =>
      agent.parseStreamLine(line),
    );
    expect(events).toEqual([
      { type: 'session_id', sessionId: 'ses_5f2a9c1e7ffeQb3kL8mN0pR4tV' },
      { type: 'tool_call', name: 'bash', args: 'task lint' },
      {
        type: 'tool_call',
        name: 'edit',
        args: JSON.stringify({ filePath: 'docs/factory.md', oldString: 'a', newString: 'b' }),
      },
      { type: 'text', text: 'Committed, and wrote .factory/result.json.' },
      { type: 'result', result: 'Committed, and wrote .factory/result.json.' },
      { type: 'context_window', contextWindow: { tokens: 20500 } },
      { type: 'error', message: 'Rate limit exceeded' },
    ]);
  });
});
