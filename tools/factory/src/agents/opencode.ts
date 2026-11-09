/**
 * The OpenCode adapter (F12, #278): Sandcastle's `opencode()` provider under the same Seatbelt
 * sandbox. Its permissions come from `agents/opencode.json` in the factory's own checkout, passed
 * inline (`OPENCODE_CONFIG_CONTENT`) with project config turned off, so nothing in the worktree
 * can loosen them. The bash deny list mirrors Claude's (`DENY_RULES`). Sandcastle's
 * `--dangerously-skip-permissions` is taken off: the config allows everything else, so nothing
 * prompts, and the deny rules hold.
 */
import { readFileSync } from 'node:fs';
import type { AgentProvider } from '@ai-hero/sandcastle';

export function opencodeConfig(): string {
  return readFileSync(new URL('../../agents/opencode.json', import.meta.url), 'utf8');
}

/** `Bash(git push:*)` as OpenCode's bash pattern, `git push*`. */
export function bashPattern(claudeRule: string): string {
  const inner = /^Bash\((.+)\)$/.exec(claudeRule)?.[1] ?? claudeRule;
  return inner.endsWith(':*') ? `${inner.slice(0, -2)}*` : inner;
}

export async function opencodeAgent(
  model: string,
  env: Readonly<Record<string, string>> = {},
): Promise<AgentProvider> {
  const { opencode } = await import('@ai-hero/sandcastle');
  const base = opencode(model, {
    env: {
      OPENCODE_CONFIG_CONTENT: opencodeConfig(),
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      // Not Ryan's ~/.claude skills or CLAUDE.md; the repository's AGENTS.md still applies.
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      ...env,
    },
  });
  return withoutSkipPermissions(base);
}

export function withoutSkipPermissions(base: AgentProvider): AgentProvider {
  return {
    ...base,
    parseStreamLine: (line) => base.parseStreamLine(line),
    buildPrintCommand: (options) => {
      const command = base.buildPrintCommand(options);
      if (!/^opencode run\s/.test(command.command))
        throw new Error(`unexpected opencode command: ${command.command}`);
      return {
        ...command,
        // A private server: OpenCode's shared background service has one fixed port, which the
        // Mac's own OpenCode (or the other slot) already holds, so a sandboxed run can't start it.
        command: command.command
          .replace(' --dangerously-skip-permissions', '')
          .replace(/^opencode run\s/, 'opencode run --standalone '),
      };
    },
  };
}
