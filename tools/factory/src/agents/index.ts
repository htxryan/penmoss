/** The agent for an issue's spec: Claude Code or OpenCode, by its labels (F12). */
import type { AgentProvider } from '@ai-hero/sandcastle';
import { hasLogin, loginDir } from '../claude-login.ts';
import type { FactoryConfig } from '../config.ts';
import type { IssueSpec } from '../labels.ts';
import { issueKey } from '../tracker/port.ts';
import { claudeAgent } from './claude.ts';
import { opencodeAgent } from './opencode.ts';

const modelOf = (config: FactoryConfig, spec: IssueSpec) =>
  config.models[spec.modelAlias]?.model ?? spec.model;

export function agentFor(config: FactoryConfig, spec: IssueSpec): Promise<AgentProvider> {
  const model = modelOf(config, spec);
  return spec.agent === 'opencode' ? opencodeAgent(model) : claudeAgent(model);
}

/** A run's sessions' name in the Claude app: the card as people know it. */
export const runSessionName = (config: FactoryConfig, issue: number) =>
  `Penmoss ${issueKey(config, issue)} run`;

/**
 * The same agent with a chat in the Claude app (A1287), when the issue runs on Claude Code and
 * the factory has its own claude.ai login; undefined otherwise, and the run uses `agentFor`'s.
 */
export async function remoteAgentFor(
  config: FactoryConfig,
  spec: IssueSpec,
  issue: number,
): Promise<AgentProvider | undefined> {
  const dir = loginDir(config);
  if (spec.agent !== 'claude' || !dir || !hasLogin(dir)) return undefined;
  return claudeAgent(modelOf(config, spec), {}, runSessionName(config, issue));
}
