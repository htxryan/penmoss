/**
 * The Claude Code adapter: Sandcastle's `claudeCode()` provider, with the factory's flags added
 * to its command line. No MCP servers or connectors (`--strict-mcp-config` with an empty
 * config), project settings only (never Ryan's), and deny rules passed inline so the agent
 * can't edit them in its worktree.
 */
import type { AgentProvider } from '@ai-hero/sandcastle';
import { fileURLToPath } from 'node:url';

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

/**
 * What an interactive session must not do on top (A1287): ask a question or wait on a plan's
 * approval, which `claude -p` can't, and which would leave the run waiting on a keypress.
 */
export const INTERACTIVE_DENY = ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'] as const;

/** The in-sandbox runner of a session with a chat in the Claude app (sandbox/remote-claude.ts). */
export const REMOTE_RUNNER = fileURLToPath(
  new URL('../../sandbox/remote-claude.ts', import.meta.url),
);

/**
 * The hooks the runner ends a session by: each keeps its input where the runner looks
 * (`$FACTORY_RC_DIR`), and the runner sets both variables for Claude Code.
 */
export const REMOTE_HOOKS = Object.fromEntries(
  ['SessionStart', 'Stop', 'StopFailure'].map((event) => [
    event,
    [{ hooks: [{ type: 'command', command: 'node "$FACTORY_RC_SELF" hook' }] }],
  ]),
);

/** The flags the factory adds to every `claude` run; `remote` adds the runner's hooks and denials. */
export function claudeFlags(remote = false): string {
  const settings = JSON.stringify({
    permissions: { deny: remote ? [...DENY_RULES, ...INTERACTIVE_DENY] : DENY_RULES },
    // An interactive session asks before it bypasses permissions; `-p` never does.
    ...(remote ? { hooks: REMOTE_HOOKS, skipDangerousModePermissionPrompt: true } : {}),
  });
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
  /** The session's name in the Claude app: given, the session gets a chat there (A1287). */
  remote?: string,
): Promise<AgentProvider> {
  const { claudeCode } = await import('@ai-hero/sandcastle');
  // claude.ai connectors come with an account login; the factory's token must not bring them.
  const base = claudeCode(model, { env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false', ...env } });
  const flagged = withFlags(base, claudeFlags(remote !== undefined));
  return remote === undefined ? flagged : withRemoteControl(flagged, remote);
}

/**
 * A provider whose session runs under the in-sandbox runner, as an interactive
 * `claude --remote-control`: the same command line, which the runner turns into an interactive
 * one, and the same stream-json out, so Sandcastle reads it as it reads `claude -p`.
 */
export function withRemoteControl(
  base: AgentProvider,
  name: string,
  runner = REMOTE_RUNNER,
): AgentProvider {
  return {
    ...base,
    parseStreamLine: (line) => base.parseStreamLine(line),
    buildPrintCommand: (options) => {
      const command = base.buildPrintCommand(options);
      if (!/^claude\s/.test(command.command))
        throw new Error(`unexpected claude command: ${command.command}`);
      return {
        ...command,
        command: `node ${quote(runner)} run --name ${quote(name)} -- ${command.command}`,
      };
    },
  };
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
