/**
 * The Claude Code adapter: Sandcastle's `claudeCode()` provider, with the factory's flags added
 * to its command line. No MCP servers or connectors (`--strict-mcp-config` with an empty
 * config), project settings only (never Ryan's), and deny rules passed inline so the agent
 * can't edit them in its worktree.
 */
import type { AgentProvider } from '@ai-hero/sandcastle';

/** What the agent may never do, even with permissions skipped: the harness owns these. */
export const DENY_RULES = [
  'Bash(git push:*)',
  'Bash(git remote:*)',
  'Bash(git config --global:*)',
  'Bash(gh pr create:*)',
  'Bash(gh pr merge:*)',
  'Bash(gh pr review:*)',
  'Bash(gh pr edit:*)',
  'Bash(gh project:*)',
  'Bash(gh api graphql:*)',
  'Bash(gh auth:*)',
  'Bash(wrangler deploy:*)',
  'Bash(pnpm exec wrangler deploy:*)',
  'Bash(corepack pnpm exec wrangler deploy:*)',
  'Bash(task site:deploy:*)',
  'Bash(security:*)',
] as const;

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** The flags the factory adds to every `claude` run. */
export function claudeFlags(): string {
  const settings = JSON.stringify({ permissions: { deny: DENY_RULES } });
  return [
    '--strict-mcp-config',
    `--mcp-config ${quote('{"mcpServers":{}}')}`,
    '--setting-sources project',
    `--settings ${quote(settings)}`,
  ].join(' ');
}

export async function claudeAgent(
  model: string,
  env: Readonly<Record<string, string>> = {},
): Promise<AgentProvider> {
  const { claudeCode } = await import('@ai-hero/sandcastle');
  // claude.ai connectors come with an account login; the factory's token must not bring them.
  const base = claudeCode(model, { env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false', ...env } });
  return withFlags(base, claudeFlags());
}

/** A provider whose print command carries extra flags after `claude`. */
export function withFlags(base: AgentProvider, flags: string): AgentProvider {
  return {
    ...base,
    parseStreamLine: (line) => base.parseStreamLine(line),
    buildPrintCommand: (options) => {
      const command = base.buildPrintCommand(options);
      if (!/^claude\s/.test(command.command))
        throw new Error(`unexpected claude command: ${command.command}`);
      return { ...command, command: command.command.replace(/^claude\s/, `claude ${flags} `) };
    },
  };
}
