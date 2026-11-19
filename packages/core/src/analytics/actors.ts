/**
 * Who is behind an event (PEN-137, N5): a person, an agent or a script. The MCP server's events
 * are always an agent's, named by `agentClient` from a fixed list; the CLI's are an agent's when
 * a known agent's environment marker is set or Settings → Agents launched it, a person's on a
 * terminal, and a script's otherwise.
 */
import type { Actor } from './events';

/** The agents an MCP client's `initialize` name maps to; anything else is `other`. */
export const AGENT_CLIENTS = [
  'claude-code',
  'claude-desktop',
  'codex',
  'cursor',
  'vscode',
  'windsurf',
  'zed',
  'gemini',
  'goose',
  'cline',
  'continue',
  'penmoss',
  'other',
] as const;
export type AgentClient = (typeof AGENT_CLIENTS)[number];

const CLIENT_MATCHES: ReadonlyArray<readonly [RegExp, AgentClient]> = [
  [/claude[-\s]?code/i, 'claude-code'],
  [/claude/i, 'claude-desktop'],
  [/codex/i, 'codex'],
  [/cursor/i, 'cursor'],
  [/windsurf|codeium/i, 'windsurf'],
  [/visual studio code|vscode|copilot/i, 'vscode'],
  [/\bzed\b/i, 'zed'],
  [/gemini/i, 'gemini'],
  [/goose/i, 'goose'],
  [/cline/i, 'cline'],
  [/continue/i, 'continue'],
  [/penmoss/i, 'penmoss'],
];

/** The fixed name for an MCP client's `clientInfo.name` (never the name itself). */
export function agentClientOf(name: unknown): AgentClient {
  if (typeof name !== 'string') return 'other';
  for (const [pattern, client] of CLIENT_MATCHES) if (pattern.test(name)) return client;
  return 'other';
}

/** Environment markers that known agents set in the shells they run. */
export const AGENT_ENV_MARKERS: readonly string[] = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CODEX_SANDBOX',
  'CODEX_HOME',
  'CURSOR_AGENT',
  'GEMINI_CLI',
  'PENMOSS_AGENT',
];

/** The CLI's actor, from its environment and whether stdout is a terminal. */
export function cliActor(env: Readonly<Record<string, string | undefined>>, tty: boolean): Actor {
  if (AGENT_ENV_MARKERS.some((key) => (env[key] ?? '') !== '')) return 'agent';
  return tty ? 'person' : 'script';
}
