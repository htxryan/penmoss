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
    expect(command).toMatch(/^opencode run --format json --model 'opencode-go\/kimi-k3'/);
    expect(command).not.toContain('--dangerously-skip-permissions');
  });
  it('parses its JSON stream', async () => {
    const agent = await opencodeAgent('m');
    const line = JSON.stringify({ type: 'text', part: { type: 'text', text: 'hello' } });
    expect(() => agent.parseStreamLine(line)).not.toThrow();
  });
});
